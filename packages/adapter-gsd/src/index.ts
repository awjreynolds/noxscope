import {
  createSanitizer,
  type AdapterSanitizationManifest,
  type SanitizedProjection,
} from "@noxscope/core";
import {
  NOXSCOPE_PROTOCOL,
  validateOperationInput,
  validateRecord,
  type CapabilityDeclaration,
  type ConnectOptions,
  type DiagnosticEventRecord,
  type InvokeRequest,
  type NoxscopeAdapter,
  type NoxscopeError,
  type NoxscopeRecord,
  type OperationRecord,
  type OperationTerminal,
  type RequestOptions,
  type Result,
  type RuntimeDescriptor,
  type RuntimeSession,
  type Snapshot,
  type SnapshotRecord,
  type SnapshotRequest,
  type CancelRequest,
} from "@noxscope/protocol";
import { GSD_SANITIZATION_MANIFEST } from "./manifest.js";

export { GSD_SANITIZATION_MANIFEST, GSD_SOURCE_COMMIT } from "./manifest.js";

export const GSD_TRANSPORT_VERSION = "gsd/1" as const;
export const GSD_ADAPTER_ID = "org.noxscope.adapter-gsd" as const;
export const GSD_ADAPTER_VERSION = "0.1.0" as const;

export type GsdRequestType = "describe" | "getState" | "invoke" | "cancel";

export interface GsdRequest {
  readonly version: typeof GSD_TRANSPORT_VERSION;
  readonly id: string;
  readonly type: GsdRequestType;
  readonly payload?: unknown;
}

export interface GsdTransportConnection extends AsyncIterable<unknown> {
  describe(): Promise<unknown>;
  request(request: GsdRequest): Promise<unknown>;
  cancel?(requestId: string): void;
  close?(): Promise<void> | void;
}

export interface GsdTransport {
  open(options: { readonly signal: AbortSignal }): Promise<Result<GsdTransportConnection>>;
}

export interface GsdAdapterOptions {
  readonly transport: GsdTransport;
  readonly now?: () => string;
  /** Inject a recording-scoped key in tests; it is never serialized. */
  readonly pseudonymKey?: Uint8Array;
  readonly queueCapacity?: number;
  readonly sessionId?: () => string;
}

export interface GsdNativeMessage {
  readonly version: string;
  readonly type: string;
  readonly stream?: "state" | "events" | "operations" | string;
  readonly sequence?: string | number;
  readonly observedAt?: string;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly payload?: unknown;
}

export interface GsdMessagePort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

/**
 * Create a browser-compatible transport for a MessagePort, Worker, or
 * extension port with the small postMessage/addEventListener surface. Native
 * framing and request correlation remain inside this adapter.
 */
export function createGsdMessagePortTransport(
  port: GsdMessagePort,
  options: { readonly timeoutMs?: number } = {},
): GsdTransport {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    async open({ signal }) {
      if (signal.aborted) return cancelled("GSD transport open was cancelled");
      return { ok: true, value: new MessagePortConnection(port, signal, timeoutMs) };
    },
  };
}

export function createGsdAdapter(options: GsdAdapterOptions): NoxscopeAdapter {
  const sanitizer = createSanitizer();
  const now = options.now ?? (() => new Date().toISOString());
  const pseudonymKey = copyPseudonymKey(options.pseudonymKey ?? randomKey());
  const makeSessionId = options.sessionId ?? (() => randomId("gsd-session"));
  const capacity = clampCapacity(options.queueCapacity ?? 128);

  return {
    async connect(connectOptions: ConnectOptions): Promise<Result<RuntimeSession>> {
      if (connectOptions.signal.aborted) return cancelled("GSD connection was cancelled");
      let opened: Result<GsdTransportConnection>;
      let openPromise: Promise<Result<GsdTransportConnection>>;
      try {
        openPromise = options.transport.open({ signal: connectOptions.signal });
        const openedRace = await awaitOrAbort(openPromise, connectOptions.signal);
        if (openedRace.state === "aborted") {
          void openPromise.then(
            (late) => {
              if (late.ok) void closeQuietly(late.value);
            },
            () => undefined,
          );
          return cancelled("GSD connection was cancelled");
        }
        opened = openedRace.value;
      } catch {
        return transportError("GSD transport could not be opened", true);
      }
      if (!opened.ok) return opened;

      const described = await describeRuntime(
        opened.value,
        sanitizer,
        pseudonymKey,
        now,
        connectOptions.signal,
      );
      if (!described.ok) {
        await closeQuietly(opened.value);
        return described;
      }
      if (connectOptions.signal.aborted) {
        await closeQuietly(opened.value);
        return cancelled("GSD handshake was cancelled");
      }
      const sessionId = makeSessionId();
      if (!isSafeId(sessionId)) {
        await closeQuietly(opened.value);
        return invalid("GSD session id is invalid");
      }
      return {
        ok: true,
        value: new GsdRuntimeSession(
          opened.value,
          described.value.descriptor,
          sessionId,
          connectOptions.signal,
          sanitizer,
          pseudonymKey,
          now,
          capacity,
        ),
      };
    },
  };
}

