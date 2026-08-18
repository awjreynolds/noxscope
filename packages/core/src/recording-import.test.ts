import {
  NOXSCOPE_RECORDING_MAGIC,
  createRecorder,
  type RecordingExport,
  type RecordingRecord,
} from "./recording.js";
import type { NoxscopeRecord } from "@noxscope/protocol";
import { importRecording, type RecordingImportOptions } from "./recording-import.js";
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
): Promise<RecordingExport> {
  const recorder = createRecorder({
    now: () => "2026-08-18T12:00:02.000Z",
    sanitization: { manifest, pseudonymKey: key },
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
});

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
