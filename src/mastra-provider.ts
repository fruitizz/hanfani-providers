import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client'
import { gateOpened, type GateResolution, type Provider, type ResumeHandle } from '@hanfani/core'
import { mapMastraStream } from './mastra-stream.js'
import type { MastraRunner, MastraRun } from './mastra-types.js'

function errorChunk(message: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CHUNK,
    role: 'assistant',
    messageId: crypto.randomUUID(),
    delta: `Provider error: ${message}`,
  } as BaseEvent
}

export function createMastraProvider(opts: {
  approvalNames: readonly string[]
  surfaceTools: readonly string[]
  runner: MastraRunner
}): Provider {
  const { approvalNames, surfaceTools, runner } = opts

  // Drive ONE Mastra run (start or resume): map chunks → AG-UI, track the last approval-named
  // tool-call (= the gate proposal, last-wins), and on a suspended result synthesize GATE_OPENED
  // from it. `emitGateOnSuspend=false` on resume (a resumed run must not re-open the gate).
  async function* drive(run: MastraRun, emitGateOnSuspend: boolean): AsyncGenerator<BaseEvent> {
    // Mutable container avoids TS control-flow narrowing-to-never after async IIFE mutations.
    const state: {
      lastApproval: {
        toolName: string
        toolCallId: string
        artifact: Record<string, unknown>
      } | null
    } = { lastApproval: null }
    // Did the run settle on its own (finished/suspended/failed)? A `finally` runs on BOTH normal
    // completion AND an early `iterator.return()` (Stop). We must abort ONLY on the latter: a
    // SUSPENDED run is parked in Mastra's storage for the native resume, and aborting it would
    // cancel that snapshot ("This workflow run was not suspended" on resume). So abort iff the
    // generator was interrupted before settling (caution a) — never on a clean suspend/finish.
    let settled = false
    try {
      // Tap the stream: forward every chunk to the mapper AND watch for the approval tool-call.
      const tap = (async function* () {
        for await (const c of run.stream) {
          const name = (c.payload?.toolName ?? c.toolName) as string | undefined
          if (c.type === 'tool-call' && name && approvalNames.includes(name)) {
            const args = (c.payload?.args ?? c.args ?? {}) as Record<string, unknown>
            const id = (c.payload?.toolCallId ?? c.toolCallId ?? crypto.randomUUID()) as string
            state.lastApproval = { toolName: name, toolCallId: id, artifact: args } // last-wins (caution b)
          }
          yield c
        }
      })()

      yield* mapMastraStream(tap, { surfaceTools })

      const result = await run.result
      if (result.status === 'failed') {
        settled = true
        yield errorChunk(result.error)
        return
      }
      const { lastApproval } = state
      if (result.status === 'suspended' && emitGateOnSuspend && lastApproval) {
        yield gateOpened({
          gateKind: 'approval',
          toolName: lastApproval.toolName,
          toolCallId: lastApproval.toolCallId,
          proposedArtifact: lastApproval.artifact,
        })
      }
      // completed (or suspended w/o an approval call) → return; RunObserver does transition(finish).
      settled = true
    } finally {
      // Abort ONLY if interrupted before settling (Stop via iterator.return). A clean
      // suspend/finish must NOT abort — that would cancel the parked suspended run.
      if (!settled) run.abort()
    }
  }

  return {
    async *run(input: RunAgentInput): AsyncIterable<BaseEvent> {
      const runId = (input?.runId as string) ?? crypto.randomUUID()
      const inputData = { messages: input?.messages ?? [] }
      yield* drive(runner.start(runId, inputData), true)
    },

    async *resume(handle: ResumeHandle, resolution: GateResolution): AsyncIterable<BaseEvent> {
      // The server already executed the effect; resolution carries decision + executedResult.
      // gateStep (server-side) reads these from resumeData (approved → confirm sentence;
      // rejected → bail). A resumed run must NOT re-open the gate → emitGateOnSuspend=false.
      yield* drive(runner.resume(handle.runId, resolution), false)
    },
  }
}