class GsdRuntimeSession implements RuntimeSession {
  readonly descriptor: RuntimeDescriptor;
  readonly #connection: GsdTransportConnection;
  readonly #signal: AbortSignal;
  readonly #sanitizer = createSanitizer();
  readonly #manifest: AdapterSanitizationManifest = GSD_SANITIZATION_MANIFEST;
  readonly #pseudonymKey: Uint8Array;
  readonly #now: () => string;
  readonly #queue: RecordQueue<NoxscopeRecord>;
  readonly #streams = new Map<string, StreamState>();
  readonly #operations = new Map<string, { readonly kind: string; readonly terminal: boolean }>();
  #revision = 0;
  #closed = false;

  constructor(
    connection: GsdTransportConnection,
    descriptor: RuntimeDescriptor,
    sessionId: string,
    signal: AbortSignal,
    sanitizer: ReturnType<typeof createSanitizer>,
    pseudonymKey: Uint8Array,
    now: () => string,
    capacity: number,
  ) {
    this.#connection = connection;
    this.#signal = signal;
    this.#pseudonymKey = pseudonymKey;
    this.#now = now;
    this.#queue = new RecordQueue(capacity);
    this.#sanitizer = sanitizer;
    this.descriptor = { ...descriptor, sessionId };
    signal.addEventListener("abort", () => void this.close(), { once: true });
    void this.#pump();
  }

  [Symbol.asyncIterator](): AsyncIterator<NoxscopeRecord> {
    return this.#queue.iterator();
  }

