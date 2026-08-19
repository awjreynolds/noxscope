# `@noxscope/adapter-gsd`

Read-only canonical Adapter for the audited GSD worker/GSD Connect message
boundary. Supply an existing `MessagePort`/Worker-like port through
`createGsdMessagePortTransport`; Noxscope does not start or manage the wallet
runtime.

The Adapter uses the checked-in deny manifest and does not expose vaults,
keys, checkpoints, transaction payloads, or arbitrary native diagnostics.
Source and fixture evidence are documented in
[`PROVENANCE.md`](../../docs/PROVENANCE.md).
