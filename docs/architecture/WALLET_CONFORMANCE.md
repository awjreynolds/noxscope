# Wallet qualification and conformance

Status: executable admission policy for `noxscope/adapter/1`

## Decision

Noxscope makes two independent claims:

1. **Adapter conformance:** an Adapter truthfully implements the canonical Runtime Session interface for everything it declares.
2. **Connector compatibility:** an installed wallet correctly exposes and executes the public Midnight DApp Connector surface that Noxscope can observe from a page.

Passing connector compatibility does not imply access to internal sync, dependency, cache, proof, lifecycle, or diagnostic telemetry. Passing Adapter conformance does not require a broad feature set: the read-only Moth daemon Adapter can be fully conformant by exposing its small supported set and explicitly evidencing everything else as unsupported.

The canonical Adapter interface is the conformance seam. Common assertions run unchanged against every Adapter; wallet-specific transport assertions stay in qualification harnesses and Adapter fixtures. This prevents wallet names, connector brands, and transport details from entering Core or UI logic.

## Admission model

Each installable build, platform, surface, and native protocol version is a separate qualification target. A Moth daemon and Moth extension are different targets; 1AM extension, Android, and any iOS build are different targets.

| State | Meaning | Release claim |
| --- | --- | --- |
| **full** | A live, maintained runtime has a Noxscope Adapter that passes all core assertions, every suite for its declared capabilities, redaction conformance, and its target-specific gate. | “Supported Wallet Runtime Adapter,” limited to the evidenced versions/networks/capabilities. |
| **connector** | A live installed wallet passes the public connector suite. It may be observed through the generic Connector Adapter but has no qualified deep Adapter surface. | “Connector compatible,” never “fully observable.” |
| **fixture** | Deterministic, legally retainable canonical/native fixtures pass replay and translation tests, but no current live target is release-gated. | Regression coverage only. |
| **watch** | There is credible product or source evidence, but no current executable Midnight surface has passed an admission gate. | No compatibility claim. |
| **historical** | A formerly executable target is discontinued; retained fixtures are useful but no live dependency or current-support claim remains. | Historical regression coverage only. |

`quarantined` is an orthogonal release condition applied to a previously `full` or `connector` target. The registry retains its last admission state and evidence, but release/UI support claims are suppressed until requalification.

Admission is scoped by an evidence key:

```text
target + platform + distribution/build digest + native protocol/API version
+ Adapter version + canonical protocol major + network + conformance-suite digest
```

A pass for one evidence key cannot be projected onto another build, mobile platform, network, connector provider, or runtime surface.

## Executable core Adapter suite

Every candidate for `full` must pass all assertions below using only `NoxscopeAdapter.connect`, Runtime Session iteration, `RuntimeSession.request`, and the public descriptor. Tests may inject transport, clocks, and IDs inside the Adapter implementation, but those internal seams are not exposed to callers.

### A1 — connection, identity, and versions

- `A1.1` A successful connection returns protocol `noxscope/adapter/1`, non-empty `runtimeId` and `sessionId`, and exact Adapter ID/version.
- `A1.2` reconnect creates a new `sessionId`; `runtimeId` is preserved only when supported by evidence rather than wallet name or timing.
- `A1.3` runtime surface and every observable wallet, connector, daemon, SDK, ledger, node, indexer, and prover version are separate facts. Unknown versions are omitted, never guessed.
- `A1.4` simultaneous sessions retain distinct descriptors, streams, sequences, availability, and identities. The Host never merges them or invents a global causal order.
- `A1.5` incompatible native/canonical majors return `incompatible` or `protocol`, do not create a partially usable session, and do not emit unsanitised native errors.

### A2 — capability truthfulness

- `A2.1` each declaration has a governed or reverse-domain ID, kind, version when supported, and evidence from a declaration, handshake, successful probe, static wire contract, or explicit Adapter derivation.
- `A2.2` `unsupported`, `unavailable`, and absent are distinct. Missing state is never converted to an empty array, zero, healthy state, or `unsupported`.
- `A2.3` support is immutable for a Runtime Session. Temporary lock, readiness, authorization, connection, dependency, or configuration changes affect availability only.
- `A2.4` every supported capability passes its specific suite below. A declaration without a passing suite is a conformance failure.
- `A2.5` requesting an unsupported capability returns typed `unsupported`; requesting a temporarily unreachable supported capability returns typed `unavailable` with truthful retryability.

