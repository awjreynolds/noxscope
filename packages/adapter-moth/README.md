# `@noxscope/adapter-moth`

Read-only canonical Adapter for the audited Moth daemon `version` and
`getState` contract. It polls the daemon and reports freshness, readiness,
three-domain sync, network, and balances where the daemon exposes them.

Use a Unix socket where possible. TCP is loopback-only and requires a
read-only daemon token supplied by the caller; never commit or print it. The
Adapter performs no wallet mutation, transaction submission, or audit-log
tailing. See [`MOTH_INTEGRATION.md`](../../docs/architecture/MOTH_INTEGRATION.md).
