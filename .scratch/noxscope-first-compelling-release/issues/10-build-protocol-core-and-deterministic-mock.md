# Build protocol, Core, and deterministic mock

Type: task
Status: resolved
Blocked by: 04, 05, 08

## Question

Implement the smallest runnable monorepo slice containing the dependency-free canonical protocol, Core Runtime Session registry/record handling, deterministic mock Adapter, conformance tests, and a minimal browser application that renders runtime identity, capabilities, sync/balances, and an ordered event stream exclusively through the canonical interface.

## Answer

Implemented the runnable pnpm/TypeScript foundation: a dependency-free versioned protocol with runtime validation, a Core multi-session registry with one public subscribed view, deterministic mock scenarios covering healthy and required failure/queue behavior, and a React/Vite Overview driven exclusively by Core. Behavior-focused tests exercise only the confirmed Adapter, Core, and browser seams. Tests, typechecking, production build, lint, formatting, and diff checks all pass.

Review hardening added recursive canonical validation, per-stream ordering and gap evidence, immutable Core views, live abortable mock streams, truthful capability availability, reconnection and cancellation fixtures, shutdown behavior, and explicit unknown sync progress without expanding into wallet Adapters or recording.
