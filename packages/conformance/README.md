# `@noxscope/conformance`

This package is the executable admission seam for Noxscope wallet targets. It
has two independent runners:

- `runAdapterConformance` exercises only the canonical
  `NoxscopeAdapter`/`RuntimeSession` interface (A1–A6), including descriptor
  truthfulness, per-stream ordering and gaps, snapshot freshness,
  operation correlation, bounded evidence, and central sanitisation.
- `runConnectorQualification` discovers own UUID-keyed providers in a
  `window.midnight`-shaped source, records transient discovery UUIDs separately
  from stable `rdns`, selects an explicit API major, bounds public reads, and
  observes asynchronous injection/removal. It does not infer daemon health or
  deep wallet telemetry from connector authorization.

Every assertion is labelled `fixture` or `exercised`. Reports include the target
evidence key, evidence source, environment, timestamps, capability support and
availability (`supported`, `unsupported`, `unavailable`, or `not-tested`),
sanitisation counts, and safety controls. A fixture can only receive
`admission: "fixture"`; it can never establish a compatibility claim. Live
reports require an isolated target and use `full` for a deep Adapter or
`connector` for a public connector.

Mutation/operation checks are opt-in and require exactly `localnet` or
`preprod`, an expected-network match, an explicit allowlist, one bounded runner,
and a maximum operation count. Mainnet is read-only. The runners retain no
provider results, transaction bytes, proofs, witnesses, signatures, keys, or
credentials; all evidence passes the central sanitizer and hostile method
getters/calls are bounded.

The deterministic corpus is exposed from `@noxscope/conformance/fixtures`.
Run its seam tests with:

```sh
pnpm --filter @noxscope/conformance test
```

The official SDK and Lace entries are deterministic baseline fixtures. 1AM and
Gero are explicitly labelled `non-live-qualification`, and the Moth extension
fixture is deliberately separate from the Moth daemon target.
