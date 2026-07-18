import type { GateResolution } from '@hanfani/core'

// Shared Mastra runner/stream types. The concrete `MastraRunner` implementation lives in
// `mastraRunner.ts`; the provider adapter (`mastra-provider.ts`) and the chunk mapper
// (`mastra-stream.ts`) only depend on these structural shapes, so they live here to break the
// import cycle between runner and provider.

export interface MastraChunk {
  type: string
  payload?: {
    text?: string
    toolCallId?: string
    toolName?: string
    args?: unknown
    argsTextDelta?: string
    result?: unknown
    error?: unknown
  }
  text?: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  error?: unknown
}

export type MastraRunResult =
  | { status: 'suspended' }
  | { status: 'completed' }
  | { status: 'failed'; error: string }

export interface MastraRun {
  stream: AsyncIterable<MastraChunk>
  result: Promise<MastraRunResult>
  abort(): void
}

export interface MastraRunner {
  start(runId: string, inputData: Record<string, unknown>): MastraRun
  resume(runId: string, resolution: GateResolution): MastraRun
}
