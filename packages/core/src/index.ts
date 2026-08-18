import {
  validateRecord,
  type CapabilityDeclaration,
  type NoxscopeAdapter,
  type NoxscopeError,
  type NoxscopeRecord,
  type Result,
  type RuntimeDescriptor,
  type Snapshot,
} from "@noxscope/protocol";

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
  lastSequence?: bigint;
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
    const connected = await adapter.connect({ signal: this.#signal });
    if (!connected.ok) return connected;
    const session = connected.value;
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
    if (runtime.lastSequence !== undefined && sequence <= runtime.lastSequence) {
      runtime.failures.push({
        code: "protocol",
        message: "Record sequence did not increase",
        retryable: false,
      });
      runtime.status = "failed";
      this.#notify();
      return;
    }
    runtime.lastSequence = sequence;
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
    const runtimeOrder = new Map(
      runtimes.map((runtime, index) => [runtime.descriptor.runtimeId, index]),
    );
    const timeline = runtimes
      .flatMap((runtime) =>
        runtime.records.map((record) => ({ runtimeId: runtime.descriptor.runtimeId, record })),
      )
      .sort((left, right) => {
        const time = left.record.meta.receivedAt.localeCompare(right.record.meta.receivedAt);
        if (time !== 0) return time;
        if (left.runtimeId === right.runtimeId) {
          return Number(BigInt(left.record.meta.sequence) - BigInt(right.record.meta.sequence));
        }
        return (runtimeOrder.get(left.runtimeId) ?? 0) - (runtimeOrder.get(right.runtimeId) ?? 0);
      });
    return { runtimes, timeline, ordering: "display-time-only" };
  }
}
