import { describe, expect, it } from "vitest";
import { createMockAdapter } from "./index.js";

describe("NoxscopeAdapter", () => {
  it("connects a healthy runtime and emits its sync progression in source order", async () => {
    const lifetime = new AbortController();
    const connected = await createMockAdapter("healthy").connect({ signal: lifetime.signal });

    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    expect(connected.value.descriptor.runtime.name).toBe(
      "Deterministic Midnight Runtime — healthy",
    );
    const records = [];
    for await (const record of connected.value) records.push(record);

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
    const records = [];
    for await (const record of connected.value) records.push(record);

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
      const records = [];
      for await (const record of connected.value) records.push(record);
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
    const records = [];
    for await (const record of connected.value) records.push(record);

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
