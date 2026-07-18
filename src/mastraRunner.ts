import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { PostgresStore } from '@mastra/pg'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { type GateResolution, type Message, type PromptStrategy } from '@hanfani/core'
import type { RunAgentInput } from '@ag-ui/client'
import type { MastraRunner, MastraRun, MastraChunk, MastraRunResult } from './mastra-types.js'

// A Mastra tool is opaque to the runner — the app builds the concrete map and injects it. Kept
// structural (the runner only hands these straight to `new Agent({ tools })`) so the package has
// no compile-time dependency on the app's tool definitions.
export type MastraToolLike = unknown

export interface MastraRunnerConfig {
  agentId: string
  instructions: string
  approvalNames: readonly string[] // [] for the qualifier
  readTools: readonly string[] // e.g. ['get_latest_email']
  renderAndProposeTools: readonly string[] // e.g. ['renderLead','saveDraft'] or ['renderVerdict']
  model: string // e.g. 'claude-sonnet-4-6'
  databaseUrl: string
  // The agent's prompt strategy — the SAME object claude-cli uses. The runner builds the
  // first-turn prompt from `buildFirst` so both providers share ONE prompt source (per workflow's
  // `prompts` module); there is no Mastra-specific prompt path.
  prompts: PromptStrategy
  // The concrete tool map, injected by the app (drops the old hard ./tools.js import). Keyed by
  // bare tool name; the runner picks the subset named by readTools + renderAndProposeTools.
  tools: Record<string, MastraToolLike>
}

// ONE Mastra storage shared across every agent. A PostgresStore per agent opened its own pool
// AND created Mastra's full composite schema (~20 tables) at boot — two of those exhausted
// Postgres connections ("too many clients", proc.c InitProcess) before any run started. A single
// bounded pool (max 8) + a single store, created once, fixes it; tables are created once.
let sharedStore: PostgresStore | undefined
function getSharedStore(databaseUrl: string): PostgresStore {
  if (!sharedStore) {
    sharedStore = new PostgresStore({
      id: 'mastra',
      connectionString: databaseUrl,
      max: 8,
      idleTimeoutMillis: 10_000,
    })
  }
  return sharedStore
}

// Mastra's ToolStream wraps every `writer.write(value)` in a workflow-step-output envelope before
// it surfaces on `run.stream`. The pure mapper/provider key on 'text-delta'/'tool-call', so we
// must unwrap here (in the Mastra-specific runner) rather than polluting the pure layer.
interface StepOutputChunk {
  type: string
  payload?: { output?: MastraChunk }
}

// Exported so the pure unit test can verify the two cases without any Mastra dependency.
export function unwrapStepOutput(raw: MastraChunk): MastraChunk {
  if (raw.type !== 'workflow-step-output') return raw
  const step = raw as unknown as StepOutputChunk
  return step.payload?.output ?? raw
}

// Structural views of the Mastra surface we touch. The workflow stream chunk shapes are not
// strongly typed for our purposes (the mapper reads them defensively), so we narrow to just the
// methods/fields the bridge uses instead of leaking Mastra's deep generics across the seam.
interface MastraStreamLike {
  // Iterating the WorkflowRunOutput directly is deprecated in Mastra — use `.fullStream`.
  fullStream: AsyncIterable<MastraChunk>
  result: Promise<{ status: string; error?: unknown }>
}
interface MastraRunLike {
  stream(args: { inputData: { prompt: string } }): MastraStreamLike
  resumeStream(args: { resumeData: unknown }): MastraStreamLike
  cancel(): Promise<void>
}

