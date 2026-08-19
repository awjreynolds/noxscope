# Noxscope

Noxscope is a local-first developer observability and interoperability
workbench for Midnight Wallet Runtimes. It observes runtimes through one
versioned, wallet-agnostic Adapter protocol; it is not a wallet and never
holds seeds, keys, credentials, or consumer funds.

The first release is designed for development, localnet, and dedicated
Midnight Preprod identities. Mainnet mutation tests and real user wallets are
out of scope. A fixture or source audit is not a compatibility claim.

## What is included

- `@noxscope/protocol`: canonical Runtime Session, capability, snapshot,
  record, operation, and error contracts.
- `@noxscope/core`: multi-runtime state, deny-by-default sanitisation, and
  bounded framed Recording v1 export/import/offline replay.
- `@noxscope/adapter-gsd`: read-only GSD worker/GSD Connect boundary Adapter.
- `@noxscope/adapter-moth`: read-only Moth daemon `version`/`getState` polling
  Adapter.
- `@noxscope/hostbridge`: authenticated, bounded loopback browser-to-Node
  canonical bridge.
- `@noxscope/adapter-mock`: deterministic local fixture scenarios.
- `@noxscope/conformance`: executable adapter and connector admission seams.
- `apps/web`: browser-first split-pane workbench with local Recording controls.

The Moth Node HostBridge entry point is a library, not a command-line daemon:
`@noxscope/hostbridge/node` exposes `createLoopbackHostBridge` for a host that
already owns the runtime. Noxscope does not invent a wallet startup command.

## Quickstart

Requirements: Node.js 24 or newer and pnpm 10.33 or newer. The browser app is
tested as a modern full-tab browser application; it requires Web Crypto,
`TextDecoder`, and IndexedDB for persistent Recording storage. A Node Host is
required for Moth Unix/TCP sockets and the Node HostBridge.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter @noxscope/web dev
```

Open the Vite URL shown by the dev server. The default development composition
uses deterministic mock data. `pnpm verify` is deterministic and local after
dependencies are installed: it checks metadata for seven publishable packages,
provenance, Recording fixtures, formatting, lint, types, tests, production
builds, and clean/importable package tarballs.

Useful individual commands:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

## Connecting audited runtimes

Noxscope consumes an existing runtime; it does not create wallet state.

### GSD worker / GSD Connect

Pass the already-created `MessagePort` (or Worker-like port) at the audited
GSD boundary. The Adapter owns framing, validation, correlation, bounded
queueing, and sanitisation:

```ts
import { createCore } from "@noxscope/core";
import { createGsdAdapter, createGsdMessagePortTransport } from "@noxscope/adapter-gsd";

const transport = createGsdMessagePortTransport(existingMessagePort);
const adapter = createGsdAdapter({ transport });
const core = createCore({ signal: AbortSignal.timeout(60_000) });
await core.connect(adapter);
```

`existingMessagePort` is supplied by the host integration. Do not pass wallet
keys, vaults, checkpoints, transaction payloads, or arbitrary logs to the
Adapter. See [`CURRENT_GSD.md`](docs/architecture/CURRENT_GSD.md) and
[`PROVENANCE.md`](docs/PROVENANCE.md).

### Moth daemon and Node HostBridge

Use the daemon's permission-protected Unix socket whenever possible. The
socket path is installation-specific; do not guess it in application code.
For loopback TCP, supply a read-only token from the process environment or a
secret manager at runtime—never put it in source, examples, recordings, or
logs:

```ts
import { createMothAdapter } from "@noxscope/adapter-moth";

const moth = createMothAdapter({
  endpoint: { kind: "unix", path: socketPathFromHostConfiguration },
});
```

The privileged Node host may then expose only canonical data to the browser:

```ts
import { createLoopbackHostBridge } from "@noxscope/hostbridge/node";

