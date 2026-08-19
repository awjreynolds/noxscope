# Build the first-release observability workbench

Type: task
Status: resolved
Blocked by: 09, 10, 11

## Question

Implement the accepted dense developer-tool workbench over canonical Core state: simultaneous runtime Overview, capability/status display, three-domain sync, structured event stream, correlated transaction/dApp timelines, DUST diagnostics, failure inspection, recording controls, and offline recording view without wallet-specific UI branches.

## Answer

Implemented the accepted production workbench as a dense split-pane canonical inspector: the Variant C shell, Variant B cross-runtime temporal ledger, and Variant A capability evidence/failure treatment. It selects simultaneous Runtime Sessions by collision-safe session identity, distinguishes support, availability, freshness, absence, and unknown state, renders three-domain sync and balances, exposes DUST evidence honestly, links correlated dApp/transaction operation phases, and provides searchable structured records plus bounded sanitized raw disclosures without wallet-specific UI branches.

The trace ledger preserves per-stream order under clock skew, precomputes a bounded safe search index, pages large recordings rather than rendering up to one million rows, and uses collision-proof tuple keys for arbitrary protocol IDs. Failures are severity/recency ordered and remain independently selectable even when their content repeats. Recording/library controls surface bounded errors; offline mode preserves the recorded multi-runtime identity and disables operations. Independent interaction reviews covered duplicate runtime names/IDs, correlation navigation, absent/stale/unknown DUST, huge timelines, StrictMode, export failures, inert raw rendering, delimiter/control/Unicode IDs, Core gap identities, accessibility, and production-bundle removal of all prototype switching. The integrated slice passes 136 tests and every gate.
