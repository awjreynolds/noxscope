# Integrate Moth and the Node HostBridge

Type: task
Status: resolved
Blocked by: 10, 11

## Question

Implement the read-only Moth daemon Adapter, Unix and authenticated loopback TCP clients, polling/freshness/error mapping, version/getState fixtures, Node Host, versioned loopback HostBridge, and browser remote-session Adapter while reporting all unexposed telemetry as unsupported.

## Answer

Implemented `@noxscope/adapter-moth` over the audited Moth daemon `version`/`getState` length-prefixed JSON contract at revision `e9a974eb6aa49e4db66c8910328f2f787dde541b`. The Adapter is read-only, enforces its own connect/request/partial-frame deadlines even for injected transports, maps readiness/network/sync/balance observations into canonical records, applies its immutable deny manifest before queueing, reports freshness and failures, and explicitly marks unexposed diagnostics and operations unsupported.

Implemented `@noxscope/hostbridge` as a loopback-only, versioned canonical-record bridge with exact origin admission, per-launch token plus replay-resistant client identity, constant-time authentication, bounded connection/request/message/fragment/queue budgets, fatal UTF-8 and duplicate-key rejection, strict recursive canonical envelopes, deterministic per-stream gap evidence, cancellation, and atomic shutdown. The Node WebSocket parser supports bounded fragmentation and partial TCP reads without slowloris retention; the remote browser Adapter exposes no file, shell, process, generic proxy, or wallet-mutation surface. Independent hostile reviews covered session identity, injected transports, blackholes, split frames, replay/shutdown races, schema additives, delimiter collisions, raw redaction metadata, and Unicode confusables. The branch passes 96 tests and all gates.
