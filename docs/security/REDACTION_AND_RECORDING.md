# Redaction and recording trust boundary

Status: implementation policy for `noxscope/adapter/1`

## Decision

Noxscope treats every Wallet Runtime payload as untrusted, potentially secret-bearing input. An Adapter must reduce native input to an allowlisted canonical Record and sanitise any raw detail **before** either crosses the Adapter seam. The recorder repeats validation and sanitisation rather than trusting the Adapter, and import repeats it again rather than trusting a Noxscope file or its integrity digest.

The safe object is the output of a named, versioned policy, not an object carrying a `sanitized` flag. No mnemonic, seed, entropy, private or viewing key, passphrase, credential, witness, proof, signature, or serialized transaction is permitted in a Diagnostic Event or Recording. There is no ordinary configuration or developer override for this invariant.

This is deliberately stricter than source telemetry. GSD stores seed bytes in its vault and its failed-transaction diagnostic path can include raw transaction material ([GSD storage](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/shared/storage.ts), [connected API handler](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/offscreen/connectedApiHandler.ts)). By contrast, the initial Moth daemon Adapter needs only the deliberately small `getState` result containing readiness, runtime labels, network, coarse sync, and balances ([Moth RPC types](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/core/src/daemon/wallet-rpc-types.ts), [read-scoped handler](https://github.com/shieldedtech/moth-wallet/blob/e9a974eb6aa49e4db66c8910328f2f787dde541b/packages/core/src/daemon/wallet-handlers.ts)). Noxscope must not broaden either source merely to make recordings look uniform.

The policy follows OWASP's rules to treat data from other trust zones as untrusted, exclude credentials and encryption keys, sanitise event data, restrict access, and protect logs in transit and at rest ([OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)). It also follows OpenTelemetry's data-minimisation warning that telemetry systems cannot decide application-specific sensitivity automatically ([OpenTelemetry sensitive-data guidance](https://opentelemetry.io/docs/security/handling-sensitive-data/)). Detectors below are therefore backstops, not permission to collect first and scrub later.

## Trust zones and mandatory ordering

```text
Z0 Wallet Runtime / native logger (secret-bearing, untrusted)
  -> Z1 Adapter capture buffer (ephemeral native value)
  -> schema projection -> policy sanitiser -> canonical validation
  -> Z2 Adapter seam (canonical Record + optional SanitizedRawDetail)
  -> independent recorder sanitiser -> bounded encoder
  -> Z3 local Recording store
  -> export sanitiser + integrity manifest
  -> Z4 portable Recording (untrusted when read elsewhere)
  -> bounded parser -> schema validation -> import sanitiser
  -> Z5 replay/analysis/UI
```

The required processing order at every sanitisation point is:

1. Apply byte, record-count, nesting, collection, and time budgets before allocation or recursive descent.
2. Parse only JSON primitives, arrays, and objects; never revive classes, evaluate tags, resolve references, or invoke getters. OWASP recommends safe interchange formats and warns that unsafe deserialisation can lead to denial of service or code execution ([OWASP Deserialization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html)).
3. Reject duplicate object keys, invalid UTF-8, unpaired surrogates, non-finite numbers, and the keys `__proto__`, `prototype`, and `constructor`.
4. Normalize keys to Unicode NFKC and case-fold for matching while retaining the original spelling only if the field is allowed.
5. Project known native fields into the canonical schema. Unknown canonical fields are dropped; an unknown object is never copied wholesale.
6. Apply unconditional forbidden-key and forbidden-path rules.
7. Apply field-specific transforms: URL decomposition, header allowlisting, pseudonymisation, truncation, aggregation, or removal.
8. Run value detectors recursively over allowed strings and byte-like encodings. A detector match removes the complete field or raw-detail item; it does not partially mask cryptographic material.
9. Serialize the candidate, scan it again, then validate its canonical or declared raw-detail schema and all resource limits.
10. Attach a redaction report containing policy identity and decisions but no removed values, then cross the seam or persist.

Sanitisation must happen synchronously before an untrusted value is queued, logged, broadcast, placed in a ring buffer, sent over WebSocket, or written to storage. A later display-time scrub is insufficient. The recorder and exporter repeat the process as defence in depth and must fail closed if their policy is older than the Adapter manifest's required policy.

## Data classification and disposition

| Class | Examples | May cross Adapter seam? | May enter Recording/export? | Required disposition |
| --- | --- | --- | --- | --- |
| **S0 secret authority** | mnemonic/seed/entropy; spending, private, viewing, DUST or unshielded keys; passphrase/PIN/password; API/auth/session token; cookie; key material/provider; private TLS key | No | No | Remove the containing field; reject a record whose required canonical field contains it. Never hash or fingerprint. |
| **S1 private execution material** | witness/redeemer; ZK proof or proving key; signature; sealed/unsealed/signed transaction; serialized transaction/CBOR; contract private state/input; raw UTXO/coin object; SDK checkpoint or vault entry | No, except an allowlisted non-reversible derived fact | No | Replace with derived metadata such as byte count, phase, duration, outcome, or item count. Full values are forbidden. |
| **S2 sensitive identifier/state** | wallet/account name; address; transaction hash; exact balance; token identifier; dApp origin; internal endpoint/host; file path | Only in a typed canonical field whose capability requires it | Pseudonymised, reduced, or omitted by default | Session-scoped pseudonym, origin-only URL, path basename, endpoint role, balance bucket/delta, or explicit safe field rule. |
| **S3 operational diagnostic** | lifecycle/sync phase; percentage; duration; retry count; queue depth; dependency role/status; error code; transaction/proof size; network ID; adapter/runtime versions | Yes when schema-valid | Yes | Record from an allowlist, with bounded strings and collections. Free-form messages receive all detectors. |
| **S4 public product metadata** | Adapter ID/version, canonical capability ID, protocol version, stable public provider `rdns` | Yes | Yes | Record as typed, bounded fields. |

Classification is by meaning, not representation. Hex, Base64, arrays of numbers, nested objects, error strings, stack traces, URL query parameters, and filenames can all contain S0 or S1 data. Encryption or Base64 encoding does not lower a class. Public-chain identifiers remain S2 because a portable trace can link developer activity, accounts, dApps, and timing.

The live canonical snapshot may expose an S2 field required by an explicitly declared capability, but ordinary recording applies the stricter persistence disposition. A caller must be able to distinguish `redacted` from `unsupported`, `unavailable`, empty, and zero; redaction never fabricates a canonical value.

## Deny-by-default field policy

Canonical Records use per-version allowlists. For every field the policy registry states its class, accepted type, maximum shape, persistence transform, and justification. A field absent from that registry is removed. Adapter-specific raw detail has a separate, narrower allowlist from its checked-in manifest; absence of a manifest means no raw detail.

Key/path matching uses normalized complete segments plus conservative suffix/prefix patterns. The global forbidden vocabulary includes:

- `mnemonic`, `seed`, `seedBytes`, `entropy`, `recoveryPhrase`, `secret`, `privateKey`, `spendingKey`, `viewingKey`, `signingKey`, `keyMaterial`, `keyMaterialProvider`, `passphrase`, `password`, `passwd`, `pin`;
- `authorization`, `proxyAuthorization`, `apiKey`, `accessToken`, `refreshToken`, `sessionToken`, `bearer`, `cookie`, `setCookie`, `clientSecret`, `credential`;
- `witness`, `redeemer`, `proof`, `provingKey`, `signature`, `signedTx`, `sealedTx`, `unsealedTx`, `rawTx`, `rawTransaction`, `transactionBytes`, `cbor`, `privateState`, `privateInput`, `checkpoint`, `vault`.

Paths match anywhere in nested input, including maps masquerading as attribute bags. `token`, `key`, `transaction`, and `proof` alone are context-sensitive because they also name safe concepts. They are denied in raw/unknown schemas; a canonical allowlist may admit `tokenId`, `transactionId`, `proof.durationMs`, or `proof.byteLength` only with the S2/S3 transform assigned to that exact path.

Structured rules run before generic string scanning:

- Keep URL scheme, normalized host, explicit port, and allowlisted path template. Remove user-info, fragment, and query by default. Query keys may be retained while values become `[REDACTED]`. OpenTelemetry likewise forbids URL user/password capture and requires known sensitive query values to be scrubbed ([URL semantic convention](https://opentelemetry.io/docs/specs/semconv/url/)).
- Deny all HTTP/WebSocket headers except an explicit case-insensitive allowlist such as content type, content length, and selected protocol/version headers. Authorization and cookies are unconditional S0.
- Error objects admit a bounded canonical code, retryability, source subsystem, and a sanitised message. Native `message`, `cause`, `stack`, stdout, and stderr are scanned independently; nested causes are not copied automatically.
- Filesystem paths reduce to a role plus basename or session pseudonym. Home directories and socket paths are not portable diagnostic facts.

Value detectors remove the containing field when they see:

- a 12/15/18/21/24-word sequence matching any bundled BIP-39 language list, including mixed whitespace and Unicode-normalized variants;
- PEM/OpenSSH private-key armour, common keystore JSON, JWTs, HTTP Basic/Bearer credentials, cookie assignments, or URI user-info;
- secret assignments such as normalized `name=value` / JSON / query pairs where the name matches the S0 vocabulary;
- high-entropy hex/Base64/base58 or integer arrays at common key, seed, signature, proof, witness, or transaction lengths unless that exact canonical path has an allowlisted transform;
- source-specific canaries declared by an Adapter manifest.

Detectors never turn an unknown value into an allowed one. An allowlisted transaction hash, address, or token ID is pseudonymised with a random per-Recording HMAC key and domain-separated labels; the key is destroyed after encoding and is never exported. Plain hashing is not used for small or predictable identifiers because OpenTelemetry notes that such hashes can be reversible in practice ([sensitive-data guidance](https://opentelemetry.io/docs/security/handling-sensitive-data/#risk-and-limitations-of-hashing-for-anonymization)).

## Adapter redaction manifest

Every shipped Adapter version must include a reviewed, immutable manifest with:

| Required entry | Meaning |
| --- | --- |
| Adapter ID/version and native protocol/source revisions | Exact implementation to which the rules apply. |
| Minimum global policy ID/version/digest | Prevents use with an older core policy. |
| Native message kinds consumed | Closed list of capture entry points. |
| Canonical projections | Source path to canonical path, class, transform, and diagnostic justification. |
| Raw-detail profiles | Namespace, schema version/digest, allowed paths, type/size constraints, class, transform, and reason. |
| Always-forbidden source paths | Known wallet-specific secret-bearing fields, even when generic detectors miss them. |
| Source-specific value detectors | Prefixes, encodings, structured containers, and test canaries. |
| Maximum native and sanitized sizes | Must be no larger than global limits. |
| Golden fixture/test revision | Evidence that the manifest was exercised against that source revision. |
| Known residual risks | Free-form native surfaces or unverified version differences. |

The manifest is Noxscope code/configuration, never supplied by the observed runtime. Adapter rules may only narrow the global policy. A native version outside the manifest's declared compatibility range may still provide canonical fields proven safe by schema, but raw detail is disabled and a policy-mismatch event is emitted.

Initial requirements:

- **GSD:** exclude the entire vault, SDK checkpoint, keys/keystores, connected-operation inputs/results, and failed-transaction raw material. Diagnostic console interception is treated as an unknown free-form source. Admit only individually projected state and diagnostic fields. GSD's existing logger persists and restores events ([diagnostic logger](https://github.com/awjreynolds/gsd-wallet/blob/3ec1b1ffd21c371cf769fe1c49e38f837a0f9255/src/background/diagnosticLogger.ts)), so Noxscope sanitisation cannot retroactively secure source logs; the Adapter must sanitise before its own buffering or forwarding.
- **Moth daemon:** admit only the typed `version` and `getState` response fields used by the read-only Adapter. Treat wallet name and token IDs/balances as S2. Do not tail process or audit logs as part of this manifest.
- **DApp Connector:** deny authorization payloads, connected-method inputs/results, transaction objects, proving/key-material providers, origins beyond the canonical reduced origin, and configuration URI credentials/query strings. Provider discovery identity and API version are separate allowlisted facts.

## Raw detail

`SanitizedRawDetail` is omitted by default. It is allowed only when all of the following are true:

1. A checked-in Adapter manifest declares the namespace and exact schema version.
2. The detail provides diagnostic value not already represented canonically.
3. Projection begins from an allowlist; it does not clone and delete from a native object.
4. The result passes global detectors, the raw schema, and raw-specific size limits.
5. Its sanitisation metadata records policy ID/version/digest and redaction paths/reasons without original values.

Raw detail cannot establish a capability, override canonical meaning, carry opaque bytes, embed an attachment, reference a local file, or instruct an importer to fetch a URL. Unknown namespaces or schema versions are dropped on import with an auditable warning. Rendering is inert text/tree rendering: no HTML interpretation, clickable credential-bearing URLs, shell escapes, or automatic source-map/file access.

## Transactions, proofs, and witnesses

The default safe transaction/proof record is metadata, not a payload:

- allowed: operation/correlation ID, canonical phase and terminal state, public network ID, timings, retry count, queue time, input/output counts, serialized byte count, fee bucket, prover role (`local`/`remote`/`wallet`/`unknown`), and bounded canonical error code;
- S2 transform: transaction hash, contract address, account/address, token ID, and dApp origin become Recording-scoped pseudonyms unless a future reviewed scenario explicitly requires a public value;
- forbidden: raw or encoded transaction, intent body, inputs/outputs, coins/UTXOs, contract arguments, private state, balanced/sealed/unsealed/signed forms, signature, witness, redeemer, proof bytes, proving/verifying/key material, and full native failure objects.

Confirmation does not make a captured transaction safe: the same object may contain private or linking material beyond what appears on-chain. Proofs may be designed for public verification, but Noxscope has no general proof-format contract proving that an arbitrary native value is public; therefore only proof metadata crosses the seam. A future exception requires a new typed canonical capability and policy review, not a raw-detail rule.

## Developer overrides

Developer mode may increase S3 verbosity or retain specifically named S2 canonical values in an **unsafe local capture**, but it may not admit S0, S1, unknown raw fields, or relax structural/resource checks.

An unsafe capture must be session-scoped, requested through an interactive action naming every widened field, show a persistent warning, expire on disconnect/restart, bind only to loopback/local storage, and emit an audit event containing the actor/action/time/policy change but no sensitive value. Environment variables, wallet-provided settings, remembered UI preferences, and remote requests cannot enable it. Release/CI builds may compile the facility out.

Unsafe captures are not Recordings: they use a distinct file marker and restrictive permissions, cannot be shared or uploaded through Noxscope, and cannot be imported into normal replay. Conversion to a Recording reruns the standard policy and discards the widened fields. This preserves one meaningful promise for every file called a Noxscope Recording.

## Recording, export, and import invariants

A Recording contains only protocol-versioned canonical Records, redaction reports, Adapter manifests/references, policy identities, stream-gap/drop counters, and an integrity manifest. It contains no source checkpoint, vault, arbitrary attachment, executable serialization, or external reference.

Export must:

- rerun current policy over every Record and fail closed on an unknown required schema, policy downgrade, or sanitizer error;
- write to a newly created file with restrictive user-only permissions, using atomic completion so a partial file is not mistaken for valid;
- include protocol, schema, Adapter, and policy versions/digests; counts of records, gaps, dropped records/attributes, and redactions by reason; and per-chunk plus whole-file cryptographic digests;
- state that integrity digests detect accidental/modifying changes but do not authenticate the producer unless a separately configured signature is verified;
- never export the pseudonymisation key, removed values, unsafe captures, source files, or temporary parse buffers.

Import treats the file as hostile even if it was created locally or has valid digests. It checks the magic/format and declared length, parses bounded plain JSON without type revival, rejects an incompatible protocol major, validates every envelope and known schema, reruns sanitisation, recomputes integrity digests, and reports dropped unknown/additive fields. It never opens embedded paths/URLs or extracts archives. OWASP recommends allowlisting types, validating signatures as only one control, generated safe filenames, least-privilege storage, and both compressed and decompressed limits for uploaded files ([OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)). Recording v1 therefore uses uncompressed framed JSON; compressed/archive imports are unsupported.

Imported timestamps, runtime identity, sequence, correlation, severity, and attributes are data, not authority. Replay cannot invoke an Operation, access an Adapter, or cause network/filesystem activity.

## Resource limits

The v1 defaults are hard security ceilings, applied to UTF-8 bytes after framing and again after sanitisation:

| Resource | Ceiling |
| --- | ---: |
| Recording file | 512 MiB |
| Records per Recording | 1,000,000 |
| Native frame accepted by an Adapter | 16 MiB, or a smaller native limit |
| Sanitized canonical Record | 256 KiB |
| One raw-detail item / items per Record | 64 KiB / 4 |
| String / object key | 16 KiB / 256 bytes |
| Object properties / array elements | 512 / 4,096 |
| Nesting depth | 32 |
| Stack/error message after sanitisation | 16 KiB |

Adapters should use materially smaller per-message limits where their source contract permits it. Limit violations produce a bounded canonical overflow event with counts only; the rejected value is not echoed. Live backpressure may shed complete Records only through the canonical stream-gap mechanism—silent loss is forbidden. OpenTelemetry similarly requires configurable attribute limits and reporting of discarded attributes ([Logs SDK](https://opentelemetry.io/docs/specs/otel/logs/sdk/#logrecord-limits), [dropped-attribute mapping](https://opentelemetry.io/docs/specs/otel/common/mapping-to-non-otlp/#dropped-attributes-count)).

## Auditability

Each sanitized Record carries or inherits:

- global policy ID, semantic version, and content digest;
- Adapter manifest ID/version/digest and source protocol version;
- counts by decision (`removed`, `pseudonymised`, `truncated`, `aggregated`, `rejected`) and stable reason codes;
- normalized redacted paths, never removed values or reversible hashes;
- input/output byte counts and any limit reached;
- whether recorder/export/import defence-in-depth changed the Adapter output.

The Recording manifest aggregates these values and records export time/tool version, record/gap counts, and integrity digests. Policy/manifest changes require reviewable source diffs and new golden fixtures. Security audit events themselves use a minimal fixed schema and pass through the same sanitizer. Access to stored Recordings and export actions should be auditable; OWASP recommends recording and monitoring access to logs and restricting read privileges ([OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#protection)).

## Required verification

### Property tests

- **Non-disclosure:** inject unique canary mnemonics, keys, tokens, witnesses, proofs, signatures, and transactions at every recursive position and encoding; no canary or reversible derivative occurs in serialized output, reports, errors, or filenames.
- **Idempotence:** sanitising already sanitized output under the same policy is byte-stable apart from explicitly excluded processing timestamps.
- **Determinism:** equal input, manifest, policy, and Recording pseudonym context produce equal output and decisions.
- **Monotonic restriction:** adding an Adapter rule cannot reveal a value removed by the global policy; an older/unknown manifest cannot enable raw detail.
- **Shape preservation:** removing a field cannot turn missing into empty/zero, change ordering/correlation, or falsely refresh a snapshot.
- **Boundedness:** every accepted output satisfies all byte/depth/cardinality limits; every rejected input yields a bounded error without echo.

### Fuzz and adversarial tests

Fuzz every capture/import entry point with nested JSON, huge lengths, duplicate keys, Unicode confusables, invalid UTF-8, cycles from in-process objects, getters/proxies, numeric arrays, mixed encodings, CR/LF/delimiter injection, URL/header variants, split secrets across fields, and detector near-misses. Include normalization metamorphisms—case, punctuation, NFKC, percent encoding, escaped JSON, whitespace, chunk boundaries, and Base64/hex case. Assert termination under time/memory budgets and no crash, mutation of source data, prototype pollution, file/network access, or secret echo.

OWASP explicitly calls for testing logging against injection, confidentiality, integrity, and availability failures and sanitising CR/LF/delimiters ([Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#verification)).

### Golden and conformance fixtures

- GSD state, console/error diagnostics, failed-transaction diagnostics, vault/checkpoint-shaped objects, reconnects, and the maximum native message size;
- Moth `version`, ready/not-ready `getState`, balances/token maps, RPC errors, authorization errors, and malformed/oversized frames;
- DApp Connector discovery/configuration plus every operation phase with transaction, proving, key-material, origin, endpoint, and nested-error canaries;
- safe transaction/proof metadata that must survive, paired with forbidden payload variants that must not;
- export/import round trips, tampering, truncation, reordering, digest mismatch, unknown schema/policy, oversized declarations, and v1 archive rejection.

Every manifest change must update its golden corpus. CI must scan built fixture outputs and committed Recording fixtures with both Noxscope detectors and an independent secret scanner. A detector regression blocks release; a false positive requires a narrow canonical path rule, never global weakening.

## Known limits and unresolved validation facts

- No detector can prove arbitrary telemetry secret-free. Novel wallet field names, custom seed languages, encrypted/obfuscated secrets, secrets split across events, and valid-looking high-entropy identifiers can evade or confuse heuristics. Allowlisted projection and source review remain the primary controls.
- Sanitisation cannot protect a secret already persisted by the Wallet Runtime, source logger, browser extension, OS crash reporter, swap, debugger, clipboard, screenshot, or compromised Adapter process. GSD's existing persistent diagnostic buffer and raw failed-transaction logging require an upstream hardening decision as well as a Noxscope Adapter rule.
- A local-first Recording is still sensitive operational data. Pseudonyms, timings, balances, network IDs, and version combinations can permit linkage or fingerprinting when combined with outside information.
- Exact Midnight transaction, proof, witness, viewing-key, and DUST-key encodings must be extracted from the package family actually selected for implementation and added to source-specific detectors and fixtures. The global policy intentionally forbids their enclosing fields in the meantime.
- Installed Lace, 1AM, Gero, Moth extension, and future connector builds must be captured in isolated profiles to enumerate real configuration/error shapes; source or connector-version claims alone are insufficient.
- Retention duration, deletion UI, optional authenticated signing, and at-rest encryption/key management need product and deployment decisions. They cannot weaken the content invariant defined here.
- The numeric v1 ceilings need performance tests against long GSD sync/replay sessions. A ceiling change is a reviewed policy change and must remain bounded; it is not an Adapter override.
