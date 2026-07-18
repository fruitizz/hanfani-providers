// The Mastra-backed provider + runner, exposed behind the `./mastra` subpath so importing the
// main entry never pulls in the `@mastra/*` / `@ai-sdk/anthropic` peer deps.
export { createMastraProvider } from './mastra-provider.js'
export { mapMastraStream } from './mastra-stream.js'
export {
  makeMastraRunner,
  unwrapStepOutput,
  type MastraToolLike,
  type MastraRunnerConfig,
} from './mastraRunner.js'
export type { MastraChunk, MastraRun, MastraRunner, MastraRunResult } from './mastra-types.js'
