# Noxscope

Noxscope is a local-first developer observability and interoperability workbench for Midnight wallet runtimes. It provides a wallet-agnostic diagnostic language without becoming a wallet itself.

## Language

**Wallet Runtime**:
A running Midnight wallet implementation that Noxscope can observe or invoke through a supported boundary.
_Avoid_: Wallet app, wallet backend

**Adapter**:
The wallet-specific boundary that discovers a Wallet Runtime's capabilities and translates its state, operations, and telemetry into Noxscope's canonical language.
_Avoid_: Connector, integration layer, wallet implementation

**Runtime Session**:
A single connection through an Adapter to one observed Wallet Runtime, with its own identity, capability evidence, freshness, and ordered record stream.
_Avoid_: Connection, adapter session

**Capability**:
An adapter-reported unit of observable or invokable behaviour that a Wallet Runtime actually supports.
_Avoid_: Feature flag, assumed feature

**Capability Support**:
Evidence that a Runtime Session can or cannot provide a Capability under its negotiated contract.
_Avoid_: Availability, enabled state

**Capability Availability**:
The current reachability or health of a supported Capability, independent of whether the Runtime Session supports it in principle.
_Avoid_: Support, feature flag

**Diagnostic Event**:
A timestamped observation emitted through an Adapter and correlated with the operation or subsystem that produced it.
_Avoid_: Log line, telemetry blob

**Snapshot**:
A freshness-qualified observation of the state a Runtime Session could expose at a point in time.
_Avoid_: Wallet state, current state

**Operation**:
A correlated unit of wallet work, such as synchronising, balancing, proving, submitting, or answering a dApp request.
_Avoid_: Request, command, transaction

**Diagnostic Session**:
A bounded period during which Noxscope observes one or more Wallet Runtimes and correlates their events and state changes.
_Avoid_: Session, trace

**Recording**:
A sanitised, portable representation of a Diagnostic Session that can be inspected without the original Wallet Runtime running.
_Avoid_: Dump, export, log archive

**Scenario**:
A wallet-agnostic sequence of logical steps that compatible Adapters may execute for diagnostic or comparative purposes.
_Avoid_: Test script, workflow

**Comparison Run**:
The results of executing the same Scenario against two or more Wallet Runtimes and comparing observable outcomes without assuming identical internal behaviour.
_Avoid_: Benchmark, differential test
