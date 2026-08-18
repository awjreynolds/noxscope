import {
  NOXSCOPE_PROTOCOL,
  validateRecord,
  validateRuntimeDescriptor,
  type ConnectOptions,
  type CancelRequest,
  type DiagnosticEventRecord,
  type InvokeRequest,
  type NoxscopeAdapter,
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
} from "@noxscope/protocol";

export type MockScenario =
  | "healthy"
  | "failed-transaction"
  | "stalled-sync"
  | "prover-failure"
  | "node-disconnect"
  | "dust-registration"
  | "queue";

const at = (second: number) => `2026-08-18T12:00:0${second}.000Z`;

export function createMockAdapter(scenario: MockScenario): NoxscopeAdapter {
  return {
    async connect(options) {
      if (options.signal.aborted) {
        return {
          ok: false,
          error: { code: "cancelled", message: "Connection was cancelled", retryable: false },
        };
      }
      return { ok: true, value: new MockRuntimeSession(scenario, options) };
    },
  };
}

class MockRuntimeSession implements RuntimeSession {
  readonly descriptor: RuntimeDescriptor;
  readonly #records: NoxscopeRecord[];
  readonly #signal: AbortSignal;
  readonly #scenario: MockScenario;
  #submittedTransactions = 0;

  constructor(scenario: MockScenario, options: ConnectOptions) {
    this.#signal = options.signal;
    this.#scenario = scenario;
    this.descriptor = descriptorFor(scenario);
    this.#records = recordsFor(scenario, this.descriptor);
    assertProtocol(this.descriptor, this.#records);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<NoxscopeRecord> {
    for (const record of this.#records) {
      if (this.#signal.aborted) return;
      yield record;
    }
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
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", message: "Request wait was cancelled", retryable: false },
      };
    }
    if (request.kind === "snapshot") {
      const latest = [...this.#records].reverse().find((record) => record.kind === "snapshot");
      if (latest?.kind === "snapshot") return { ok: true, value: latest.snapshot };
    }
    if (request.kind === "invoke" && request.operation.kind === "transaction.submit") {
      if (this.#scenario === "failed-transaction") {
        const terminal: OperationTerminal = {
          kind: "transaction.submit",
          phase: "submitting",
          state: "failed",
          error: {
            code: "rejected",
            message: "Node rejected the deterministic transaction",
            retryable: false,
          },
        };
        this.#appendOperations(request, [terminal]);
        return { ok: true, value: terminal };
      }
      const terminal: OperationTerminal = {
        kind: "transaction.submit",
        phase: "confirmed",
        state: "succeeded",
        result: { transactionId: "tx-mock-0001" },
      };
      const updates = [
        ...(this.#scenario === "queue" && this.#submittedTransactions > 0
          ? [{ kind: "transaction.submit", phase: "queued", state: "running" as const }]
          : []),
        { kind: "transaction.submit", phase: "submitting", state: "running" as const },
        { kind: "transaction.submit", phase: "confirming", state: "running" as const },
        terminal,
      ];
      this.#submittedTransactions += 1;
      this.#appendOperations(request, updates);
      return { ok: true, value: terminal };
    }
    if (
      request.kind === "invoke" &&
      this.#scenario === "dust-registration" &&
      request.operation.kind === "dev.noxscope.dust.register"
    ) {
      const terminal: OperationTerminal = {
        kind: "dev.noxscope.dust.register",
        phase: "registered",
        state: "succeeded",
      };
      this.#appendOperations(request, [
        {
          kind: "dev.noxscope.dust.register",
          phase: "registering",
          state: "running",
          progress: 50,
        },
        terminal,
      ]);
      return { ok: true, value: terminal };
    }
    return {
      ok: false,
      error: { code: "unsupported", message: "Operation is unsupported", retryable: false },
    };
  }

  #appendOperations(
    request: InvokeRequest,
    updates: readonly OperationRecord["operation"][],
  ): void {
    for (const [index, operation] of updates.entries()) {
      const sequence = this.#records.length + 1;
      const time = at(Math.min(9, 4 + index + 1));
      const record: OperationRecord = {
        kind: "operation",
        meta: {
          ...meta(this.descriptor, sequence, time),
          correlation: {
            requestId: request.requestId,
            operationId: request.operationId,
            ...(request.parentOperationId === undefined
              ? {}
              : { parentOperationId: request.parentOperationId }),
          },
        },
        operation,
      };
      const checked = validateRecord(record);
      if (!checked.ok) throw new Error(checked.error.message);
      this.#records.push(record);
    }
  }
}

function descriptorFor(scenario: MockScenario): RuntimeDescriptor {
  return {
    protocol: NOXSCOPE_PROTOCOL,
    sessionId: `session-${scenario}-1`,
    runtimeId: `runtime-${scenario}-1`,
    adapter: { id: "dev.noxscope.adapter-mock", version: "0.1.0" },
    runtime: {
      surface: "sdk",
      name: `Deterministic Midnight Runtime — ${scenario}`,
      identifiers: [{ scheme: "mock", value: `deterministic-${scenario}`, stability: "reported" }],
      versions: [{ subject: "wallet-sdk", version: "mock-1.0.0" }],
    },
    capabilities: [
      capability("sync.observe", "snapshot"),
      capability("balances.read", "snapshot"),
      capability("diagnostics.observe", "event"),
      capability("operation.submit", "operation"),
      capability("dev.noxscope.dust.register", "operation"),
    ],
  };
}

