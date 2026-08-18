# Selectively extract GSD into a fresh monorepo

Noxscope will remain a fresh monorepo and copy only coherent GSD slices after their behavior is characterised and their Adapter seam is proven. This gives clearer architecture, licensing, and reviewability than importing all GSD history or renaming a GSD branch. Exact upstream commit/path/license metadata in `docs/PROVENANCE.md` compensates for cross-repository blame, while the pinned GSD build remains runnable until each canonical replacement reaches parity.

