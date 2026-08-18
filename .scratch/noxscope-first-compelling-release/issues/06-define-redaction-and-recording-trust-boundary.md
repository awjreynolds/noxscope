# Define the redaction and recording trust boundary

Type: research
Status: resolved
Blocked by: 01, 02, 04

## Question

Which data classifications, deny-by-default redaction rules, structural sanitisation points, secret-detection tests, raw-payload controls, and export invariants are required so Diagnostic Events and Recordings remain useful without persisting mnemonics, private/viewing keys, witness data, passphrases, or wallet-specific secret fields?

## Answer

Treat every native payload as untrusted. Project allowlisted canonical fields and sanitise before buffering or crossing the Adapter seam; repeat validation/sanitisation at recording, export, and import. Forbid secret authority and private execution material—including mnemonics, keys, credentials, witnesses, proofs, signatures, and serialized transactions—even in developer mode. Permit only manifest-declared, schema-validated, namespaced raw detail; apply bounded hostile parsing, structural/value detectors, resource ceilings, audit decisions, and property/fuzz/golden conformance tests. Recordings are local uncompressed framed JSON with integrity digests in v1; import never invokes Operations or performs network/filesystem actions.

Decision: [Redaction and recording trust boundary](../../../docs/security/REDACTION_AND_RECORDING.md) and [Deny secret and private execution material from Recordings](../../../docs/adr/0004-deny-by-default-recordings.md)
