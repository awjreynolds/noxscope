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

export type ExtensionOperationId = `${string}.${string}.${string}`;

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
  | { readonly kind: ExtensionOperationId; readonly input: JsonValue };

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
  readonly sourceStreamId: string;
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
  if (
    !nonEmpty(value.adapter.id) ||
    !nonEmpty(value.adapter.version) ||
    !nonEmpty(value.runtime.surface) ||
    !Array.isArray(value.runtime.identifiers) ||
    !value.runtime.identifiers.every(isRuntimeIdentifier) ||
    !Array.isArray(value.runtime.versions) ||
    !value.runtime.versions.every(isVersionFact)
  ) {
    return invalid("Runtime descriptor runtime facts are invalid");
  }
  if (!value.capabilities.every(isCapabilityDeclaration)) {
    return invalid("Runtime descriptor capabilities are invalid");
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
  if (meta.correlation !== undefined && !isCorrelation(meta.correlation)) {
    return invalid("Record correlation is invalid");
  }
  if (value.kind === "snapshot") {
    if (!isSnapshot(value.snapshot)) return invalid("Snapshot payload is invalid");
  } else if (value.kind === "diagnostic-event") {
    if (!isCanonicalEvent(value.event)) return invalid("Diagnostic event payload is invalid");
  } else if (value.kind === "operation") {
    if (
      !isObject(meta.correlation) ||
      !nonEmpty(meta.correlation.operationId) ||
      !isOperationUpdate(value.operation)
    ) {
      return invalid("Operation payload or correlation is invalid");
    }
  } else {
    return invalid("Record kind is unknown");
  }
  return { ok: true, value: value as unknown as NoxscopeRecord };
}

export function validateOperationInput(value: unknown): Result<OperationInput> {
  if (!isObject(value) || !nonEmpty(value.kind)) return invalidInput();
  if (value.kind === "wallet.sync") {
    return ["start", "stop", "rescan"].includes(value.action as string)
      ? { ok: true, value: value as unknown as OperationInput }
      : invalidInput();
  }
  if (value.kind === "asset.transfer") {
    return nonEmpty(value.to) &&
      nonEmpty(value.assetId) &&
      typeof value.amount === "string" &&
      unsignedDecimal.test(value.amount) &&
      ["shielded", "unshielded", "dust"].includes(value.domain as string)
      ? { ok: true, value: value as unknown as OperationInput }
      : invalidInput();
  }
  if (
    ["transaction.balance", "transaction.prove", "transaction.sign", "transaction.submit"].includes(
      value.kind,
    )
  ) {
    return value.artifact !== undefined && isJsonValue(value.artifact)
      ? { ok: true, value: value as unknown as OperationInput }
      : invalidInput();
  }
  return isNamespacedId(value.kind, 3) && value.input !== undefined && isJsonValue(value.input)
    ? { ok: true, value: value as unknown as OperationInput }
    : invalidInput();
}

function invalid(message: string): Result<never> {
  return { ok: false, error: { code: "protocol", message, retryable: false } };
}

function invalidInput(): Result<never> {
  return {
    ok: false,
    error: { code: "invalid", message: "Operation input is invalid", retryable: false },
  };
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

function isRuntimeIdentifier(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmpty(value.scheme) &&
    nonEmpty(value.value) &&
    ["diagnostic-session", "installation", "reported"].includes(value.stability as string)
  );
}

function isVersionFact(value: unknown): boolean {
  return isObject(value) && nonEmpty(value.subject) && nonEmpty(value.version);
}

function isCapabilityDeclaration(value: unknown): boolean {
  if (
    !isObject(value) ||
    !nonEmpty(value.id) ||
    !["snapshot", "event", "operation"].includes(value.kind as string) ||
    !isObject(value.support) ||
    !isObject(value.availability)
  ) {
    return false;
  }
  if (!isCapabilityEvidence(value.support.evidence)) return false;
  if (value.support.state === "supported") {
    if (!nonEmpty(value.support.version)) return false;
  } else if (value.support.state === "unsupported") {
    if (!nonEmpty(value.support.reason)) return false;
  } else {
    return false;
  }
  return isCapabilityAvailability(value.availability);
}

