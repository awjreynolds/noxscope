# Noxscope first compelling release

Label: wayfinder:map

## Destination

Deliver a runnable, tested, Apache-2.0 Noxscope release that can connect to GSD or Moth, discover the runtime and network, observe shielded/unshielded/DUST sync and state, correlate dApp and transaction operations, diagnose failures, and export/import centrally sanitised recordings. The same canonical protocol must support deterministic validation against the official Midnight Wallet SDK and connector-level qualification of Lace, 1AM, and Gero without wallet-specific branches in the UI.

## Notes

- Domain: local-first developer observability and interoperability for Midnight Wallet Runtimes.
- Use `wayfinder`, `grilling`, and `domain-modeling` when resolving design decisions; use `research` for facts outside this repository.
- Accepted defaults: planning recommendations may be adopted without pausing; stop only for a decision with materially different scope or risk.
- This effort explicitly carries execution through the map. Implementation proceeds as small runnable vertical slices after their prerequisite decisions resolve.
- Agent-produced code must be reviewed by a fresh sub-agent. Findings return to the implementing agent for fixes, and the fix is rechecked before integration.
- Validation uses localnet and Midnight Preprod with dedicated test identities/funds. Mainnet and real user wallets are excluded from this release.
- Preserve Apache-2.0 licensing, copyright, NOTICE, and source provenance for reused GSD or Moth material.
- Do not claim wallet compatibility without exercising a real public interface or an explicitly labelled fixture.

## Decisions so far

- [Map GSD architecture and extraction seams](./issues/01-map-gsd-architecture-and-extraction-seams.md) — Adapt at GSD's worker/GSD Connect boundaries first, preserving the working runtime and diagnostics while translating them into a versioned canonical protocol before UI extraction.
- [Map Moth supported integration surfaces](./issues/02-map-moth-supported-integration-surfaces.md) — Poll Moth daemon `version`/`getState` as a separate read-only runtime, expose its real capability gaps and freshness, and keep extension connector conformance distinct from daemon health.
- [Which additional Midnight wallets should Noxscope validate?](./issues/03-identify-additional-wallet-validation-targets.md) — Prioritise the official Wallet SDK and Lace, qualify 1AM and Gero, keep inaccessible or announced wallets in later/watch tiers, and treat Ctrl as historical only.
- [Define the canonical protocol and capability contract](./issues/04-define-canonical-protocol-and-capability-contract.md) — Use one versioned Runtime Session with typed core Capabilities, ordered Records, explicit support/availability/freshness, correlation, typed errors, and sanitised namespaced raw detail.
- [Choose the first-release host and runtime topology](./issues/05-choose-host-and-runtime-topology.md) — Keep Core/UI platform-neutral in a browser-first workbench, with privileged Moth access behind a loopback Node HostBridge that transports canonical records only.
- [Choose source provenance and migration strategy](./issues/08-choose-source-provenance-and-migration-strategy.md) — Selectively extract characterised GSD slices into the fresh monorepo with exact provenance, preserve MIT/Apache boundaries, and integrate Moth through public contracts rather than copied internals.

## Not yet specified

- Differential Scenario and Comparison Run execution after the first compelling release.

## Out of scope

- Consumer-wallet custody, portfolio, trading, or seed-management functionality: Noxscope observes Wallet Runtimes and is not a wallet.
- Hosted Noxscope accounts, central telemetry collection, or mandatory cloud services: the release is local-first.
- Mainnet mutation tests or testing with real user wallets: validation is limited to localnet and Preprod.
- Native mobile Noxscope applications: mobile wallets may be qualified through available interfaces, but Noxscope's first host is browser/full-tab based unless source audits prove that infeasible.
- Full multi-wallet Scenario execution and comparison reports: the protocol must preserve the path, but delivery belongs to a later destination.
