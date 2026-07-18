# @hanfani/providers

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