  request(request: SnapshotRequest, options?: RequestOptions): Promise<Result<Snapshot>>;
  request(request: InvokeRequest, options?: RequestOptions): Promise<Result<OperationTerminal>>;
  request(
    request: CancelRequest,
    options?: RequestOptions,
  ): Promise<Result<{ readonly accepted: boolean }>>;
  async request(
    request: SnapshotRequest | InvokeRequest | CancelRequest,
    options?: RequestOptions,
  ): Promise<Result<Snapshot | OperationTerminal | { readonly accepted: boolean }>> {
    if (this.#signal.aborted || options?.signal?.aborted || this.#closed) {
      return cancelled("GSD request was cancelled");
    }
    if (request.kind === "snapshot") {
      const response = await this.send(
        { version: GSD_TRANSPORT_VERSION, id: request.requestId, type: "getState" },
        options,
      );
      if (!response.ok) return response;
      if (this.#signal.aborted || options?.signal?.aborted || this.#closed) {
        return cancelled("GSD request was cancelled");
      }
      const snapshot = await this.mapSnapshotResponse(response.value, request.requestId);
      return snapshot;
    }
    if (request.kind === "cancel") {
      // GSD's existing worker request seam does not provide an evidenced,
      // portable cancellation capability. Do not send a cancellation that
      // could be mistaken for stopping wallet work.
      return { ok: true, value: { accepted: false } };
    }
    const checked = validateOperationInput(request.operation);
    if (!checked.ok) return checked;
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: "GSD Adapter exposes no automatic wallet mutation operations",
        retryable: false,
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#connection.close?.();
    } catch {
      // Closing an observation transport is best effort and never echoes a
      // native exception into the canonical stream.
    }
    this.#queue.close();
  }

  async #pump(): Promise<void> {
    try {
      for await (const native of this.#connection) {
        if (this.#signal.aborted || this.#closed) break;
        await this.ingest(native);
      }
      if (!this.#closed && !this.#signal.aborted) {
        this.emitDiagnostic(
          "gsd.transport.closed",
          "network",
          "warn",
          "GSD transport closed while observation was active",
          "events",
        );
      }
    } catch {
      if (!this.#closed && !this.#signal.aborted) {
        this.emitDiagnostic(
          "gsd.transport.failed",
          "network",
          "error",
          "GSD transport failed while observation was active",
          "events",
        );
      }
    } finally {
      this.#queue.close();
    }
  }

  async ingest(native: unknown): Promise<void> {
    let sanitized: Result<SanitizedProjection>;
    try {
      sanitized = await this.#sanitizer.sanitize(native, this.#manifest, {
        pseudonymKey: this.#pseudonymKey,
      });
    } catch {
      this.emitDiagnostic(
        "gsd.adapter.rejected",
        "storage",
        "warn",
        "GSD message could not be safely inspected",
        "events",
      );
      return;
    }
    if (!sanitized.ok) {
      this.emitDiagnostic(
        sanitized.error.code === "overflow" ? "gsd.adapter.overflow" : "gsd.adapter.rejected",
        "storage",
        sanitized.error.code === "overflow" ? "error" : "warn",
        sanitized.error.code === "overflow"
          ? "GSD message exceeded the adapter resource limit"
          : "GSD message did not satisfy the checked-in adapter manifest",
        "events",
      );
      return;
    }
    const envelope = objectAt(sanitized.value.value, "envelope");
    const type = canonicalMessageType(stringAt(envelope, "type"));
    const version = stringAt(envelope, "version");
    if (version !== GSD_TRANSPORT_VERSION || type === undefined) {
      this.emitDiagnostic(
        "gsd.protocol.invalid",
        "network",
        "error",
        "GSD message version or type is invalid",
        "events",
      );
      return;
    }
    const stream = canonicalStream(stringAt(envelope, "stream")) ?? streamFor(type);
    const sequence = parseSourceSequence(envelope?.sequence);
    if (type === "reconnect") {
      this.resetNativeSequences();
    } else if (sequence !== undefined && this.noteSourceGap(stream, sequence)) {
      return;
    }
    const observedAt = validTime(stringAt(envelope, "observedAt"))
      ? (stringAt(envelope, "observedAt") as string)
      : this.#now();
    const requestId = stringAt(envelope, "requestId");
    const operationId = stringAt(envelope, "operationId");
    const correlation =
      requestId === undefined && operationId === undefined
        ? undefined
        : {
            ...(requestId === undefined ? {} : { requestId }),
            ...(operationId === undefined ? {} : { operationId }),
          };
    if (type === "state") {
      const snapshot = this.mapSnapshot(sanitized.value, observedAt);
      if (snapshot !== undefined) {
        this.emitSnapshot(snapshot, stream, observedAt, correlation);
      } else {
        this.emitDiagnostic(
          "gsd.state.rejected",
          "wallet",
          "warn",
          "GSD state did not contain a valid canonical projection",
          stream,
          observedAt,
          correlation,
        );
      }
      return;
    }
    if (type === "reconnect") {
      this.emitGap(stream, "reconnect", observedAt);
      this.emitDiagnostic(
        "gsd.transport.reconnected",
        "network",
        "info",
        "GSD transport reconnected; source continuity must be re-established",
        "events",
        observedAt,
      );
      return;
    }
    if (type === "heartbeat") return;
    if (type === "ready") {
      this.emitDiagnostic(
        "gsd.runtime.ready",
        "wallet",
        "info",
        "GSD runtime is ready",
        stream,
        observedAt,
        correlation,
      );
      return;
    }
    if (type === "overflow") {
      this.emitDiagnostic(
        "gsd.runtime.overflow",
        "storage",
        "error",
        "GSD runtime reported an overflow",
        stream,
        observedAt,
        correlation,
      );
      return;
    }
    const diagnostic = await this.mapDiagnostic(sanitized.value, type, observedAt, correlation);
    if (diagnostic === undefined) return;
    if (diagnostic.kind === "operation") this.pushRecord(diagnostic);
    else this.pushRecord(diagnostic);
  }

  private mapSnapshot(value: SanitizedProjection, observedAt: string): Snapshot | undefined {
    const canonical = objectAt(value.value, "canonical");
    if (canonical === undefined) return undefined;
    const sync = mapSync(canonical);
    const balances = mapBalances(canonical);
    const addresses = mapAddresses(canonical);
    const dependencies = mapDependencies(canonical);
    const lifecycle = lifecycleState(stringAt(canonical, "lifecycle"));
    const networkId = stringAt(canonical, "network");
    const account = stringAt(canonical, "account");
    const snapshot: Snapshot = {
      revision: String(++this.#revision),
      freshness: {
        state: "fresh",
        observedAt,
        receivedAt: this.#now(),
        source: "runtime",
        consecutiveFailures: 0,
        lastSuccessAt: observedAt,
      },
      ...(lifecycle === undefined ? {} : { lifecycle: { state: lifecycle } }),
      ...(networkId === undefined ? {} : { network: { id: networkId } }),
      ...(account === undefined ? {} : { identity: { account } }),
      ...(sync === undefined ? {} : { sync }),
      ...(balances === undefined ? {} : { balances }),
      ...(addresses === undefined ? {} : { addresses }),
      ...(dependencies === undefined ? {} : { dependencies }),
    };
    const checked = validateRecord({
      kind: "snapshot",
      meta: meta(this.descriptor, `${this.#revision}`, observedAt, "state", this.#now()),
      snapshot,
    });
    return checked.ok && checked.value.kind === "snapshot" ? checked.value.snapshot : undefined;
  }

  private async mapSnapshotResponse(value: unknown, requestId: string): Promise<Result<Snapshot>> {
    let sanitized: Result<SanitizedProjection>;
    try {
      sanitized = await this.#sanitizer.sanitize(value, this.#manifest, {
        pseudonymKey: this.#pseudonymKey,
      });
    } catch {
      return invalid("GSD snapshot response could not be safely inspected");
    }
    if (!sanitized.ok) return sanitized;
    const snapshot = this.mapSnapshot(sanitized.value, this.#now());
    if (snapshot === undefined) {
      return invalid("GSD snapshot response is invalid");
    }
    this.emitSnapshot(snapshot, "state", this.#now(), { requestId });
    return { ok: true, value: snapshot };
  }

  private async mapDiagnostic(
    sanitized: SanitizedProjection,
    type: string,
    observedAt: string,
    correlation: Record<string, string> | undefined,
  ): Promise<DiagnosticEventRecord | OperationRecord | undefined> {
    const diagnostic = objectAt(sanitized.value, "diagnostic");
    if (diagnostic === undefined) return undefined;
    const operationId = stringAt(diagnostic, "operationId") ?? correlation?.operationId;
    const requestId = stringAt(diagnostic, "requestId") ?? correlation?.requestId;
    const operationKind = stringAt(diagnostic, "kind");
    const phase = stringAt(diagnostic, "phase");
    const state = operationState(stringAt(diagnostic, "state"));
    if (
      operationId !== undefined &&
      operationKind !== undefined &&
      phase !== undefined &&
      state !== undefined
    ) {
      const prior = this.#operations.get(operationId);
      if (prior !== undefined && (prior.terminal || prior.kind !== operationKind)) return undefined;
      const error = mapError(objectAt(diagnostic, "error"), state);
      const progress = numberAt(diagnostic, "progress");
      const operation: OperationRecord = {
        kind: "operation",
        meta: {
          ...meta(this.descriptor, "0", observedAt, "operations", this.#now()),
          correlation: {
            operationId,
            ...(requestId === undefined ? {} : { requestId }),
          },
        },
        operation: {
          kind: operationKind,
          phase,
          state,
          ...(progress === undefined ? {} : { progress }),
          ...(error === undefined ? {} : { error }),
        },
      };
      const checked = validateRecord(operation);
      if (!checked.ok || checked.value.kind !== "operation") return undefined;
      this.#operations.set(operationId, { kind: operationKind, terminal: state !== "running" });
      return this.withSequence(checked.value, "operations");
    }
    const raw = await this.mapRawDetail(sanitized);
    const message = stringAt(diagnostic, "message");
    const event: DiagnosticEventRecord = {
      kind: "diagnostic-event",
      meta: {
        ...meta(this.descriptor, "0", observedAt, "events", this.#now()),
        ...(correlation === undefined ? {} : { correlation }),
      },
      event: {
        type: "diagnostic",
        name: stringAt(diagnostic, "name") ?? `gsd.${type}`,
        category: stringAt(diagnostic, "category") ?? "sdk",
        level: diagnosticLevel(stringAt(diagnostic, "level")),
        source: "runtime",
        ...(message === undefined ? {} : { message }),
        ...(raw === undefined ? {} : { raw: [raw] }),
      },
    };
    const checked = validateRecord(event);
    return checked.ok && checked.value.kind === "diagnostic-event" ? checked.value : undefined;
  }

  private async mapRawDetail(sanitized: SanitizedProjection) {
    const input = objectAt(sanitized.value, "diagnosticDetail");
    if (input === undefined) return undefined;
    const raw = await this.#sanitizer.sanitizeRawDetail(input, this.#manifest, {
      pseudonymKey: this.#pseudonymKey,
    });
    if (!raw.ok) return undefined;
    return {
      ...raw.value,
      sanitization: {
        ...raw.value.sanitization,
        redactions: sanitized.audit.redactions,
      },
    };
  }

  private emitSnapshot(
    snapshot: Snapshot,
    stream: string,
    observedAt: string,
    correlation?: Record<string, string>,
  ): void {
    const record: SnapshotRecord = {
      kind: "snapshot",
      meta: {
        ...meta(this.descriptor, "0", observedAt, stream, this.#now()),
        ...(correlation === undefined ? {} : { correlation }),
      },
      snapshot,
    };
    this.pushRecord(this.withSequence(record, stream));
  }

  private emitDiagnostic(
    name: string,
    category: string,
    level: "trace" | "debug" | "info" | "warn" | "error",
    message: string,
    stream: string,
    observedAt = this.#now(),
    correlation?: Record<string, string>,
  ): void {
    const record: DiagnosticEventRecord = {
      kind: "diagnostic-event",
      meta: {
        ...meta(this.descriptor, "0", observedAt, stream, this.#now()),
        ...(correlation === undefined ? {} : { correlation }),
      },
      event: { type: "diagnostic", name, category, level, source: "adapter", message },
    };
    this.pushRecord(this.withSequence(record, stream));
  }

  private emitGap(
    stream: string,
    reason: "overflow" | "source-gap" | "reconnect",
    observedAt: string,
    firstLostSequence?: string,
    lastLostSequence?: string,
  ): void {
    const sourceStreamId = `${this.descriptor.sessionId}:${stream}`;
    const state = this.#streams.get(stream);
    const first =
      firstLostSequence ??
      (reason === "reconnect"
        ? "0"
        : state?.lastSource === undefined
          ? "0"
          : (state.lastSource + 1n).toString());
    const last =
      lastLostSequence ??
      (reason === "reconnect"
        ? first
        : state?.lastSource === undefined
          ? first
          : state.lastSource.toString());
    const record: DiagnosticEventRecord = {
      kind: "diagnostic-event",
      meta: meta(this.descriptor, "0", observedAt, "events", this.#now()),
      event: {
        type: "stream-gap",
        sourceStreamId,
        firstLostSequence: first,
        lastLostSequence: last,
        reason,
      },
    };
    this.pushRecord(this.withSequence(record, "events"));
  }

  private noteSourceGap(stream: string, sequence: bigint): boolean {
    const state = this.#streams.get(stream) ?? { next: 1n, lastSource: undefined };
    const previous = state.lastSource;
    state.lastSource = sequence;
    this.#streams.set(stream, state);
    if (previous !== undefined && sequence > previous + 1n) {
      this.emitGap(
        stream,
        "source-gap",
        this.#now(),
        (previous + 1n).toString(),
        (sequence - 1n).toString(),
      );
    }
    return previous !== undefined && sequence <= previous;
  }

  private resetNativeSequences(): void {
    for (const state of this.#streams.values()) state.lastSource = undefined;
  }

  private withSequence<T extends NoxscopeRecord>(record: T, stream: string): T {
    const state = this.#streams.get(stream) ?? { next: 1n, lastSource: undefined };
    const sequence = state.next.toString();
    state.next += 1n;
    this.#streams.set(stream, state);
    return {
      ...record,
      meta: { ...record.meta, streamId: `${this.descriptor.sessionId}:${stream}`, sequence },
    } as T;
  }

  private pushRecord(record: NoxscopeRecord): void {
    this.#queue.push(record, (dropped, incoming) => this.overflowRecords(dropped, incoming));
  }

  private overflowRecords(
    dropped: NoxscopeRecord,
    incoming: NoxscopeRecord,
  ): readonly NoxscopeRecord[] {
    const ranges = new Map<string, Array<[bigint, bigint]>>();
    addOverflowRanges(ranges, dropped);
    addOverflowRanges(ranges, incoming);
    const records: NoxscopeRecord[] = [];
    for (const [sourceStreamId, intervals] of ranges) {
      for (const [first, last] of intervals) {
        const gap: DiagnosticEventRecord = {
          kind: "diagnostic-event",
          meta: meta(this.descriptor, "0", this.#now(), "events", this.#now()),
          event: {
            type: "stream-gap",
            sourceStreamId,
            firstLostSequence: first.toString(),
            lastLostSequence: last.toString(),
            reason: "overflow",
          },
        };
        records.push(this.withSequence(gap, "events"));
      }
    }
    return records;
  }

  private async send(request: GsdRequest, options?: RequestOptions): Promise<Result<unknown>> {
    if (options?.signal?.aborted || this.#signal.aborted)
      return cancelled("GSD request was cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signals = [options?.signal, this.#signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    let abort: (() => void) | undefined;
    try {
      const abortPromise = new Promise<never>((_, reject) => {
        abort = () => reject(new AdapterAbortError());
        for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        if (options?.timeoutMs === undefined) return;
        timer = setTimeout(() => reject(new AdapterTimeoutError()), options.timeoutMs);
      });
      const response = await Promise.race([
        this.#connection.request(request),
        abortPromise,
        timeoutPromise,
      ]);
      return { ok: true, value: response };
    } catch (error) {
      if (error instanceof AdapterAbortError) {
        cancelQuietly(this.#connection, request.id);
        return cancelled("GSD request was cancelled");
      }
      if (error instanceof AdapterTimeoutError) {
        cancelQuietly(this.#connection, request.id);
        return {
          ok: false,
          error: { code: "timeout", message: "GSD request timed out", retryable: true },
        };
      }
      return transportError("GSD request failed", true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort !== undefined) {
        for (const signal of signals) signal.removeEventListener("abort", abort);
      }
    }
  }
}

class AdapterAbortError extends Error {
  constructor() {
    super("aborted");
  }
}

class AdapterTimeoutError extends Error {
  constructor() {
    super("timeout");
  }
}

interface StreamState {
  next: bigint;
  lastSource: bigint | undefined;
}

function addOverflowRanges(
  ranges: Map<string, Array<[bigint, bigint]>>,
  record: NoxscopeRecord,
): void {
  if (record.kind === "diagnostic-event" && record.event.type === "stream-gap") {
    addOverflowRange(
      ranges,
      record.event.sourceStreamId,
      BigInt(record.event.firstLostSequence),
      BigInt(record.event.lastLostSequence),
    );
    return;
  }
  addOverflowRange(
    ranges,
    record.meta.streamId,
    BigInt(record.meta.sequence),
    BigInt(record.meta.sequence),
  );
}

function addOverflowRange(
  ranges: Map<string, Array<[bigint, bigint]>>,
  sourceStreamId: string,
  first: bigint,
  last: bigint,
): void {
  const intervals = ranges.get(sourceStreamId) ?? [];
  let nextFirst = first;
  let nextLast = last;
  const retained: Array<[bigint, bigint]> = [];
  for (const [existingFirst, existingLast] of intervals) {
    if (existingLast + 1n < nextFirst || nextLast + 1n < existingFirst) {
      retained.push([existingFirst, existingLast]);
      continue;
    }
    nextFirst = nextFirst < existingFirst ? nextFirst : existingFirst;
    nextLast = nextLast > existingLast ? nextLast : existingLast;
  }
  retained.push([nextFirst, nextLast]);
  retained.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  ranges.set(sourceStreamId, retained);
}

class RecordQueue<T> {
  readonly #capacity: number;
  readonly #buffer: T[] = [];
  readonly #pending: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  push(record: T, overflowRecords: (dropped: T, incoming: T) => readonly T[]): void {
    if (this.#closed) return;
    if (this.#waiting !== undefined) {
      const resolve = this.#waiting;
      this.#waiting = undefined;
      resolve({ done: false, value: record });
      return;
    }
    if (this.#buffer.length >= this.#capacity) {
      const dropped = this.#buffer.shift();
      if (dropped !== undefined) this.#pending.push(...overflowRecords(dropped, record));
      return;
    }
    this.#buffer.push(record);
  }

  close(): void {
    this.#closed = true;
    this.#finishWaiting();
  }

  iterator(): AsyncIterator<T> {
    let detached = false;
    return {
      next: async () => {
        if (detached) return { done: true, value: undefined };
        const pending = this.#pending.shift();
        if (pending !== undefined) return { done: false, value: pending };
        const next = this.#buffer.shift();
        if (next !== undefined) return { done: false, value: next };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: async () => {
        detached = true;
        this.#finishWaiting();
        return { done: true, value: undefined };
      },
    };
  }

  #finishWaiting(): void {
    const resolve = this.#waiting;
    this.#waiting = undefined;
    resolve?.({ done: true, value: undefined });
  }
}

class MessagePortConnection implements GsdTransportConnection {
  readonly #port: GsdMessagePort;
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #messages = new RecordQueue<unknown>(256);
  readonly #listener: (event: { readonly data: unknown }) => void;

  constructor(port: GsdMessagePort, signal: AbortSignal, timeoutMs: number) {
    this.#port = port;
    this.#signal = signal;
    this.#timeoutMs = timeoutMs;
    this.#listener = (event) => this.receive(event.data);
    port.addEventListener("message", this.#listener);
    port.start?.();
    signal.addEventListener(
      "abort",
      () => {
        try {
          this.close();
        } catch {
          // A hostile port must not escape through the caller's abort event.
        }
      },
      { once: true },
    );
  }

  describe(): Promise<unknown> {
    return this.request({
      version: GSD_TRANSPORT_VERSION,
      id: randomId("describe"),
      type: "describe",
    });
  }

  request(request: GsdRequest): Promise<unknown> {
    if (this.#signal.aborted) return Promise.reject(new Error("cancelled"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(new Error("timeout"));
      }, this.#timeoutMs);
      this.#pending.set(request.id, { resolve, reject, timer });
      try {
        this.#port.postMessage(request);
      } catch (error) {
        this.#pending.delete(request.id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  cancel(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(new Error("cancelled"));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    const iterator = this.#messages.iterator();
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  close(): void {
    this.#port.removeEventListener("message", this.#listener);
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("closed"));
      this.#pending.delete(id);
    }
    this.#messages.close();
    this.#port.close?.();
  }

  private receive(value: unknown): void {
    try {
      if (!isPlainObject(value)) return;
      const id = typeof value.id === "string" ? value.id : undefined;
      if (
        id !== undefined &&
        this.#pending.has(id) &&
        (value.kind === "response" || value.type === "response")
      ) {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(value.payload);
        return;
      }
      this.#messages.push(value, () => [
        {
          version: GSD_TRANSPORT_VERSION,
          type: "overflow",
          stream: "events",
          payload: { source: "message-port-queue" },
        },
      ]);
    } catch {
      this.#messages.push(
        {
          version: GSD_TRANSPORT_VERSION,
          type: "overflow",
          stream: "events",
          payload: { source: "message-port-inspection" },
        },
        () => [],
      );
    }
  }
}

interface DescribedRuntime {
  readonly descriptor: RuntimeDescriptor;
}

async function describeRuntime(
  connection: GsdTransportConnection,
  sanitizer: ReturnType<typeof createSanitizer>,
  pseudonymKey: Uint8Array,
  now: () => string,
  signal: AbortSignal,
): Promise<Result<DescribedRuntime>> {
  let native: unknown;
  let describePromise: Promise<unknown>;
  try {
    describePromise = connection.describe();
    const describedRace = await awaitOrAbort(describePromise, signal);
    if (describedRace.state === "aborted") return cancelled("GSD handshake was cancelled");
    native = describedRace.value;
  } catch {
    return transportError("GSD runtime handshake failed", true);
  }
  let sanitized: Result<SanitizedProjection>;
  try {
    sanitized = await sanitizer.sanitize(native, GSD_SANITIZATION_MANIFEST, {
      pseudonymKey,
    });
  } catch {
    return invalid("GSD runtime handshake did not satisfy the adapter manifest");
  }
  if (!sanitized.ok) return invalid("GSD runtime handshake did not satisfy the adapter manifest");
  const envelope = objectAt(sanitized.value.value, "envelope");
  if (stringAt(envelope, "version") !== GSD_TRANSPORT_VERSION) {
    return invalid("GSD runtime handshake has an incompatible protocol");
  }
  const runtime = objectAt(sanitized.value.value, "runtime");
  const id = stringAt(runtime, "id");
  if (id === undefined || !isSafeId(id))
    return invalid("GSD runtime handshake has no valid identity");
  const surface = stringAt(runtime, "surface") ?? "worker";
  const name = stringAt(runtime, "name");
  const walletVersion = stringAt(runtime, "walletVersion");
  const sdkVersion = stringAt(runtime, "sdkVersion");
  const versions = [
    { subject: "gsd-protocol", version: GSD_TRANSPORT_VERSION },
    ...(walletVersion === undefined ? [] : [{ subject: "gsd-wallet", version: walletVersion }]),
    ...(sdkVersion === undefined ? [] : [{ subject: "midnight-sdk", version: sdkVersion }]),
  ];
  const observedAt = now();
  const descriptor: RuntimeDescriptor = {
    protocol: NOXSCOPE_PROTOCOL,
    sessionId: "pending",
    runtimeId: id,
    adapter: { id: GSD_ADAPTER_ID, version: GSD_ADAPTER_VERSION },
    runtime: {
      surface,
      ...(name === undefined ? {} : { name }),
      identifiers: [{ scheme: "gsd-runtime", value: id, stability: "installation" }],
      versions,
    },
    capabilities: capabilities(observedAt),
  };
  return { ok: true, value: { descriptor } };
}

function capabilities(observedAt: string): CapabilityDeclaration[] {
  const evidence = {
    source: "static-wire-contract" as const,
    observedAt,
    summary: "GSD worker/GSD Connect boundary reviewed at the pinned source commit",
  };
  return [
    supported("sync.observe", "snapshot", evidence),
    supported("balances.read", "snapshot", evidence),
    supported("diagnostics.observe", "event", evidence),
    unsupported(
      "operation.submit",
      "operation",
      evidence,
      "GSD mutation is intentionally not exposed",
    ),
    unsupported(
      "operation.prove",
      "operation",
      evidence,
      "GSD mutation is intentionally not exposed",
    ),
    unsupported(
      "operation.cancel",
      "operation",
      evidence,
      "Cancellation is not evidenced by the GSD seam",
    ),
  ];
}

function supported(
  id: string,
  kind: CapabilityDeclaration["kind"],
  evidence: CapabilityDeclaration["support"]["evidence"],
): CapabilityDeclaration {
  return {
    id,
    kind,
    support: { state: "supported", version: "1", evidence },
    availability: { state: "available" },
  };
}

function unsupported(
  id: string,
  kind: CapabilityDeclaration["kind"],
  evidence: CapabilityDeclaration["support"]["evidence"],
  reason: string,
): CapabilityDeclaration {
  return {
    id,
    kind,
    support: { state: "unsupported", reason, evidence },
    availability: { state: "unavailable", reason: "Capability is unsupported", retryable: false },
  };
}

function mapSync(canonical: Record<string, unknown>): Snapshot["sync"] {
  const source = objectAt(canonical, "sync");
  if (source === undefined) return undefined;
  const domains = (["shielded", "unshielded", "dust"] as const).flatMap((domain) => {
    const item = objectAt(source, domain);
    const state = syncDomainState(stringAt(item, "state"));
    if (item === undefined || state === undefined) return [];
    const percentage = numberAt(item, "percentage");
    return [{ domain, state, ...(percentage === undefined ? {} : { percentage }) }];
  });
  if (domains.length === 0) return undefined;
  const state = domains.some((domain) => domain.state === "stalled")
    ? "stalled"
    : domains.every((domain) => domain.state === "synced")
      ? "synced"
      : domains.some((domain) => domain.state === "syncing")
        ? "syncing"
        : "unknown";
  const percentages = domains.flatMap((domain) =>
    domain.percentage === undefined ? [] : [domain.percentage],
  );
  return {
    state,
    ...(percentages.length === 0 ? {} : { percentage: Math.min(...percentages) }),
    domains,
  };
}

function mapBalances(canonical: Record<string, unknown>): Snapshot["balances"] {
  const source = objectAt(canonical, "balances");
  if (source === undefined) return undefined;
  return (["shielded", "unshielded", "dust"] as const).flatMap((domain) => {
    const item = objectAt(source, domain);
    const assetId = stringAt(item, "assetId");
    const amount = stringAt(item, "amount");
    return assetId !== undefined && amount !== undefined && /^(0|[1-9]\d*)$/u.test(amount)
      ? [{ domain, assetId, amount }]
      : [];
  });
}

function mapAddresses(canonical: Record<string, unknown>): Snapshot["addresses"] {
  const source = objectAt(canonical, "addresses");
  if (source === undefined) return undefined;
  return (["shielded", "unshielded", "dust"] as const).flatMap((domain) => {
    const value = stringAt(source, domain);
    return value === undefined ? [] : [{ domain, value }];
  });
}

function mapDependencies(canonical: Record<string, unknown>): Snapshot["dependencies"] {
  const source = objectAt(canonical, "dependencies");
  if (source === undefined) return undefined;
  return (["node", "indexer", "prover"] as const).flatMap((role) => {
    const value = dependencyState(stringAt(source, role));
    return value === undefined ? [] : [{ role, state: value }];
  });
}

function mapError(
  value: Record<string, unknown> | undefined,
  state: string,
): NoxscopeError | undefined {
  if (state !== "failed") return undefined;
  const code = stringAt(value, "code");
  const message = stringAt(value, "message");
  return {
    code: isErrorCode(code) ? code : "failed",
    message: message ?? "GSD operation failed",
    retryable: value?.retryable === true,
  };
}

function meta(
  descriptor: RuntimeDescriptor,
  sequence: string,
  observedAt: string,
  stream: string,
  receivedAt: string,
) {
  return {
    protocol: NOXSCOPE_PROTOCOL,
    sessionId: descriptor.sessionId,
    runtimeId: descriptor.runtimeId,
    streamId: `${descriptor.sessionId}:${stream}`,
    sequence,
    observedAt,
    receivedAt,
  } as const;
}

function objectAt(value: unknown, path: string): Record<string, unknown> | undefined {
  const found = readPath(value, path);
  return isPlainObject(found) ? found : undefined;
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stringAt(value: unknown, key: string): string | undefined {
  const found = isPlainObject(value) ? value[key] : undefined;
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  const found = isPlainObject(value) ? value[key] : undefined;
  return typeof found === "number" && Number.isFinite(found) && found >= 0 && found <= 100
    ? found
    : undefined;
}

function parseSourceSequence(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function lifecycleState(
  value: string | undefined,
): "starting" | "ready" | "locked" | "stopping" | "stopped" | "unknown" | undefined {
  return ["starting", "ready", "locked", "stopping", "stopped", "unknown"].includes(value as string)
    ? (value as "starting" | "ready" | "locked" | "stopping" | "stopped" | "unknown")
    : value === undefined
      ? undefined
      : "unknown";
}

function syncDomainState(
  value: string | undefined,
): "pending" | "syncing" | "synced" | "stalled" | "unknown" | undefined {
  return value === undefined
    ? undefined
    : ["pending", "syncing", "synced", "stalled", "unknown"].includes(value)
      ? (value as "pending" | "syncing" | "synced" | "stalled" | "unknown")
      : "unknown";
}

function dependencyState(
  value: string | undefined,
): "connected" | "degraded" | "disconnected" | "unknown" | undefined {
  return value === undefined
    ? undefined
    : ["connected", "degraded", "disconnected", "unknown"].includes(value)
      ? (value as "connected" | "degraded" | "disconnected" | "unknown")
      : "unknown";
}

function operationState(
  value: string | undefined,
): "running" | "succeeded" | "failed" | "cancelled" | undefined {
  return value !== undefined && ["running", "succeeded", "failed", "cancelled"].includes(value)
    ? (value as "running" | "succeeded" | "failed" | "cancelled")
    : undefined;
}

function diagnosticLevel(value: string | undefined): "trace" | "debug" | "info" | "warn" | "error" {
  return value !== undefined && ["trace", "debug", "info", "warn", "error"].includes(value)
    ? (value as "trace" | "debug" | "info" | "warn" | "error")
    : "info";
}

function isErrorCode(value: string | undefined): value is NoxscopeError["code"] {
  return (
    value !== undefined &&
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
    ].includes(value)
  );
}

function streamFor(type: string): string {
  return type === "state" ? "state" : type === "response" ? "operations" : "events";
}

function canonicalStream(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  if (normalized === "state") return "state";
  if (normalized === "event" || normalized === "events" || normalized === "diagnostic")
    return "events";
  if (normalized === "operation" || normalized === "operations" || normalized === "response")
    return "operations";
  return isSafeId(value) ? value : undefined;
}

function canonicalMessageType(
  value: string | undefined,
):
  | "state"
  | "diagnostic"
  | "response"
  | "ready"
  | "heartbeat"
  | "reconnect"
  | "overflow"
  | undefined {
  if (value === undefined) return undefined;
  switch (value.toLowerCase().replaceAll("_", "").replaceAll("-", "")) {
    case "state":
    case "stateupdate":
      return "state";
    case "diagnostic":
    case "diagnosticevent":
    case "socketevent":
      return "diagnostic";
    case "response":
      return "response";
    case "ready":
      return "ready";
    case "heartbeat":
      return "heartbeat";
    case "reconnect":
    case "reconnected":
      return "reconnect";
    case "overflow":
      return "overflow";
    default:
      return undefined;
  }
}

function validTime(value: string | undefined): boolean {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeId(value: string): boolean {
  return value.length <= 256 && /^[a-zA-Z0-9._:-]+$/u.test(value);
}

function clampCapacity(value: number): number {
  return Number.isSafeInteger(value) && value >= 4 && value <= 4096 ? value : 128;
}

function copyPseudonymKey(key: Uint8Array): Uint8Array {
  return Uint8Array.prototype.slice.call(key) as Uint8Array;
}

function randomKey(): Uint8Array {
  const key = new Uint8Array(32);
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Web Crypto is required when no pseudonym key is supplied");
  }
  crypto.getRandomValues(key);
  return key;
}

function randomId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cancelled(message: string): Result<never> {
  return { ok: false, error: { code: "cancelled", message, retryable: false } };
}

function invalid(message: string): Result<never> {
  return { ok: false, error: { code: "protocol", message, retryable: false } };
}

function transportError(message: string, retryable: boolean): Result<never> {
  return { ok: false, error: { code: "unavailable", message, retryable } };
}

async function awaitOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ readonly state: "value"; readonly value: T } | { readonly state: "aborted" }> {
  if (signal.aborted) return { state: "aborted" };
  let listener: (() => void) | undefined;
  try {
    const abort = new Promise<{ readonly state: "aborted" }>((resolve) => {
      listener = () => resolve({ state: "aborted" });
      signal.addEventListener("abort", listener, { once: true });
    });
    const value = await Promise.race([
      promise.then((result) => ({ state: "value" as const, value: result })),
      abort,
    ]);
    return value;
  } finally {
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

async function closeQuietly(connection: GsdTransportConnection): Promise<void> {
  try {
    await connection.close?.();
  } catch {
    /* no native errors cross the seam */
  }
}

function cancelQuietly(connection: GsdTransportConnection, requestId: string): void {
  try {
    connection.cancel?.(requestId);
  } catch {
    /* A cancellation hint is best effort and must not mask the settled result. */
  }
}
