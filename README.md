# @hanfani/providers

[![build status][build-src]][build-href]
[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![size][size-src]][size-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

Provider adapters for the [Hanfani](https://github.com/fruitizz/hanfani-core) agent framework —
the layer that turns a model backend into a `Provider` the `@hanfani/server` pipeline can drive.

Each adapter honors the core two-phase contract: the agent proposes, a human (or a pre-declared
rule) approves, the server acts. A provider's `run()` emits AG-UI events and a `GATE_OPENED`
custom event when an approval-named tool fires; it never executes an effect itself.

## Install

```bash
pnpm add @hanfani/providers @hanfani/core
```

`@ai-sdk/anthropic`, `@mastra/core`, and `@mastra/pg` are optional peers — needed only if you use
the Mastra-backed provider via the `./mastra` subpath.

## Exports

| Entry | Contents |
|-------|----------|
| `.` | `createClaudeCliProvider`, `createMockInboxProvider`, `mapClaudeStream`, `PROVIDERS`, `ProviderId` |
| `./ids` | `PROVIDERS`, `ProviderId` — the provider-id registry, importable without the adapters |
| `./mastra` | `createMastraProvider`, `makeMastraRunner`, `mapMastraStream`, `unwrapStepOutput`, and the `Mastra*` types |

```ts
import { createClaudeCliProvider, PROVIDERS } from '@hanfani/providers'
import { createMastraProvider, makeMastraRunner } from '@hanfani/providers/mastra'
```

## License

[MIT](./LICENSE) License © [Fruitizz](https://github.com/fruitizz)

[build-src]: https://img.shields.io/github/actions/workflow/status/fruitizz/hanfani-providers/ci.yml?branch=main&style=flat&colorA=080f12&colorB=1fa669&label=build
[build-href]: https://github.com/fruitizz/hanfani-providers/actions/workflows/ci.yml
[npm-version-src]: https://img.shields.io/npm/v/@hanfani/providers?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@hanfani/providers
[npm-downloads-src]: https://img.shields.io/npm/dm/@hanfani/providers?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@hanfani/providers
[size-src]: https://img.shields.io/npm/unpacked-size/@hanfani/providers?style=flat&colorA=080f12&colorB=1fa669&label=size
[size-href]: https://www.npmjs.com/package/@hanfani/providers
[license-src]: https://img.shields.io/github/license/fruitizz/hanfani-providers.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/fruitizz/hanfani-providers/blob/main/LICENSE
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/@hanfani/providers
