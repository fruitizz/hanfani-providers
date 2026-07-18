import { EventType, type BaseEvent } from '@ag-ui/client'
import type { MastraChunk } from './mastra-types.js'

// Read a field from payload first, then the flattened root (workflow wrapping varies).
function field<T>(c: MastraChunk, key: keyof NonNullable<MastraChunk['payload']>): T | undefined {
  const p = c.payload as Record<string, unknown> | undefined
  return (
    ((p?.[key as string] ?? (c as unknown as Record<string, unknown>)[key as string]) as T) ??
    undefined
  )
}

function textChunk(messageId: string, delta: string): BaseEvent {
  return { type: EventType.TEXT_MESSAGE_CHUNK, role: 'assistant', messageId, delta } as BaseEvent
}

// Maps Mastra fullStream chunks → AG-UI events. Mirrors claude-stream: contiguous text shares
// ONE messageId (cleared at any tool boundary — the AG-UI "split bubble" gotcha); only
// surfaceTools appear as tool calls; surfaced tools also emit TOOL_CALL_RESULT so the default
// chip flips Running→Done and the client gets the data directly.
export async function* mapMastraStream(
  chunks: AsyncIterable<MastraChunk>,
  opts: { surfaceTools: readonly string[] }
): AsyncGenerator<BaseEvent> {
  let textId: string | null = null
  // toolCallId → whether we surfaced it (so we only emit a RESULT for surfaced tools)
  const surfaced = new Map<string, boolean>()

  for await (const c of chunks) {
    if (c.type === 'text-delta') {
      const text = field<string>(c, 'text') ?? ''
      if (!text) continue
      if (textId === null) textId = crypto.randomUUID()
      yield textChunk(textId, text)
      continue
    }

    if (c.type === 'tool-call') {
      textId = null // boundary: close any open text message
      const toolCallId = field<string>(c, 'toolCallId') ?? crypto.randomUUID()
      const toolName = field<string>(c, 'toolName') ?? ''
      const show = opts.surfaceTools.includes(toolName)
      surfaced.set(toolCallId, show)
      if (!show) continue
      const args = field<unknown>(c, 'args') ?? {}
      yield {
        type: EventType.TOOL_CALL_START,
        parentMessageId: crypto.randomUUID(),
        toolCallId,
        toolCallName: toolName,
      } as BaseEvent
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: typeof args === 'string' ? args : JSON.stringify(args),
      } as BaseEvent
      yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent
      continue
    }

    if (c.type === 'tool-result') {
      const toolCallId = field<string>(c, 'toolCallId') ?? ''
      if (!surfaced.get(toolCallId)) continue
      const result = field<unknown>(c, 'result') ?? {}
      yield {
        type: EventType.TOOL_CALL_RESULT,
        role: 'tool',
        toolCallId,
        messageId: crypto.randomUUID(),
        content: typeof result === 'string' ? result : JSON.stringify(result),
      } as BaseEvent
      continue
    }

    if (c.type === 'error') {
      const err = field<unknown>(c, 'error')
      yield textChunk(crypto.randomUUID(), `Provider error: ${String(err ?? 'unknown')}`)
      textId = null
    }
    // 'finish'/'start'/'step-*' carry no client-visible content — ignored.
  }
}
