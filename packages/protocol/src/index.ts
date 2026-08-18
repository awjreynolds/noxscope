export const NOXSCOPE_PROTOCOL = "noxscope/adapter/1" as const;

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: NoxscopeError };

export interface NoxscopeError {
  readonly code:
    | "unsupported"
    | "unavailable"
    | "incompatible"
    | "unauthorized"
    | "timeout"
    | "cancelled"
    | "invalid"
    | "rejected"
    | "failed"
    | "protocol"
    | "overflow"
    | "internal";
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly capability?: string;
  readonly raw?: readonly SanitizedRawDetail[];
}

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

export interface ConnectOptions {
  readonly signal: AbortSignal;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface NoxscopeAdapter {
  connect(options: ConnectOptions): Promise<Result<RuntimeSession>>;
}

export interface RuntimeSession extends AsyncIterable<NoxscopeRecord> {
  readonly descriptor: RuntimeDescriptor;
  request(request: SnapshotRequest, options?: RequestOptions): Promise<Result<Snapshot>>;
  request(request: InvokeRequest, options?: RequestOptions): Promise<Result<OperationTerminal>>;
  request(
    request: CancelRequest,
    options?: RequestOptions,
  ): Promise<Result<{ readonly accepted: boolean }>>;
}

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

export interface RuntimeIdentifier {
  readonly scheme: string;
  readonly value: string;
  readonly stability: "diagnostic-session" | "installation" | "reported";
}

export interface VersionFact {
  readonly subject: string;
  readonly version: string;
}

export type CapabilityEvidence = {
  readonly source:
    "runtime-declaration" | "handshake" | "probe" | "static-wire-contract" | "adapter-derivation";
  readonly observedAt: string;
  readonly summary: string;
};

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

export interface SnapshotRequest {
  readonly kind: "snapshot";
  readonly requestId: string;
  readonly select?: readonly string[];
}

export interface InvokeRequest {
  readonly kind: "invoke";
  readonly requestId: string;
  readonly operationId: string;
  readonly parentOperationId?: string;
  readonly operation: OperationInput;
}

export interface CancelRequest {
  readonly kind: "cancel";
  readonly requestId: string;
  readonly operationId: string;
}

export type OperationInput =
  | { readonly kind: "wallet.sync"; readonly action: "start" | "stop" | "rescan" }
  | {
      readonly kind: "asset.transfer";
      readonly to: string;
      readonly assetId: string;
      readonly amount: string;
      readonly domain: "shielded" | "unshielded" | "dust";
    }
  | {
      readonly kind:
        "transaction.balance" | "transaction.prove" | "transaction.sign" | "transaction.submit";
      readonly artifact: JsonValue;
    }
  | { readonly kind: string; readonly input: JsonValue };

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

export type NoxscopeRecord = SnapshotRecord | DiagnosticEventRecord | OperationRecord;

export interface SnapshotRecord {
  readonly kind: "snapshot";
  readonly meta: RecordMeta;
  readonly snapshot: Snapshot;
}

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

export interface LifecycleState {
  readonly state: "starting" | "ready" | "locked" | "stopping" | "stopped" | "unknown";
}

export interface WalletIdentity {
  readonly account?: string;
  readonly walletName?: string;
}

export interface NetworkState {
  readonly id: string;
}

export interface SyncState {
  readonly state: "idle" | "syncing" | "synced" | "stalled" | "unknown";
  readonly percentage?: number;
  readonly etaSeconds?: number | null;
  readonly domains?: readonly SyncDomain[];
}

export interface SyncDomain {
  readonly domain: "shielded" | "unshielded" | "dust" | string;
  readonly state: "pending" | "syncing" | "synced" | "stalled" | "unknown";
  readonly percentage?: number;
}

export interface Balance {
  readonly assetId: string;
  readonly domain: "shielded" | "unshielded" | "dust" | string;
  readonly amount: string;
}

export interface WalletAddress {
  readonly domain: "shielded" | "unshielded" | "dust" | string;
  readonly value: string;
  readonly account?: string;
}

export interface DustState {
  readonly state: "unregistered" | "registering" | "registered" | "unknown";
  readonly progress?: number;
}

export interface TransactionSummary {
  readonly id: string;
  readonly state: "pending" | "confirmed" | "failed" | "unknown";
}

export interface DependencyHealth {
  readonly role: "node" | "indexer" | "prover" | string;
  readonly state: "connected" | "degraded" | "disconnected" | "unknown";
  readonly endpoint?: string;
}

export interface DiagnosticEventRecord {
  readonly kind: "diagnostic-event";
  readonly meta: RecordMeta;
  readonly event: DiagnosticEvent | CapabilityAvailabilityEvent | StreamGapEvent;
}

export interface DiagnosticEvent {
  readonly type: "diagnostic";
  readonly name: string;
  readonly category: string;
  readonly level: "trace" | "debug" | "info" | "warn" | "error";
  readonly source: "runtime" | "adapter";
  readonly message?: string;
  readonly attributes?: JsonValue;
  readonly raw?: readonly SanitizedRawDetail[];
}

export interface CapabilityAvailabilityEvent {
  readonly type: "capability-availability";
  readonly capabilityId: string;
  readonly availability: CapabilityAvailability;
}

export interface StreamGapEvent {
  readonly type: "stream-gap";
  readonly firstLostSequence: string;
  readonly lastLostSequence: string;
  readonly reason: "overflow" | "source-gap" | "reconnect";
}

export interface OperationRecord {
  readonly kind: "operation";
  readonly meta: RecordMeta & {
    readonly correlation: RecordMeta["correlation"] & { readonly operationId: string };
  };
  readonly operation: OperationUpdate;
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

export type OperationTerminal = OperationUpdate & {
  readonly state: "succeeded" | "failed" | "cancelled";
};

const unsignedDecimal = /^(0|[1-9]\d*)$/;

export function validateRuntimeDescriptor(value: unknown): Result<RuntimeDescriptor> {
  if (!isObject(value) || value.protocol !== NOXSCOPE_PROTOCOL) {
    return invalid("Runtime descriptor has an incompatible protocol");
  }
  if (!nonEmpty(value.sessionId) || !nonEmpty(value.runtimeId) || !isObject(value.adapter)) {
    return invalid("Runtime descriptor is missing identity");
  }
  if (!isObject(value.runtime) || !Array.isArray(value.capabilities)) {
    return invalid("Runtime descriptor is missing runtime or capabilities");
  }
  return { ok: true, value: value as unknown as RuntimeDescriptor };
}

export function validateRecord(value: unknown): Result<NoxscopeRecord> {
  if (!isObject(value) || !isObject(value.meta) || value.meta.protocol !== NOXSCOPE_PROTOCOL) {
    return invalid("Record has an incompatible protocol");
  }
  const meta = value.meta;
  if (
    !nonEmpty(meta.sessionId) ||
    !nonEmpty(meta.runtimeId) ||
    !nonEmpty(meta.streamId) ||
    typeof meta.sequence !== "string" ||
    !unsignedDecimal.test(meta.sequence) ||
    !validTime(meta.observedAt) ||
    !validTime(meta.receivedAt)
  ) {
    return invalid("Record metadata is invalid");
  }
  if (!(["snapshot", "diagnostic-event", "operation"] as const).includes(value.kind as never)) {
    return invalid("Record kind is unknown");
  }
  if (value.kind === "snapshot" && !isObject(value.snapshot)) {
    return invalid("Snapshot record is missing its snapshot");
  }
  if (value.kind === "diagnostic-event" && !isObject(value.event)) {
    return invalid("Diagnostic event record is missing its event");
  }
  if (value.kind === "operation") {
    if (
      !isObject(value.operation) ||
      !isObject(meta.correlation) ||
      !nonEmpty(meta.correlation.operationId)
    ) {
      return invalid("Operation record is missing operation correlation");
    }
  }
  return { ok: true, value: value as unknown as NoxscopeRecord };
}

function invalid(message: string): Result<never> {
  return { ok: false, error: { code: "protocol", message, retryable: false } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
