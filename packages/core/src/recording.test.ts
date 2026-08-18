import { NOXSCOPE_RECORDING_MAGIC, createRecorder, type RecordingRecord } from "./recording.js";
import type { AdapterSanitizationManifest } from "./sanitizer.js";
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

const manifest: AdapterSanitizationManifest = {
  adapter: { id: "test-adapter", version: "1.0.0", sourceVersions: ["fixture"] },
  policy: { id: "noxscope.redaction", version: "1.0.0", digest: "policy-digest" },
  projections: [],
};

const key = new Uint8Array(32).fill(7);

function makeRecorder(
  options: Parameters<typeof createRecorder>[0] = {},
): ReturnType<typeof createRecorder> {
  return createRecorder({
    ...options,
    sanitization: { manifest, pseudonymKey: key },
  });
}

function framePayloads(bytes: Uint8Array): { type: string; payload: string }[] {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  expect(lines.shift()).toBe(NOXSCOPE_RECORDING_MAGIC);
  const frames: { type: string; payload: string }[] = [];
  let index = 0;
  while (index < lines.length - 1) {
    const controlLine = lines[index++];
    if (controlLine === "") break;
    if (controlLine === undefined) break;
    const control = JSON.parse(controlLine) as { type: string; bytes: number };
    const payload = lines[index++] ?? "";
    expect(new TextEncoder().encode(payload).byteLength).toBe(control.bytes);
    frames.push({ type: control.type, payload });
  }
  return frames;
}

