import type { InvokeRequest, NoxscopeRecord, RuntimeSession } from "@noxscope/protocol";
import { describe, expect, it } from "vitest";
import { createMockAdapter, type MockScenario } from "./index.js";

describe("NoxscopeAdapter", () => {
  it("connects a healthy runtime and emits its sync progression in source order", async () => {
    const lifetime = new AbortController();
    const connected = await createMockAdapter("healthy").connect({ signal: lifetime.signal });

    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    expect(connected.value.descriptor.runtime.name).toBe(
      "Deterministic Midnight Runtime — healthy",
    );
    const records = await takeRecords(connected.value, 4);

    expect(records.map((record) => record.meta.sequence)).toEqual(["1", "2", "3", "4"]);
    expect(
      records
        .filter((record) => record.kind === "snapshot")
        .map((record) => record.snapshot.sync?.state),
    ).toEqual(["syncing", "syncing", "synced"]);
    expect(records.at(-1)?.kind).toBe("diagnostic-event");
  });

  it("runs a successful transaction as one correlated operation", async () => {
    const lifetime = new AbortController();
    const connected = await createMockAdapter("healthy").connect({ signal: lifetime.signal });
    if (!connected.ok) throw new Error(connected.error.message);

    const result = await connected.value.request({
      kind: "invoke",
      requestId: "request-submit-1",
      operationId: "operation-submit-1",
      operation: { kind: "transaction.submit", artifact: { transaction: "fixture-1" } },
    });
    const records = await takeRecords(connected.value, 7);

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "transaction.submit",
        phase: "confirmed",
        state: "succeeded",
        result: { transactionId: "tx-mock-0001" },
      },
    });
    expect(
      records
        .filter((record) => record.kind === "operation")
        .map((record) => [record.meta.correlation.operationId, record.operation.phase]),
    ).toEqual([
      ["operation-submit-1", "submitting"],
      ["operation-submit-1", "confirming"],
      ["operation-submit-1", "confirmed"],
    ]);
  });

  it("keeps the ordered stream live for operation updates requested after observation starts", async () => {
    const lifetime = new AbortController();
    const connected = await createMockAdapter("healthy").connect({ signal: lifetime.signal });
    if (!connected.ok) throw new Error(connected.error.message);
    const iterator = connected.value[Symbol.asyncIterator]();
    for (let index = 0; index < 4; index += 1) await iterator.next();
    const nextUpdate = iterator.next();
    await Promise.resolve();

    await connected.value.request({
      kind: "invoke",
      requestId: "request-live-1",
      operationId: "operation-live-1",
      operation: { kind: "transaction.submit", artifact: { transaction: "live" } },
    });
    const updates = [await nextUpdate];
    for (let index = 1; index < 3; index += 1) updates.push(await iterator.next());
    lifetime.abort();

    expect(
      updates.map((update) =>
        update.done
          ? "done"
          : update.value.kind === "operation"
            ? update.value.operation.phase
            : "unexpected",
      ),
    ).toEqual(["submitting", "confirming", "confirmed"]);
  });

  it("rejects a portable operation that uses an extension payload shape", async () => {
    const connected = await createMockAdapter("healthy").connect({
      signal: new AbortController().signal,
    });
    if (!connected.ok) throw new Error(connected.error.message);
    const malformed: unknown = {
      kind: "invoke",
      requestId: "request-malformed-1",
      operationId: "operation-malformed-1",
      operation: { kind: "transaction.submit", input: { transaction: "missing-artifact" } },
    };

    const result = await connected.value.request(malformed as InvokeRequest);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid",
        message: "Operation input is invalid",
        retryable: false,
      },
    });
  });

  it("reports a failed transaction once as its terminal operation outcome", async () => {
    const connected = await createMockAdapter("failed-transaction").connect({
      signal: new AbortController().signal,
    });
    if (!connected.ok) throw new Error(connected.error.message);

    const result = await connected.value.request({
      kind: "invoke",
      requestId: "request-failed-1",
      operationId: "operation-failed-1",
      operation: { kind: "transaction.submit", artifact: { transaction: "fixture-rejected" } },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "transaction.submit",
        phase: "submitting",
        state: "failed",
        error: {
          code: "rejected",
          message: "Node rejected the deterministic transaction",
          retryable: false,
        },
      },
    });
  });

  it("exposes stalled sync, prover failure, and node disconnect as canonical observations", async () => {
    const observed: Record<string, string> = {};
    for (const scenario of ["stalled-sync", "prover-failure", "node-disconnect"] as const) {
      const connected = await createMockAdapter(scenario).connect({
        signal: new AbortController().signal,
      });
      if (!connected.ok) throw new Error(connected.error.message);
      const records = await takeRecords(connected.value, 4);
      const latest = records.filter((record) => record.kind === "snapshot").at(-1);
      if (latest?.kind !== "snapshot") throw new Error("Expected a snapshot");
      observed[scenario] =
        scenario === "stalled-sync"
          ? (latest.snapshot.sync?.state ?? "missing")
          : (latest.snapshot.dependencies?.find((dependency) => dependency.state !== "connected")
              ?.state ?? "missing");
    }

    expect(observed).toEqual({
      "stalled-sync": "stalled",
      "prover-failure": "degraded",
      "node-disconnect": "disconnected",
    });
  });

  it("runs DUST registration through canonical operation updates", async () => {
    const connected = await createMockAdapter("dust-registration").connect({
      signal: new AbortController().signal,
    });
    if (!connected.ok) throw new Error(connected.error.message);

    const result = await connected.value.request({
      kind: "invoke",
      requestId: "request-dust-1",
      operationId: "operation-dust-1",
      operation: { kind: "dev.noxscope.dust.register", input: { source: "mock" } },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "dev.noxscope.dust.register",
        phase: "registered",
        state: "succeeded",
      },
    });
  });

  it("declares DUST registration support only for the scenario that implements it", async () => {
    const healthy = await createMockAdapter("healthy").connect({
      signal: new AbortController().signal,
    });
    const dust = await createMockAdapter("dust-registration").connect({
      signal: new AbortController().signal,
    });
    if (!healthy.ok || !dust.ok) throw new Error("Expected deterministic Runtime Sessions");

    expect(
      [healthy.value, dust.value].map(
        (session) =>
          session.descriptor.capabilities.find(
            (capability) => capability.id === "dev.noxscope.dust.register",
          )?.support.state,
      ),
    ).toEqual(["unsupported", "supported"]);
  });

  it("represents temporary operation unavailability without changing capability support", async () => {
    const connected = await createMockAdapter("unavailable" as MockScenario).connect({
      signal: new AbortController().signal,
    });
    if (!connected.ok) throw new Error(connected.error.message);

    const capability = connected.value.descriptor.capabilities.find(
      (candidate) => candidate.id === "operation.submit",
    );

    expect({
      support: capability?.support.state,
      availability: capability?.availability.state,
    }).toEqual({
      support: "supported",
      availability: "unavailable",
    });
  });

  it("creates a new Runtime Session identity when the same runtime reconnects", async () => {
    const adapter = createMockAdapter("reconnection" as MockScenario);

    const first = await adapter.connect({ signal: new AbortController().signal });
    const second = await adapter.connect({ signal: new AbortController().signal });
    if (!first.ok || !second.ok) throw new Error("Expected deterministic reconnections");

    expect({
      sessions: [first.value.descriptor.sessionId, second.value.descriptor.sessionId],
      runtimes: [first.value.descriptor.runtimeId, second.value.descriptor.runtimeId],
      identifiers: [
        first.value.descriptor.runtime.identifiers[0]?.value,
        second.value.descriptor.runtime.identifiers[0]?.value,
      ],
    }).toEqual({
      sessions: ["session-reconnection-1", "session-reconnection-2"],
      runtimes: ["runtime-reconnection-1", "runtime-reconnection-1"],
      identifiers: ["deterministic-reconnection", "deterministic-reconnection"],
    });
  });

  it("cancels a caller wait without claiming the underlying operation stopped", async () => {
    const lifetime = new AbortController();
    const waiting = new AbortController();
    const connected = await createMockAdapter("cancellation-race" as MockScenario).connect({
      signal: lifetime.signal,
    });
    if (!connected.ok) throw new Error(connected.error.message);
    const iterator = connected.value[Symbol.asyncIterator]();
    for (let index = 0; index < 4; index += 1) await iterator.next();

    const pending = connected.value.request(
      {
        kind: "invoke",
        requestId: "request-cancel-race-1",
        operationId: "operation-cancel-race-1",
        operation: { kind: "transaction.prove", artifact: { transaction: "slow" } },
      },
      { signal: waiting.signal },
    );
    const runningUpdate = iterator.next();
    waiting.abort();
    const result = await pending;
    lifetime.abort();
    const running = await runningUpdate;

    expect({
      result,
      update:
        running.done || running.value.kind !== "operation"
          ? undefined
          : { phase: running.value.operation.phase, state: running.value.operation.state },
    }).toEqual({
      result: {
        ok: false,
        error: { code: "cancelled", message: "Request wait was cancelled", retryable: false },
      },
      update: { phase: "proving", state: "running" },
    });
  });

  it("closes active iteration and pending waits when observation shuts down", async () => {
    const lifetime = new AbortController();
    const connected = await createMockAdapter("cancellation-race").connect({
      signal: lifetime.signal,
    });
    if (!connected.ok) throw new Error(connected.error.message);
    const iterator = connected.value[Symbol.asyncIterator]();
    for (let index = 0; index < 4; index += 1) await iterator.next();
    const request = connected.value.request({
      kind: "invoke",
      requestId: "request-shutdown-1",
      operationId: "operation-shutdown-1",
      operation: { kind: "transaction.prove", artifact: { transaction: "slow" } },
    });
    await iterator.next();
    const closed = iterator.next();

    lifetime.abort();

    expect({
      request: await request,
      iterator: await closed,
      later: await connected.value.request({ kind: "snapshot", requestId: "after-shutdown" }),
    }).toEqual({
      request: {
        ok: false,
        error: { code: "cancelled", message: "Request wait was cancelled", retryable: false },
      },
      iterator: { done: true, value: undefined },
      later: {
        ok: false,
        error: { code: "cancelled", message: "Request wait was cancelled", retryable: false },
      },
    });
  });

  it("preserves queue order for concurrent transaction operations", async () => {
    const connected = await createMockAdapter("queue").connect({
      signal: new AbortController().signal,
    });
    if (!connected.ok) throw new Error(connected.error.message);

    await connected.value.request({
      kind: "invoke",
      requestId: "request-queue-1",
      operationId: "operation-queue-1",
      operation: { kind: "transaction.submit", artifact: { transaction: "first" } },
    });
    await connected.value.request({
      kind: "invoke",
      requestId: "request-queue-2",
      operationId: "operation-queue-2",
      operation: { kind: "transaction.submit", artifact: { transaction: "second" } },
    });
    const records = await takeRecords(connected.value, 11);

    expect(
      records
        .filter(
          (record) =>
            record.kind === "operation" &&
            record.meta.correlation.operationId === "operation-queue-2",
        )
        .map((record) => (record.kind === "operation" ? record.operation.phase : "")),
    ).toEqual(["queued", "submitting", "confirming", "confirmed"]);
  });
});

async function takeRecords(session: RuntimeSession, count: number): Promise<NoxscopeRecord[]> {
  const iterator = session[Symbol.asyncIterator]();
  const records: NoxscopeRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await iterator.next();
    if (next.done) throw new Error(`Runtime Session ended after ${records.length} records`);
    records.push(next.value);
  }
  await iterator.return?.();
  return records;
}
