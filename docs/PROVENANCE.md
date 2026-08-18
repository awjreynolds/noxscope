# Source provenance

Noxscope is a fresh Apache-2.0 monorepo. Upstream code is copied only as a coherent, reviewable slice after its behavior is characterised and its place behind a canonical Adapter seam is established.

## Audited behavioral references

These repositories inform interoperability and architecture but have not yet been copied into Noxscope:

| Upstream | Commit | License | Use |
| --- | --- | --- | --- |
| `https://github.com/awjreynolds/gsd-wallet` | `3ec1b1ffd21c371cf769fe1c49e38f837a0f9255` | Apache-2.0; `packages/gsd-socket` is MIT | GSD architecture, diagnostics, and external protocol reference |
| `https://github.com/shieldedtech/moth-wallet` | `e9a974eb6aa49e4db66c8910328f2f787dde541b` | Apache-2.0 | Moth daemon and connector wire-behavior reference |

## Copied or transformed source

No source has been copied yet.

When code is imported, add one row per file or coherent directory:

| Destination | Upstream repository | Source commit | Original path | License | Copyright | Treatment | Import date | Importing commit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Import rules

- Preserve existing copyright and SPDX headers.
- Add an accurate SPDX identifier where an imported file lacks one.
- Mark modified Apache-2.0 files prominently.
- Preserve an imported MIT notice and license; do not relabel MIT source as Apache-2.0.
- Keep the original GSD repository independently runnable during extraction.
- Prefer public wire contracts and dependencies over copying implementation code.

