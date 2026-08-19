# Build wallet conformance and connector validation

Type: task
Status: resolved
Blocked by: 07, 10, 11

## Question

Implement the executable conformance matrix for the official Wallet SDK/local stack, Lace, 1AM, and Gero qualification, including `window.midnight` discovery identity/version evidence, harmless localnet/Preprod flows, capability-specific assertions, fixtures, and honest admission/reporting rules.

## Answer

Implemented `@noxscope/conformance` as an executable two-layer qualification harness: canonical Runtime Adapter A1–A6 behavior and connector discovery/identity/capability admission. It snapshots hostile `window.midnight`-style registries without trusting global names or invoking accessors, bounds provider maps and asynchronous injection/removal observation, validates `rdns`/UUID/API-major evidence and collisions, and emits exact machine-readable reports scoped to target, build/source version, environment, evidence source, timestamp, support, availability, and exercised-versus-fixture status.

Compatibility admission is derived from concrete mandatory passed checks, never a caller-supplied evidence label. Deterministic fixtures cannot become live claims even when mutated or relabelled; the official SDK and Lace remain baseline fixture targets, 1AM and Gero remain non-live qualification targets, and Moth connector evidence remains separate from daemon health. Adapter checks cover records, capability honesty, reconnect, abort, staleness/polling, unsupported requests, sanitization, and bounded malformed Results. Connector operations use an exact reconstructed plan with trusted localnet/Preprod network evidence, test identity, spend and single-operation budgets, timeout/cancellation, and no arbitrary callback surface. Reports are sanitized and the fixture corpus is transitively immutable. Independent hostile review passes 17 focused, 151 full, and 45 targeted regression tests plus every gate.
