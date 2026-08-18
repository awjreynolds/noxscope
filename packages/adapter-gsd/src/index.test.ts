import type {
  GsdAdapterOptions,
  GsdNativeMessage,
  GsdRequest,
  GsdTransport,
  GsdTransportConnection,
} from "./index.js";
import { createGsdAdapter } from "./index.js";
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
    const messages = Array.from({ length: 18 }, (_, index) => healthyState(String(index + 1)));
    const session = await connect(new FixtureConnection(healthyHandshake(), messages), {
      queueCapacity: 4,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const records = await takeRecords(session, 4);
    expect(
      records.some(
        (record) =>
          record.kind === "diagnostic-event" &&
          record.event.type === "stream-gap" &&
          record.event.reason === "overflow",
      ),
    ).toBe(true);
  });

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
  readonly #handshake: unknown;
  readonly #messages: readonly unknown[];
  readonly #snapshot: unknown;
  constructor(handshake: unknown, messages: readonly unknown[], snapshot?: unknown) {
    this.#handshake = handshake;
    this.#messages = messages;
    this.#snapshot = snapshot;
  }
  async describe(): Promise<unknown> {
    return this.#handshake;
  }
  async request(request: GsdRequest): Promise<unknown> {
    this.requests.push(request);
    return this.#snapshot ?? { version: "gsd/1", type: "response", payload: {} };
  }
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (const message of this.#messages) {
      await Promise.resolve();
      yield message;
    }
  }
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