function capability(id: string, kind: "snapshot" | "event" | "operation") {
  return {
    id,
    kind,
    support: {
      state: "supported" as const,
      version: "1",
      evidence: {
        source: "runtime-declaration" as const,
        observedAt: at(0),
        summary: "Declared by deterministic scenario",
      },
    },
    availability: { state: "available" as const },
  };
}

function recordsFor(scenario: MockScenario, descriptor: RuntimeDescriptor): NoxscopeRecord[] {
  const snapshot = (
    sequence: number,
    percentage: number,
    state: "syncing" | "synced",
  ): SnapshotRecord => {
    const time = at(sequence);
    return {
      kind: "snapshot",
      meta: meta(descriptor, sequence, time),
      snapshot: {
        revision: String(sequence),
        freshness: {
          state: "fresh",
          observedAt: time,
          receivedAt: time,
          source: "runtime",
          consecutiveFailures: 0,
          lastSuccessAt: time,
        },
        lifecycle: { state: "ready" },
        network: { id: "undeployed" },
        sync: {
          state,
          percentage,
          domains: [
            { domain: "shielded", state, percentage },
            { domain: "unshielded", state, percentage },
            { domain: "dust", state, percentage },
          ],
        },
        balances: [
          { assetId: "NIGHT", domain: "shielded", amount: "42000000" },
          { assetId: "NIGHT", domain: "unshielded", amount: "12000000" },
          { assetId: "DUST", domain: "dust", amount: "730000" },
        ],
        dependencies: [
          { role: "node", state: "connected" },
          { role: "indexer", state: "connected" },
          { role: "prover", state: "connected" },
        ],
      },
    };
  };
  const event: DiagnosticEventRecord = {
    kind: "diagnostic-event",
    meta: meta(descriptor, 4, at(4)),
    event: {
      type: "diagnostic",
      name: "sync.complete",
      category: "sync",
      level: "info",
      source: "runtime",
      message: "All domains synchronized",
    },
  };
  const records: NoxscopeRecord[] = [
    snapshot(1, 18, "syncing"),
    snapshot(2, 67, "syncing"),
    snapshot(3, 100, "synced"),
    event,
  ];
  const final = records[2];
  if (final?.kind !== "snapshot") return records;
  if (scenario === "stalled-sync") {
    records[2] = {
      ...final,
      snapshot: {
        ...final.snapshot,
        sync: {
          state: "stalled",
          percentage: 67,
          domains: [
            { domain: "shielded", state: "synced", percentage: 100 },
            { domain: "unshielded", state: "syncing", percentage: 67 },
            { domain: "dust", state: "stalled", percentage: 41 },
          ],
        },
      },
    };
  }
  if (scenario === "prover-failure" || scenario === "node-disconnect") {
    const failedRole = scenario === "prover-failure" ? "prover" : "node";
    const failedState = scenario === "prover-failure" ? "degraded" : "disconnected";
    records[2] = {
      ...final,
      snapshot: {
        ...final.snapshot,
        dependencies: (final.snapshot.dependencies ?? []).map((dependency) =>
          dependency.role === failedRole ? { ...dependency, state: failedState } : dependency,
        ),
      },
    };
  }
  if (scenario === "prover-failure") {
    records[3] = {
      kind: "diagnostic-event",
      meta: meta(descriptor, 4, at(4)),
      event: {
        type: "capability-availability",
        capabilityId: "operation.submit",
        availability: {
          state: "degraded",
          reason: "Deterministic prover failure",
          retryable: true,
        },
      },
    };
  }
  if (scenario === "failed-transaction") {
    records[3] = {
      kind: "operation",
      meta: {
        ...meta(descriptor, 4, at(4)),
        correlation: { operationId: "operation-failed-fixture" },
      },
      operation: {
        kind: "transaction.submit",
        phase: "submitting",
        state: "failed",
        error: {
          code: "rejected",
          message: "Node rejected the deterministic transaction",
          retryable: false,
        },
      },
    };
  }
  if (scenario === "dust-registration") {
    records[2] = { ...final, snapshot: { ...final.snapshot, dust: { state: "registered" } } };
  }
  return records;
}

function meta(descriptor: RuntimeDescriptor, sequence: number, time: string) {
  return {
    protocol: NOXSCOPE_PROTOCOL,
    sessionId: descriptor.sessionId,
    runtimeId: descriptor.runtimeId,
    streamId: `${descriptor.sessionId}-stream`,
    sequence: String(sequence),
    observedAt: time,
    receivedAt: time,
  };
}

function assertProtocol(descriptor: RuntimeDescriptor, records: readonly NoxscopeRecord[]): void {
  const checkedDescriptor = validateRuntimeDescriptor(descriptor);
  if (!checkedDescriptor.ok) throw new Error(checkedDescriptor.error.message);
  for (const record of records) {
    const checked = validateRecord(record);
    if (!checked.ok) throw new Error(checked.error.message);
  }
}