### A3 — ordered Record stream

- `A3.1` `sequence` is a strictly increasing unsigned decimal integer per `streamId`, with no duplicate or reordering under concurrency.
- `A3.2` every Record carries matching protocol/session/runtime/stream identity and valid observed/received timestamps. Ordering assertions use sequence, never clock time.
- `A3.3` source events are marked `runtime`; polling, inferred availability, reconnect, overflow, and other Adapter observations are marked `adapter`.
- `A3.4` bounded backpressure either preserves complete Records or emits a canonical stream-gap Record. Silent loss is a failure.
- `A3.5` source restart/reconnect behavior matches the target's identity rules. A GSD service-worker suspension is not automatically a wallet restart; transport loss cannot silently continue the old session.
- `A3.6` orderly close terminates iteration, stops polling/subscriptions, releases credentials/transports, and resolves pending requests with typed cancellation/unavailability rather than hanging.

### A4 — snapshots and freshness

- `A4.1` on-demand and streamed snapshots use monotonically changing revisions when observable content changes.
- `A4.2` freshness includes state, observed/received time, source, failure count, and polling interval/last success where applicable.
- `A4.3` a failed poll retains the last good value and `observedAt`, increments failure/age, and degrades availability; it does not emit an empty refreshed snapshot.
- `A4.4` `{ ready: false }`, locked, disconnected, syncing, stale, and unsupported are represented independently.
- `A4.5` optional sections appear only when supported and observed. Cross-domain sync or balances are not collapsed if the source exposes shielded, unshielded, and DUST independently.

### A5 — events, operations, and correlation

- `A5.1` each event has a stable namespaced name/category, severity, source, bounded attributes, and correlation only when observed.
- `A5.2` one logical Operation preserves one `operationId` across authorization, balance, proof, sign, submit, acknowledgement, confirmation, retry, and state changes that the Adapter can actually correlate.
- `A5.3` an Operation emits at most one terminal state. Failure appears once in the terminal update; `request` returns the same terminal meaning.
- `A5.4` parent, causation, request, and trace links are preserved when present and absent when not provable. Temporal proximity alone never creates causality.
- `A5.5` aborting a caller wait returns/throws the specified cancellation outcome but does not report wallet work cancelled. Only advertised cancellation plus a terminal `cancelled` update proves cancellation.
- `A5.6` retries and duplicate native responses cannot create duplicate submissions or duplicate canonical terminal outcomes.

### A6 — errors, limits, and redaction

- `A6.1` expected transport/domain failures map to the canonical error set with correct retryability; programmer failures are contained at the Host and close/quarantine the session.
- `A6.2` malformed, oversized, deeply nested, or unknown native input fails within the policy budgets and never echoes the offending value.
- `A6.3` all Records and raw detail pass the Adapter manifest and `REDACTION_AND_RECORDING.md` non-disclosure, idempotence, boundedness, fuzz, and golden tests before crossing the seam.
- `A6.4` raw detail is omitted unless its namespace/schema is manifest-allowlisted; it never supplies canonical meaning or capability evidence.
- `A6.5` transaction, witness, proof, signature, key material, seed, passphrase, credential, and source checkpoint canaries do not occur in serialized Records or errors.

## Capability-specific suites

Only declared supported capabilities run. An unsupported declaration is tested for evidence and correct rejection, not forced through a fictitious common denominator.

