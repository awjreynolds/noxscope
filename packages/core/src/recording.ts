import {
  NOXSCOPE_PROTOCOL,
  validateRecord,
  type NoxscopeRecord,
  type Result,
} from "@noxscope/protocol";
import type { AdapterSanitizationManifest } from "./sanitizer.js";

/** The first bytes of every portable Noxscope Recording. */
export const NOXSCOPE_RECORDING_MAGIC = "NOXSCOPE-RECORDING/1" as const;
export const NOXSCOPE_RECORDING_FORMAT = "noxscope.recording" as const;
export const NOXSCOPE_RECORDING_SCHEMA_VERSION = "1" as const;

export interface RecordingAdapterReference {
  readonly id: string;
  readonly version: string;
  readonly sourceVersions: readonly string[];
}

export interface RecordingPolicyReference {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface RecordingLimits {
  readonly maxFileBytes: number;
  readonly maxRecords: number;
  readonly maxRecordBytes: number;
}

export const RECORDING_LIMITS: RecordingLimits = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxRecords: 1_000_000,
  maxRecordBytes: 256 * 1024,
});

export interface RecordingOptions {
  /** A clock is injectable so test fixtures can remain deterministic. */
  readonly now?: () => string;
  readonly adapters?: readonly RecordingAdapterReference[];
  readonly policies?: readonly RecordingPolicyReference[];
  /** Convenience for callers that already have the reviewed adapter manifest. */
  readonly manifest?: AdapterSanitizationManifest;
  readonly limits?: Partial<RecordingLimits>;
}

export type RecordingRecord = NoxscopeRecord;

export interface RecordingCounts {
  readonly records: number;
  readonly gaps: number;
  readonly droppedRecords: number;
  readonly droppedAttributes: number;
  readonly redactions: number;
}

export interface RecordingFrameDigest {
  readonly index: number;
  readonly type: "header" | "record";
  readonly bytes: number;
  readonly sha256: string;
}

export interface RecordingIntegrity {
  readonly algorithm: "SHA-256";
  readonly frameDigests: readonly RecordingFrameDigest[];
  /** Digest of all bytes from the magic through the final record frame. */
  readonly contentDigest: string;
  readonly authenticated: false;
  readonly warning: "Integrity digests detect accidental or modifying changes; they do not authenticate the producer.";
}

export interface RecordingManifest {
  readonly format: typeof NOXSCOPE_RECORDING_FORMAT;
  readonly formatVersion: 1;
  readonly protocol: typeof NOXSCOPE_PROTOCOL;
  readonly schemaVersion: typeof NOXSCOPE_RECORDING_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly adapters: readonly RecordingAdapterReference[];
  readonly policies: readonly RecordingPolicyReference[];
  readonly counts: RecordingCounts;
  readonly integrity: RecordingIntegrity;
}

export interface RecordingExport {
  readonly bytes: Uint8Array;
  readonly manifest: RecordingManifest;
}

export interface Recorder {
  append(record: unknown): Result<void>;
  finalize(): Promise<Result<RecordingExport>>;
}

interface ResolvedRecordingOptions {
  readonly now: () => string;
  readonly adapters: readonly RecordingAdapterReference[];
  readonly policies: readonly RecordingPolicyReference[];
  readonly limits: RecordingLimits;
}

interface FrameDigestInput {
  readonly type: "header" | "record";
  readonly payload: Uint8Array;
}

interface MutableRecordingCounts {
  records: number;
  gaps: number;
  droppedRecords: number;
  droppedAttributes: number;
  redactions: number;
}

interface FrameControl {
  readonly type: "header" | "record" | "manifest";
  readonly bytes: number;
  readonly sha256: string;
}

interface RecordingHeader {
  readonly format: typeof NOXSCOPE_RECORDING_FORMAT;
  readonly formatVersion: 1;
  readonly protocol: typeof NOXSCOPE_PROTOCOL;
  readonly schemaVersion: typeof NOXSCOPE_RECORDING_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly adapters: readonly RecordingAdapterReference[];
  readonly policies: readonly RecordingPolicyReference[];
}