function isCapabilityEvidence(value: unknown): boolean {
  return (
    isObject(value) &&
    [
      "runtime-declaration",
      "handshake",
      "probe",
      "static-wire-contract",
      "adapter-derivation",
    ].includes(value.source as string) &&
    validTime(value.observedAt) &&
    nonEmpty(value.summary)
  );
}

function isCapabilityAvailability(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.state === "available") return true;
  return (
    ["degraded", "unavailable"].includes(value.state as string) &&
    nonEmpty(value.reason) &&
    typeof value.retryable === "boolean" &&
    (value.retryAfterMs === undefined || nonNegativeFinite(value.retryAfterMs))
  );
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCorrelation(value: unknown): boolean {
  if (!isObject(value)) return false;
  const identifiersValid = ["requestId", "operationId", "parentOperationId", "traceId"].every(
    (key) => value[key] === undefined || nonEmpty(value[key]),
  );
  return (
    identifiersValid &&
    (value.causedBySequence === undefined ||
      (typeof value.causedBySequence === "string" && unsignedDecimal.test(value.causedBySequence)))
  );
}

function isSnapshot(value: unknown): boolean {
  if (!isObject(value) || !nonEmpty(value.revision) || !isFreshness(value.freshness)) return false;
  if (value.lifecycle !== undefined && !isLifecycle(value.lifecycle)) return false;
  if (value.identity !== undefined && !isWalletIdentity(value.identity)) return false;
  if (value.network !== undefined && !isNetwork(value.network)) return false;
  if (value.sync !== undefined && !isSync(value.sync)) return false;
  if (value.balances !== undefined && !isArrayOf(value.balances, isBalance)) return false;
  if (value.addresses !== undefined && !isArrayOf(value.addresses, isAddress)) return false;
  if (value.dust !== undefined && !isDust(value.dust)) return false;
  if (value.transactions !== undefined && !isArrayOf(value.transactions, isTransaction))
    return false;
  if (value.dependencies !== undefined && !isArrayOf(value.dependencies, isDependency))
    return false;
  return value.raw === undefined || isRawDetails(value.raw);
}

function isFreshness(value: unknown): boolean {
  return (
    isObject(value) &&
    ["fresh", "stale", "unknown"].includes(value.state as string) &&
    validTime(value.observedAt) &&
    validTime(value.receivedAt) &&
    ["runtime", "adapter"].includes(value.source as string) &&
    nonNegativeInteger(value.consecutiveFailures) &&
    (value.pollingIntervalMs === undefined || nonNegativeFinite(value.pollingIntervalMs)) &&
    (value.lastSuccessAt === undefined || validTime(value.lastSuccessAt))
  );
}

function isLifecycle(value: unknown): boolean {
  return (
    isObject(value) &&
    ["starting", "ready", "locked", "stopping", "stopped", "unknown"].includes(
      value.state as string,
    )
  );
}

function isWalletIdentity(value: unknown): boolean {
  return (
    isObject(value) &&
    (value.account === undefined || nonEmpty(value.account)) &&
    (value.walletName === undefined || nonEmpty(value.walletName))
  );
}

function isNetwork(value: unknown): boolean {
  return isObject(value) && nonEmpty(value.id);
}

function isSync(value: unknown): boolean {
  return (
    isObject(value) &&
    ["idle", "syncing", "synced", "stalled", "unknown"].includes(value.state as string) &&
    (value.percentage === undefined || isPercentage(value.percentage)) &&
    (value.etaSeconds === undefined ||
      value.etaSeconds === null ||
      nonNegativeFinite(value.etaSeconds)) &&
    (value.domains === undefined || isArrayOf(value.domains, isSyncDomain))
  );
}

function isSyncDomain(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmpty(value.domain) &&
    ["pending", "syncing", "synced", "stalled", "unknown"].includes(value.state as string) &&
    (value.percentage === undefined || isPercentage(value.percentage))
  );
}

function isBalance(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmpty(value.assetId) &&
    nonEmpty(value.domain) &&
    typeof value.amount === "string" &&
    unsignedDecimal.test(value.amount)
  );
}

function isAddress(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmpty(value.domain) &&
    nonEmpty(value.value) &&
    (value.account === undefined || nonEmpty(value.account))
  );
}