| Suite | Mandatory assertions when declared supported |
| --- | --- |
| **C-ID identity/network** | Stable and ephemeral identifiers stay distinct; requested/connected network is evidenced; network changes produce state/availability changes without merging identities. |
| **C-SYNC sync** | Cold start, progress, independently exposed domains, completion, stall, disconnect, retry, restore/rescan, and stale last-good behavior; no invented height/ETA. |
| **C-BAL balances** | Shielded/unshielded/DUST distinctions, decimal-string precision, token-ID mapping, empty versus unavailable, update ordering, and redacted Recording disposition. |
| **C-ADDR addresses** | Address class/network/account semantics where exposed, absence versus locked/unavailable, and persistence pseudonymisation. No key material crosses the seam. |
| **C-DUST DUST state** | Generation/designation/registration/reference phases only when native evidence exists; unsupported substate remains absent. |
| **C-DEP dependencies** | Node/indexer/prover role, configured versus reachable, latency/health freshness, degradation/recovery, endpoint sanitisation, and no credential/query leakage. |
| **C-DIAG diagnostics** | Native versus Adapter provenance, severity mapping, structured errors, overflow/gap behavior, free-form sanitisation, and restart persistence semantics. |
| **C-TX transactions/history** | Stable summary identity, pending/confirmed/failed transitions, retry/reorg behavior where observable, no raw transaction/witness/signature, and Recording-scoped pseudonyms. |
| **C-OP operations** | Input validation, authorization/rejection, phase order, correlation, one terminal result, timeout/retry/cancel race, harmless successful execution, and forbidden private output removal. |
| **C-PROOF proving** | Local/wallet/delegated role is observed rather than assumed; timing/outcome/size metadata, timeout/failure, privacy boundary, and complete exclusion of proof/key/witness bytes. |
| **C-CACHE cache/replay** | Source/range/rate/stall/invalidation/transition-to-live facts, expensive-work cancellation, and no source cache/checkpoint in Recordings. |
| **C-LIFE lifecycle** | Start/ready/lock/unlock/stop/restart/suspension as exposed; observation shutdown is not runtime shutdown without an explicit lifecycle capability. |

Capability versions have their own suite versions. Adding a new required assertion changes the suite digest and marks existing evidence stale until rerun; it does not silently revoke historical evidence.

## Public DApp Connector suite

This suite runs against an installed production build in an isolated browser profile and a controlled test dApp. It tests public compatibility, not wallet internals.

### D1 — discovery and identity

- Enumerate every own provider entry under `window.midnight`; do not assume a friendly property name or one provider.
- Validate each discovery key as a session-ephemeral UUIDv4 and record it separately from the provider's stable `rdns`, `name`, icon origin, and advertised `apiVersion`.
- Rediscovery/restart may change UUID but must not be treated as a new wallet brand solely for that reason. Duplicate/malformed providers are isolated and cannot suppress valid providers.
- Presence only under `window.cardano`, Cardano-side NIGHT holding/redemption, or a product announcement does not pass Midnight connector discovery.

### D2 — negotiation and authorization

- Connect to the requested supported test network and verify the connected network; wrong/unsupported networks fail explicitly rather than falling back.
- Capture allow, reject, locked, disconnect, reconnect, permission expiry/revocation, and extension background/offscreen restart behavior.
- Query configuration and record sanitized node/indexer/WebSocket/prover roles and separately observable versions. Never persist URI credentials, query strings, authorization payloads, or provider objects.
- API version/method support is observed from the installed provider. Product pages or another platform's version do not substitute.

### D3 — public state and operations

- Exercise every advertised read method for configuration, addresses, shielded/unshielded/DUST balances, and transaction history; classify unsupported versus temporarily unavailable.
- Execute one bounded, harmless Preprod flow through intent/construction, balancing, proving, signing, submission, acknowledgement, and confirmation where the connector advertises those methods.
- Exercise user rejection, invalid input, timeout, locked/disconnected wallet, prover failure where safely injectable, and caller cancellation. Do not infer that wallet work stopped.
- Record operation phases and sanitized metadata only; connector inputs/results containing transactions, witnesses, proofs, signatures, or key material must not cross the Adapter seam.

The generic Connector Adapter may declare only facts observable through this surface. Connection status means connector authorization/session state, not daemon readiness, sync health, node health, or prover health. Deep telemetry requires a separate live Adapter and the core suite.

## Deterministic fixtures and reproducibility

The conformance repository must provide:

- an in-memory Adapter with deterministic clock, IDs, sequences, snapshots, native and Adapter events, operations, cancellation races, reconnects, gaps, malformed input, and availability changes;
- versioned native fixtures for each Adapter mapping and canonical Recording fixtures for replay/import;
- scenario fixtures for happy path, each typed error, stale polling, partial capability sets, restart, concurrent operations, stream overflow, and multiple simultaneous runtimes;
- generated-at-test redaction canaries at every nested position/encoding. Public non-funded test seeds may initialize a local harness but never appear in committed Recordings or Adapter output;
- expected canonical Records normalized only for explicitly variable fields. Tests must not discard ordering, versions, capability evidence, redaction reports, or freshness to obtain stable snapshots.

Every fixture records source repository/commit or installed build digest, native protocol/API version, Adapter and canonical protocol versions, suite digest, sanitisation policy/manifest digests, network, and capture date. Fixtures containing third-party code or traces require provenance/license approval. A canonical Recording imported from a third party is hostile input, not qualification evidence by itself.

Qualification is reproducible only when a clean environment can run the same scenario twice with equivalent canonical meaning. Exact wall-clock durations may use bounded ranges; sequence, phase, support, terminal state, and redaction decisions must be exact.

## Network and execution safety

| Network | Permitted qualification work |
| --- | --- |
| **local `undeployed`** | Default for deterministic SDK/GSD mutation, fault injection, restart/recovery, destructive cache tests, and repeatable scenario fixtures. Pin package lock and node/indexer/prover image digests. |
| **Preprod** | Connector admission and one harmless end-to-end operation using a disposable, minimally funded test wallet and explicit human/CI opt-in. Record the exact connected network before mutation. |
| **Preview** | Read-only/configuration qualification unless a target cannot be validated on Preprod and a separately reviewed disposable-wallet scenario is approved. |
| **Mainnet** | Discovery, version/configuration, and other read-only checks only. Automated signing, proving, submission, DUST registration/designation, transfer, contract mutation, cache clearing, or approval is forbidden. |

Mutation harnesses enforce an operation allowlist, expected network genesis/ID, maximum fee/spend, destination allowlist, one-operation budget, timeout, and post-run reconciliation. A network mismatch aborts before construction/signing. Tests never weaken wallet approval, spend, authentication, read-only key, or auto-shutdown controls. Browser qualification uses an isolated profile with no personal accounts; daemon TCP uses loopback and least-privilege/read-only credentials except a separately admitted mutation scenario.

Secrets, deterministic wallet material, faucet credentials, and authorization tokens remain outside fixtures and Recordings. Transaction/proof/witness data follows the redaction policy even on localnet.

## Evidence captured for every run

The machine-readable qualification result and human summary must include:

- target name, surface, platform/OS/architecture, distribution source, store/package version, build/extension/binary digest, and source commit when available;
- transient connector UUID plus stable `rdns`, connector API version, native daemon/wire protocol, wallet/SDK/ledger/runtime versions;
- Adapter, Host, canonical protocol, capability-suite, harness, fixture-corpus, redaction-policy, and Adapter-manifest versions/digests;
- requested and connected network IDs, sanitized dependency roles/endpoints, node/indexer/prover versions, localnet image digests, and proving role when observed;
- every capability declaration and its evidence, availability transitions, assertion pass/fail/skip with reason, start/end time, retry count, stream gaps, redaction counts, and generated Recording digest;
- authorization mode and every safety control applied, without credentials or private material.

`skip` is never a pass. A mandatory assertion skipped because of registry access, unavailable infrastructure, user rejection, missing funds, or absent fault injection leaves the gate blocked. An unsupported capability produces a passing support-truthfulness assertion and no capability execution suite.

## Quarantine and requalification

Immediate quarantine triggers are:

- any secret/private-material, raw-detail, import, or resource-limit invariant failure;
- wrong-network mutation, unexpected spend/submission, bypassed approval/authentication, or use of non-loopback plaintext privileged transport;
- canonical protocol/sequence/correlation violation, duplicate terminal/submission behavior, or a false capability claim;
- installed/native major version outside the admitted Adapter manifest or connector compatibility range;
- a vendor/build identity mismatch or evidence that the tested artifact is not the distributed artifact.

Other mandatory assertion failures quarantine after reproduction in two clean runs against the same evidence key. Environment failures before connection mark the run `blocked`, not the target failed; a clean rerun is still required before release. Flakiness is reported and cannot be converted to pass by retries: the published result includes every attempt, and two successes with an intervening unexplained failure remain quarantined.

