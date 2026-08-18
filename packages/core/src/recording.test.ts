import { NOXSCOPE_RECORDING_MAGIC, createRecorder, type RecordingRecord } from "./recording.js";
import { describe, expect, it } from "vitest";

const record: RecordingRecord = {
  kind: "diagnostic-event",
  meta: {
    protocol: "noxscope/adapter/1",
    sessionId: "session-1",
    runtimeId: "runtime-1",
    streamId: "events",
    sequence: "1",
    observedAt: "2026-08-18T12:00:00.000Z",
    receivedAt: "2026-08-18T12:00:00.001Z",
  },
  event: {
    type: "diagnostic",
    name: "runtime.ready",
    category: "lifecycle",
    level: "info",
    source: "runtime",
    message: "ready",
  },
};

describe("Recording v1 codec", () => {
  it("writes explicit magic, byte-length framed JSON, digests, and an immutable export", async () => {
    const recorder = createRecorder({
      now: () => "2026-08-18T12:00:02.000Z",
      adapters: [{ id: "mock", version: "1.0.0", sourceVersions: ["fixture"] }],
      policies: [{ id: "noxscope.redaction", version: "1.0.0", digest: "policy-digest" }],
    });

    expect(recorder.append(record)).toEqual({ ok: true, value: undefined });
    const result = await recorder.finalize();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result.value.bytes)).toContain(`${NOXSCOPE_RECORDING_MAGIC}\n`);
    expect(result.value.manifest.counts.records).toBe(1);
    expect(result.value.manifest.integrity.frameDigests).toHaveLength(2);
    expect(result.value.manifest.integrity.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result.value.manifest)).toBe(true);
    expect(Object.isFrozen(result.value.manifest.counts)).toBe(true);
    expect(() => result.value.bytes.fill(0)).not.toThrow();
    expect(recorder.append(record)).toEqual({
      ok: false,
      error: { code: "invalid", message: "Recorder has been finalized", retryable: false },
    });
    expect(await recorder.finalize()).toEqual({
      ok: false,
      error: { code: "invalid", message: "Recorder has been finalized", retryable: false },
    });
  });

  it("rejects invalid records without echoing input and enforces lower test limits", async () => {
    const recorder = createRecorder({ limits: { maxRecords: 1, maxRecordBytes: 512 } });
    const oversized = {
      ...record,
      event: { ...record.event, message: "x".repeat(200) },
    };

    expect(recorder.append(oversized)).toEqual({
      ok: false,
      error: {
        code: "overflow",
        message: "Recording record exceeds a resource limit",
        retryable: false,
      },
    });
    expect(recorder.append(record)).toEqual({ ok: true, value: undefined });
    expect(recorder.append(record)).toEqual({
      ok: false,
      error: {
        code: "overflow",
        message: "Recording record count exceeds a resource limit",
        retryable: false,
      },
    });
  });

  it("rejects unsafe encoding inputs and reports bounded lifecycle failures", () => {
    const recorder = createRecorder();
    const invalid = { ...record, meta: { ...record.meta, protocol: "wrong" } };
    expect(recorder.append(invalid)).toEqual({
      ok: false,
      error: { code: "protocol", message: "Record has an incompatible protocol", retryable: false },
    });
  });
});
