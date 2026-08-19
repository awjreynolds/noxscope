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
- [Define the redaction and recording trust boundary](./issues/06-define-redaction-and-recording-trust-boundary.md) — Project allowlisted canonical fields and sanitise at every trust transition; forbid secret/private execution material even in developer mode, bound hostile imports, and use integrity-checked framed JSON Recordings.
- [Define wallet qualification and conformance matrix](./issues/07-define-wallet-qualification-and-conformance-matrix.md) — Separate deep Adapter conformance from connector compatibility, scope every claim to exact evidence, require capability-specific suites, and quarantine false/security-unsafe claims.
- [Build protocol, Core, and deterministic mock](./issues/10-build-protocol-core-and-deterministic-mock.md) — Established the reviewed dependency-free protocol, multi-session Core, deterministic Adapter scenarios, and runnable React/Vite Overview with validated ordering, lifecycle, and failure invariants.
- [Prototype the observability workbench](./issues/09-prototype-the-observability-workbench.md) — Use the dense split-pane inspector as the shell, the cross-runtime trace table as the temporal view, and the runtime console's evidence-rich failure treatment; preserve the reviewed three-variant prototype as a disposable branch artifact.
- [Build central sanitizer and portable Recordings](./issues/11-build-central-sanitizer-and-recordings.md) — Enforce one reviewed deny-by-default policy at every trust transition, encode bounded provenance- and integrity-bearing Recording v1 files, and keep browser persistence/export/import plus immutable offline replay entirely local and operation-free.
- [Integrate GSD through the canonical Adapter](./issues/12-integrate-gsd-through-the-canonical-adapter.md) — Observe the audited GSD worker/GSD Connect boundary through a versioned read-only Adapter, apply its deny manifest before bounded queueing, and keep native continuity separate from canonical backpressure evidence.
- [Integrate Moth and the Node HostBridge](./issues/13-integrate-moth-and-the-node-hostbridge.md) — Poll only the audited Moth daemon state contract and carry exact canonical records through an authenticated, replay-resistant, loopback-only, strictly bounded HostBridge with honest unsupported capabilities.
- [Build the first-release observability workbench](./issues/15-build-the-first-release-workbench.md) — Use one collision-safe canonical split-pane inspector for simultaneous live and offline runtimes, combining bounded temporal search, capability/freshness evidence, correlated operations, DUST and failure diagnostics, and local Recording controls.
- [Build wallet conformance and connector validation](./issues/14-build-wallet-conformance-and-connector-validation.md) — Qualify canonical Adapters and connector discovery separately through bounded executable evidence, exact harmless-operation safety plans, sanitized scoped reports, and admission rules that cannot turn fixtures into live compatibility claims.

## Not yet specified

- Differential Scenario and Comparison Run execution after the first compelling release.

## Out of scope

- Consumer-wallet custody, portfolio, trading, or seed-management functionality: Noxscope observes Wallet Runtimes and is not a wallet.
- Hosted Noxscope accounts, central telemetry collection, or mandatory cloud services: the release is local-first.
- Mainnet mutation tests or testing with real user wallets: validation is limited to localnet and Preprod.
- Native mobile Noxscope applications: mobile wallets may be qualified through available interfaces, but Noxscope's first host is browser/full-tab based unless source audits prove that infeasible.
- Full multi-wallet Scenario execution and comparison reports: the protocol must preserve the path, but delivery belongs to a later destination.
