# Map GSD architecture and extraction seams

Type: research
Status: resolved
Blocked by:

## Question

What are GSD Wallet's actual runtime contexts, state stores, diagnostic/event types, persistence paths, message boundaries, UI-to-wallet couplings, licensing/provenance constraints, and safest extraction seams for making its current full-tab diagnostics operate through a wallet-independent Noxscope Adapter without losing capability?

## Answer

GSD already has a useful seam at its offscreen Web Worker request/broadcast protocol and GSD Connect WebSocket. Introduce a versioned typed Noxscope observer/adapter there, translate snapshots and diagnostics before the UI, and leave SDK hosting, keys, cache/replay, transaction serialisation, and Chrome lifecycle inside the GSD Adapter until another runtime proves a shared abstraction. Characterisation tests must freeze current diagnostics before extraction, and central sanitisation must run before persistence because GSD diagnostics may contain raw transactions.

Research: [Current GSD architecture and Noxscope extraction seams](../../../docs/architecture/CURRENT_GSD.md)
