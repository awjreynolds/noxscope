# Integrate GSD through the canonical Adapter

Type: task
Status: resolved
Blocked by: 10, 11

## Question

Implement a versioned GSD Adapter at the characterised worker/GSD Connect seams, preserve current state and diagnostic fidelity, centralise sanitisation, add lifecycle/correlation/characterisation/conformance tests, and render GSD through the same workbench without direct wallet-internal UI dependencies.

## Answer

Implemented `@noxscope/adapter-gsd` as a versioned, read-only canonical Adapter around the audited worker/GSD Connect message boundary at source revision `3ec1b1ffd21c371cf769fe1c49e38f837a0f9255`. It negotiates a typed handshake, reports evidence-backed capabilities, maps state and diagnostics into canonical snapshots/events/operation lifecycles, and provides an injectable browser `MessagePort` transport without importing GSD UI components.

The checked-in immutable GSD manifest applies deny-by-default projection before queueing; vaults, checkpoints, keys, connected-operation inputs/results, raw failed transactions, and native logs cannot cross. Independent fix/review cycles hardened abort and handshake races, hostile accessors, terminal-operation deduplication, reconnect sequence resets, case-normalized correlation, fresh observation times, and sustained backpressure. Native continuity and adapter queue-loss evidence use distinct stream domains, with a globally bounded 32 exact ranges plus one honest non-contiguous summary. Golden fixtures cover healthy, stalled, failed, reconnecting, oversized, and secret-bearing sources. The integrated suite passes 103 tests and every build-quality gate.
