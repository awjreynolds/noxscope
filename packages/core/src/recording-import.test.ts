import {
  NOXSCOPE_RECORDING_MAGIC,
  createRecorder,
  sanitizeRecordingRecord,
  type RecordingExport,
  type RecordingRecord,
} from "./recording.js";
import type { NoxscopeRecord } from "@noxscope/protocol";
import { importRecording, type RecordingImportOptions } from "./recording-import.js";
import type { AdapterSanitizationManifest } from "./sanitizer.js";
import { describe, expect, it, vi } from "vitest";

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

const secondRecord: RecordingRecord = {
  ...record,
  meta: { ...record.meta, sequence: "2", receivedAt: "2026-08-18T12:00:00.002Z" },
};

const manifest: AdapterSanitizationManifest = {
  adapter: { id: "test-adapter", version: "1.0.0", sourceVersions: ["fixture"] },
  policy: { id: "noxscope.redaction", version: "1.0.0", digest: "policy-digest" },
  projections: [],
};

const key = new Uint8Array(32).fill(9);
const options: RecordingImportOptions = { sanitization: { manifest, pseudonymKey: key } };

async function makeExport(
  records: readonly RecordingRecord[] = [record],
  recordingManifest: AdapterSanitizationManifest = manifest,
): Promise<RecordingExport> {
  const recorder = createRecorder({
    now: () => "2026-08-18T12:00:02.000Z",
    sanitization: { manifest: recordingManifest, pseudonymKey: key },
  });
  for (const item of records) await recorder.append(item);
  const result = await recorder.finalize();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function frameRanges(
  bytes: Uint8Array,
): { type: string; start: number; end: number; payloadStart: number; payloadEnd: number }[] {
  const text = new TextDecoder().decode(bytes);
  const ranges: {
    type: string;
    start: number;
    end: number;
    payloadStart: number;
    payloadEnd: number;
  }[] = [];
  let offset = new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`).byteLength;
  while (offset < bytes.byteLength) {
    const start = offset;
    const controlEnd = bytes.indexOf(0x0a, offset);
    if (controlEnd < 0) break;
    const control = JSON.parse(text.slice(offset, controlEnd)) as { type: string; bytes: number };
    const payloadStart = controlEnd + 1;
    const payloadEnd = payloadStart + control.bytes;
    ranges.push({ type: control.type, start, end: payloadEnd + 1, payloadStart, payloadEnd });
    offset = payloadEnd + 1;
  }
  return ranges;
}

function replaceByte(bytes: Uint8Array, needle: string): Uint8Array {
  const copy = bytes.slice();
  const text = new TextDecoder().decode(copy);
  const index = text.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  if (index < 0) throw new Error("fixture needle missing");
  copy[index] = copy[index]! ^ 1;
  return copy;
}

async function expectRejected(bytes: Uint8Array, expectedCode?: string): Promise<void> {
  const result = await importRecording(bytes, options);
  expect(result.ok).toBe(false);
  if (!result.ok && expectedCode !== undefined) expect(result.error.code).toBe(expectedCode);
}

describe("Recording v1 hostile import and offline replay", () => {
  it("round-trips, detaches source bytes, and replays inert records deterministically", async () => {
    const exported = await makeExport();
    const source = exported.bytes.slice();
    const pending = importRecording(source, options);
    source.fill(0);
    const imported = await pending;
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.records).toHaveLength(1);
    const first: NoxscopeRecord[] = [];
    for await (const item of imported.value) first.push(item);
    const second: NoxscopeRecord[] = [];
    for await (const item of imported.value.replay()) second.push(item);
    expect(first).toEqual(second);
    expect(Object.isFrozen(imported.value.manifest)).toBe(true);
    expect(Object.isFrozen(imported.value.records)).toBe(true);

    const request = await imported.value
      .replay()
      .request({ kind: "invoke", operation: "wallet.sync" });
    expect(request).toEqual({
      ok: false,
      error: {
        code: "unsupported",
        message: "Offline replay cannot invoke runtime operations",
        retryable: false,
      },
    });
    const abort = new AbortController();
    abort.abort();
    const aborted: NoxscopeRecord[] = [];
    for await (const item of imported.value.replay({ signal: abort.signal })) aborted.push(item);
    expect(aborted).toEqual([]);
  });

  it("keeps canonical recording pseudonyms stable across import and re-export", async () => {
    const first = await makeExport([
      {
        ...record,
        meta: {
          ...record.meta,
          correlation: {
            requestId: "request-1",
            operationId: "operation-1",
            traceId: "trace-1",
          },
        },
      },
    ]);
    const imported = await importRecording(first.bytes, options);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const recorder = createRecorder({
      now: () => "2026-08-18T12:00:02.000Z",
      sanitization: { manifest, pseudonymKey: key },
    });
    await recorder.append(imported.value.records[0]);
    const second = await recorder.finalize();
    expect(second).toEqual({ ok: true, value: expect.objectContaining({ bytes: first.bytes }) });
  });

  it("keeps raw S2 pseudonyms stable across import and re-export", async () => {
    const rawManifest: AdapterSanitizationManifest = {
      ...manifest,
      raw: {
        namespace: "test.raw.s2",
        schemaVersion: "1",
        projections: [
          {
            source: "address",
            target: "address",
            classification: "S2",
            transform: "pseudonym",
          },
        ],
      },
    };
    const rawRecord = {
      ...record,
      event: {
        ...record.event,
        raw: [
          {
            namespace: "test.raw.s2",
            schemaVersion: "1",
            value: { address: "raw-address" },
            sanitization: {
              policy: manifest.policy.id,
              policyVersion: manifest.policy.version,
              redactions: [],
            },
          },
        ],
      },
    } as unknown as RecordingRecord;
    const first = await makeExport([rawRecord], rawManifest);
    const firstText = new TextDecoder().decode(first.bytes);
    expect(firstText).toMatch(/hmac-sha256:[0-9a-f]{64}/u);
    const imported = await importRecording(first.bytes, {
      sanitization: { manifest: rawManifest, pseudonymKey: key },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const recorder = createRecorder({
      now: () => "2026-08-18T12:00:02.000Z",
      sanitization: { manifest: rawManifest, pseudonymKey: key },
    });
    await recorder.append(imported.value.records[0]);
    const second = await recorder.finalize();
    expect(second).toEqual({ ok: true, value: expect.objectContaining({ bytes: first.bytes }) });
  });

  it("bounds lower file limits and copies the source buffer only once", async () => {
    const exported = await makeExport([record, secondRecord]);
    const sourceSize = exported.bytes.byteLength;
    const originalSlice = Uint8Array.prototype.slice;
    let fullCopies = 0;
    const sliceSpy = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (
      this: Uint8Array,
      start?: number,
      end?: number,
    ) {
      if (this.byteLength === sourceSize && start === undefined && end === undefined) {
        fullCopies += 1;
      }
      return originalSlice.call(this, start, end);
    });
    try {
      const imported = await importRecording(exported.bytes, options);
      expect(imported.ok).toBe(true);
      expect(fullCopies).toBe(1);
      const overflowed = await importRecording(exported.bytes, {
        ...options,
        limits: { maxFileBytes: sourceSize - 1 },
      });
      expect(overflowed).toMatchObject({ ok: false, error: { code: "overflow" } });
    } finally {
      sliceSpy.mockRestore();
    }
  });

  it("contains hostile Uint8Array traps and caller re-sanitization limits", async () => {
    const exported = await makeExport();
    const hostile = new Proxy(exported.bytes, {
      get(target, property, receiver) {
        if (property === "byteLength" || property === "slice") throw new Error("byte trap");
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(importRecording(hostile as unknown as Uint8Array, options)).resolves.toMatchObject(
      { ok: false, error: { code: "invalid" } },
    );

    const inputLimited = await importRecording(exported.bytes, {
      ...options,
      limits: { maxInputBytes: 1 },
    });
    expect(inputLimited).toMatchObject({ ok: false, error: { code: "overflow" } });

    const frameLimited = await importRecording(exported.bytes, {
      ...options,
      limits: { maxRecordBytes: 1 },
    });
    expect(frameLimited).toMatchObject({ ok: false, error: { code: "overflow" } });
  });

  it("imports more than 4,095 accepted records while bounding the configured count", async () => {
    const records = Array.from({ length: 4_096 }, (_, index) => ({
      ...record,
      meta: { ...record.meta, sequence: String(index + 1) },
    }));
    const exported = await makeExport(records);
    const imported = await importRecording(exported.bytes, {
      ...options,
      limits: { maxRecords: records.length },
    });
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.value.records).toHaveLength(records.length);
  });

  it("rejects tamper, truncation, trailing data, reorder, and control digest changes", async () => {
    const exported = await makeExport([record, secondRecord]);
    await expectRejected(replaceByte(exported.bytes, "ready"));
    await expectRejected(exported.bytes.slice(0, -1));
    await expectRejected(new Uint8Array([...exported.bytes, 0x00]));
    const ranges = frameRanges(exported.bytes);
    const records = ranges.filter((range) => range.type === "record");
    const reordered = exported.bytes.slice();
    const first = reordered.slice(records[0]!.start, records[0]!.end);
    const second = reordered.slice(records[1]!.start, records[1]!.end);
    reordered.set(second, records[0]!.start);
    reordered.set(first, records[1]!.start);
    await expectRejected(reordered);
    await expectRejected(replaceByte(exported.bytes, '"sha256":'));
  });

  it("rejects invalid UTF-8, duplicate/prototype keys, archives, and oversized declarations", async () => {
    const exported = await makeExport();
    const ranges = frameRanges(exported.bytes);
    const header = ranges[0]!;

    const invalidUtf8 = exported.bytes.slice();
    invalidUtf8[header.payloadStart] = 0xc3;
    await expectRejected(invalidUtf8, "invalid");

    const duplicate = new TextEncoder().encode(
      '{"format":"noxscope.recording","format":"noxscope.recording"}',
    );
    await expectRejected(duplicate);

    const polluted = new TextEncoder().encode('{"__proto__":null,"format":"noxscope.recording"}');
    await expectRejected(polluted);

    const gzip = exported.bytes.slice();
    gzip[0] = 0x1f;
    gzip[1] = 0x8b;
    await expectRejected(gzip, "incompatible");

    const oversized = exported.bytes.slice();
    const controlEnd = oversized.indexOf(
      0x0a,
      new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`).byteLength,
    );
    const control = new TextDecoder().decode(
      oversized.slice(
        new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`).byteLength,
        controlEnd,
      ),
    );
    const rewritten = control.replace(/"bytes":\d+/u, `"bytes":${Number.MAX_SAFE_INTEGER}`);
    const rewrittenBytes = new TextEncoder().encode(rewritten);
    const rebuilt = new Uint8Array(
      oversized.byteLength +
        rewrittenBytes.byteLength -
        (controlEnd - new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`).byteLength),
    );
    const controlStart = new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`).byteLength;
    rebuilt.set(oversized.slice(0, controlStart), 0);
    rebuilt.set(rewrittenBytes, controlStart);
    rebuilt[controlStart + rewrittenBytes.byteLength] = 0x0a;
    rebuilt.set(oversized.slice(controlEnd + 1), controlStart + rewrittenBytes.byteLength + 1);
    await expectRejected(rebuilt, "overflow");
  });

  it("rejects protocol/schema/policy provenance mismatches and re-sanitizes canaries", async () => {
    const exported = await makeExport();
    const otherManifest: AdapterSanitizationManifest = {
      ...manifest,
      policy: { ...manifest.policy, digest: "other-policy" },
    };
    const mismatch = await importRecording(exported.bytes, {
      sanitization: { manifest: otherManifest, pseudonymKey: key },
    });
    expect(mismatch).toMatchObject({ ok: false, error: { code: "incompatible" } });

    const canaryRecord = {
      ...record,
      event: {
        ...record.event,
        message:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      },
    };
    const canary = await makeExport([canaryRecord]);
    expect(new TextDecoder().decode(canary.bytes)).not.toContain("abandon abandon");
    const imported = await importRecording(canary.bytes, options);
    expect(imported.ok).toBe(true);
    if (imported.ok)
      expect(JSON.stringify(imported.value.records)).not.toContain("abandon abandon");
  });

  it("reports raw namespace drops when a hostile record adds unknown raw detail", async () => {
    const exported = await makeExport();
    const tampered = await addUnknownRawAndReframe(exported.bytes);
    const imported = await importRecording(tampered, options);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.audit.droppedRawDetails).toBe(1);
    expect(imported.value.audit.warnings).toContain(
      "Unknown raw detail namespace or schema was dropped during import",
    );
    expect(JSON.stringify(imported.value.records)).not.toContain("unknown.raw");
  });

  it("drops raw details with mismatched embedded sanitization provenance", async () => {
    const rawManifest: AdapterSanitizationManifest = {
      ...manifest,
      raw: {
        namespace: "test.raw",
        schemaVersion: "1",
        projections: [
          {
            source: "message",
            target: "message",
            classification: "S3",
            transform: "copy",
          },
        ],
      },
    };
    const rawRecord = {
      ...record,
      event: {
        ...record.event,
        raw: [
          {
            namespace: "test.raw",
            schemaVersion: "1",
            value: { message: "safe raw message" },
            sanitization: {
              policy: manifest.policy.id,
              policyVersion: manifest.policy.version,
              redactions: [],
            },
          },
        ],
      },
    } as unknown as RecordingRecord;
    const exported = await makeExport([rawRecord], rawManifest);
    const tampered = await replaceRawProvenance(exported.bytes, "wrong-policy", "0");
    const imported = await importRecording(tampered, {
      sanitization: { manifest: rawManifest, pseudonymKey: key },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.audit.droppedRawDetails).toBe(1);
    expect(imported.value.audit.warnings).toContain(
      "Raw detail sanitization provenance was incompatible and was dropped during import",
    );
    expect(JSON.stringify(imported.value.records)).not.toContain("safe raw message");
  });

  it("rejects inconsistent accepted counts and does not trust dropped/redaction claims", async () => {
    const exported = await makeExport();
    const inconsistent = await mutateManifestAndReframe(exported.bytes, (value) => {
      const counts = value.counts as Record<string, unknown>;
      counts.records = 99;
      counts.droppedRecords = 98;
      counts.droppedAttributes = 97;
      counts.redactions = 96;
    });
    const rejected = await importRecording(inconsistent, options);
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid" } });

    const claims = await mutateManifestAndReframe(exported.bytes, (value) => {
      const counts = value.counts as Record<string, unknown>;
      counts.droppedRecords = 98;
      counts.droppedAttributes = 97;
      counts.redactions = 96;
    });
    const accepted = await importRecording(claims, options);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.manifest.counts).toMatchObject({
        records: 1,
        gaps: 0,
        droppedRecords: 0,
        droppedAttributes: 0,
        redactions: 0,
      });
      expect(accepted.value.audit.sourceCounts).toMatchObject({
        droppedRecords: 98,
        droppedAttributes: 97,
        redactions: 96,
      });
    }

    const mismatchedManifest = await mutateManifestAndReframe(exported.bytes, (value) => {
      value.exportedAt = "2026-08-18T12:00:03.000Z";
    });
    await expectRejected(mismatchedManifest, "incompatible");
  });

  it("rejects additive manifest, count, and integrity keys without exposing canaries", async () => {
    const exported = await makeExport();
    const hostile = await mutateManifestAndReframe(exported.bytes, (value) => {
      value.mnemonic =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      (value.counts as Record<string, unknown>).unknownCanary = "count-canary";
      (value.integrity as Record<string, unknown>).unknownCanary = "integrity-canary";
    });
    const result = await importRecording(hostile, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["invalid", "incompatible"]).toContain(result.error.code);
    expect(JSON.stringify(result)).not.toContain("abandon abandon");
    expect(JSON.stringify(result)).not.toContain("count-canary");
    expect(JSON.stringify(result)).not.toContain("integrity-canary");
  });

  it("contains hostile direct canonicalization inputs without invoking getters or cycles", async () => {
    const getter = structuredClone(record) as unknown as Record<string, unknown>;
    let invoked = false;
    Object.defineProperty(getter.meta, "sessionId", {
      enumerable: true,
      get() {
        invoked = true;
        return "must-not-read";
      },
    });
    const cycle = structuredClone(record) as unknown as Record<string, unknown>;
    (cycle.event as Record<string, unknown>).loop = cycle;
    await expect(
      sanitizeRecordingRecord(getter as unknown as RecordingRecord, {
        manifest,
        pseudonymKey: key,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid" } });
    await expect(
      sanitizeRecordingRecord(cycle as unknown as RecordingRecord, { manifest, pseudonymKey: key }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(invoked).toBe(false);
  });
});

async function mutateManifestAndReframe(
  bytes: Uint8Array,
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<Uint8Array> {
  const ranges = frameRanges(bytes);
  const manifestRange = ranges.find((range) => range.type === "manifest")!;
  const text = new TextDecoder().decode(bytes);
  const value = JSON.parse(
    text.slice(manifestRange.payloadStart, manifestRange.payloadEnd),
  ) as Record<string, unknown>;
  mutate(value);
  return reframeManifest(bytes, new TextEncoder().encode(JSON.stringify(sortJson(value))));
}

async function reframeManifest(
  bytes: Uint8Array,
  manifestPayload: Uint8Array,
): Promise<Uint8Array> {
  const ranges = frameRanges(bytes);
  const text = new TextDecoder().decode(bytes);
  const parts: { type: string; payload: Uint8Array }[] = [];
  for (const range of ranges) {
    const controlEnd = bytes.indexOf(0x0a, range.start);
    const control = JSON.parse(text.slice(range.start, controlEnd)) as { type: string };
    parts.push({
      type: control.type,
      payload:
        control.type === "manifest"
          ? manifestPayload
          : bytes.slice(range.payloadStart, range.payloadEnd),
    });
  }
  const frameBytes = async (part: { type: string; payload: Uint8Array }): Promise<Uint8Array> => {
    const digest = await sha256(part.payload);
    const control = new TextEncoder().encode(
      JSON.stringify(
        sortJson({ type: part.type, bytes: part.payload.byteLength, sha256: digest }),
      ) + "\n",
    );
    return new Uint8Array([...control, ...part.payload, 0x0a]);
  };
  const prefixParts: Uint8Array[] = [new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`)];
  for (const part of parts.slice(0, -2)) prefixParts.push(await frameBytes(part));
  const prefix = new Uint8Array(prefixParts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of prefixParts) {
    prefix.set(part, offset);
    offset += part.byteLength;
  }
  const manifestFrame = await frameBytes({ type: "manifest", payload: manifestPayload });
  const beforeTerminal = new Uint8Array([...prefix, ...manifestFrame]);
  const terminalPayload = new TextEncoder().encode(
    JSON.stringify(
      sortJson({
        type: "integrity",
        contentDigest: await sha256Hex(beforeTerminal),
        manifestFrameDigest: await sha256(manifestPayload),
      }),
    ),
  );
  const terminalFrame = await frameBytes({ type: "integrity", payload: terminalPayload });
  return new Uint8Array([...beforeTerminal, ...terminalFrame]);
}