Quarantine disables automatic connection/operation by default, removes the target from the supported matrix, preserves last-known evidence, and emits a bounded explanation without wallet secrets. It must not silently downgrade `full` to `connector`; a separately valid connector evidence key may remain admitted.

Exit requires diagnosis, a reviewed Adapter/manifest/suite change where applicable, fresh artifacts, and a complete clean rerun of core, declared capability, redaction, target, and network-safety gates. Security or wrong-network quarantine additionally requires security-owner approval.

Scheduled requalification is required on wallet/extension/daemon/SDK/connector major or minor change, Adapter or policy change, canonical protocol/suite change, localnet package/image change, and at least once per release for live `full`/`connector` targets. Patch builds may reuse evidence only when the artifact digest and declared native interface are unchanged—which normally means they cannot.

## Exact target gates

### Official Midnight Wallet SDK/runtime

**Initial state:** `watch` while authenticated registry/package access and a pinned compatible package family are unavailable.

**Gate to `full`:** instantiate the runtime directly against pinned local `undeployed`; pass A1–A6 and every declared suite; reproduce official deterministic address/state vectors; cold sync shielded/unshielded/DUST; expose balances and dependencies; build, balance, prove, sign, submit, acknowledge, and confirm one local transaction/contract scenario; exercise user/validation/prover/indexer/node failure, cancellation, restart/checkpoint recovery, reorg or equivalent deterministic rollback, and replay; capture package/ledger/node/indexer/prover versions and image digests; prove redaction excludes seed, keys, checkpoint, transaction, proof, signature, and witness material. This is the behavioral baseline, not evidence for any consumer-wallet UX.

### GSD Wallet Runtime

**Initial target:** deep GSD Adapter over the worker/in-process or GSD Connect seam; standard connector behavior is a separate evidence key.

**Gate to `full`:** pass A1–A6 and all declared suites on pinned localnet; characterize initial snapshot-before-sync, three-domain progress/balances, dependency health, diagnostics, transaction queue, operation phases, cache/replay-to-live transition, stop timeout, and restart/reconnect; demonstrate that service-worker suspension differs from offscreen/worker/wallet restart; fault node/indexer/prover and overflow the diagnostic/transport buffers to verify degradation and stream gaps; run one bounded local operation through confirmation; pass GSD-specific redaction fixtures for vault/seed, checkpoint, raw failed transaction, console/error, witness/proof/signature, and Connect payloads. The manifest is scoped to the audited source/build commit.

### Moth daemon

**Initial target:** read-only daemon Adapter in the Node Host. The Moth extension connector is separate.

**Gate to `full`:** pass A1–A6, C-ID, C-SYNC, and C-BAL over the canonical Unix socket and, if shipped, loopback TCP with a read-only key; negotiate exactly `moth-wallet-daemon/1`; test `{ready:false}`, ready/synced transitions, shielded/unshielded/DUST progress and balances, polling freshness, consecutive timeout/closed/refused failures, recovery, missing/stale socket, malformed/oversized frame, protocol mismatch, and unauthorized/scope failure; explicitly evidence addresses, detailed DUST, dependencies, events, history, and mutations as unsupported; call no mutation method and ingest no process/audit log. Wallet name/token IDs/balances receive the S2 Recording treatment.

### Lace browser extension

**Initial state:** candidate for `connector`, not `full`.

**Gate to `connector`:** install the exact production build in an isolated profile; pass D1–D3 on Preprod, capturing current UUID, stable `rdns`, API version, extension/build digest, requested/connected network, sanitized configuration, and observable versions; verify authorization allow/reject/revoke, lock/unlock, MV3/background restart and reconnect, configuration, addresses, three balance classes, advertised transaction history, and one bounded Preprod transfer or contract flow through proof/submission/confirmation plus safe failure/cancel paths. Qualify local `undeployed`, Preview, or Mainnet read-only separately only when the installed build advertises and demonstrates them. Promotion to `full` requires a distinct deep telemetry Adapter and A1–A6; source availability alone is insufficient.

