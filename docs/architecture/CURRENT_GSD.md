# Current GSD architecture and Noxscope extraction seams

Source audited: [`awjreynolds/gsd-wallet`](https://github.com/awjreynolds/gsd-wallet) at `3ec1b1ffd21c371cf769fe1c49e38f837a0f9255` on 18 August 2026.

## Conclusion

GSD is already split around a useful runtime boundary. Noxscope should first place a versioned, typed observer/adapter around GSD's Web Worker request/broadcast protocol and its existing GSD Connect WebSocket boundary. Diagnostic and state payloads should be translated into the canonical Noxscope model there, before extracting or replacing the UI.

This preserves the working extension lifecycle, SDK hosting, cache/replay logic, transaction queue, and diagnostics while preventing Noxscope's UI from importing GSD wallet internals. GSD remains a development wallet: it stores seed material unencrypted and auto-approves sensitive dApp operations, so it must not be presented as a consumer-security baseline.

## Runtime topology

```text
page dApp
  → injected window.midnight provider
  → content-script Chrome port
  → MV3 service-worker router
  → persistent offscreen document
  → Web Worker hosting Midnight SDK
```

- [`manifest.json`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/manifest.json) declares the MV3 service worker, offscreen permission, content script, `<all_urls>`, and WASM content-security policy.
- [`src/background/index.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/background/index.ts) creates the offscreen document, waits for its `READY` broadcast, auto-unlocks the active wallet, and initializes the SDK.
- [`src/offscreen/offscreen.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/offscreen.ts) hosts the Web Worker, relays worker messages, reconnects to the service worker with backoff, and emits a heartbeat.
- [`src/offscreen/worker.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/worker.ts) installs SDK instrumentation before SDK imports, owns wallet initialization/sync/transactions/diagnostics, serializes transaction work through `withTxQueue`, and dispatches all worker requests.

The persistent offscreen document is the continuity layer across service-worker suspension. Noxscope must observe the offscreen/worker lifecycle separately from the service-worker lifecycle rather than treating extension restart as wallet restart.

## Existing message seam

[`src/shared/messages.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/shared/messages.ts) defines request envelopes with an ID, type, and currently untyped payload. Requests include wallet start/stop/state, dApp API calls, transfer and DUST operations, diagnostics, cache export, socket control, and socket responses. Broadcasts include state updates, diagnostic events, readiness, socket events, and heartbeats.

[`src/background/offscreenClient.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/background/offscreenClient.ts) already supplies important transport semantics: UUID request IDs, a 120-second timeout, at most 100 pending requests, and explicit rejection when the port reconnects.

This protocol is the best in-process adapter seam, but Noxscope must:

1. version the envelope;
2. replace `payload: unknown` at the boundary with request/response schemas;
3. distinguish state snapshots from events;
4. retain the GSD payload only under a sanitised raw-detail field;
5. correlate dApp, balance, proof, submit, confirmation, and state-update phases under one operation.

## Wallet and SDK state

[`src/offscreen/walletManager.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/walletManager.ts) owns the active `WalletFacade`, network, shielded and DUST keys, unshielded keystore, transaction history storage, environment, checkpoint identity, RxJS subscription, and latest state.

Its serialised state already exposes:

- shielded, unshielded, and DUST addresses and balances;
- shielded, unshielded, and DUST progress independently;
- UTXOs;
- node, indexer, and prover connectivity;
- sync phase;
- BigInt values normalised to decimal strings.

Initialization subscribes before `facade.start`, emits an initial state immediately, and starts sync without blocking the request. Stop saves a checkpoint, unsubscribes, blocks new sockets, force-closes tracked sockets, and bounds `facade.stop()` with a three-second timeout. These transitions should become canonical lifecycle and sync events instead of UI-only state.

## Persistence and replay

[`src/shared/storage.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/shared/storage.ts) defines IndexedDB database `gsd-wallet` version 3 with `vault`, `permissions`, `txHistory`, `settings`, `sdkState`, and `networkEvents` stores. Wallet entries include seed bytes; this storage must remain outside Noxscope recording/export.

[`src/offscreen/sdkCheckpoint.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/sdkCheckpoint.ts) serialises shielded, unshielded, DUST, and transaction-history state. Checkpoints are scoped by environment/account/wallet hash and invalidated when the SDK facade version changes.

[`src/offscreen/cacheImporter.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/cacheImporter.ts), [`cachingSyncService.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/cachingSyncService.ts), and [`cachingDustSyncService.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/cachingDustSyncService.ts) implement NDJSON import, cache replay, and transition to live indexer WebSockets. Dedicated scan and replay workers isolate expensive offline processing.

Noxscope should observe cache source, replay range, transition to live sync, rate, stalls, and invalidation. It should not make GSD's cache structure part of the cross-wallet protocol.

## DApp boundary

[`src/content-script/inpage.js`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/content-script/inpage.js) registers a UUID-keyed provider under `window.midnight`, proxies 17 API methods, uses 30-second normal and five-minute proving/transaction timeouts, and normalises selected BigInt responses.

[`src/background/messageRouter.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/background/messageRouter.ts) validates origin/session state, enforces a 30-minute session lifetime, clears sessions on wallet/environment switch, and currently auto-approves sensitive methods. Noxscope can instrument this router, but approval and security semantics remain Adapter facts rather than canonical assumptions.

## Diagnostics and external automation

[`src/background/diagnosticLogger.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/background/diagnosticLogger.ts) maintains a 2,000-event ring buffer, persists it to `chrome.storage.local`, and restores it after service-worker restart. Worker diagnostics are broadcast to the service worker and forwarded to GSD Connect. SDK console interception happens before SDK imports.

Failed-transaction diagnostics in [`src/offscreen/connectedApiHandler.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/connectedApiHandler.ts) intentionally include raw transaction material. The canonical adapter must therefore sanitise before persistence, not trust this source logger.

GSD Connect is the existing out-of-process seam:

- [`src/offscreen/connectClient.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/connectClient.ts) connects over `ws:`/`wss:`, transports trace events and dApp requests, forwards state/diagnostic events, and maintains one active session.
- [`packages/gsd-socket/src/server.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/packages/gsd-socket/src/server.ts) listens on loopback by default and handles dApp responses, diagnostics, state, and termination.
- [`packages/gsd-socket/src/client.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/packages/gsd-socket/src/client.ts) mirrors connector calls and provides diagnostic/state subscriptions.

Noxscope should wrap, version, and test this protocol rather than expose it unchanged as the canonical protocol.

## Local development and tests

[`src/shared/environments.ts`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/shared/environments.ts) includes deployed environments and local `Undeployed` node/indexer/prover defaults (`9944`, `8088`, `6300`). [`compose.yml`](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/compose.yml) pins local node, indexer, and proof-server images and binds them to loopback.

Existing coverage is strongest around service-worker routing, diagnostics, port behavior, state locking, UI state, utilities, and GSD Connect integration. Important gaps include `walletManager`, cache/replay services, offline workers, and page/content-script bridging. Extraction tests must freeze observable behavior across those gaps before moving code.

## Licensing and provenance

- GSD root code is Apache-2.0, copyright Adam Reynolds.
- `packages/gsd-socket` is separately MIT licensed and needs its license preserved if code is copied.
- Midnight SDK packages are external Apache-2.0 dependencies rather than vendored code.
- Noxscope must record the exact GSD source commit for each copied component in `docs/PROVENANCE.md` and preserve file-level SPDX/copyright notices.

## Incremental extraction plan

1. Freeze GSD's current state snapshots, diagnostic events, and GSD Connect behavior with fixtures and characterization tests.
2. Introduce a versioned Noxscope protocol beside the current message types; do not move runtime code yet.
3. Implement a GSD Adapter in the worker/offscreen layer that maps existing state and diagnostics to canonical snapshots/events and applies central sanitisation.
4. Render a small Noxscope Overview and event stream using only that Adapter contract, first with a deterministic mock and then GSD.
5. Move reusable diagnostic UI behind wallet-agnostic view models one panel at a time while the old GSD UI remains runnable.
6. Keep cache/replay, SDK hosting, keys, transaction queue, and Chrome lifecycle inside the GSD Adapter until a second runtime proves a deeper shared abstraction.
7. Add the versioned WebSocket transport only after in-process contract behavior is stable; use it for external hosts and conformance tests.

## Unresolved validation facts

- Current cross-wallet connector method/version compatibility must be exercised, not inferred.
- The single-account assumptions in several GSD paths need explicit capability representation.
- Raw transaction material needs a settled recording policy before export.
- Localnet image compatibility must be rerun against the package family selected for Noxscope.
- Cache/replay optimization is valuable GSD telemetry, but is not a required capability for other Wallet Runtimes.

