# Define wallet qualification and conformance matrix

Type: task
Status: resolved
Blocked by: 04

## Question

What executable common assertions, capability-specific suites, fixture rules, supported networks, version evidence, and admission gates will distinguish full runtime validation, connector compatibility, fixture-only coverage, and watch-list status for GSD, Moth, the official Wallet SDK, Lace, 1AM, Gero, and later Wallet Runtimes?

## Answer

Use two independent claims: deep Adapter conformance through the canonical interface and public DApp Connector compatibility against an installed build. Admit evidence-keyed targets as `full`, `connector`, `fixture`, `watch`, or `historical`, with quarantine orthogonal to prior state. All full Adapters pass A1–A6 covering connection/identity, Capability truthfulness, ordered Records, freshness, correlation/Operations, and redaction/limits plus every suite for declared Capabilities. Connector targets pass discovery/identity, negotiation/authorization, and bounded public-state/operation checks. Qualification is scoped to exact build/protocol/Adapter/suite/network evidence and uses localnet by default or disposable Preprod identities for harmless connector operations.

Decision: [Wallet qualification and conformance](../../../docs/architecture/WALLET_CONFORMANCE.md)