### 1AM browser extension

**Initial state:** candidate for `connector`; Android and any iOS build remain separate targets.

**Gate to `connector`:** the Lace connector gate against the exact production extension build on Preprod, plus evidence for whether proving is in-browser, delegated to Proof Station, or selected dynamically for the observed operation; exercise the safely injectable failure/timeout path for every observed proving role and verify configuration/network traces reveal no credentials/private material. Product claims or Android network support do not qualify the extension. No `full` admission occurs without a separately callable deep observability surface and Adapter.

### Gero Wallet

**Initial state:** `watch`.

**Gate to `connector`:** install the current production store build, not only the development source; discover a valid `window.midnight` provider whose stable `rdns` identifies Gero; capture UUID/API/build evidence; connect specifically to Preprod; obtain sanitized configuration, address, and balance results; and complete one bounded signed/submitted/confirmed Preprod operation plus D1–D3 error/restart paths. If the provider is absent, only CIP-30 exists, API/network cannot be verified, or the flow fails twice cleanly, remain `watch` rather than claiming compatibility. Once admitted, later regression uses normal quarantine rules. `full` additionally requires a distinct deep Adapter covering any Nexus/Gero Sync dependencies and A1–A6.

### Later, mobile, and discontinued targets

- **Urble:** `watch` until a publicly obtainable Midnight-enabled build and executable automation/deep-link/interface exist; then create a platform-specific gate before running state or mutation checks.
- **Turnkey embedded wallet:** `watch` until a product-maintained Midnight SDK/sample exposes native state and transaction flow; a future embedded/TEE Adapter must independently qualify policy/remote-signing semantics.
- **Begin, VESPR, SubWallet, and Tokeo:** `watch` until an installed product-maintained build passes D1 discovery or exposes another callable native runtime. Announcements and catalog entries do not pass.
- **NuFi, Keystone, Blockchain.com, and Yoroi:** Cardano-side NIGHT/redemption or hardware asset support is not a native Midnight Runtime admission. Keep outside the native matrix unless a new executable surface appears.
- **1AM Android/iOS and other mobile builds:** each remains `watch` until current installability, native Midnight account/network behavior, and a safe automation surface are demonstrated; extension evidence is not reusable.
- **Ctrl Wallet:** `historical`; retain only legally obtained, provenance-recorded fixtures/Recordings. Do not require or advertise a live dependency.

## Initial release matrix

| Target | Intended admission | First network | Deep Adapter claim | Blocking evidence |
| --- | --- | --- | --- | --- |
| In-memory deterministic Adapter | fixture | none | canonical oracle only | Implement complete A1–A6 scenarios. |
| Official Wallet SDK | full, conditional | local `undeployed` | yes | Registry access, pinned package family, full deterministic gate. |
| GSD | full | local `undeployed` | yes | Adapter implementation, characterization/fault/redaction gate. |
| Moth daemon | full, read-only | local daemon/devnet | yes, limited capabilities | Polling/error/unsupported/redaction gate. |
| Lace extension | connector | Preprod | no | Current installed-build D1–D3 evidence. |
| 1AM extension | connector | Preprod | no | Current installed-build D1–D3 and proving-role evidence. |
| Gero production extension | watch -> connector | Preprod | no | Production `window.midnight` discovery and complete transaction gate. |
| Ctrl | historical | archived testnet fixtures | no | Provenance/legal retention only. |
| Other named wallets | watch | none | no | Product-maintained executable native surface. |

## Result interpretation

- A broad wallet that fails one declared capability suite is not conformant; deleting the declaration solely to obtain green status is allowed only if evidence shows the capability truly is not exposed.
- A narrow Adapter is not penalized for truthful unsupported declarations.
- Connector and deep Adapter results appear in separate columns and evidence records.
- Fixture success prevents translation regressions but never renews live compatibility evidence.
- Cross-wallet comparison runs use only the intersection of supported, available, same-version canonical capabilities and report all exclusions. They compare observable outcomes, not identical internal phase sequences or performance.
- The matrix is evidence, not marketing inheritance: no result is inferred from wallet family, source branch, mobile sibling, connector major, or ecosystem announcement.
