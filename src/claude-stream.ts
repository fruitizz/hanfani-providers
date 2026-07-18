import { EventType, type BaseEvent } from '@ag-ui/client'
import { gateOpened, type GateOpenedValue } from '@hanfani/core'

// Claude Code MCP tools surface as `mcp__<server>__<tool>`; the client registered
// the bare names (`renderLead`, `saveDraft`), so strip the prefix.
function stripMcpPrefix(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const rest = name.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  return sep === -1 ? name : rest.slice(sep + 2)
}

function textChunk(text: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CHUNK,
    role: 'assistant',
    messageId: crypto.randomUUID(),
    delta: text,
  } as BaseEvent
}

// Normalizes a `claude` tool_result `content` (string | array of {text} blocks |
// arbitrary) to a plain string the client can store on a ToolMessage.
function normalizeResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''
      )
      .join('')
    return text || JSON.stringify(content)
  }
  return JSON.stringify(content ?? '')
}

type ToolBlock = {
  id: string
  name: string
  sawArgs: boolean
  startInput: unknown
  argsBuf: string
}

// Parses the `claude --output-format stream-json` NDJSON stream into AG-UI events.
//
// Claude emits a turn in TWO overlapping shapes: incremental `stream_event` lines
// (content_block_start/delta/stop, with `--include-partial-messages`) AND a final
// complete top-level `{ type: 'assistant', message }` line. Synthetic/cached turns
// (and short responses) may arrive ONLY as the complete top-level message with no
// partial deltas. We handle both and de-duplicate: text is emitted from deltas when
// streaming, else from the complete message; tool calls are de-duped by id.
//
// Stops (returns) right after emitting TOOL_CALL_END for an approval tool — the
// caller then kills the subprocess (turn-1 HITL pause).
export async function* mapClaudeStream(
  lines: AsyncIterable<string>,
  opts: { approvalNames: readonly string[]; surfaceTools?: readonly string[] }
): AsyncGenerator<BaseEvent> {
  const blocks = new Map<number, ToolBlock>()
  const emittedToolIds = new Set<string>()
  // Whether text was streamed via deltas since the last message boundary — if so,
  // skip the complete top-level message's text to avoid double-emitting.
  let streamedText = false

  // All text deltas of ONE contiguous text run MUST share a single messageId, or
  // AG-UI closes the message and opens a new one on each differing id (TEXT_MESSAGE_CHUNK
  // semantics) — rendering one bubble per delta ("Draf"/"ted a reply"). Allocate lazily
  // on first delta; `endTextRun()` clears it at a boundary (tool call, message_start,
  // end of a complete message) so the next run is a fresh, separate bubble.
  let textMsgId: string | null = null
  function textRunChunk(text: string): BaseEvent {
    if (!textMsgId) textMsgId = crypto.randomUUID()
    return {
      type: EventType.TEXT_MESSAGE_CHUNK,
      role: 'assistant',
      messageId: textMsgId,
      delta: text,
    } as BaseEvent
  }
  const endTextRun = () => {
    textMsgId = null
  }

  // Only surface tool calls that are part of the agent's contract (the names the
  // client can render). Internal/built-in tools the model may use to reach them
  // (e.g. ToolSearch) are machinery — never show them to the consumer. When
  // `surfaceTools` is omitted, all tool calls pass through (back-compat).
  function shouldSurface(name: string): boolean {
    return !opts.surfaceTools || opts.surfaceTools.includes(name)
  }

  // Emits START/ARGS/END for a tool call (used by both the complete-message path
  // and as a helper). Returns true if it was an approval tool (caller should stop).
  function* emitToolCall(
    id: string,
    rawName: string,
    argsJson: string | undefined
  ): Generator<BaseEvent> {
    const name = stripMcpPrefix(rawName)
    emittedToolIds.add(id)
    endTextRun() // a tool call ends the preceding text run
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: crypto.randomUUID(),
    } as BaseEvent
    if (argsJson) {
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: argsJson } as BaseEvent
    }
    yield { type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent
  }

  // Normalize the approval tool's args into the gate's `proposedArtifact`. Two callers feed it
  // different shapes: the streaming path passes the accumulated `argsBuf` JSON STRING (reconstructed
  // from input_json_delta partials); the complete-message path passes the already-parsed `input`
  // OBJECT. Hence both the string-parse and object-passthrough branches.
  function parseArtifact(raw: unknown): Record<string, unknown> {
    if (typeof raw === 'string') {
      try {
        const v = JSON.parse(raw)
        return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    }
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>
    return {}
  }
  function gateFor(
    toolName: string,
    toolCallId: string,
    artifact: Record<string, unknown>
  ): BaseEvent {
    const value: GateOpenedValue = {
      gateKind: 'approval',
      toolName,
      toolCallId,
      proposedArtifact: artifact,
    }
    return gateOpened(value)
  }

  for await (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const obj = parsed as {
      type?: string
      event?: Record<string, unknown>
      is_error?: boolean
      result?: string
      message?: { model?: string; content?: Array<Record<string, unknown>> }
    }

    // A run-level failure (e.g. auth: "Not logged in · Please run /login") arrives
    // as a `result` line, not a stream_event — surface it as readable text and stop.
    if (obj.type === 'result' && obj.is_error) {
      yield textChunk(`Provider error: ${obj.result ?? 'run failed'}`)
      return
    }

    // Complete top-level assistant message (covers non-streamed turns). Skip TEXT
    // from `<synthetic>` messages — those are system-injected notices (e.g. the
    // "Not logged in" auth message), already surfaced via the result-error path;
    // don't echo them as assistant chat text. Real model turns are emitted normally.
    if (obj.type === 'assistant' && obj.message?.content) {
      const synthetic = obj.message.model === '<synthetic>'
      for (const block of obj.message.content) {
        const b = block as {
          type?: string
          text?: string
          id?: string
          name?: string
          input?: unknown
        }
        if (b.type === 'text' && b.text && !streamedText && !synthetic) {
          yield textRunChunk(b.text)
        }
        if (
          b.type === 'tool_use' &&
          b.id &&
          !emittedToolIds.has(b.id) &&
          shouldSurface(stripMcpPrefix(b.name ?? ''))
        ) {
          const argsJson =
            b.input && typeof b.input === 'object' && Object.keys(b.input as object).length > 0
              ? JSON.stringify(b.input)
              : undefined
          yield* emitToolCall(b.id, b.name ?? '', argsJson)
          const toolName = stripMcpPrefix(b.name ?? '')
          if (opts.approvalNames.includes(toolName)) {
            yield gateFor(toolName, b.id, parseArtifact(b.input))
            return
          }
        }
      }
      streamedText = false
      endTextRun()
      continue
    }

    // Tool RESULT line: `claude` ran a tool and fed the result back as a top-level
    // `user` message with tool_result blocks. Surface the result (only for tools WE
    // surfaced — internal tool results like ToolSearch stay hidden) as a ToolMessage
    // so the client can (a) flip the tool chip from Running→Done and (b) read the
    // data directly instead of the model re-emitting it into a render tool.
    if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message!.content) {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown }
        if (b.type === 'tool_result' && b.tool_use_id && emittedToolIds.has(b.tool_use_id)) {
          yield {
            type: EventType.TOOL_CALL_RESULT,
            messageId: crypto.randomUUID(),
            toolCallId: b.tool_use_id,
            content: normalizeResultContent(b.content),
            role: 'tool',
          } as BaseEvent
        }
      }
      continue
    }

    if (obj.type !== 'stream_event' || !obj.event) continue
    const ev = obj.event as {
      type?: string
      index?: number
      content_block?: { type?: string; id?: string; name?: string; input?: unknown }
      delta?: { type?: string; text?: string; partial_json?: string }
    }
    const index = typeof ev.index === 'number' ? ev.index : -1

    if (ev.type === 'message_start') {
      streamedText = false
      endTextRun()
      continue
    }

    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      const name = stripMcpPrefix(ev.content_block.name ?? '')
      // Internal/built-in tool (e.g. ToolSearch) — don't track or emit it; its
      // later args/stop lines find no block and are harmlessly ignored.
      if (!shouldSurface(name)) continue
      const id = ev.content_block.id ?? crypto.randomUUID()
      blocks.set(index, {
        id,
        name,
        sawArgs: false,
        startInput: ev.content_block.input,
        argsBuf: '',
      })
      emittedToolIds.add(id)
      endTextRun() // a tool call ends the preceding text run
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: id,
        toolCallName: name,
        parentMessageId: crypto.randomUUID(),
      } as BaseEvent
      continue
    }

    if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta' && ev.delta.text) {
        streamedText = true
        yield textRunChunk(ev.delta.text)
        continue
      }
      if (ev.delta?.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
        const block = blocks.get(index)
        if (block) {
          block.sawArgs = true
          block.argsBuf += ev.delta.partial_json
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: block.id,
            delta: ev.delta.partial_json,
          } as BaseEvent
        }
        continue
      }
      continue
    }

    if (ev.type === 'content_block_stop') {
      const block = blocks.get(index)
      if (!block) continue
      if (
        !block.sawArgs &&
        block.startInput &&
        typeof block.startInput === 'object' &&
        Object.keys(block.startInput as object).length > 0
      ) {
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: block.id,
          delta: JSON.stringify(block.startInput),
        } as BaseEvent
      }
      yield { type: EventType.TOOL_CALL_END, toolCallId: block.id } as BaseEvent
      const stoppedBlock = block
      blocks.delete(index)
      if (opts.approvalNames.includes(stoppedBlock.name)) {
        const artifact = parseArtifact(stoppedBlock.argsBuf || stoppedBlock.startInput)
        yield gateFor(stoppedBlock.name, stoppedBlock.id, artifact)
        return
      }
      continue
    }
  }
}
