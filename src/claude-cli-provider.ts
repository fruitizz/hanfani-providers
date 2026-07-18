import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client'
import {
  approvalResolved,
  lastApprovalArgs,
  type GateResolution,
  type Provider,
  type PromptStrategy,
  type ResumeHandle,
  type Message,
} from '@hanfani/core'
import { mapClaudeStream } from './claude-stream.js'

// Spawns a `claude` run for a prompt and exposes stdout as NDJSON lines + kill().
// `allowedTools` is the agent's permission allow-list (fully-qualified MCP names) —
// the hard per-agent boundary on which tools the model may call. Injectable so the
// Node implementation stays server-side and tests use a fake.
export type ClaudeSpawn = (
  prompt: string,
  allowedTools: readonly string[]
) => {
  lines: AsyncIterable<string>
  kill: () => void
}

function errorChunk(message: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CHUNK,
    role: 'assistant',
    messageId: crypto.randomUUID(),
    delta: `Provider error: ${message}`,
  } as BaseEvent
}

function textChunk(message: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CHUNK,
    role: 'assistant',
    messageId: crypto.randomUUID(),
    delta: message,
  } as BaseEvent
}

// Generic over the agent: prompts come from an injected PromptStrategy, so the same
// provider serves the reply agent, the qualifier, and any future claude-cli agent.
export function createClaudeCliProvider(opts: {
  approvalNames: readonly string[]
  // The agent's renderable tool names — only these surface to the client; the
  // model's internal tools (e.g. ToolSearch) are filtered out of the thread.
  surfaceTools: readonly string[]
  // The agent's permission allow-list (fully-qualified MCP names) — passed to spawn.
  allowedTools: readonly string[]
  // The composed agent identity (defineAgent.instructions ⊕ the workflow prompt). The provider
  // PREPENDS this to every turn so the PromptStrategy stays turn-only — identity is never repeated
  // in the strategy's prose. Optional/empty ⇒ no prepend (no stray separator).
  instructions?: string
  prompts: PromptStrategy
  spawn: ClaudeSpawn
}): Provider {
  const { approvalNames, surfaceTools, allowedTools, instructions, prompts, spawn } = opts

  // Prepend the composed identity to a turn prompt. A null turn (buildResume rejected the resume)
  // stays null; an empty/absent `instructions` yields the turn verbatim (no leading separator).
  const withIdentity = (turn: string | null): string | null =>
    turn === null ? null : instructions ? `${instructions}\n\n${turn}` : turn

  // Spawn the CLI for a prompt and map its NDJSON to AG-UI events. `detectApprovals` is the
  // approval-name set the stream watches for the GATE_OPENED suspend point — passed [] on a
  // resume run (a resumed run must not re-open the same gate).
  async function* primeAndStream(
    prompt: string,
    detectApprovals: readonly string[]
  ): AsyncGenerator<BaseEvent> {
    let child: { lines: AsyncIterable<string>; kill: () => void }
    try {
      child = spawn(prompt, allowedTools)
    } catch (err) {
      yield errorChunk(err instanceof Error ? err.message : String(err))
      return
    }
    try {
      yield* mapClaudeStream(child.lines, { approvalNames: detectApprovals, surfaceTools })
    } catch (err) {
      yield errorChunk(err instanceof Error ? err.message : String(err))
    } finally {
      child.kill()
    }
  }

  // Returns the resume PROMPT (string) to spawn, or null when there is no prompt-mode resume to run.
  // message/null modes are resolved by the SERVER before resume() is called, so they never reach here.
  // Precedence is `??` (not `||`) on purpose: an explicitly-passed `form` is honored even when
  // empty `{}` — the caller's decision wins over the transcript. Do not change `??` to `||`.
  function resumePromptFrom(handle: ResumeHandle, resolution: GateResolution): string | null {
    const messages = (handle.input?.messages ?? []) as Message[]
    const args = resolution.form ?? lastApprovalArgs(messages, approvalNames) ?? {}
    const outcome = prompts.buildResume?.(args, resolution.executedResult) ?? null
    if (outcome && outcome.kind === 'prompt') return withIdentity(outcome.text)
    return null // message/null mode: nothing for the provider to spawn
  }

  return {
    async *run(input: RunAgentInput): AsyncIterable<BaseEvent> {
      const messages = (input?.messages ?? []) as Message[]
      const resuming = approvalResolved(messages, approvalNames)
      if (resuming) {
        // Legacy stateless re-prime: the old client drives resume through run() with the
        // resolved transcript and NO resolution.form, so this reads args from the transcript
        // only. The explicit resume() path (below) prefers resolution.form via resumePromptFrom.
        const args = lastApprovalArgs(messages, approvalNames) ?? {}
        const outcome = prompts.buildResume?.(args) ?? null
        const resumePrompt =
          outcome && outcome.kind === 'prompt' ? withIdentity(outcome.text) : null
        if (!resumePrompt) return // message/null/none: clean end, no "Resume failed"
        yield* primeAndStream(resumePrompt, [])
        return
      }
      yield* primeAndStream(withIdentity(prompts.buildFirst(input)) ?? '', approvalNames)
    },

    async *resume(handle: ResumeHandle, resolution: GateResolution): AsyncIterable<BaseEvent> {
      if (resolution.decision === 'rejected') {
        yield textChunk('The human rejected the proposed action; no changes were made.')
        return
      }
      const resumePrompt = resumePromptFrom(handle, resolution)
      if (!resumePrompt) return // message/null handled server-side; nothing to spawn here
      yield* primeAndStream(resumePrompt, [])
    },
  }
}