const INTEGRITY_WARNING =
  "Integrity digests detect accidental or modifying changes; they do not authenticate the producer." as const;

export function createRecorder(options: RecordingOptions = {}): Recorder {
  return new RecordingBuilder(resolveOptions(options));
}

class RecordingBuilder implements Recorder {
  readonly #options: ResolvedRecordingOptions;
  readonly #frames: FrameDigestInput[] = [];
  readonly #counts: MutableRecordingCounts = {
    records: 0,
    gaps: 0,
    droppedRecords: 0,
    droppedAttributes: 0,
    redactions: 0,
  };
  #finalized = false;

  constructor(options: ResolvedRecordingOptions) {
    this.#options = options;
  }

  append(candidate: unknown): Result<void> {
    if (this.#finalized) return lifecycleError();
    const checked = validateRecord(candidate);
    if (!checked.ok) return checked;
    const encoded = encodeJson(checked.value);
    if (!encoded.ok) return encoded;
    if (encoded.value.byteLength > this.#options.limits.maxRecordBytes) {
      return overflow("Recording record exceeds a resource limit");
    }
    if (this.#counts.records >= this.#options.limits.maxRecords) {
      return overflow("Recording record count exceeds a resource limit");
    }

    this.#frames.push({ type: "record", payload: encoded.value });
    this.#counts.records += 1;
    if (checked.value.kind === "diagnostic-event" && checked.value.event.type === "stream-gap") {
      this.#counts.gaps += 1;
    }
    return { ok: true, value: undefined };
  }

  async finalize(): Promise<Result<RecordingExport>> {
    if (this.#finalized) return lifecycleError();
    this.#finalized = true;
    const exportedAt = this.#options.now();
    if (!validTimestamp(exportedAt)) return invalid("Recording export time is invalid");

    const header: RecordingHeader = {
      format: NOXSCOPE_RECORDING_FORMAT,
      formatVersion: 1,
      protocol: NOXSCOPE_PROTOCOL,
      schemaVersion: NOXSCOPE_RECORDING_SCHEMA_VERSION,
      exportedAt,
      adapters: this.#options.adapters,
      policies: this.#options.policies,
    };
    const encodedHeader = encodeJson(header);
    if (!encodedHeader.ok) return encodedHeader;
    if (encodedHeader.value.byteLength > this.#options.limits.maxRecordBytes) {
      return overflow("Recording header exceeds a resource limit");
    }
    const frames: FrameDigestInput[] = [
      { type: "header", payload: encodedHeader.value },
      ...this.#frames,
    ];
    const digests: RecordingFrameDigest[] = [];
    for (const [index, frame] of frames.entries()) {
      digests.push({
        index,
        type: frame.type,
        bytes: frame.payload.byteLength,
        sha256: await sha256Hex(frame.payload),
      });
    }

    const prefixParts: Uint8Array[] = [utf8(`${NOXSCOPE_RECORDING_MAGIC}\n`)];
    let totalBytes = prefixParts[0]!.byteLength;
    for (const [index, frame] of frames.entries()) {
      const control: FrameControl = {
        type: frame.type,
        bytes: frame.payload.byteLength,
        sha256: digests[index]!.sha256,
      };
      const encoded = encodeFrame(control, frame.payload);
      if (!encoded.ok) return encoded;
      prefixParts.push(encoded.value);
      totalBytes += encoded.value.byteLength;
      if (totalBytes > this.#options.limits.maxFileBytes) {
        return overflow("Recording file exceeds a resource limit");
      }
    }
    const prefix = concat(prefixParts, totalBytes);
    const manifest: RecordingManifest = deepFreeze({
      format: NOXSCOPE_RECORDING_FORMAT,
      formatVersion: 1,
      protocol: NOXSCOPE_PROTOCOL,
      schemaVersion: NOXSCOPE_RECORDING_SCHEMA_VERSION,
      exportedAt,
      adapters: this.#options.adapters,
      policies: this.#options.policies,
      counts: { ...this.#counts },
      integrity: {
        algorithm: "SHA-256",
        frameDigests: digests,
        contentDigest: await sha256Hex(prefix),
        authenticated: false,
        warning: INTEGRITY_WARNING,
      },
    });
    const encodedManifest = encodeJson(manifest);
    if (!encodedManifest.ok) return encodedManifest;
    const manifestDigest = await sha256Hex(encodedManifest.value);
    const manifestFrame = encodeFrame(
      { type: "manifest", bytes: encodedManifest.value.byteLength, sha256: manifestDigest },
      encodedManifest.value,
    );
    if (!manifestFrame.ok) return manifestFrame;
    const finalBytes = concat(
      [prefix, manifestFrame.value],
      prefix.byteLength + manifestFrame.value.byteLength,
    );
    if (finalBytes.byteLength > this.#options.limits.maxFileBytes) {
      return overflow("Recording file exceeds a resource limit");
    }
    return {
      ok: true,
      value: Object.freeze({ bytes: finalBytes, manifest }),
    };
  }
}

function resolveOptions(options: RecordingOptions): ResolvedRecordingOptions {
  const adapters = [...(options.adapters ?? [])];
  const policies = [...(options.policies ?? [])];
  if (options.manifest !== undefined) {
    if (!adapters.some((adapter) => adapter.id === options.manifest!.adapter.id)) {
      adapters.push({
        id: options.manifest.adapter.id,
        version: options.manifest.adapter.version,
        sourceVersions: [...options.manifest.adapter.sourceVersions],
      });
    }
    if (!policies.some((policy) => policy.id === options.manifest!.policy.id)) {
      policies.push({ ...options.manifest.policy });
    }
  }
  return {
    now: options.now ?? (() => new Date().toISOString()),
    adapters: deepFreeze(
      adapters.map((adapter) => ({ ...adapter, sourceVersions: [...adapter.sourceVersions] })),
    ),
    policies: deepFreeze(policies.map((policy) => ({ ...policy }))),
    limits: resolveLimits(options.limits),
  };
}

function resolveLimits(overrides: Partial<RecordingLimits> | undefined): RecordingLimits {
  const values = {
    maxFileBytes: overrides?.maxFileBytes ?? RECORDING_LIMITS.maxFileBytes,
    maxRecords: overrides?.maxRecords ?? RECORDING_LIMITS.maxRecords,
    maxRecordBytes: overrides?.maxRecordBytes ?? RECORDING_LIMITS.maxRecordBytes,
  };
  if (
    !Number.isSafeInteger(values.maxFileBytes) ||
    !Number.isSafeInteger(values.maxRecords) ||
    !Number.isSafeInteger(values.maxRecordBytes) ||
    values.maxFileBytes <= 0 ||
    values.maxRecords <= 0 ||
    values.maxRecordBytes <= 0
  ) {
    throw new Error("Recording limits are invalid");
  }
  return Object.freeze(values);
}

function encodeJson(value: unknown): Result<Uint8Array> {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return invalid("Recording value is not JSON");
    return { ok: true, value: utf8(text) };
  } catch {
    return invalid("Recording value is not JSON");
  }
}

function encodeFrame(control: FrameControl, payload: Uint8Array): Result<Uint8Array> {
  const encodedControl = encodeJson(control);
  if (!encodedControl.ok) return encodedControl;
  const line = concat([encodedControl.value, utf8("\n")], encodedControl.value.byteLength + 1);
  return {
    ok: true,
    value: concat([line, payload, utf8("\n")], line.byteLength + payload.byteLength + 1),
  };
}

function sha256Hex(value: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", value as BufferSource)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function validTimestamp(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function lifecycleError(): Result<never> {
  return invalid("Recorder has been finalized");
}

function overflow(message: string): Result<never> {
  return {
    ok: false,
    error: { code: "overflow", message, retryable: false },
  };
}

function invalid(message: string): Result<never> {
  return {
    ok: false,
    error: { code: "invalid", message, retryable: false },
  };
}