export function makeMastraRunner(cfg: MastraRunnerConfig): MastraRunner {
  // Fail fast on an unregistered tool name rather than building an Agent with an `undefined` tool
  // (which fails mysteriously only at run time). With more agents a typo here is easy to make.
  const tools = Object.fromEntries(
    [...cfg.readTools, ...cfg.renderAndProposeTools].map((n) => {
      const t = cfg.tools[n]
      if (!t)
        throw new Error(`Mastra has no tool "${n}" — add it to the tools map injected by the app`)
      return [n, t]
    })
  )

  const agent = new Agent({
    id: cfg.agentId,
    name: cfg.agentId,
    instructions: cfg.instructions,
    model: anthropic(cfg.model),
    tools,
  })

  const hasApproval = cfg.approvalNames.length > 0
  const workflowId = `wf-${cfg.agentId}`

  // agentStep: stream the agent, bubble chunks to the run stream via `writer`, and capture the
  // LAST approval-named tool-call (last-wins, caution b). Zero approval calls → { draft: null }.
  const agentStep = createStep({
    id: 'agent',
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({
      draft: z.record(z.unknown()).nullable(),
      toolCallId: z.string().nullable(),
    }),
    execute: async ({ inputData, writer }) => {
      const res = await agent.stream(inputData.prompt)
      let draft: Record<string, unknown> | null = null
      let toolCallId: string | null = null
      for await (const chunk of res.fullStream) {
        await writer.write(chunk)
        const c = chunk as MastraChunk
        const name = c.payload?.toolName ?? c.toolName
        if (hasApproval && name && cfg.approvalNames.includes(name)) {
          draft = (c.payload?.args ?? c.args ?? {}) as Record<string, unknown>
          toolCallId = c.payload?.toolCallId ?? c.toolCallId ?? null
        }
      }
      return { draft, toolCallId }
    },
  })

  // gateStep: suspend when there is a draft (caution b: no draft → completed, never suspends).
  const gateStep = createStep({
    id: 'gate',
    inputSchema: z.object({
      draft: z.record(z.unknown()).nullable(),
      toolCallId: z.string().nullable(),
    }),
    resumeSchema: z.object({
      decision: z.enum(['approved', 'rejected']),
      executedResult: z.record(z.unknown()).optional(),
    }),
    suspendSchema: z.object({
      toolCallId: z.string().nullable(),
      proposedArtifact: z.record(z.unknown()).nullable(),
    }),
    outputSchema: z.object({ done: z.boolean() }),
    execute: async ({ inputData, resumeData, suspend, bail, writer }) => {
      if (!inputData.draft) return { done: true }
      if (resumeData?.decision === 'rejected') {
        await writer.write({
          type: 'text-delta',
          payload: { text: 'The human rejected the proposal; nothing was applied.' },
        })
        return bail({ done: false })
      }
      if (resumeData?.decision === 'approved') {
        await writer.write({
          type: 'text-delta',
          payload: { text: 'The action was approved and applied.' },
        })
        return { done: true }
      }
      return await suspend({
        toolCallId: inputData.toolCallId,
        proposedArtifact: inputData.draft,
      })
    },
  })

  const workflow = createWorkflow({
    id: workflowId,
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
  })
    .then(agentStep)
    .then(gateStep)
  workflow.commit()

  const mastra = new Mastra({
    storage: getSharedStore(cfg.databaseUrl),
    workflows: { [workflowId]: workflow },
  })

  // Map Mastra's settled status → our MastraRunResult. Mastra statuses (workflow.d.ts):
  // 'success' | 'failed' | 'suspended' | 'tripwire' | 'paused' | 'running' | 'canceled' | … —
  // success/bailed → completed, suspended → suspended, everything else (failed/tripwire) → failed.
  function toResult(r: { status: string; error?: unknown }): MastraRunResult {
    if (r.status === 'suspended') return { status: 'suspended' }
    if (r.status === 'success' || r.status === 'bailed') return { status: 'completed' }
    if (r.status === 'failed' || r.status === 'tripwire')
      return { status: 'failed', error: String(r.error ?? 'mastra run failed') }
    return { status: 'completed' }
  }

  // Bridge createRun's async Run into the synchronous MastraRun the provider expects: a lazy
  // async-iterable that awaits the run then streams, plus a result promise resolved when the
  // stream settles, plus an abort that cancels the underlying run (caution a).
  function deferRun(
    makeStream: (run: MastraRunLike) => MastraStreamLike,
    getRun: () => Promise<MastraRunLike>
  ): MastraRun {
    // No-op until the run resolves: an abort() before iteration starts (unreachable today — the
    // observer only cancels a `running` item that has already emitted events) silently does
    // nothing rather than throwing.
    let cancelFn: () => void = () => {}
    let resolveResult!: (r: MastraRunResult) => void
    const result = new Promise<MastraRunResult>((res) => (resolveResult = res))
    const stream: AsyncIterable<MastraChunk> = {
      async *[Symbol.asyncIterator]() {
        const run = await getRun()
        cancelFn = () => void run.cancel()
        const s = makeStream(run)
        try {
          for await (const raw of s.fullStream) yield unwrapStepOutput(raw)
        } finally {
          // Relies on Mastra settling `result` after cancel() (verified by the cancel-mid-run
          // E2E). If a future version left it pending post-cancel, this await would hang teardown.
          const r = (await s.result) ?? { status: 'success' }
          resolveResult(toResult(r))
        }
      },
    }
    return { stream, result, abort: () => cancelFn() }
  }

  // `mastra.getWorkflow(workflowId)` is typed against the union of registered workflow ids; our
  // single dynamic key collapses its deep generics, so we view the run through MastraRunLike.
  function createRun(runId: string): Promise<MastraRunLike> {
    return mastra.getWorkflow(workflowId).createRun({ runId }) as unknown as Promise<MastraRunLike>
  }

  return {
    start(runId, inputData) {
      const messages = (inputData.messages ?? []) as Message[]
      // The provider hands us only the messages; reconstruct the minimal RunAgentInput the
      // PromptStrategy reads (it decodes the handoff payload from `messages`).
      const input = {
        messages,
        threadId: runId,
        runId,
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      } as RunAgentInput
      const prompt = cfg.prompts.buildFirst(input)
      return deferRun(
        (run) => run.stream({ inputData: { prompt } }),
        () => createRun(runId)
      )
    },
    resume(runId, resolution: GateResolution) {
      return deferRun(
        (run) =>
          run.resumeStream({
            resumeData: {
              decision: resolution.decision,
              executedResult: resolution.executedResult,
            },
          }),
        () => createRun(runId)
      )
    },
  }
}
