# Noxscope

Noxscope is a local-first developer observability and interoperability workbench for Midnight Wallet Runtimes. This foundation slice proves the canonical Adapter seam end to end without becoming a wallet or importing wallet-specific code.

## Workspace

- `packages/protocol`: dependency-free, versioned canonical types and runtime validation.
- `packages/core`: multi-session registry and immutable public view subscription.
- `packages/adapter-mock`: deterministic healthy, failure, DUST, and queue scenarios.
- `apps/web`: browser-first developer Overview driven exclusively by Core state.

## Development

Requires Node.js 24 and pnpm 10.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm lint
pnpm format:check
pnpm --filter @noxscope/web dev
```

The mock Adapter is intentionally the only runtime integration in this slice. Recording, sanitisation implementation, HostBridge, GSD, Moth, and standard DApp Connector Adapters are deferred until their dedicated tickets.

## License

New Noxscope source is licensed under Apache License 2.0. See `LICENSE` and `NOTICE`.
