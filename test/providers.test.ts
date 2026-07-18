import { describe, it, expect } from 'vitest'
import { PROVIDERS, type ProviderId } from '../src/provider-ids.js'
import { createMockInboxProvider } from '../src/mock-provider.js'
import { createClaudeCliProvider, type ClaudeSpawn } from '../src/claude-cli-provider.js'

describe('PROVIDERS', () => {
  it('exposes the stable wire strings', () => {
    expect(PROVIDERS).toEqual({ claudeCli: 'claude-cli', mastra: 'mastra', mock: 'mock' })
  })

  it('narrows to the ProviderId union', () => {
    const id: ProviderId = PROVIDERS.claudeCli
    expect(id).toBe('claude-cli')
  })
})

describe('createMockInboxProvider', () => {
  it('builds a Provider exposing an async run()', () => {
    const p = createMockInboxProvider(['saveDraft'])
    expect(typeof p.run).toBe('function')
    // run() returns an async iterable, not a promise — it should not throw at construction.
    const it0 = p.run({ runId: 'r1', messages: [] } as never)[Symbol.asyncIterator]()
    expect(typeof it0.next).toBe('function')
  })
})

describe('createClaudeCliProvider', () => {
  it('builds a Provider from an injected spawn fn', () => {
    const spawn: ClaudeSpawn = () => ({
      lines: (async function* () {})(),
      kill: () => {},
    })
    const p = createClaudeCliProvider({
      approvalNames: ['saveDraft'],
      surfaceTools: ['renderLead'],
      allowedTools: ['mcp__inbox__saveDraft'],
      prompts: { buildFirst: () => 'go' },
      spawn,
    })
    expect(typeof p.run).toBe('function')
  })
})