async function addUnknownRawAndReframe(bytes: Uint8Array): Promise<Uint8Array> {
  const ranges = frameRanges(bytes);
  const recordRange = ranges.find((range) => range.type === "record")!;
  const text = new TextDecoder().decode(bytes);
  const recordPayload = JSON.parse(
    text.slice(recordRange.payloadStart, recordRange.payloadEnd),
  ) as Record<string, unknown>;
  const event = recordPayload.event as Record<string, unknown>;
  event.raw = [
    {
      namespace: "unknown.raw",
      schemaVersion: "1",
      value: {},
      sanitization: { policy: "x", policyVersion: "1", redactions: [] },
    },
  ];
  return reframe(
    bytes,
    recordRange,
    new TextEncoder().encode(JSON.stringify(sortJson(recordPayload))),
  );
}

async function replaceRawProvenance(
  bytes: Uint8Array,
  policy: string,
  policyVersion: string,
): Promise<Uint8Array> {
  const ranges = frameRanges(bytes);
  const recordRange = ranges.find((range) => range.type === "record")!;
  const text = new TextDecoder().decode(bytes);
  const recordPayload = JSON.parse(
    text.slice(recordRange.payloadStart, recordRange.payloadEnd),
  ) as Record<string, unknown>;
  const event = recordPayload.event as Record<string, unknown>;
  const raw = event.raw as Array<Record<string, unknown>>;
  const sanitization = raw[0]!.sanitization as Record<string, unknown>;
  sanitization.policy = policy;
  sanitization.policyVersion = policyVersion;
  return reframe(
    bytes,
    recordRange,
    new TextEncoder().encode(JSON.stringify(sortJson(recordPayload))),
  );
}

