# Map Moth supported integration surfaces

Type: research
Status: resolved
Blocked by:

## Question

Which public and stable Moth process boundaries can a read-only Noxscope Adapter use today—daemon RPC, sockets, CLI JSON, browser/extension messaging, status APIs, logs, or telemetry—and what wallet identity, network, balance, sync, DUST, transaction, health, and event information does each expose without importing deep internals?

## Answer

Use Moth's `moth-wallet-daemon/1` length-prefixed JSON protocol as the initial read-only boundary: negotiate with `version`, poll the read-scoped `getState`, map identity/network/coarse three-domain sync/balances, retain freshness, and advertise omitted DUST, transaction, address, network-health, log, and subscription telemetry as unsupported. Treat the extension's `window.midnight.moth` connector as a separate conformance/dApp surface, not a daemon diagnostics API. Prefer the permission-protected Unix socket; TCP requires a read-only token and protected loopback/proxy deployment.

Research: [Moth integration boundary](../../../docs/architecture/MOTH_INTEGRATION.md)