function isDust(value: unknown): boolean {
  return (
    isObject(value) &&
    ["unregistered", "registering", "registered", "unknown"].includes(value.state as string) &&
    (value.progress === undefined || isPercentage(value.progress))
  );
}

function isTransaction(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmpty(value.id) &&
    ["pending", "confirmed", "failed", "unknown"].includes(value.state as string)
  );
}

function isDependency(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmpty(value.role) &&
    ["connected", "degraded", "disconnected", "unknown"].includes(value.state as string) &&
    (value.endpoint === undefined || nonEmpty(value.endpoint))
  );
}

function isCanonicalEvent(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "diagnostic") {
    return (
      nonEmpty(value.name) &&
      nonEmpty(value.category) &&
      ["trace", "debug", "info", "warn", "error"].includes(value.level as string) &&
      ["runtime", "adapter"].includes(value.source as string) &&
      (value.message === undefined || typeof value.message === "string") &&
      (value.attributes === undefined || isJsonValue(value.attributes)) &&
      (value.raw === undefined || isRawDetails(value.raw))
    );
  }
  if (value.type === "capability-availability") {
    return nonEmpty(value.capabilityId) && isCapabilityAvailability(value.availability);
  }
  if (value.type === "stream-gap") {
    return (
      nonEmpty(value.sourceStreamId) &&
      typeof value.firstLostSequence === "string" &&
      unsignedDecimal.test(value.firstLostSequence) &&
      typeof value.lastLostSequence === "string" &&
      unsignedDecimal.test(value.lastLostSequence) &&
      BigInt(value.firstLostSequence) <= BigInt(value.lastLostSequence) &&
      ["overflow", "source-gap", "reconnect"].includes(value.reason as string)
    );
  }
  return false;
}

function isOperationUpdate(value: unknown): boolean {
  if (
    !isObject(value) ||
    !nonEmpty(value.kind) ||
    !nonEmpty(value.phase) ||
    !["running", "succeeded", "failed", "cancelled"].includes(value.state as string) ||
    (value.progress !== undefined && !isPercentage(value.progress)) ||
    (value.result !== undefined && !isJsonValue(value.result)) ||
    (value.error !== undefined && !isNoxscopeError(value.error)) ||
    (value.raw !== undefined && !isRawDetails(value.raw))
  ) {
    return false;
  }
  return value.state !== "failed" || value.error !== undefined;
}

function isNoxscopeError(value: unknown): boolean {
  return (
    isObject(value) &&
    [
      "unsupported",
      "unavailable",
      "incompatible",
      "unauthorized",
      "timeout",
      "cancelled",
      "invalid",
      "rejected",
      "failed",
      "protocol",
      "overflow",
      "internal",
    ].includes(value.code as string) &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    (value.retryAfterMs === undefined || nonNegativeFinite(value.retryAfterMs)) &&
    (value.capability === undefined || nonEmpty(value.capability)) &&
    (value.raw === undefined || isRawDetails(value.raw))
  );
}

function isRawDetails(value: unknown): boolean {
  return isArrayOf(value, (detail) => {
    if (
      !isObject(detail) ||
      !isNamespacedId(detail.namespace, 2) ||
      !nonEmpty(detail.schemaVersion) ||
      !isJsonValue(detail.value) ||
      !isObject(detail.sanitization) ||
      !nonEmpty(detail.sanitization.policy) ||
      !nonEmpty(detail.sanitization.policyVersion) ||
      !Array.isArray(detail.sanitization.redactions)
    ) {
      return false;
    }
    return detail.sanitization.redactions.every(
      (redaction) =>
        isObject(redaction) &&
        nonEmpty(redaction.path) &&
        ["secret", "key-material", "private-payload", "policy"].includes(
          redaction.reason as string,
        ),
    );
  });
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isPercentage(value: unknown): value is number {
  return nonNegativeFinite(value) && value <= 100;
}

function nonNegativeInteger(value: unknown): value is number {
  return nonNegativeFinite(value) && Number.isInteger(value);
}

function isNamespacedId(value: unknown, minimumSegments: number): value is string {
  if (!nonEmpty(value)) return false;
  const segments = value.split(".");
  return (
    segments.length >= minimumSegments &&
    segments.every((segment) => /^[a-z][a-z0-9-]*$/i.test(segment))
  );
}
