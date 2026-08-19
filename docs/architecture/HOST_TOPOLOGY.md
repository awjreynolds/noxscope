# First-release host and runtime topology

## Decision

Ship a browser-first full-tab workbench over a pure canonical core. Browser-accessible Wallet Runtimes connect directly through Adapters; Moth and other privileged Node runtimes connect through a loopback Node Host that streams canonical records over a versioned HostBridge WebSocket.

```text
Full-tab UI
  → Core session registry / ordered records
      → GSD Connect Adapter
      → window.midnight Connector Adapter
      → HostBridge remote-session Adapter
      → IndexedDB Recorder

Node Host / future desktop sidecar / CLI
  → Core session registry
      → Moth daemon Adapter (Unix or loopback TCP)
      → optional GSD Connect Adapter
      → HostBridge WebSocket server
      → NDJSON/filesystem Recorder
```

The UI and Core import no `chrome.*`, Node networking, socket, wallet SDK, or wallet-specific types. A Host may aggregate many Runtime Sessions but never merge their identities or invent cross-runtime causal order.

## Host responsibilities

The browser Host owns runtime discovery, the Core session registry, UI state, browser-accessible Adapters, HostBridge clients, and optional IndexedDB recording.

The Node Host owns Unix/TCP sockets, Moth connections, optional GSD Connect connections, filesystem recording, CLI bootstrap, and a loopback-only HostBridge server. It does not own Wallet Runtime lifecycle by default: ending observation closes transports, not the wallet or daemon, unless an explicit lifecycle Capability exists.

## Runtime lifecycle

1. `connect()` discovers the runtime, handshakes, records versions, negotiates Capabilities, and creates a new Runtime Session.
2. The Adapter emits session-open state and begins native subscription or polling.
3. Temporary loss changes Capability Availability; it never changes Capability Support.
4. Reconnection creates a new `sessionId` while preserving an evidenced runtime identity where possible.
5. Shutdown aborts observation and pending waits, performs best-effort cancellation only where supported, closes transport, emits session-closed state, flushes the Recorder, and releases credentials.

Moth `{ ready: false }` is a valid runtime snapshot. A GSD offscreen/worker lifecycle event is not automatically a new wallet identity. Cancelling a caller wait does not prove wallet work stopped.

## Simultaneous runtimes

The browser Host may observe GSD, one or more Moth daemon wallets through HostBridge, every discovered `window.midnight` provider, the official Wallet SDK harness, and deterministic mock Adapters simultaneously. Each has its own `runtimeId`, `sessionId`, stream sequence, Capability set, and freshness.

Connector discovery UUIDs identify a provider instance for the Diagnostic Session. Stable `rdns` identifiers remain separate identity evidence. Time-sorted UI views preserve the original per-stream sequence.

## Transport ownership

| Runtime | First-release transport | Owner |
| --- | --- | --- |
| GSD extension | Existing GSD Connect WebSocket | GSD Adapter |
| GSD co-located development runtime | In-process worker bridge | GSD Adapter |
| Moth daemon | Unix socket; loopback TCP with read-only key | Moth Adapter in Node Host |
| Moth observed by browser | Canonical records over HostBridge WebSocket | Node Host + remote-session Adapter |
| Standard wallet extension | `window.midnight` discovery/calls | Connector Adapter |
| Browser ↔ Node | Versioned loopback HostBridge WebSocket | Host modules |

Native framing and authentication remain inside Adapters. HostBridge transports only canonical descriptors, Results, and Records. It is implemented after in-process Adapter conformance is passing.

The implementation is split between the platform-neutral [`packages/hostbridge`](../../packages/hostbridge/src/index.ts) protocol module and its Node-only [`./node` entry point](../../packages/hostbridge/src/node.ts). The Node entry point binds only to loopback, checks the exact browser `Origin`, performs the WebSocket upgrade, and hands text frames to the HostBridge admission server. The HostBridge launch token is per server instance, and its handshake is the only place a token is accepted. Every later message is bounded, deny-manifest checked, and validated as a canonical descriptor, Record, or typed request/Result; generic proxy, file, shell, and process messages are rejected. A bounded outbound buffer drops records only with an explicit stream-gap message so a reconnecting browser can distinguish loss from an empty stream.

## Recording

Recording happens after Adapter sanitisation and record ordering:

- browser: IndexedDB-backed Recorder with portable export/import;
- Node/CLI: streamed NDJSON/filesystem Recorder;
- browser plus HostBridge: browser Recorder is authoritative by default to avoid duplicates;
- Node recording is opt-in;
- Moth audit logs require a separate explicit Capability and are never tailed implicitly.

The Recorder interface belongs to Core. Storage implementations belong to Hosts.

## Trust zones

1. **Wallet Runtime** — keys, SDK state, worker memory, daemon sockets, connector permissions.
2. **Adapter/Host** — credentials, protocol decoding, reconnection, correlation recovery, validation, and sanitisation.
3. **Core/UI** — canonical records only; no wallet SDK, browser-extension API, socket, or credential dependency.
4. **Recording** — versioned JSON-safe canonical records and sanitised raw detail only.

Moth tokens remain in Node memory. GSD raw diagnostics are sanitised before crossing the Adapter seam. Connector page/provider data is untrusted input.

## Modules that have earned existence

- `protocol`: dependency-free canonical types and invariants.
- `core`: session registry, record ordering, freshness, reconnect state, Capability Availability, correlation, aggregation, and Recorder interface.
- `adapter-mock`: deterministic states and failure scenarios.
- `adapter-gsd`: worker/GSD Connect lifecycle and translation.
- `adapter-moth`: Moth handshake, transport, polling, and translation.
- `adapter-connector`: standard `window.midnight` discovery and calls.
- `host-browser`: browser platform services, HostBridge client, IndexedDB Recorder, and full-tab bootstrap.
- `host-node`: privileged networking, HostBridge server, filesystem Recorder, and CLI/desktop bootstrap.
- `ui`: pure view models and rendering over Core records.

Do not create public transport, events, wallet-state, or recording-format packages yet. Codecs, clocks, IDs, retries, and storage drivers remain internal seams until multiple implementations need the same external interface.

## Local development

The runnable development composition includes the deterministic mock, GSD Connect, a local Moth daemon/devnet, a mock dApp/provider page, and the optional Node HostBridge. Conformance fixtures freeze Moth `version`/`getState`, GSD state/diagnostic/reconnect behavior, connector discovery, stream gaps, malformed payloads, cancellation races, and sanitisation.