describe("Recording v1 codec", () => {
  it("writes explicit magic, byte-length framed JSON, digests, and an immutable export", async () => {
    const recorder = makeRecorder({
      now: () => "2026-08-18T12:00:02.000Z",
      adapters: [{ id: "mock", version: "1.0.0", sourceVersions: ["fixture"] }],
      policies: [{ id: "noxscope.redaction", version: "1.0.0", digest: "policy-digest" }],
    });

    await expect(recorder.append(record)).resolves.toEqual({ ok: true, value: undefined });
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
    await expect(recorder.append(record)).resolves.toEqual({
      ok: false,
      error: { code: "invalid", message: "Recorder has been finalized", retryable: false },
    });
    expect(await recorder.finalize()).toEqual({
      ok: false,
      error: { code: "invalid", message: "Recorder has been finalized", retryable: false },
    });
  });

  it("rejects invalid records without echoing input and enforces lower test limits", async () => {
    const recorder = makeRecorder({ limits: { maxRecords: 1, maxRecordBytes: 4096 } });
    const oversized = {
      ...record,
      event: { ...record.event, message: "é".repeat(4000) },
    };

    await expect(recorder.append(oversized)).resolves.toEqual({
      ok: false,
      error: {
        code: "overflow",
        message: "Recording record exceeds a resource limit",
        retryable: false,
      },
    });
    await expect(recorder.append(record)).resolves.toEqual({ ok: true, value: undefined });
    await expect(recorder.append(record)).resolves.toEqual({
      ok: false,
      error: {
        code: "overflow",
        message: "Recording record count exceeds a resource limit",
        retryable: false,
      },
    });
  });

  it("rejects unsafe encoding inputs and reports bounded lifecycle failures", async () => {
    const recorder = makeRecorder();
    const invalid = { ...record, meta: { ...record.meta, protocol: "wrong" } };
    await expect(recorder.append(invalid)).resolves.toEqual({
      ok: false,
      error: { code: "protocol", message: "Record has an incompatible protocol", retryable: false },
    });
  });

  it("does not export secret/prototype canaries and records policy drops", async () => {
    const recorder = makeRecorder();
    const canary = {
      ...record,
      event: {
        ...record.event,
        message:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        attributes: { __proto__: "polluted", secret: "never-export" },
      },
      privateKey: "never-export",
    } as unknown;
    await expect(recorder.append(canary)).resolves.toEqual({ ok: true, value: undefined });
    const result = await recorder.finalize();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = new TextDecoder().decode(result.value.bytes);
    expect(text).not.toContain("never-export");
    expect(text).not.toContain("abandon abandon");
    expect(result.value.manifest.counts.droppedAttributes).toBeGreaterThan(0);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects getters and cycles before protocol traversal", async () => {
    const getterRecord = structuredClone(record) as unknown as Record<string, unknown>;
    let invoked = false;
    Object.defineProperty(getterRecord.event as Record<string, unknown>, "message", {
      enumerable: true,
      get() {
        invoked = true;
        return "must-not-read";
      },
    });
    await expect(makeRecorder().append(getterRecord)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(invoked).toBe(false);

    const cycle = structuredClone(record) as unknown as Record<string, unknown>;
    const attributes: Record<string, unknown> = {};
    attributes.loop = attributes;
    (cycle.event as Record<string, unknown>).attributes = attributes;
    await expect(makeRecorder().append(cycle)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  it("enforces pre-validation depth/property/byte budgets", async () => {
    const result = await makeRecorder({
      limits: { maxInputBytes: 256, maxDepth: 4, maxObjectProperties: 4 },
    }).append({
      ...record,
      event: { ...record.event, message: "x".repeat(1024) },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "overflow",
        message: "Recording record exceeds a resource limit",
        retryable: false,
      },
    });
  });

  it("counts accepted gaps and refuses caller-supplied count fields", async () => {
    const gap = {
      kind: "diagnostic-event",
      meta: { ...record.meta, sequence: "2" },
      event: {
        type: "stream-gap",
        sourceStreamId: "events",
        firstLostSequence: "1",
        lastLostSequence: "1",
        reason: "source-gap",
      },
      counts: { records: 999999, gaps: 999999 },
    } as unknown;
    const recorder = makeRecorder({ limits: { maxRecords: 2 } });
    await expect(recorder.append(gap)).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      recorder.append({ ...(gap as Record<string, unknown>), kind: "unknown" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "protocol" },
    });
    const result = await recorder.finalize();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.counts).toMatchObject({ records: 1, gaps: 1, droppedRecords: 1 });
    expect(result.value.manifest.counts.records).not.toBe(999999);
  });

  it("emits a manifest digest and terminal integrity frame", async () => {
    const recorder = makeRecorder({ now: () => "2026-08-18T12:00:02.000Z" });
    await recorder.append(record);
    const result = await recorder.finalize();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frames = framePayloads(result.value.bytes);
    expect(frames.map((frame) => frame.type)).toEqual([
      "header",
      "record",
      "manifest",
      "integrity",
    ]);
    const manifestFrame = frames.find((frame) => frame.type === "manifest");
    const terminal = JSON.parse(frames.at(-1)!.payload) as {
      contentDigest: string;
      manifestFrameDigest: string;
    };
    expect(terminal.manifestFrameDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(terminal.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestFrame).toBeDefined();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(manifestFrame!.payload),
    );
    expect(terminal.manifestFrameDigest).toBe(
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  });

  it("keeps export bytes private and canonicalizes semantically equal key order", async () => {
    const first = makeRecorder({ now: () => "2026-08-18T12:00:02.000Z" });
    const second = makeRecorder({ now: () => "2026-08-18T12:00:02.000Z" });
    const reordered = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    reordered.meta = {
      receivedAt: record.meta.receivedAt,
      observedAt: record.meta.observedAt,
      sequence: record.meta.sequence,
      streamId: record.meta.streamId,
      runtimeId: record.meta.runtimeId,
      sessionId: record.meta.sessionId,
      protocol: record.meta.protocol,
    };
    await first.append(record);
    await second.append(reordered);
    const left = await first.finalize();
    const right = await second.finalize();
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    const leftBytes = left.value.bytes.slice();
    left.value.bytes.fill(0);
    expect(new Uint8Array(leftBytes)).toEqual(right.value.bytes);
  });

  it("contains clock failures and does not leak exception text", async () => {
    const recorder = makeRecorder({
      now: () => {
        throw new Error("secret clock detail");
      },
    });
    const result = await recorder.finalize();
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid", message: "Recording export time is invalid", retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain("secret clock detail");
  });
});
