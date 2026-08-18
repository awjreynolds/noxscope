import {
  NOXSCOPE_PROTOCOL,
  validateRecord,
  validateRuntimeDescriptor,
  type CapabilityDeclaration,
  type DiagnosticEventRecord,
  type NoxscopeAdapter,
  type NoxscopeError,
  type NoxscopeRecord,
  type Result,
  type RuntimeDescriptor,
  type Snapshot,
} from "@noxscope/protocol";

export * from "./sanitizer.js";
export {
  NOXSCOPE_RECORDING_FORMAT,
  NOXSCOPE_RECORDING_MAGIC,
  NOXSCOPE_RECORDING_SCHEMA_VERSION,
  RECORDING_LIMITS,
  adapterReferences,
  createRecorder,
} from "./recording.js";
export type {
  Recorder,
  RecordingAdapterReference,
  RecordingCounts,
  RecordingExport,
  RecordingFrameDigest,
  RecordingIntegrity,
  RecordingLimits,
  RecordingManifest,
  RecordingOptions,
  RecordingPolicyReference,
  RecordingRecord,
  RecordingSanitizationContext,
} from "./recording.js";
export * from "./recording-import.js";

export interface CoreOptions {
  readonly signal: AbortSignal;
}

export interface RuntimeView {
  readonly descriptor: RuntimeDescriptor;
  readonly status: "observing" | "complete" | "failed" | "closed";
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly latestSnapshot?: Snapshot;
  readonly records: readonly NoxscopeRecord[];
  readonly failures: readonly NoxscopeError[];
}

export interface TimelineEntry {
  readonly runtimeId: string;
  readonly record: NoxscopeRecord;
}

export interface CoreView {
  readonly runtimes: readonly RuntimeView[];
  /** A display-time projection only. Record metadata remains the source of ordering truth. */
  readonly timeline: readonly TimelineEntry[];
  readonly ordering: "display-time-only";
}

export interface Core {
  connect(adapter: NoxscopeAdapter): Promise<Result<string>>;
  subscribe(listener: (view: CoreView) => void): () => void;
}

interface MutableRuntime {
  readonly descriptor: RuntimeDescriptor;
  status: RuntimeView["status"];
  capabilities: CapabilityDeclaration[];
  latestSnapshot?: Snapshot;
  readonly records: NoxscopeRecord[];
  readonly failures: NoxscopeError[];
  readonly lastSequenceByStream: Map<string, bigint>;
  coreSequence: bigint;
}

export function createCore(options: CoreOptions): Core {
  return new RuntimeRegistry(options);
}

class RuntimeRegistry implements Core {
  readonly #signal: AbortSignal;
  readonly #runtimes: MutableRuntime[] = [];
  readonly #listeners = new Set<(view: CoreView) => void>();

