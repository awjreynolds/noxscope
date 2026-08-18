# Target Noxscope architecture

## Architectural rule

Noxscope core reasons only in its canonical protocol. Wallet-specific transport, lifecycle, state, errors, correlation recovery, and raw payloads stay inside Adapters. One Runtime Session represents one observed Wallet Runtime; a host may aggregate any number of sessions without merging their identities or inventing a global causal order.

```text
Wallet Runtime → Adapter → Runtime Session → ordered Records → Recorder / Analysis / UI
```

The protocol package is dependency-free TypeScript. Adapters depend on it; it never depends on an Adapter, browser API, transport, wallet SDK, or UI library.

## Deep module interface

The external module has three entry points:

1. `NoxscopeAdapter.connect` creates a Runtime Session.
2. Async iteration yields the session's ordered Record stream.
3. `RuntimeSession.request` performs an on-demand snapshot, invokes a supported Operation, or requests cancellation.

```ts
export interface NoxscopeAdapter {
  connect(options: ConnectOptions): Promise<Result<RuntimeSession>>;
}

export interface RuntimeSession extends AsyncIterable<NoxscopeRecord> {
  readonly descriptor: RuntimeDescriptor;

  request(
    request: SnapshotRequest,
    options?: RequestOptions,
  ): Promise<Result<Snapshot>>;

  request(
    request: InvokeRequest,
    options?: RequestOptions,
  ): Promise<Result<OperationTerminal>>;

  request(
    request: CancelRequest,
    options?: RequestOptions,
  ): Promise<Result<{ accepted: boolean }>>;
}
```

Connection starts observation. The Adapter hides whether data arrives through native subscription, polling, browser messages, WebSocket, Unix socket, TCP, or direct library calls.

## Versions and identity

```ts
export const NOXSCOPE_PROTOCOL = "noxscope/adapter/1" as const;

export interface RuntimeDescriptor {
  readonly protocol: typeof NOXSCOPE_PROTOCOL;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly adapter: { readonly id: string; readonly version: string };
  readonly runtime: {
    readonly surface: "worker" | "daemon" | "sdk" | "dapp-connector" | string;
    readonly name?: string;
    readonly identifiers: readonly RuntimeIdentifier[];
    readonly versions: readonly VersionFact[];
  };
  readonly capabilities: readonly CapabilityDeclaration[];
}
```

`runtimeId` identifies an observed instance within the current host; `sessionId` changes on reconnect. Connector discovery UUIDs are recorded as Diagnostic Session identifiers while stable `rdns` identifiers are recorded separately. Wallet, connector, daemon protocol, SDK, ledger, node, indexer, and prover versions remain independent facts.

Breaking canonical semantics require a new protocol major. Additive fields, capabilities, event names, and namespaced extensions may be introduced within major version 1 and ignored by older callers.

## Capabilities

```ts
export type CapabilitySupport =
  | {
      readonly state: "supported";
      readonly version: string;
      readonly evidence: CapabilityEvidence;
    }
  | {
      readonly state: "unsupported";
      readonly reason: string;
      readonly evidence: CapabilityEvidence;
    };

export type CapabilityAvailability =
  | { readonly state: "available" }
  | {
      readonly state: "degraded" | "unavailable";
      readonly reason: string;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
    };

export interface CapabilityDeclaration {
  readonly id: string;
  readonly kind: "snapshot" | "event" | "operation";
  readonly support: CapabilitySupport;
  readonly availability: CapabilityAvailability;
}
```

Support and availability are different axes:

- `unsupported` means the runtime/Adapter contract cannot provide the capability.
- `unavailable` means the capability is supported but cannot currently be reached, authorized, configured, or observed.
- absence means unknown and may never be interpreted as unsupported.

Every declaration carries evidence from a runtime declaration, handshake, successful probe, static wire contract, or Adapter derivation. Support is immutable for a Runtime Session. Availability changes through records; reconnect to renegotiate support.

Core capability IDs are governed by Noxscope. Adapter-specific capabilities use reverse-domain names. UI renderers may key on capability ID and schema version, never wallet identity.

## Ordered record envelope

```ts
export type NoxscopeRecord = SnapshotRecord | DiagnosticEventRecord | OperationRecord;

export interface RecordMeta {
  readonly protocol: typeof NOXSCOPE_PROTOCOL;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly streamId: string;
  readonly sequence: string;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly correlation?: {
    readonly requestId?: string;
    readonly operationId?: string;
    readonly parentOperationId?: string;
    readonly causedBySequence?: string;
    readonly traceId?: string;
  };
}
```

`sequence` is a strictly increasing unsigned decimal integer within a stream. It defines receive order; timestamps do not. Noxscope never fabricates a total order across Runtime Sessions. Cross-runtime views sort by time while preserving per-stream sequence.

Backpressure is bounded. Any loss produces a canonical stream-gap event; silent dropping is forbidden.

## Snapshots and freshness

