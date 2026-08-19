import type {
  GsdAdapterOptions,
  GsdNativeMessage,
  GsdRequest,
  GsdTransport,
  GsdTransportConnection,
} from "./index.js";
import { createGsdAdapter, createGsdMessagePortTransport } from "./index.js";
import type { NoxscopeRecord, RuntimeSession } from "@noxscope/protocol";
import { describe, expect, it } from "vitest";

const clock = () => "2026-08-19T10:00:00.000Z";
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe("GSD Adapter", () => {
  it("negotiates a versioned descriptor and maps a healthy state through the manifest", async () => {
    const state = healthyState("1");
    const connection = new FixtureConnection(healthyHandshake(), [state]);
    const session = await connect(connection);

    expect(session.descriptor).toMatchObject({
      protocol: "noxscope/adapter/1",
      runtimeId: "gsd-dev-runtime",
      adapter: { id: "org.noxscope.adapter-gsd", version: "0.1.0" },
      runtime: {
        surface: "worker",
        name: "GSD development wallet",
        versions: [
          { subject: "gsd-protocol", version: "gsd/1" },
          { subject: "gsd-wallet", version: "0.9.0-fixture" },
          { subject: "midnight-sdk", version: "2.0.0-fixture" },
        ],
      },
    });
    const record = await nextRecord(session);
    expect(record.kind).toBe("snapshot");
    if (record.kind !== "snapshot") return;
    expect(record.snapshot).toMatchObject({
      lifecycle: { state: "ready" },
      network: { id: "preprod" },
      sync: {
        state: "syncing",
        domains: [
          { domain: "shielded", state: "synced", percentage: 100 },
          { domain: "unshielded", state: "syncing", percentage: 61 },
          { domain: "dust", state: "syncing", percentage: 42 },
        ],
      },
      balances: [
        { domain: "shielded", assetId: "NIGHT", amount: "42000000" },
        { domain: "unshielded", assetId: "NIGHT", amount: "12000000" },
        { domain: "dust", assetId: "DUST", amount: "730000" },
      ],
    });
    expect(record.snapshot.addresses?.[0]?.value).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
    expect(record.meta.sequence).toBe("1");
    expect(record.meta.streamId).toBe(`${session.descriptor.sessionId}:state`);
  });

  it("does not queue vault, checkpoint, keys, operation payloads, or raw failed transaction material", async () => {
    const hostile: GsdNativeMessage = {
      version: "gsd/1",
      type: "diagnostic",
      stream: "events",
      sequence: "1",
      payload: {
        name: "transaction.failed",
        category: "transaction",
        level: "error",
        message: "transaction failed",
        operationId: "op-1",
        kind: "transaction.submit",
        phase: "submitting",
        state: "failed",
        error: { code: "rejected", message: "node rejected", retryable: false },
        detail: {
          source: "connected-operation",
          subsystem: "transaction",
          code: "REJECTED",
          phase: "submitting",
          state: "failed",
          vault: "mnemonic abandon abandon abandon",
          checkpoint: "checkpoint-secret",
          rawTransaction: "signed-private-transaction",
        },
        vault: "never-cross-the-seam",
        checkpoint: "never-cross-the-seam",
        keys: { spendingKey: "never-cross-the-seam" },
        operationInput: { witness: "never-cross-the-seam" },
        operationResult: { signedTx: "never-cross-the-seam" },
        rawFailedTransaction: "never-cross-the-seam",
      },
    };
    const session = await connect(new FixtureConnection(healthyHandshake(), [hostile]));
    const record = await nextRecord(session);
    expect(record.kind).toBe("operation");
    expect(JSON.stringify(record)).not.toContain("never-cross-the-seam");
    expect(JSON.stringify(record)).not.toContain("signed-private-transaction");
    expect(JSON.stringify(record)).not.toContain("checkpoint-secret");
    if (record.kind !== "operation") return;
    expect(record.operation.error).toEqual({
      code: "rejected",
      message: "node rejected",
      retryable: false,
    });
  });

  it("keeps independent stream sequence and turns a source gap into canonical evidence", async () => {
    const messages: GsdNativeMessage[] = [
      healthyState("1"),
      { ...healthyState("3"), stream: "state" },
      {
        version: "gsd/1",
        type: "ready",
        stream: "events",
        sequence: "1",
        observedAt: clock(),
      },
    ];
    const session = await connect(new FixtureConnection(healthyHandshake(), messages));
    const records = await takeRecords(session, 4);
    const gaps = records.filter(
      (record) => record.kind === "diagnostic-event" && record.event.type === "stream-gap",
    );
    expect(gaps).toHaveLength(1);
    expect(
      gaps[0]?.kind === "diagnostic-event" && gaps[0].event.type === "stream-gap"
        ? gaps[0].event
        : undefined,
    ).toMatchObject({
      firstLostSequence: "2",
      lastLostSequence: "2",
      reason: "source-gap",
    });
    expect(
      records
        .filter((record) => record.meta.streamId.endsWith(":state"))
        .map((record) => record.meta.sequence),
    ).toEqual(["1", "2"]);
    expect(
      records
        .filter((record) => record.meta.streamId.endsWith(":events"))
        .map((record) => record.meta.sequence),
    ).toEqual(["1", "2"]);
  });

  it("does not move a source watermark backwards after stale or repeated messages", async () => {
    const messages = [
      healthyState("1"),
      healthyState("2"),
      healthyState("1"),
      healthyState("2"),
      healthyState("3"),
    ];
    const session = await connect(new FixtureConnection(healthyHandshake(), messages));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const records = await takeRecords(session, 8);
    expect(records.filter((record) => record.kind === "snapshot")).toHaveLength(3);
  });

  it("emits reconnect evidence and never claims a caller cancellation stopped wallet work", async () => {
    const messages: GsdNativeMessage[] = [
      { version: "gsd/1", type: "reconnect", stream: "events", sequence: "1" },
    ];
    const session = await connect(new FixtureConnection(healthyHandshake(), messages));
    const records = await takeRecords(session, 2);
    expect(
      records.some(
        (record) =>
          record.kind === "diagnostic-event" &&
          record.event.type === "stream-gap" &&
          record.event.reason === "reconnect",
      ),
    ).toBe(true);
    const cancel = await session.request({
      kind: "cancel",
      requestId: "cancel-1",
      operationId: "op-1",
    });
    expect(cancel).toEqual({ ok: true, value: { accepted: false } });
  });

  it("rejects mutation operations even when the portable input validator accepts them", async () => {
    const session = await connect(new FixtureConnection(healthyHandshake(), []));
    const result = await session.request({
      kind: "invoke",
      requestId: "invoke-1",
      operationId: "operation-1",
      operation: { kind: "wallet.sync", action: "start" },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "unsupported",
        message: "GSD Adapter exposes no automatic wallet mutation operations",
        retryable: false,
      },
    });
  });

  it("does not echo an oversized or malformed native message", async () => {
    const session = await connect(
      new FixtureConnection(healthyHandshake(), [
        {
          version: "gsd/1",
          type: "diagnostic",
          payload: { message: "x".repeat(16 * 1024 + 1) },
        },
      ]),
    );
    const record = await nextRecord(session);
    expect(record.kind).toBe("diagnostic-event");
    expect(JSON.stringify(record)).not.toContain("x".repeat(100));
    if (record.kind === "diagnostic-event" && record.event.type === "diagnostic") {
      expect(record.event.name).toBe("gsd.adapter.overflow");
    }
  });

  it("reports bounded queue loss instead of silently dropping records", async () => {
    const messages = Array.from({ length: 10 }, (_, index) => healthyState(String(index + 1)));
    const session = await connect(new FixtureConnection(healthyHandshake(), messages), {
      queueCapacity: 4,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const records = await takeRecords(session, 12);
    const gaps = records.flatMap((record) =>
      record.kind === "diagnostic-event" &&
      record.event.type === "stream-gap" &&
      record.event.reason === "overflow"
        ? [
            {
              sourceStreamId: record.event.sourceStreamId,
              first: record.event.firstLostSequence,
              last: record.event.lastLostSequence,
            },
          ]
        : [],
    );
    const stateGaps = gaps
      .filter((gap) => gap.sourceStreamId.endsWith(":state"))
      .map((gap) => [gap.first, gap.last]);
    expect(stateGaps).toEqual([["1", "7"]]);
    expect(gaps.filter((gap) => gap.sourceStreamId.endsWith(":events"))).toEqual([]);
    expect(
      records.filter((record) => record.kind === "snapshot").map((record) => record.meta.sequence),
    ).toEqual(["8", "9", "10"]);
  });

  it("settles an in-flight request promptly on caller abort and cancels its transport wait", async () => {
    const connection = new FixtureConnection(healthyHandshake(), [], healthyState("9"), {
      requestDelayMs: 1_000,
    });
    const session = await connect(connection);
    const requestSignal = new AbortController();
    const pending = session.request(
      { kind: "snapshot", requestId: "snapshot-abort" },
      { signal: requestSignal.signal, timeoutMs: 5_000 },
    );
    await Promise.resolve();
    requestSignal.abort();
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort timeout")), 100)),
    ]);
    expect(result).toEqual({
      ok: false,
      error: { code: "cancelled", message: "GSD request was cancelled", retryable: false },
    });
    expect(connection.cancelledRequests).toEqual(["snapshot-abort"]);
  });

  it("cleans a real MessagePort pending request when the caller aborts", async () => {
    const port = new FixturePort();
    const lifetime = new AbortController();
    const sessionResult = await createGsdAdapter({
      transport: createGsdMessagePortTransport(port, { timeoutMs: 5_000 }),
      now: clock,
      pseudonymKey: key,
      sessionId: () => "session-message-port",
    }).connect({ signal: lifetime.signal });
    if (!sessionResult.ok) throw new Error(sessionResult.error.message);
    const requestSignal = new AbortController();
    const pending = sessionResult.value.request(
      { kind: "snapshot", requestId: "message-port-abort" },
      { signal: requestSignal.signal, timeoutMs: 5_000 },
    );
    requestSignal.abort();
    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: "cancelled", message: "GSD request was cancelled", retryable: false },
    });
    expect(port.requests.filter((request) => request.type === "getState")).toHaveLength(1);
    lifetime.abort();
  });

  it("snapshots MessagePort data before inspecting fields and never invokes hostile getters", async () => {
    const port = new FixturePort();
    const lifetime = new AbortController();
    const sessionResult = await createGsdAdapter({
      transport: createGsdMessagePortTransport(port),
      now: clock,
      pseudonymKey: key,
      sessionId: () => "session-message-port-hostile",
    }).connect({ signal: lifetime.signal });
    if (!sessionResult.ok) throw new Error(sessionResult.error.message);

    let getterInvocations = 0;
    const accessorPayload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorPayload, "type", {
      enumerable: true,
      get() {
        getterInvocations += 1;
        throw new Error("hostile getter");
      },
    });
    port.emit(accessorPayload);
    const rejected = await nextRecord(sessionResult.value);
    expect(getterInvocations).toBe(0);
    expect(rejected.kind).toBe("diagnostic-event");

    const proxied = new Proxy(
      { version: "gsd/1", type: "ready", stream: "events" },
      {
        get() {
          getterInvocations += 1;
          throw new Error("hostile proxy getter");
        },
      },
    );
    port.emit(proxied);
    const ready = await nextRecord(sessionResult.value);
    expect(getterInvocations).toBe(0);
    expect(ready.kind).toBe("diagnostic-event");
    lifetime.abort();
  });

  it("aborts a delayed handshake without creating a session or leaving the connection open", async () => {
    const connection = new FixtureConnection(healthyHandshake(), [], undefined, {
      describeDelayMs: 1_000,
    });
    const lifetime = new AbortController();
    const pending = createGsdAdapter({
      transport: new FixtureTransport(connection),
      now: clock,
      pseudonymKey: key,
      sessionId: () => "session-never-created",
    }).connect({ signal: lifetime.signal });
    await Promise.resolve();
    lifetime.abort();
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("handshake timeout")), 100),
      ),
    ]);
    expect(result).toEqual({
      ok: false,
      error: { code: "cancelled", message: "GSD handshake was cancelled", retryable: false },
    });
    expect(connection.closed).toBe(true);
  });

  it("deduplicates repeated terminal operation diagnostics and rejects later lifecycle updates", async () => {
    const terminal = {
      version: "gsd/1" as const,
      type: "DIAGNOSTIC_EVENT" as const,
      stream: "operations" as const,
      sequence: "1",
      requestId: "request-terminal",
      operationId: "operation-terminal",
      payload: {
        name: "transaction.failed",
        category: "transaction",
        level: "error",
        kind: "transaction.submit",
        phase: "submitting",
        state: "failed",
        error: { code: "rejected", message: "node rejected", retryable: false },
      },
    };
    const repeated = { ...terminal, sequence: "2" };
    const lateRunning = {
      ...terminal,
      sequence: "3",
      payload: { ...terminal.payload, level: "info", state: "running", phase: "retrying" },
    };
    const session = await connect(
      new FixtureConnection(healthyHandshake(), [terminal, repeated, lateRunning]),
    );
    const records = await takeRecords(session, 4);
    expect(records.filter((record) => record.kind === "operation")).toHaveLength(1);
    const operation = records.find((record) => record.kind === "operation");
    expect(operation?.kind === "operation" ? operation.meta.correlation : undefined).toEqual({
      operationId: "operation-terminal",
      requestId: "request-terminal",
    });
  });

  it("resets native sequence epochs on reconnect before accepting sequence one again", async () => {
    const messages: GsdNativeMessage[] = [
      healthyState("1"),
      { version: "gsd/1", type: "RECONNECT", stream: "events", sequence: "1" },
      { ...healthyState("1"), observedAt: "2026-08-19T10:00:04.000Z" },
    ];
    const session = await connect(new FixtureConnection(healthyHandshake(), messages));
    const records = await takeRecords(session, 4);
    expect(records.filter((record) => record.kind === "snapshot")).toHaveLength(2);
    expect(
      records.some(
        (record) =>
          record.kind === "diagnostic-event" &&
          record.event.type === "stream-gap" &&
          record.event.reason === "reconnect",
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.kind === "diagnostic-event" &&
          record.event.type === "diagnostic" &&
          record.event.name === "gsd.protocol.invalid",
      ),
    ).toBe(false);
  });

  it("normalizes response type and correlation key casing", async () => {
    const response = {
      version: "gsd/1",
      type: "RESPONSE",
      stream: "OPERATIONS",
      sequence: "1",
      requestID: "request-response",
      operationID: "operation-response",
      payload: {
        name: "transaction.succeeded",
        category: "transaction",
        level: "info",
        kind: "transaction.submit",
        phase: "confirmed",
        state: "succeeded",
      },
    };
    const session = await connect(new FixtureConnection(healthyHandshake(), [response]));
    const record = await nextRecord(session);
    expect(record.kind).toBe("operation");
    if (record.kind === "operation") {
      expect(record.meta.correlation).toEqual({
        operationId: "operation-response",
        requestId: "request-response",
      });
    }
  });

  it("uses the receive clock for receivedAt while preserving the source observation time", async () => {
    let nowValue = "2026-08-19T11:00:00.000Z";
    const connection = new FixtureConnection(healthyHandshake(), [healthyState("1")], undefined, {
      messageDelayMs: 10,
    });
    const result = await createGsdAdapter({
      transport: new FixtureTransport(connection),
      now: () => nowValue,
      pseudonymKey: key,
      sessionId: () => "session-received-clock",
    }).connect({ signal: new AbortController().signal });
    if (!result.ok) throw new Error(result.error.message);
    nowValue = "2026-08-19T12:00:00.000Z";
    const record = await nextRecord(result.value);
    expect(record.meta.observedAt).toBe("2026-08-19T10:00:00.000Z");
    expect(record.meta.receivedAt).toBe("2026-08-19T12:00:00.000Z");
  });

  it("coalesces sustained producer overflow into bounded exact loss evidence", async () => {
    const messages = Array.from({ length: 5_000 }, (_, index) => minimalState(String(index + 1)));
    const connection = new FixtureConnection(healthyHandshake(), messages);
    const session = await connect(connection, { queueCapacity: 4 });
    await connection.completed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const records = await takeRecords(session, 8);
    const gaps = records.filter(
      (record) =>
        record.kind === "diagnostic-event" &&
        record.event.type === "stream-gap" &&
        record.event.reason === "overflow",
    );
    expect(gaps).toHaveLength(1);
    expect(
      gaps[0]?.kind === "diagnostic-event" && gaps[0].event.type === "stream-gap"
        ? gaps[0].event
        : undefined,
    ).toMatchObject({
      sourceStreamId: "session-gsd-fixture:state",
      firstLostSequence: "1",
      lastLostSequence: "4997",
    });
  }, 20_000);

  it("never invokes getters while rejecting hostile native payloads", async () => {
    let invoked = false;
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, "message", {
      enumerable: true,
      get() {
        invoked = true;
        return "secret getter value";
      },
    });
    const session = await connect(
      new FixtureConnection(healthyHandshake(), [
        { version: "gsd/1", type: "diagnostic", payload },
      ]),
    );
    const iterator = session[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.done).toBe(false);
    if (!next.done) expect(next.value.kind).toBe("diagnostic-event");
    expect(invoked).toBe(false);
  });

  it("maps a snapshot request through the same sanitizer before returning it", async () => {
    const connection = new FixtureConnection(healthyHandshake(), [], healthyState("9"));
    const session = await connect(connection);
    const result = await session.request({ kind: "snapshot", requestId: "snapshot-1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.revision).toBe("1");
    expect(connection.requests).toEqual([{ version: "gsd/1", id: "snapshot-1", type: "getState" }]);
  });
});

