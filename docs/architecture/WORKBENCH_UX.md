# Workbench information architecture

## Decision

The first-release Noxscope workbench uses a dense split-pane inspector as its shell, a cross-runtime trace table as its principal temporal view, and a persistent failure strip for immediate incident salience. This combines the strongest parts of the three deliberately different prototypes without retaining a runtime variant switch in production.

The reviewed prototype is preserved on branch `prototype/workbench-variants` at commit `a550510238f6c48c462aebb7e0bd187bacba9ffe`. It is a disposable design artifact, not a source branch to merge into the release.

## Layout

The production shell has four stable regions:

1. A runtime rail lists each Runtime Session independently and exposes runtime name, surface, network, connection state, and current failure count. Selecting a runtime changes the inspector context; it never merges runtime identity or capability claims.
2. A top failure strip shows the highest-severity current failures and gaps across connected sessions, with clear attribution and a route to the relevant trace.
3. The central trace table compares snapshots, events, and operation updates across sessions. It may sort cross-runtime records by display time only while preserving the original sequence within every stream.
4. The inspector presents the selected record or runtime: capability support, availability and evidence; snapshot freshness; shielded, unshielded and DUST sync; correlation; error detail; and sanitised raw detail behind explicit disclosure.

## State representation

Every primary view renders canonical protocol state and remains wallet-agnostic. UI branches may key on protocol record kind, capability ID and supported schema version, never Adapter or wallet identity.

- Unknown totals render an explicit indeterminate state. They are not zero, empty, complete, or an ambiguous dash.
- Capability support and current availability remain separate. Evidence and freshness are visible without opening raw payloads.
- Missing optional snapshot sections remain missing and are explained by capability declarations; the UI does not invent empty arrays or healthy defaults.
- Operations retain one visible identity from request through terminal outcome. Parent and trace correlations are links, not inferred causality.
- Stream gaps and stale observations remain first-class failures.
- Raw detail is JSON-only, already sanitised, and collapsed by default with a visible disclosure affordance.

## Interaction and accessibility

Runtime selectors expose their selected state with native accessibility semantics. Keyboard shortcuts ignore editable controls and contenteditable regions. Failure, selection, freshness, and progress never rely on colour alone. Dense panels retain visible focus, disclosure, and indeterminate-progress affordances.

The prototype URL/keyboard variant switch exists only in development builds and is compiled out of production. The production implementation contains one settled information architecture.

## Production extraction

Ticket 15 implements this decision afresh against Core's public subscribed view. It should reuse validated behavior and vocabulary from the prototype, not cherry-pick the prototype component wholesale. Browser recording controls and offline replay remain subordinate workbench modes built on the reviewed Recorder interface.
