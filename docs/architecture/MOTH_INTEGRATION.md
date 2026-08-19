# Moth integration boundary

Source audited: [`shieldedtech/moth-wallet`](https://github.com/shieldedtech/moth-wallet) at `e9a974eb6aa49e4db66c8910328f2f787dde541b` on 18 August 2026.

## Conclusion

The safest first Moth Adapter is a read-only polling client over the daemon's `moth-wallet-daemon/1` protocol. Use `version` to negotiate compatibility and `getState` to obtain runtime identity, network, coarse sync state, and balances. Represent omitted telemetry as unsupported capabilities and expose snapshot freshness because the daemon has no subscription protocol.

The browser extension's `window.midnight.moth` connector is a separate runtime and integration surface. It is useful for connector conformance and dApp-call observation, but its connection status is origin authorization plus unlock state—not daemon or sync health—and it must not be used as a substitute for the daemon Adapter.

## Daemon transport

[`packages/core/src/daemon/protocol.ts`](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/core/src/daemon/protocol.ts) defines a 4-byte big-endian length followed by UTF-8 JSON, with a 16 MiB maximum frame. Request and response frames correlate by string ID:

```ts
type RequestFrame = {
  id: string;
  type: "request";
  method: string;
  params?: unknown;
};

type ResponseFrame = {
  id: string;
  type: "response";
  result?: unknown;
  error?: { code: string; message: string };
};
```

The parser rejects malformed IDs/methods and responses containing both `result` and `error`. [`server.ts`](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/core/src/daemon/server.ts) always installs `version`; [`client.ts`](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/core/src/daemon/client.ts) performs the handshake and rejects a protocol mismatch.

```text
version → { protocol: "moth-wallet-daemon/1", daemon: <version> }
getState → DaemonGetStateResult
```

Other registered wallet methods are mutations (`clearSyncCache`, transaction submission/transfer, circuit/contract operations, DUST registration, and verifier-key insertion) and are outside the initial read-only Adapter.

## Address, lifecycle, and security

The canonical Unix socket path from [`packages/core/src/daemon/index.ts`](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/core/src/daemon/index.ts) is:

```text
~/.moth/sync/<networkId>/<walletName>.sock
```

The server supports Unix sockets and TCP. Unix parent directories are tightened to `0700`, sockets to `0600`, active/stale sockets are probed before replacement, and close destroys clients and unlinks the socket. Unix access relies on operating-system permissions.

TCP is plaintext and intended for loopback or a protected proxy. The CLI restricts bind hosts to loopback, requires active API keys, obtains a token from `MOTH_DAEMON_TOKEN`, and supports read/write scopes. Headless mutation service requires explicit auto-approval, a maximum-spend limit, and defaults to idle shutdown. A Noxscope TCP Adapter must use a read-only key and must not weaken these checks.

## `getState` contract

[`packages/core/src/daemon/wallet-rpc-types.ts`](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/core/src/daemon/wallet-rpc-types.ts) defines:

```ts
type DaemonGetStateResult = {
  ready: boolean;
  walletName?: string;
  networkId?: string;
  synced?: boolean;
  syncProgress?: {
    percentage: number;
    etaSeconds: number | null;
    shieldedSynced: boolean;
    unshieldedSynced: boolean;
    dustSynced: boolean;
    slowest: "shielded" | "unshielded" | "dust" | null;
  };
  balances?: {
    shielded: Record<string, string>;
    unshielded: Record<string, string>;
    dust: string;
  };
};
```

[`wallet-handlers.ts`](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/core/src/daemon/wallet-handlers.ts) returns `{ ready: false }` until balances and facade are available, serialises BigInt amounts to decimal strings, and marks `getState` with read scope.

Supported observations:

- wallet name and network ID;
- overall sync state and aggregate percentage/ETA;
- shielded, unshielded, and DUST completion flags;
- slowest sync domain;
- token-ID keyed shielded/unshielded balances and aggregate DUST balance.

Not exposed:

- addresses, public keys, accounts, or key material;
- node/indexer/prover endpoints, latency, request health, block heights, retries, or uptime;
- detailed DUST generation/registration/reference state;
- UTXOs/coins, token metadata, or pending state;
- transaction/activity history, hashes, pending transactions, or submission health;
- structured errors beyond RPC failure and `ready`/`synced` state.

These omissions are real capability gaps. Noxscope must not infer or fabricate them.

## Polling and diagnostics

The daemon is request/response only: there is no notification, keepalive, or subscription method. Internal wallet and confirmation-queue subscriptions are host implementation details, not external RPC. Noxscope should poll `getState` with a bounded timeout, preserve the last successful snapshot, and expose observed-at time, age, polling interval, consecutive failures, and connection state.

The daemon can emit process logs through an optional callback. Its JSONL audit log records write-operation decisions/outcomes and lifecycle/auth events, but does not record `getState`. Audit-log ingestion can be a later, separately permissioned capability; it should not be silently tailed by the base Adapter.

Map failures distinctly:

- socket missing/refused: unavailable;
- protocol mismatch: incompatible;
- `UNAUTHORIZED`: authentication or scope failure;
- timeout/closed: degraded/transient;
- `{ ready: false }`: runtime initializing or unavailable internally, not a transport failure.

## Extension connector

[`packages/extension/entrypoints/injected.ts`](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/extension/entrypoints/injected.ts) installs `window.midnight.moth`; calls travel through page/content/background/offscreen layers and never use the daemon socket. The extension advertises connector API 4.0.1 and exposes standard addresses, balances, transaction history/configuration, and operation methods.

[`connector-handlers.ts`](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/extension/lib/background/connector-handlers.ts) shows that `getConnectionStatus` means origin permission plus unlocked session. `getConfiguration` exposes configured services, but the connector does not expose daemon version/readiness, aggregate sync progress, or transport health.

Noxscope should implement connector discovery/conformance separately. If installed Moth builds use a stable `rdns` provider record rather than the source's friendly property, runtime discovery evidence must win over assumptions from source.

## Stability, tests, and license

Moth is experimental, unaudited, unsupported, below version 1.0, and some packages are restricted/private. Current source behavior is authoritative where draft architecture documents have drifted.

Daemon tests cover framing, version negotiation, malformed data, errors, timeouts, permissions, stale sockets, duplicate listeners, and fallback behavior in:

- `packages/core/tests/unit/daemon/protocol.test.ts`
- `packages/core/tests/unit/daemon/server-client.test.ts`

Most full daemon integration tests require a running devnet. Noxscope should vendor no Moth code initially; depend on the external wire contract and maintain captured fixtures plus compatibility tests.

The repository and package manifests use Apache License 2.0.

## Initial Adapter design

1. Discover the canonical Unix socket for a configured network/wallet, or accept an explicit Unix/TCP endpoint.
2. Use Moth's client semantics or an independently tested compatible codec to negotiate `version`.
3. Reject unknown protocol versions; record daemon and protocol versions in every Diagnostic Session.
4. Call only `getState` under read scope, poll with cancellation and bounded timeouts, and record freshness/degradation.
5. Map identity, network, three-domain sync, and balances into canonical snapshots.
6. Advertise all missing DUST, transaction, address, network, log, and subscription features as unsupported.
7. Keep connector integration in a separate Adapter instance so daemon and extension runtimes can be observed simultaneously without conflating their identities.

## Noxscope implementation

The read-only implementation lives in [`packages/adapter-moth`](../../packages/adapter-moth/src/index.ts). It accepts an injected transport for deterministic conformance tests and uses a Node length-prefixed socket transport for the canonical Unix endpoint or an explicitly loopback TCP endpoint. TCP requests carry a read-scoped authentication token only inside the native daemon request path; the token is never represented in a canonical descriptor, snapshot, Record, or HostBridge message. The Adapter negotiates `version` before its first `getState`, emits immutable canonical snapshots, polls with bounded failure handling, preserves the last successful snapshot when polling stalls, and maps authorization, timeout, unavailable, incompatible, and malformed responses to distinct Noxscope errors.

The adapter's S2 projection pseudonymises wallet names and token identifiers using the central Core sanitizer. Amounts remain canonical decimal observations so sync and balance comparisons remain meaningful; Recording export applies the full recording policy again. No daemon mutation, process log, audit log, or native payload is admitted.