```ts
export interface Snapshot {
  readonly revision: string;
  readonly freshness: {
    readonly state: "fresh" | "stale" | "unknown";
    readonly observedAt: string;
    readonly receivedAt: string;
    readonly source: "runtime" | "adapter";
    readonly pollingIntervalMs?: number;
    readonly consecutiveFailures: number;
    readonly lastSuccessAt?: string;
  };
  readonly lifecycle?: LifecycleState;
  readonly identity?: WalletIdentity;
  readonly network?: NetworkState;
  readonly sync?: SyncState;
  readonly balances?: readonly Balance[];
  readonly addresses?: readonly WalletAddress[];
  readonly dust?: DustState;
  readonly transactions?: readonly TransactionSummary[];
  readonly dependencies?: readonly DependencyHealth[];
  readonly raw?: readonly SanitizedRawDetail[];
}
```

Canonical state sections are optional because Capability declarations explain whether they are unsupported or temporarily unavailable. Missing data is never replaced with empty arrays, zeros, or invented health.

Polling failure does not refresh `observedAt` or erase the last successful snapshot. Moth records its last good snapshot with increasing age and failure count. Adapter-generated polling events identify their source and never claim native event fidelity.

## Diagnostic Events and Operations

```ts
export interface DiagnosticEvent {
  readonly name: string;
  readonly category:
    | "wallet" | "sync" | "transaction" | "proof" | "network"
    | "dapp" | "contract" | "dust" | "storage" | "sdk"
    | "system" | "adapter" | string;
  readonly level: "trace" | "debug" | "info" | "warn" | "error";
  readonly source: "runtime" | "adapter";
  readonly attributes?: JsonValue;
  readonly raw?: readonly SanitizedRawDetail[];
}

export interface OperationUpdate {
  readonly kind: string;
  readonly phase: string;
  readonly state: "running" | "succeeded" | "failed" | "cancelled";
  readonly progress?: number;
  readonly result?: JsonValue;
  readonly error?: NoxscopeError;
  readonly raw?: readonly SanitizedRawDetail[];
}
```

One logical Operation keeps one `operationId` through authorization, balancing, proving, signing, submission, confirmation, state changes, and one terminal outcome. Parent and causation fields express relationships only when observed; adapters must not guess causality from timing.

Operation inputs have typed canonical forms for portable operations and namespaced JSON forms for Adapter-specific operations. The UI must capability-gate invocation. The first Moth daemon Adapter advertises no mutation Operations.

Aborting a request stops the caller waiting and may propagate best-effort cancellation, but does not prove that wallet work stopped. Only an advertised cancellation capability plus a terminal cancelled update establishes cancellation.

## Errors

```ts
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: NoxscopeError };

export interface NoxscopeError {
  readonly code:
    | "unsupported" | "unavailable" | "incompatible" | "unauthorized"
    | "timeout" | "cancelled" | "invalid" | "rejected" | "failed"
    | "protocol" | "overflow" | "internal";
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly capability?: string;
  readonly raw?: readonly SanitizedRawDetail[];
}
```

Expected domain and transport failures are typed results or Diagnostic Events. Programmer errors may throw and are caught at the host boundary. Operation failures appear once in their terminal Operation record.

## Sanitised raw detail

```ts
export interface SanitizedRawDetail {
  readonly namespace: string;
  readonly schemaVersion: string;
  readonly value: JsonValue;
  readonly sanitization: {
    readonly policy: string;
    readonly policyVersion: string;
    readonly redactions: readonly {
      readonly path: string;
      readonly reason: "secret" | "key-material" | "private-payload" | "policy";
    }[];
  };
}
```

Raw detail is JSON-only, namespaced, schema-versioned, and centrally sanitised before crossing the Adapter seam. It cannot define canonical meaning or satisfy a Capability. Unsanitised seed, key, witness, proof, passphrase, credential, or transaction material may never cross the seam.

## Adapter mappings

### GSD

The GSD Adapter wraps the worker request/broadcast and GSD Connect protocols. Native state updates and diagnostics become ordered Records. The Adapter hides Chrome lifecycle, SDK types, reconnection, cache/replay, request IDs, transaction queue, and GSD-specific payloads.

### Moth daemon

The Moth Adapter negotiates `moth-wallet-daemon/1`, polls `getState`, and maps runtime identity, network, three-domain sync, and balances. Addresses, detailed DUST state, transactions, dependency health, runtime event subscription, and mutation Operations are explicitly unsupported. Socket errors, protocol mismatch, authorization, readiness, and staleness remain distinct.

### DApp Connector

The connector Adapter discovers every UUID-keyed provider under `window.midnight`, records stable `rdns` separately, negotiates its reported connector version/network, and exposes only observed methods. Lace, 1AM, Gero, Moth extension, and future providers share this Adapter role; wallet-specific exceptions stay inside provider-specific codecs if genuinely required.

## Testing seam

The interface is the conformance-test surface. A deterministic in-memory Adapter supplies snapshots, native and Adapter events, operation lifecycles, unavailability, reconnection, stream gaps, malformed raw detail, and cancellation races. Tests assert observable Results and Records, not internal transport state.

Do not expose transport codecs or polling clocks through the public interface merely for tests. They are internal seams injected into each Adapter implementation.

