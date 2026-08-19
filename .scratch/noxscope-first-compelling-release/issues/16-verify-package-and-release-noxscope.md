# Verify, package, and release Noxscope

Type: task
Status: resolved
Blocked by: 12, 13, 14, 15

## Question

Complete licensing/provenance checks, localnet developer experience, CI, type/lint/unit/property/integration/UI/security suites, browser/Node packaging, compatibility evidence, documentation, and release acceptance proving the destination against GSD, Moth, recordings, and the supported validation matrix.

## Answer

Prepared the Apache-2.0 Noxscope 0.1.0 source release with a frozen pnpm workspace, CI, package metadata and provenance enforcement, repository and per-package legal notices, security and contribution policies, a changelog, and explicit release-acceptance documentation. The single `pnpm verify` gate runs formatting, lint, TypeScript project checks, 179 unit/property/integration/UI/security tests, all production builds, bounded secret scans over tracked source, fixtures, generated output, and packed artifacts, plus dry-run, extracted-tarball, legal-file, and clean-consumer import checks for all seven publishable packages.

The release evidence proves the reviewed canonical protocol, Core, recordings, GSD worker/GSD Connect Adapter, Moth daemon Adapter and loopback HostBridge, conformance harness, deterministic mock, and local-first browser workbench. Compatibility claims remain scoped to their actual evidence: GSD and Moth are validated against pinned public-contract fixtures and audited source boundaries; the official Wallet SDK and Lace are deterministic connector baselines; 1AM and Gero remain non-live qualification targets; Moth connector qualification remains distinct from daemon health. No mainnet, real-user-wallet, live-wallet, or registry-publication claim is made. The source release is ready for a `v0.1.0` tag after the pushed CI run passes; npm publication remains a separate, explicitly authorized action.