async function reframe(
  bytes: Uint8Array,
  changed: { start: number; end: number; payloadStart: number; payloadEnd: number },
  payload: Uint8Array,
): Promise<Uint8Array> {
  const ranges = frameRanges(bytes);
  const parts: { type: string; payload: Uint8Array }[] = [];
  const text = new TextDecoder().decode(bytes);
  for (const range of ranges) {
    const controlEnd = bytes.indexOf(0x0a, range.start);
    const control = JSON.parse(text.slice(range.start, controlEnd)) as { type: string };
    parts.push({
      type: control.type,
      payload:
        range.start === changed.start ? payload : bytes.slice(range.payloadStart, range.payloadEnd),
    });
  }
  const header = parts[0]!;
  const record = parts.find((part) => part.type === "record")!;
  const manifest = parts.find((part) => part.type === "manifest")!;
  const frameBytes = async (part: { type: string; payload: Uint8Array }): Promise<Uint8Array> => {
    const digest = await sha256(part.payload);
    const control = new TextEncoder().encode(
      JSON.stringify(
        sortJson({ type: part.type, bytes: part.payload.byteLength, sha256: digest }),
      ) + "\n",
    );
    return new Uint8Array([...control, ...part.payload, 0x0a]);
  };
  const headerFrame = await frameBytes(header);
  const recordFrame = await frameBytes(record);
  const prefix = new Uint8Array([
    ...new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`),
    ...headerFrame,
    ...recordFrame,
  ]);
  const manifestObject = JSON.parse(new TextDecoder().decode(manifest.payload)) as Record<
    string,
    unknown
  >;
  const integrityObject = manifestObject.integrity as Record<string, unknown>;
  const frameDigests = integrityObject.frameDigests as Array<Record<string, unknown>>;
  frameDigests[1] = {
    bytes: record.payload.byteLength,
    index: 1,
    sha256: await sha256(record.payload),
    type: "record",
  };
  integrityObject.contentDigest = await sha256Hex(prefix);
  const manifestPayload = new TextEncoder().encode(JSON.stringify(sortJson(manifestObject)));
  const manifestFrame = await frameBytes({ type: "manifest", payload: manifestPayload });
  const beforeTerminal = new Uint8Array([...prefix, ...manifestFrame]);
  const terminalPayload = new TextEncoder().encode(
    JSON.stringify(
      sortJson({
        type: "integrity",
        contentDigest: await sha256Hex(beforeTerminal),
        manifestFrameDigest: await sha256(manifestPayload),
      }),
    ),
  );
  const terminalFrame = await frameBytes({ type: "integrity", payload: terminalPayload });
  return new Uint8Array([...beforeTerminal, ...terminalFrame]);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      output[key] = sortJson((value as Record<string, unknown>)[key]);
    return output;
  }
  return value;
}

function sha256(value: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", value as BufferSource)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function sha256Hex(value: Uint8Array): Promise<string> {
  return sha256(value);
}
