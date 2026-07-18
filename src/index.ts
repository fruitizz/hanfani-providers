// Public barrel for @hanfani/providers. The mock + claude-cli provider adapters and the
// provider-id registry. The Mastra-backed provider lives behind the `./mastra` subpath so the
// main entry stays free of the heavy `@mastra/*` peer deps.
export { createClaudeCliProvider, type ClaudeSpawn } from './claude-cli-provider.js'
export { createMockInboxProvider } from './mock-provider.js'
export { mapClaudeStream } from './claude-stream.js'
export { PROVIDERS, type ProviderId } from './provider-ids.js'
