# Choose source provenance and migration strategy

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Should Noxscope import GSD history, copy provenance-tracked components into a fresh monorepo, or evolve a GSD branch and later rename/extract it; how will Moth-derived knowledge or code be kept at supported boundaries; and which choice best preserves attribution, reviewability, and an always-runnable migration?

## Answer

Keep the fresh Noxscope monorepo and selectively copy only coherent, provenance-tracked GSD slices after characterization and Adapter-level integration prove they are needed. Keep pinned GSD independently runnable throughout migration. Preserve Apache-2.0 and the separate MIT license of `gsd-socket`, record exact source commits/paths, and import one reviewable concern at a time. Do not copy Moth initially; target its public daemon and connector contracts with captured fixtures.

Decision: [Source provenance](../../../docs/PROVENANCE.md) and [Selectively extract GSD into a fresh monorepo](../../../docs/adr/0003-selective-provenance-tracked-gsd-extraction.md)
