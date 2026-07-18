// The library owns the list of provider identifiers. Userland descriptors write
// `provider: PROVIDERS.claudeCli` instead of inventing the string at the call site —
// autocomplete + a compile-time typo guard, with the list owned here.
//
// This is a typed string-literal const + union, NOT a TS `enum` (I7 config-as-data,
// see the spec §0 + the locked "status is a string-literal union, not an enum"
// decision): the RUNTIME value stays the wire string (`'claude-cli'`); only the TYPE
// narrows. The keys mirror the registry keys in apps/inbox/server/providers.ts.
export const PROVIDERS = {
  claudeCli: 'claude-cli',
  mastra: 'mastra',
  mock: 'mock',
} as const

// The union of valid wire strings, derived from the const so adding a provider in one
// place updates both. `defineAgent` deliberately does NOT consume this type
// (@hanfani/core stays provider-agnostic — I3/I5); it exists for userland + the server
// registry to reference.
export type ProviderId = (typeof PROVIDERS)[keyof typeof PROVIDERS]
