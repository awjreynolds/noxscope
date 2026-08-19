# `@noxscope/protocol`

The dependency-free, versioned canonical protocol shared by Noxscope Adapters,
Core, Hosts, and the browser workbench. It defines Runtime Sessions,
capabilities, snapshots, ordered records, typed errors, and validation.

This package contains types and validators only. It never opens a socket,
accesses a wallet, performs an operation, or sends telemetry.

See the [repository README](../../README.md) and
[`TARGET_NOXSCOPE.md`](../../docs/architecture/TARGET_NOXSCOPE.md).
