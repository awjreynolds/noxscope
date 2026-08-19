# Release acceptance checklist

This checklist is the gate for a tagged Noxscope release. A green build alone
does not establish wallet compatibility or localnet/Preprod evidence.

## Repository and package gates

- [ ] `pnpm install --frozen-lockfile` succeeds on Node 24+ / pnpm 10.33+.
- [ ] `pnpm verify` passes: metadata, provenance, Recording fixture scan,
      formatting, lint, typecheck, tests, and production build.
- [ ] Exactly seven publishable library packages pass metadata and package
      content gates; root/`apps/web` remain private.
- [ ] Package tarballs contain only the declared `dist`, package README,
      Apache-2.0 `LICENSE`, `NOTICE`, and third-party audit; root/`apps/web`
      remain private.
- [ ] Conformance deterministic fixtures remain test-only source material and
      are absent from package exports and tarballs; the published entry imports.
- [ ] `LICENSE`, `NOTICE`, `docs/PROVENANCE.md`, and
      `docs/THIRD_PARTY_NOTICES.md` agree with copied/transformed source.
- [ ] CI runs the same frozen install and local verification, plus an
      independent committed-Recording secret scan.

## Runtime and security gates

- [ ] GSD fixtures and a pinned GSD build pass Adapter A1–A6 on localnet.
- [ ] Moth fixtures and a pinned daemon pass Adapter A1–A6 on localnet.
- [ ] HostBridge loopback/origin/token/replay/bounds/fragmentation tests pass.
- [ ] Recording export/import tamper, truncation, reordering, unknown-schema,
      oversize, and secret-canary tests pass.
- [ ] Browser recording storage/export/import/offline operation denial is
      manually checked in a supported browser.
- [ ] No test uses a real user wallet, mainnet mutation, or committed secret.

## Compatibility evidence

- [ ] Official Wallet SDK/local stack has an exact build and localnet report.
- [ ] Lace connector has an installed-build discovery and harmless localnet
      report, or remains `watch`.
- [ ] 1AM and Gero remain `watch` unless their public surfaces were exercised.
- [ ] Any Preprod run uses a disposable, funded test identity and records the
      network/build/suite evidence without recording credentials.
- [ ] README and `WALLET_CONFORMANCE.md` make every evidence class explicit.

The release owner signs this checklist in the release notes. Missing evidence
is a documented limitation, not a reason to infer support.
