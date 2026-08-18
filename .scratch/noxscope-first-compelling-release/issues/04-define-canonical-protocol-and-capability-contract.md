# Define the canonical protocol and capability contract

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Which smallest canonical model, capability-negotiation contract, correlation semantics, raw-detail escape hatch, and compatibility/versioning rules can preserve GSD's useful diagnostics while truthfully representing Moth, the official Wallet SDK, and standard DApp Connector wallets without wallet-specific UI logic?

## Answer

Use a dependency-free `noxscope/adapter/1` protocol with a deep three-entry-point Module: Adapter connect, one ordered Runtime Session record stream, and one request channel for snapshots/Operations/cancellation. Keep a typed canonical core, explicit evidence-backed Capability Support versus changing Capability Availability, freshness-qualified snapshots, per-stream sequence and correlation, typed errors, and centrally sanitised namespaced raw detail. One Runtime Session observes one runtime; hosts may merge displays but never invent global causality. Defer fully schema-driven capability catalogs until real adapters require them.

Decision: [Target Noxscope architecture](../../../docs/architecture/TARGET_NOXSCOPE.md) and [Use one versioned Runtime Session and ordered Record protocol](../../../docs/adr/0001-canonical-adapter-protocol.md)
