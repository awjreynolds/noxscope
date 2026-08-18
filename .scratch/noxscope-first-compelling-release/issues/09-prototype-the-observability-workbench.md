# Prototype the observability workbench

Type: prototype
Status: resolved
Blocked by: 04, 05

## Question

What is the smallest dense, developer-tool information architecture that makes runtime identity, network, capability availability, three-domain sync, correlated operations, failures, and event detail immediately legible while preserving progressive disclosure and supporting more than one connected Wallet Runtime?

## Answer

Use the dense split-pane inspector (prototype C) as the production foundation, add the trace-first prototype's cross-runtime timeline as the principal temporal view, and retain the runtime-console prototype's prominent failure strip and richer capability-evidence presentation. Runtime selection changes context without merging identities; the trace view preserves per-stream order while comparing sessions.

All surfaces must represent the same canonical facts: runtime/network identity, capability support and availability with evidence, snapshot freshness, explicit indeterminate sync when totals are unknown, correlated operations, logs, failures, and progressively disclosed sanitised raw detail. The developer-only three-variant prototype remains isolated on `prototype/workbench-variants` at `a550510238f6c48c462aebb7e0bd187bacba9ffe`; it is not production code. A fresh independent recheck passed all 29 tests and the lint, formatting, typecheck, build, production-dead-code, and diff gates.