async function connect(
  connection: FixtureConnection,
  overrides: Pick<GsdAdapterOptions, "queueCapacity"> = {},
): Promise<RuntimeSession> {
  const adapterOptions: GsdAdapterOptions = {
    transport: new FixtureTransport(connection),
    now: clock,
    pseudonymKey: key,
    sessionId: () => "session-gsd-fixture",
    ...overrides,
  };
  const result = await createGsdAdapter(adapterOptions).connect({
    signal: new AbortController().signal,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function nextRecord(session: RuntimeSession): Promise<NoxscopeRecord> {
  const next = await session[Symbol.asyncIterator]().next();
  if (next.done) throw new Error("Expected a record");
  return next.value;
}

async function takeRecords(session: RuntimeSession, count: number): Promise<NoxscopeRecord[]> {
  const iterator = session[Symbol.asyncIterator]();
  const records: NoxscopeRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await iterator.next();
    if (next.done) break;
    records.push(next.value);
  }
  return records;
}

class FixtureTransport implements GsdTransport {
  readonly #connection: FixtureConnection;
  constructor(connection: FixtureConnection) {
    this.#connection = connection;
  }
  async open(): Promise<{ ok: true; value: GsdTransportConnection }> {
    return { ok: true, value: this.#connection };
  }
}

class FixtureConnection implements GsdTransportConnection {
  readonly requests: GsdRequest[] = [];
  readonly cancelledRequests: string[] = [];
  readonly completed: Promise<void>;
  closed = false;
  readonly #handshake: unknown;
  readonly #messages: readonly unknown[];
  readonly #snapshot: unknown;
  readonly #complete: () => void;
  readonly #options: {
    readonly describeDelayMs?: number;
    readonly requestDelayMs?: number;
    readonly messageDelayMs?: number;
  };
  constructor(
    handshake: unknown,
    messages: readonly unknown[],
    snapshot?: unknown,
    options: {
      readonly describeDelayMs?: number;
      readonly requestDelayMs?: number;
      readonly messageDelayMs?: number;
    } = {},
  ) {
    let complete!: () => void;
    this.completed = new Promise((resolve) => {
      complete = resolve;
    });
    this.#complete = complete;
    this.#handshake = handshake;
    this.#messages = messages;
    this.#snapshot = snapshot;
    this.#options = options;
  }
  async describe(): Promise<unknown> {
    if (this.#options.describeDelayMs !== undefined) await delay(this.#options.describeDelayMs);
    return this.#handshake;
  }
  async request(request: GsdRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.#options.requestDelayMs !== undefined) await delay(this.#options.requestDelayMs);
    return this.#snapshot ?? { version: "gsd/1", type: "response", payload: {} };
  }
  cancel(requestId: string): void {
    this.cancelledRequests.push(requestId);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    try {
      for (const message of this.#messages) {
        await delay(this.#options.messageDelayMs ?? 0);
        yield message;
      }
    } finally {
      this.#complete();
    }
  }
}

class FixturePort {
  readonly requests: GsdRequest[] = [];
  readonly #listeners = new Set<(event: { readonly data: unknown }) => void>();

  postMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const request = message as GsdRequest;
    this.requests.push(request);
    if (request.type === "describe") {
      queueMicrotask(() =>
        this.emit({ id: request.id, type: "response", payload: healthyHandshake() }),
      );
    }
  }

  addEventListener(_type: "message", listener: (event: { readonly data: unknown }) => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    this.#listeners.delete(listener);
  }

  close(): void {
    this.#listeners.clear();
  }

  emit(data: unknown): void {
    for (const listener of this.#listeners) listener({ data });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function healthyHandshake() {
  return {
    version: "gsd/1",
    runtime: {
      id: "gsd-dev-runtime",
      name: "GSD development wallet",
      surface: "worker",
      walletVersion: "0.9.0-fixture",
      sdkVersion: "2.0.0-fixture",
      vault: "secret-vault-must-not-cross",
    },
  };
}

function healthyState(sequence: string): GsdNativeMessage {
  return {
    version: "gsd/1",
    type: "state",
    stream: "state",
    sequence,
    observedAt: clock(),
    payload: {
      lifecycle: "ready",
      network: "preprod",
      account: "addr_test1_account_fixture",
      addresses: {
        shielded: "addr_test1_shielded_fixture",
        unshielded: "addr_test1_unshielded_fixture",
        dust: "addr_test1_dust_fixture",
      },
      sync: {
        shielded: { state: "synced", percentage: 100 },
        unshielded: { state: "syncing", percentage: 61 },
        dust: { state: "syncing", percentage: 42 },
      },
      balances: {
        shielded: { assetId: "NIGHT", amount: "42000000" },
        unshielded: { assetId: "NIGHT", amount: "12000000" },
        dust: { assetId: "DUST", amount: "730000" },
      },
      dependencies: { node: "connected", indexer: "connected", prover: "connected" },
      vault: "seed-vault-fixture",
      checkpoint: "checkpoint-fixture",
      keys: { spendingKey: "spending-key-fixture" },
    },
  };
}

function minimalState(sequence: string): GsdNativeMessage {
  return {
    version: "gsd/1",
    type: "state",
    stream: "state",
    sequence,
    payload: { lifecycle: "ready", network: "preprod" },
  };
}