  constructor(options: CoreOptions) {
    this.#signal = options.signal;
    this.#signal.addEventListener("abort", () => {
      for (const runtime of this.#runtimes) {
        if (runtime.status === "observing") runtime.status = "closed";
      }
      this.#notify();
    });
  }

  async connect(adapter: NoxscopeAdapter): Promise<Result<string>> {
    if (this.#signal.aborted) return coreStopped();
    const connected = await adapter.connect({ signal: this.#signal });
    if (!connected.ok) return connected;
    if (this.#signal.aborted) return coreStopped();
    const session = connected.value;
    const descriptor = validateRuntimeDescriptor(session.descriptor);
    if (!descriptor.ok) return descriptor;
    if (
      this.#runtimes.some(
        (runtime) => runtime.descriptor.sessionId === session.descriptor.sessionId,
      )
    ) {
      return {
        ok: false,
        error: {
          code: "invalid",
          message: `Runtime Session ${session.descriptor.sessionId} is already registered`,
          retryable: false,
        },
      };
    }
    const runtime: MutableRuntime = {
      descriptor: session.descriptor,
      status: "observing",
      capabilities: [...session.descriptor.capabilities],
      records: [],
      failures: [],
      lastSequenceByStream: new Map(),
      coreSequence: 0n,
    };
    this.#runtimes.push(runtime);
    this.#notify();
    void this.#consume(runtime, session);
    return { ok: true, value: session.descriptor.runtimeId };
  }

  subscribe(listener: (view: CoreView) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#view());
    return () => this.#listeners.delete(listener);
  }

  async #consume(runtime: MutableRuntime, records: AsyncIterable<NoxscopeRecord>): Promise<void> {
    try {
      for await (const record of records) this.#accept(runtime, record);
      if (runtime.status === "observing")
        runtime.status = this.#signal.aborted ? "closed" : "complete";
    } catch (cause) {
      runtime.status = "failed";
      runtime.failures.push({
        code: "internal",
        message: cause instanceof Error ? cause.message : "Runtime Session stream failed",
        retryable: true,
      });
    }
    this.#notify();
  }

  #accept(runtime: MutableRuntime, candidate: unknown): void {
    const checked = validateRecord(candidate);
    if (!checked.ok) {
      runtime.failures.push(checked.error);
      runtime.status = "failed";
      this.#notify();
      return;
    }
    const record = checked.value;
    if (
      record.meta.runtimeId !== runtime.descriptor.runtimeId ||
      record.meta.sessionId !== runtime.descriptor.sessionId
    ) {
      runtime.failures.push({
        code: "protocol",
        message: "Record identity does not match its Runtime Session",
        retryable: false,
      });
      runtime.status = "failed";
      this.#notify();
      return;
    }
    const sequence = BigInt(record.meta.sequence);
    const lastSequence = runtime.lastSequenceByStream.get(record.meta.streamId);
    if (lastSequence !== undefined && sequence <= lastSequence) {
      runtime.failures.push({
        code: "protocol",
        message: "Record sequence did not increase",
        retryable: false,
      });
      runtime.status = "failed";
      this.#notify();
      return;
    }
    if (lastSequence !== undefined && sequence > lastSequence + 1n) {
      this.#appendGap(runtime, record, lastSequence + 1n, sequence - 1n);
    }
    runtime.lastSequenceByStream.set(record.meta.streamId, sequence);
    runtime.records.push(record);
    if (record.kind === "snapshot") runtime.latestSnapshot = record.snapshot;
    if (
      record.kind === "operation" &&
      record.operation.state === "failed" &&
      record.operation.error
    ) {
      runtime.failures.push(record.operation.error);
    }
    if (record.kind === "diagnostic-event" && record.event.type === "capability-availability") {
      const event = record.event;
      runtime.capabilities = runtime.capabilities.map((capability) =>
        capability.id === event.capabilityId
          ? { ...capability, availability: event.availability }
          : capability,
      );
    }
    this.#notify();
  }

  #appendGap(
    runtime: MutableRuntime,
    sourceRecord: NoxscopeRecord,
    firstLost: bigint,
    lastLost: bigint,
  ): void {
    runtime.coreSequence += 1n;
    const streamId = `${runtime.descriptor.sessionId}-core`;
    const gap: DiagnosticEventRecord = {
      kind: "diagnostic-event",
      meta: {
        protocol: NOXSCOPE_PROTOCOL,
        sessionId: runtime.descriptor.sessionId,
        runtimeId: runtime.descriptor.runtimeId,
        streamId,
        sequence: runtime.coreSequence.toString(),
        observedAt: sourceRecord.meta.receivedAt,
        receivedAt: sourceRecord.meta.receivedAt,
      },
      event: {
        type: "stream-gap",
        sourceStreamId: sourceRecord.meta.streamId,
        firstLostSequence: firstLost.toString(),
        lastLostSequence: lastLost.toString(),
        reason: "source-gap",
      },
    };
    runtime.lastSequenceByStream.set(streamId, runtime.coreSequence);
    runtime.records.push(gap);
  }

  #notify(): void {
    const view = this.#view();
    for (const listener of this.#listeners) listener(view);
  }

  #view(): CoreView {
    const runtimes = this.#runtimes.map<RuntimeView>((runtime) => ({
      descriptor: runtime.descriptor,
      status: runtime.status,
      capabilities: runtime.capabilities,
      ...(runtime.latestSnapshot === undefined ? {} : { latestSnapshot: runtime.latestSnapshot }),
      records: runtime.records,
      failures: runtime.failures,
    }));
    const timeline = mergeTimeline(runtimes);
    return immutableCopy({ runtimes, timeline, ordering: "display-time-only" });
  }
}

function coreStopped(): Result<never> {
  return {
    ok: false,
    error: { code: "cancelled", message: "Core is shut down", retryable: false },
  };
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

interface TimelineStream {
  readonly order: number;
  index: number;
  readonly entries: TimelineEntry[];
}

function mergeTimeline(runtimes: readonly RuntimeView[]): TimelineEntry[] {
  const streams = new Map<string, TimelineStream>();
  let streamOrder = 0;
  for (const runtime of runtimes) {
    for (const record of runtime.records) {
      const key = `${runtime.descriptor.sessionId}\u0000${runtime.descriptor.runtimeId}\u0000${record.meta.streamId}`;
      let stream = streams.get(key);
      if (stream === undefined) {
        stream = { order: streamOrder++, index: 0, entries: [] };
        streams.set(key, stream);
      }
      stream.entries.push({ runtimeId: runtime.descriptor.runtimeId, record });
    }
  }

  const timeline: TimelineEntry[] = [];
  while (true) {
    let selected: TimelineStream | undefined;
    for (const stream of streams.values()) {
      const candidate = stream.entries[stream.index];
      if (candidate === undefined) continue;
      const current = selected?.entries[selected.index];
      if (
        current === undefined ||
        candidate.record.meta.receivedAt < current.record.meta.receivedAt ||
        (candidate.record.meta.receivedAt === current.record.meta.receivedAt &&
          selected !== undefined &&
          stream.order < selected.order)
      ) {
        selected = stream;
      }
    }
    if (selected === undefined) return timeline;
    timeline.push(selected.entries[selected.index]!);
    selected.index += 1;
  }
}