const bridge = createLoopbackHostBridge({
  allowedOrigins: ["http://localhost:5173"],
});
await bridge.listen();
// Attach a canonical Runtime Session through bridge.bridge.
```

The bridge generates a per-launch token when one is not supplied. A real host
must deliver that token through an application-controlled, local channel; do
not expose it in a URL or accept `*` origins. The current library does not
provide a CLI, filesystem recorder, wallet lifecycle control, or generic
proxy. See [`HOST_TOPOLOGY.md`](docs/architecture/HOST_TOPOLOGY.md) and
[`MOTH_INTEGRATION.md`](docs/architecture/MOTH_INTEGRATION.md).

## Recordings and safety boundary

Recording v1 is uncompressed, framed canonical JSON with bounded lengths,
per-frame and whole-content integrity digests, policy/Adapter provenance,
Recording-scoped pseudonyms, and immutable offline replay. Import treats every
byte as hostile: it validates framing and canonical schemas, re-sanitises
records, rejects incompatible or additive metadata, and never opens embedded
paths/URLs or invokes an Adapter/Operation.

The current ceilings include a 512 MiB file, one million records, 256 KiB per
canonical record, bounded raw detail, depth, strings, object properties, and
array elements. Compressed archives, unsafe captures, source files, keys,
mnemonics, credentials, witnesses, proofs, signatures, and raw transaction
payloads are not Recording inputs. Browser persistence uses detached IndexedDB
bytes; export/import remain local and explicit.

See [`REDACTION_AND_RECORDING.md`](docs/security/REDACTION_AND_RECORDING.md),
[`adr/0004`](docs/adr/0004-deny-by-default-recordings.md), and the
`@noxscope/core` package documentation.

## Compatibility and evidence

The table records the current evidence class, not a promise that every wallet
works. `fixture` means deterministic protocol fixtures only; `watch` means no
installable/callable surface has been qualified. Localnet and dedicated
Preprod validation must be recorded with exact build, network, Adapter, and
suite evidence before a target is promoted.

| Target                            | Surface                            | Current evidence                | Next validation                                     |
| --------------------------------- | ---------------------------------- | ------------------------------- | --------------------------------------------------- |
| Official Wallet SDK / local stack | SDK/runtime harness                | `watch` (planned reference)     | A1–A6 on localnet, then dedicated Preprod           |
| GSD Wallet                        | worker/GSD Connect                 | `fixture` + Adapter conformance | Run a pinned build on localnet                      |
| Moth Wallet                       | daemon `version`/`getState`        | `fixture` + Adapter conformance | Run a pinned daemon on localnet                     |
| Lace                              | public `window.midnight` connector | `watch`                         | Qualify an installed build on localnet              |
| 1AM                               | public connector                   | `watch`                         | Black-box discovery and harmless localnet flows     |
| Gero                              | public connector                   | `watch`                         | Hands-on installed-extension qualification          |
| Urble, Turnkey, mobile 1AM        | callable surface not frozen here   | `watch`                         | Reassess when an installable interface is available |
| Ctrl                              | historical                         | `historical`                    | No first-release validation                         |

The priority for additional wallet validation is official SDK/local stack and
Lace first, then 1AM and Gero. Announcements, Cardano-side compatibility, or
wallet branding do not establish a Midnight connector. See
[`WALLET_CONFORMANCE.md`](docs/architecture/WALLET_CONFORMANCE.md) and the
[wallet landscape research](docs/research/midnight-wallet-landscape.md).

## Architecture and contribution

- [Target architecture](docs/architecture/TARGET_NOXSCOPE.md)
- [Host topology](docs/architecture/HOST_TOPOLOGY.md)
- [Workbench UX](docs/architecture/WORKBENCH_UX.md)
- [GSD boundary](docs/architecture/CURRENT_GSD.md)
- [Moth boundary](docs/architecture/MOTH_INTEGRATION.md)
- [Conformance matrix](docs/architecture/WALLET_CONFORMANCE.md)
- [Source provenance](docs/PROVENANCE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Release acceptance checklist](docs/RELEASE_ACCEPTANCE.md)

## License

New Noxscope source is licensed under the Apache License 2.0. See
[`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and
[`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md). Upstream GSD and
Moth repositories are references; Noxscope does not include Moth source and
the GSD Adapter is an independent codec/projection.
