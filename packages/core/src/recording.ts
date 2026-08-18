import {
  NOXSCOPE_PROTOCOL,
  validateRecord,
  type JsonValue,
  type SanitizedRawDetail,
  type NoxscopeRecord,
  type Result,
} from "@noxscope/protocol";
import {
  createSanitizer,
  type AdapterSanitizationManifest,
  type DataClassification,
  type FieldTransform,
} from "./sanitizer.js";
import { isImportedRecordingRecord } from "./recording-internals.js";

/** The first bytes of every portable Noxscope Recording. */
export const NOXSCOPE_RECORDING_MAGIC = "NOXSCOPE-RECORDING/1" as const;
export const NOXSCOPE_RECORDING_FORMAT = "noxscope.recording" as const;
export const NOXSCOPE_RECORDING_SCHEMA_VERSION = "1" as const;

export interface RecordingAdapterReference {
  readonly id: string;
  readonly version: string;
  readonly sourceVersions: readonly string[];
  readonly raw?: { readonly namespace: string; readonly schemaVersion: string };
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
  readonly maxInputBytes: number;
  readonly maxDepth: number;
  readonly maxObjectProperties: number;
  readonly maxArrayElements: number;
  readonly maxStringBytes: number;
}

export const RECORDING_LIMITS: RecordingLimits = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxRecords: 1_000_000,
  maxRecordBytes: 256 * 1024,
  maxInputBytes: 16 * 1024 * 1024,
  maxDepth: 32,
  maxObjectProperties: 512,
  maxArrayElements: 4_096,
  maxStringBytes: 16 * 1024,
});

export interface RecordingSanitizationContext {
  readonly manifest: AdapterSanitizationManifest;
  /** Every Adapter manifest represented by the captured Runtime Sessions. */
  readonly adapters?: readonly AdapterSanitizationManifest[];
  /** A per-recording HMAC context; it is never serialized. */
  readonly pseudonymKey: Uint8Array;
  /** @internal Import-only preservation of already canonical recording pseudonyms. */
  readonly preserveRecordingPseudonyms?: boolean;
}

export interface RecordingOptions {
  /** A clock is injectable so test fixtures can remain deterministic. */
  readonly now?: () => string;
  readonly sanitization?: RecordingSanitizationContext;
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
  readonly type: "header" | "record" | "manifest";
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
  append(record: unknown): Promise<Result<void>>;
  finalize(): Promise<Result<RecordingExport>>;
}

export interface SanitizedRecordingRecord {
  readonly record: NoxscopeRecord;
  readonly droppedAttributes: number;
  readonly redactions: number;
}

interface ResolvedRecordingOptions {
  readonly now: () => string;
  readonly limits: RecordingLimits;
  readonly sanitization: RecordingSanitizationContext;
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
  readonly type: "header" | "record" | "manifest" | "integrity";
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

type SanitizedRecordResult = Result<{
  readonly record: NoxscopeRecord;
  readonly droppedAttributes: number;
  readonly redactions: number;
}>;

type FieldResult =
  | { readonly state: "kept"; readonly value: JsonValue; readonly redactions: number }
  | { readonly state: "dropped"; readonly redactions: number }
  | { readonly state: "invalid" };

interface SanitizationAccumulator {
  droppedAttributes: number;
  redactions: number;
}

const INTEGRITY_WARNING =
  "Integrity digests detect accidental or modifying changes; they do not authenticate the producer." as const;
const FINALIZATION_RESERVE_BYTES = 256 * 1024;

export function createRecorder(options: RecordingOptions = {}): Recorder {
  return new RecordingBuilder(resolveOptions(options));
}

/** Reuses the recorder's strict canonical projection for hostile imports. */
export async function sanitizeRecordingRecord(
  record: unknown,
  context: RecordingSanitizationContext,
  limits: RecordingLimits = RECORDING_LIMITS,
): Promise<Result<SanitizedRecordingRecord>> {
  try {
    const snapshot = snapshotInert(record, limits);
    if (snapshot.state !== "valid") {
      return snapshot.state === "overflow"
        ? overflow("Recording record exceeds a resource limit")
        : invalid("Recording record is invalid");
    }
    const checked = validateRecord(snapshot.value);
    if (!checked.ok) return checked;
    const manifest = snapshotInert(context.manifest, RECORDING_LIMITS);
    if (manifest.state !== "valid" || !isRecord(manifest.value)) {
      return invalid("Recording sanitization context is invalid");
    }
    if (
      !(context.pseudonymKey instanceof Uint8Array) ||
      context.pseudonymKey.byteLength < 32 ||
      context.pseudonymKey.byteLength > 64
    ) {
      return invalid("Recording sanitization context is invalid");
    }
    const safeContext: RecordingSanitizationContext = {
      manifest: manifest.value as unknown as AdapterSanitizationManifest,
      pseudonymKey: Uint8Array.prototype.slice.call(context.pseudonymKey) as Uint8Array,
      preserveRecordingPseudonyms: context.preserveRecordingPseudonyms === true,
    };
    return await sanitizeCanonicalRecord(checked.value, createSanitizer(), safeContext);
  } catch {
    return invalid("Recording record could not be sanitized");
  }
}

class RecordingBuilder implements Recorder {
  readonly #options: ResolvedRecordingOptions;
  readonly #frames: FrameDigestInput[] = [];
  readonly #sanitizer = createSanitizer();
  readonly #counts: MutableRecordingCounts = {
    records: 0,
    gaps: 0,
    droppedRecords: 0,
    droppedAttributes: 0,
    redactions: 0,
  };
  #appendTail: Promise<void> = Promise.resolve();
  #queuedBytes = utf8(`${NOXSCOPE_RECORDING_MAGIC}\n`).byteLength;
  #finalizing = false;
  #finalized = false;

  constructor(options: ResolvedRecordingOptions) {
    this.#options = options;
  }

  append(candidate: unknown): Promise<Result<void>> {
    if (this.#finalized || this.#finalizing) return Promise.resolve(lifecycleError());
    if (this.#queuedBytes + FINALIZATION_RESERVE_BYTES >= this.#options.limits.maxFileBytes) {
      this.#counts.droppedRecords += 1;
      return Promise.resolve(overflow("Recording file exceeds a resource limit"));
    }
    const snapshot = snapshotInert(candidate, this.#options.limits);
    if (snapshot.state !== "valid") {
      this.#counts.droppedRecords += 1;
      return Promise.resolve(
        snapshot.state === "overflow"
          ? overflow("Recording record exceeds a resource limit")
          : invalid("Recording record is invalid"),
      );
    }
    const preserveRecordingPseudonyms =
      typeof candidate === "object" && candidate !== null && isImportedRecordingRecord(candidate);
    const next = this.#appendTail.then(async () => {
      const result = await this.#appendInternal(snapshot.value, preserveRecordingPseudonyms);
      if (!result.ok) this.#counts.droppedRecords += 1;
      return result;
    });
    this.#appendTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async finalize(): Promise<Result<RecordingExport>> {
    if (this.#finalized || this.#finalizing) return lifecycleError();
    this.#finalizing = true;
    await this.#appendTail;
    this.#finalized = true;
    let exportedAt: unknown;
    try {
      exportedAt = this.#options.now();
    } catch {
      return invalid("Recording export time is invalid");
    }
    if (!validTimestamp(exportedAt)) return invalid("Recording export time is invalid");

    const header: RecordingHeader = {
      format: NOXSCOPE_RECORDING_FORMAT,
      formatVersion: 1,
      protocol: NOXSCOPE_PROTOCOL,
      schemaVersion: NOXSCOPE_RECORDING_SCHEMA_VERSION,
      exportedAt,
      adapters: adapterReferences(this.#options.sanitization),
      policies: [policyReference(this.#options.sanitization.manifest)],
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
      let digest: string;
      try {
        digest = await sha256Hex(frame.payload);
      } catch {
        return invalid("Recording integrity could not be computed");
      }
      digests.push({ index, type: frame.type, bytes: frame.payload.byteLength, sha256: digest });
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
    let prefixDigest: string;
    try {
      prefixDigest = await sha256Hex(prefix);
    } catch {
      return invalid("Recording integrity could not be computed");
    }
    const manifest: RecordingManifest = deepFreeze({
      format: NOXSCOPE_RECORDING_FORMAT,
      formatVersion: 1,
      protocol: NOXSCOPE_PROTOCOL,
      schemaVersion: NOXSCOPE_RECORDING_SCHEMA_VERSION,
      exportedAt,
      adapters: adapterReferences(this.#options.sanitization),
      policies: [policyReference(this.#options.sanitization.manifest)],
      counts: { ...this.#counts },
      integrity: {
        algorithm: "SHA-256",
        frameDigests: digests,
        contentDigest: prefixDigest,
        authenticated: false,
        warning: INTEGRITY_WARNING,
      },
    });
    const encodedManifest = encodeJson(manifest);
    if (!encodedManifest.ok) return encodedManifest;
    let manifestDigest: string;
    try {
      manifestDigest = await sha256Hex(encodedManifest.value);
    } catch {
      return invalid("Recording integrity could not be computed");
    }
    const manifestFrame = encodeFrame(
      { type: "manifest", bytes: encodedManifest.value.byteLength, sha256: manifestDigest },
      encodedManifest.value,
    );
    if (!manifestFrame.ok) return manifestFrame;
    const contentBeforeTerminal = concat(
      [prefix, manifestFrame.value],
      prefix.byteLength + manifestFrame.value.byteLength,
    );
    let terminalContentDigest: string;
    try {
      terminalContentDigest = await sha256Hex(contentBeforeTerminal);
    } catch {
      return invalid("Recording integrity could not be computed");
    }
    const terminalPayload = encodeJson({
      type: "integrity",
      contentDigest: terminalContentDigest,
      manifestFrameDigest: manifestDigest,
    });
    if (!terminalPayload.ok) return terminalPayload;
    let terminalDigest: string;
    try {
      terminalDigest = await sha256Hex(terminalPayload.value);
    } catch {
      return invalid("Recording integrity could not be computed");
    }
    const terminalFrame = encodeFrame(
      { type: "integrity", bytes: terminalPayload.value.byteLength, sha256: terminalDigest },
      terminalPayload.value,
    );
    if (!terminalFrame.ok) return terminalFrame;
    const finalBytes = concat(
      [contentBeforeTerminal, terminalFrame.value],
      contentBeforeTerminal.byteLength + terminalFrame.value.byteLength,
    );
    if (finalBytes.byteLength > this.#options.limits.maxFileBytes) {
      return overflow("Recording file exceeds a resource limit");
    }
    return {
      ok: true,
      value: Object.freeze({ bytes: finalBytes.slice(), manifest }),
    };
  }

  async #appendInternal(
    candidate: unknown,
    preserveRecordingPseudonyms = false,
  ): Promise<Result<void>> {
    if (this.#finalized || this.#finalizing) return lifecycleError();
    if (this.#counts.records >= this.#options.limits.maxRecords) {
      return overflow("Recording record count exceeds a resource limit");
    }
    const checked = validateRecord(candidate);
    if (!checked.ok) return checked;
    let sanitized: SanitizedRecordResult;
    try {
      sanitized = await sanitizeCanonicalRecord(
        checked.value,
        this.#sanitizer,
        preserveRecordingPseudonyms
          ? { ...this.#options.sanitization, preserveRecordingPseudonyms: true }
          : this.#options.sanitization,
      );
    } catch {
      return invalid("Recording record could not be sanitized");
    }
    if (!sanitized.ok) return sanitized;
    const encoded = encodeJson(sanitized.value.record);
    if (!encoded.ok) return encoded;
    if (encoded.value.byteLength > this.#options.limits.maxRecordBytes) {
      return overflow("Recording record exceeds a resource limit");
    }
    const frameBytes = framedPayloadSize("record", encoded.value.byteLength);
    if (
      this.#queuedBytes + frameBytes + FINALIZATION_RESERVE_BYTES >
      this.#options.limits.maxFileBytes
    ) {
      return overflow("Recording file exceeds a resource limit");
    }
    this.#frames.push({ type: "record", payload: encoded.value });
    this.#queuedBytes += frameBytes;
    this.#counts.records += 1;
    this.#counts.droppedAttributes += sanitized.value.droppedAttributes;
    this.#counts.redactions += sanitized.value.redactions;
    if (
      sanitized.value.record.kind === "diagnostic-event" &&
      sanitized.value.record.event.type === "stream-gap"
    ) {
      this.#counts.gaps += 1;
    }
    return { ok: true, value: undefined };
  }
}

async function sanitizeCanonicalRecord(
  record: NoxscopeRecord,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
): Promise<SanitizedRecordResult> {
  const accumulator: SanitizationAccumulator = { droppedAttributes: 0, redactions: 0 };
  const kind = await project(record.kind, "S4", "copy", sanitizer, context);
  if (kind.state !== "kept") return invalid("Recording record could not be sanitized");
  const metaSource = record.meta as unknown as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  if (!(await required(meta, "protocol", metaSource.protocol, "S4", "copy", sanitizer, context))) {
    return invalid("Recording record could not be sanitized");
  }
  if (
    !(await required(
      meta,
      "sessionId",
      metaSource.sessionId,
      "S2",
      "pseudonym",
      sanitizer,
      context,
    ))
  ) {
    return invalid("Recording record could not be sanitized");
  }
  if (
    !(await required(
      meta,
      "runtimeId",
      metaSource.runtimeId,
      "S2",
      "pseudonym",
      sanitizer,
      context,
    ))
  ) {
    return invalid("Recording record could not be sanitized");
  }
  if (
    !(await required(meta, "streamId", metaSource.streamId, "S2", "pseudonym", sanitizer, context))
  ) {
    return invalid("Recording record could not be sanitized");
  }
  if (!(await required(meta, "sequence", metaSource.sequence, "S3", "copy", sanitizer, context))) {
    return invalid("Recording record could not be sanitized");
  }
  if (
    !(await required(meta, "observedAt", metaSource.observedAt, "S3", "copy", sanitizer, context))
  ) {
    return invalid("Recording record could not be sanitized");
  }
  if (
    !(await required(meta, "receivedAt", metaSource.receivedAt, "S3", "copy", sanitizer, context))
  ) {
    return invalid("Recording record could not be sanitized");
  }
  if (metaSource.correlation !== undefined) {
    const correlation = await sanitizeCorrelation(metaSource.correlation, sanitizer, context);
    if (!correlation.ok) return correlation;
    meta.correlation = correlation.value;
  }

  let payload: Record<string, unknown>;
  if (record.kind === "snapshot") {
    const result = await sanitizeSnapshot(
      record.snapshot as unknown as Record<string, unknown>,
      sanitizer,
      context,
      accumulator,
    );
    if (!result.ok) return result;
    payload = { snapshot: result.value };
  } else if (record.kind === "diagnostic-event") {
    const result = await sanitizeEvent(
      record.event as unknown as Record<string, unknown>,
      sanitizer,
      context,
      accumulator,
    );
    if (!result.ok) return result;
    payload = { event: result.value };
  } else {
    const result = await sanitizeOperation(
      record.operation as unknown as Record<string, unknown>,
      sanitizer,
      context,
      accumulator,
    );
    if (!result.ok) return result;
    payload = { operation: result.value };
  }
  const candidate: Record<string, unknown> = { kind: kind.value, meta, ...payload };
  accumulator.droppedAttributes += countMissingFields(record as unknown, candidate);
  const checked = validateRecord(candidate);
  if (!checked.ok) return checked;
  return { ok: true, value: { record: checked.value, ...accumulator } };
}

async function sanitizeCorrelation(
  source: unknown,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
): Promise<Result<Record<string, JsonValue>>> {
  if (!isRecord(source)) return invalid("Recording record could not be sanitized");
  const output: Record<string, JsonValue> = {};
  for (const key of ["requestId", "operationId", "parentOperationId", "traceId"] as const) {
    if (source[key] === undefined) continue;
    const field = await project(source[key], "S2", "pseudonym", sanitizer, context);
    if (field.state !== "kept") return invalid("Recording record could not be sanitized");
    output[key] = field.value;
  }
  if (source.causedBySequence !== undefined) {
    const field = await project(source.causedBySequence, "S3", "copy", sanitizer, context);
    if (field.state !== "kept") return invalid("Recording record could not be sanitized");
    output.causedBySequence = field.value;
  }
  return { ok: true, value: output };
}

async function sanitizeSnapshot(
  source: Record<string, unknown>,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<Record<string, unknown>>> {
  const output: Record<string, unknown> = {};
  if (!(await required(output, "revision", source.revision, "S3", "copy", sanitizer, context))) {
    return invalid("Recording record could not be sanitized");
  }
  const freshnessSource = source.freshness;
  if (!isRecord(freshnessSource)) return invalid("Recording record could not be sanitized");
  const freshness: Record<string, unknown> = {};
  for (const [key, value, classification, transform, requiredField] of [
    ["state", freshnessSource.state, "S3", "copy", true],
    ["observedAt", freshnessSource.observedAt, "S3", "copy", true],
    ["receivedAt", freshnessSource.receivedAt, "S3", "copy", true],
    ["source", freshnessSource.source, "S3", "copy", true],
    ["consecutiveFailures", freshnessSource.consecutiveFailures, "S3", "copy", true],
    ["pollingIntervalMs", freshnessSource.pollingIntervalMs, "S3", "copy", false],
    ["lastSuccessAt", freshnessSource.lastSuccessAt, "S3", "copy", false],
  ] as const) {
    if (value === undefined && !requiredField) continue;
    if (
      !(await assignField(
        freshness,
        key,
        value,
        classification,
        transform,
        requiredField,
        sanitizer,
        context,
        accumulator,
      ))
    ) {
      return invalid("Recording record could not be sanitized");
    }
  }
  output.freshness = freshness;
  if (source.lifecycle !== undefined) {
    const lifecycle = await simpleObject(
      source.lifecycle,
      [["state", "S3", "copy", true]],
      sanitizer,
      context,
      accumulator,
    );
    if (!lifecycle.ok) return lifecycle;
    output.lifecycle = lifecycle.value;
  }
  if (source.identity !== undefined) {
    if (!isRecord(source.identity)) return invalid("Recording record could not be sanitized");
    const identity: Record<string, unknown> = {};
    for (const key of ["account", "walletName"] as const) {
      if (
        !(await assignField(
          identity,
          key,
          source.identity[key],
          "S2",
          "pseudonym",
          false,
          sanitizer,
          context,
          accumulator,
        ))
      ) {
        return invalid("Recording record could not be sanitized");
      }
    }
    output.identity = identity;
  }
  if (source.network !== undefined) {
    const network = await simpleObject(
      source.network,
      [["id", "S3", "copy", true]],
      sanitizer,
      context,
      accumulator,
    );
    if (!network.ok) return network;
    output.network = network.value;
  }
  if (source.sync !== undefined) {
    const sync = await sanitizeSync(source.sync, sanitizer, context, accumulator);
    if (!sync.ok) return sync;
    output.sync = sync.value;
  }
  if (source.balances !== undefined) {
    const balances = await sanitizeBalances(source.balances, sanitizer, context, accumulator);
    if (!balances.ok) return balances;
    output.balances = balances.value;
  }
  if (source.addresses !== undefined) {
    const addresses = await sanitizeAddresses(source.addresses, sanitizer, context, accumulator);
    if (!addresses.ok) return addresses;
    output.addresses = addresses.value;
  }
  if (source.dust !== undefined) {
    const dust = await simpleObject(
      source.dust,
      [
        ["state", "S3", "copy", true],
        ["progress", "S3", "copy", false],
      ],
      sanitizer,
      context,
      accumulator,
    );
    if (!dust.ok) return dust;
    output.dust = dust.value;
  }
  if (source.transactions !== undefined) {
    const transactions = await sanitizeList(
      source.transactions,
      [
        ["id", "S2", "pseudonym", true],
        ["state", "S3", "copy", true],
      ],
      sanitizer,
      context,
      accumulator,
    );
    if (!transactions.ok) return transactions;
    output.transactions = transactions.value;
  }
  if (source.dependencies !== undefined) {
    const dependencies = await sanitizeList(
      source.dependencies,
      [
        ["role", "S3", "copy", true],
        ["state", "S3", "copy", true],
        ["endpoint", "S2", "url", false],
      ],
      sanitizer,
      context,
      accumulator,
    );
    if (!dependencies.ok) return dependencies;
    output.dependencies = dependencies.value;
  }
  if (source.raw !== undefined) {
    const raw = await sanitizeRawList(source.raw, sanitizer, context, accumulator);
    if (raw.length > 0) output.raw = raw;
  }
  return { ok: true, value: output };
}

async function sanitizeEvent(
  source: Record<string, unknown>,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<Record<string, unknown>>> {
  const type = await project(source.type, "S4", "copy", sanitizer, context);
  if (type.state !== "kept") return invalid("Recording record could not be sanitized");
  const output: Record<string, unknown> = { type: type.value };
  if (type.value === "diagnostic") {
    for (const [key, classification, transform, requiredField] of [
      ["name", "S3", "copy", true],
      ["category", "S3", "copy", true],
      ["level", "S3", "copy", true],
      ["source", "S3", "copy", true],
      ["message", "S3", "copy", false],
    ] as const) {
      if (
        !(await assignField(
          output,
          key,
          source[key],
          classification,
          transform,
          requiredField,
          sanitizer,
          context,
          accumulator,
        ))
      ) {
        return invalid("Recording record could not be sanitized");
      }
    }
    if (source.attributes !== undefined) {
      accumulator.droppedAttributes += 1;
      accumulator.redactions += 1;
    }
    if (source.raw !== undefined) {
      const raw = await sanitizeRawList(source.raw, sanitizer, context, accumulator);
      if (raw.length > 0) output.raw = raw;
    }
  } else if (type.value === "capability-availability") {
    if (
      !(await assignField(
        output,
        "capabilityId",
        source.capabilityId,
        "S3",
        "copy",
        true,
        sanitizer,
        context,
        accumulator,
      ))
    ) {
      return invalid("Recording record could not be sanitized");
    }
    const availability = await sanitizeAvailability(
      source.availability,
      sanitizer,
      context,
      accumulator,
    );
    if (!availability.ok) return availability;
    output.availability = availability.value;
  } else if (type.value === "stream-gap") {
    for (const key of [
      "sourceStreamId",
      "firstLostSequence",
      "lastLostSequence",
      "reason",
    ] as const) {
      if (
        !(await assignField(
          output,
          key,
          source[key],
          "S3",
          "copy",
          true,
          sanitizer,
          context,
          accumulator,
        ))
      ) {
        return invalid("Recording record could not be sanitized");
      }
    }
  } else {
    return invalid("Recording record could not be sanitized");
  }
  return { ok: true, value: output };
}

async function sanitizeOperation(
  source: Record<string, unknown>,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<Record<string, unknown>>> {
  const output: Record<string, unknown> = {};
  for (const key of ["kind", "phase", "state"] as const) {
    if (
      !(await assignField(
        output,
        key,
        source[key],
        "S3",
        "copy",
        true,
        sanitizer,
        context,
        accumulator,
      ))
    ) {
      return invalid("Recording record could not be sanitized");
    }
  }
  if (
    source.progress !== undefined &&
    !(await assignField(
      output,
      "progress",
      source.progress,
      "S3",
      "copy",
      false,
      sanitizer,
      context,
      accumulator,
    ))
  ) {
    return invalid("Recording record could not be sanitized");
  }
  if (source.result !== undefined) {
    accumulator.droppedAttributes += 1;
    accumulator.redactions += 1;
  }
  if (source.error !== undefined) {
    const error = await sanitizeError(source.error, sanitizer, context, accumulator);
    if (!error.ok) return error;
    output.error = error.value;
  }
  if (source.raw !== undefined) {
    const raw = await sanitizeRawList(source.raw, sanitizer, context, accumulator);
    if (raw.length > 0) output.raw = raw;
  }
  return { ok: true, value: output };
}

async function sanitizeSync(
  source: unknown,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<Record<string, unknown>>> {
  if (!isRecord(source)) return invalid("Recording record could not be sanitized");
  const output: Record<string, unknown> = {};
  const fields = [
    ["state", "S3", "copy", true],
    ["percentage", "S3", "copy", false],
    ["etaSeconds", "S3", "copy", false],
  ] as const;
  for (const [key, classification, transform, requiredField] of fields) {
    if (
      !(await assignField(
        output,
        key,
        source[key],
        classification,
        transform,
        requiredField,
        sanitizer,
        context,
        accumulator,
      ))
    ) {
      return invalid("Recording record could not be sanitized");
    }
  }
  if (source.domains !== undefined) {
    const domains = await sanitizeList(
      source.domains,
      [
        ["domain", "S3", "copy", true],
        ["state", "S3", "copy", true],
        ["percentage", "S3", "copy", false],
      ],
      sanitizer,
      context,
      accumulator,
    );
    if (!domains.ok) return domains;
    output.domains = domains.value;
  }
  return { ok: true, value: output };
}

async function sanitizeBalances(
  source: unknown,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<readonly Record<string, unknown>[]>> {
  return sanitizeList(
    source,
    [
      ["assetId", "S2", "pseudonym", true],
      ["domain", "S3", "copy", true],
      ["amount", "S3", "copy", true],
    ],
    sanitizer,
    context,
    accumulator,
  );
}

async function sanitizeAddresses(
  source: unknown,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<readonly Record<string, unknown>[]>> {
  return sanitizeList(
    source,
    [
      ["domain", "S3", "copy", true],
      ["value", "S2", "pseudonym", true],
      ["account", "S2", "pseudonym", false],
    ],
    sanitizer,
    context,
    accumulator,
  );
}

async function sanitizeAvailability(
  source: unknown,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<Record<string, unknown>>> {
  return simpleObject(
    source,
    [
      ["state", "S3", "copy", true],
      ["reason", "S3", "copy", false],
      ["retryable", "S3", "copy", false],
      ["retryAfterMs", "S3", "copy", false],
    ],
    sanitizer,
    context,
    accumulator,
  );
}

async function sanitizeError(
  source: unknown,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<Record<string, unknown>>> {
  return simpleObject(
    source,
    [
      ["code", "S3", "copy", true],
      ["message", "S3", "copy", true],
      ["retryable", "S3", "copy", true],
      ["retryAfterMs", "S3", "copy", false],
      ["capability", "S2", "pseudonym", false],
    ],
    sanitizer,
    context,
    accumulator,
  );
}

async function simpleObject(
  source: unknown,
  fields: readonly (readonly [string, DataClassification, FieldTransform, boolean])[],
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<Record<string, unknown>>> {
  if (!isRecord(source)) return invalid("Recording record could not be sanitized");
  const output: Record<string, unknown> = {};
  for (const [key, classification, transform, requiredField] of fields) {
    if (
      !(await assignField(
        output,
        key,
        source[key],
        classification,
        transform,
        requiredField,
        sanitizer,
        context,
        accumulator,
      ))
    ) {
      return invalid("Recording record could not be sanitized");
    }
  }
  return { ok: true, value: output };
}

async function sanitizeList(
  source: unknown,
  fields: readonly (readonly [string, DataClassification, FieldTransform, boolean])[],
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<Result<readonly Record<string, unknown>[]>> {
  if (!Array.isArray(source)) return invalid("Recording record could not be sanitized");
  const output: Record<string, unknown>[] = [];
  for (const item of source) {
    const result = await simpleObject(item, fields, sanitizer, context, accumulator);
    if (!result.ok) return result;
    output.push(result.value);
  }
  return { ok: true, value: output };
}

async function sanitizeRawList(
  source: unknown,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<readonly SanitizedRawDetail[]> {
  if (!Array.isArray(source)) {
    accumulator.droppedAttributes += 1;
    return [];
  }
  const output: SanitizedRawDetail[] = [];
  const rawManifest = context.manifest.raw;
  for (const detail of source) {
    if (
      !isRecord(detail) ||
      rawManifest === undefined ||
      detail.namespace !== rawManifest.namespace ||
      detail.schemaVersion !== rawManifest.schemaVersion ||
      !matchesSanitizationProvenance(
        detail as unknown as SanitizedRawDetail,
        context.manifest.policy,
      )
    ) {
      accumulator.droppedAttributes += 1;
      accumulator.redactions += 1;
      continue;
    }
    const result = await sanitizer.sanitizeRawDetail(
      detail.value,
      context.manifest,
      context.preserveRecordingPseudonyms === true
        ? { pseudonymKey: context.pseudonymKey, preserveRecordingPseudonyms: true }
        : { pseudonymKey: context.pseudonymKey },
    );
    if (!result.ok) {
      accumulator.droppedAttributes += 1;
      if (result.error.code === "overflow") accumulator.redactions += 1;
      continue;
    }
    output.push(result.value);
    accumulator.redactions += result.value.sanitization.redactions.length;
  }
  return output;
}

function matchesSanitizationProvenance(
  detail: SanitizedRawDetail,
  policy: AdapterSanitizationManifest["policy"],
): boolean {
  const sanitization = detail.sanitization;
  return (
    sanitization.policy === policy.id &&
    sanitization.policyVersion === policy.version &&
    sanitization.redactions.every(
      (redaction) =>
        typeof redaction.path === "string" &&
        redaction.path.length > 0 &&
        redaction.path.length <= 256 &&
        ["secret", "key-material", "private-payload", "policy"].includes(redaction.reason),
    )
  );
}

async function assignField(
  output: Record<string, unknown>,
  key: string,
  value: unknown,
  classification: DataClassification,
  transform: FieldTransform,
  requiredField: boolean,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
  accumulator: SanitizationAccumulator,
): Promise<boolean> {
  if (value === undefined) {
    if (requiredField) return false;
    return true;
  }
  const field = await project(value, classification, transform, sanitizer, context);
  if (field.state === "kept") {
    output[key] = field.value;
    accumulator.redactions += field.redactions;
    return true;
  }
  if (!requiredField && field.state === "dropped") {
    accumulator.droppedAttributes += 1;
    accumulator.redactions += field.redactions;
    return true;
  }
  return false;
}

async function required(
  output: Record<string, unknown>,
  key: string,
  value: unknown,
  classification: DataClassification,
  transform: FieldTransform,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
): Promise<boolean> {
  const field = await project(value, classification, transform, sanitizer, context);
  if (field.state !== "kept") return false;
  output[key] = field.value;
  return true;
}

async function project(
  value: unknown,
  classification: DataClassification,
  transform: FieldTransform,
  sanitizer: ReturnType<typeof createSanitizer>,
  context: RecordingSanitizationContext,
): Promise<FieldResult> {
  const manifest: AdapterSanitizationManifest = {
    ...context.manifest,
    projections: [{ source: "value", target: "value", classification, transform }],
  };
  const result = await sanitizer.sanitize(
    { value },
    manifest,
    context.preserveRecordingPseudonyms === true
      ? { pseudonymKey: context.pseudonymKey, preserveRecordingPseudonyms: true }
      : { pseudonymKey: context.pseudonymKey },
  );
  if (!result.ok) return { state: "invalid" };
  if (!Object.prototype.hasOwnProperty.call(result.value.value, "value")) {
    return { state: "dropped", redactions: result.value.audit.redactions.length };
  }
  const projected = (result.value.value as Record<string, unknown>).value;
  if (!isJsonValue(projected)) return { state: "invalid" };
  return { state: "kept", value: projected, redactions: result.value.audit.redactions.length };
}

type SnapshotResult =
  { readonly state: "invalid" | "overflow" } | { readonly state: "valid"; readonly value: unknown };

function snapshotInert(root: unknown, limits: RecordingLimits): SnapshotResult {
  const seen = new WeakSet<object>();
  let bytes = 0;
  const visit = (value: unknown, depth: number): SnapshotResult => {
    if (depth > limits.maxDepth) return { state: "overflow" };
    if (value === null || typeof value === "boolean") return { state: "valid", value };
    if (typeof value === "number")
      return Number.isFinite(value) ? { state: "valid", value } : { state: "invalid" };
    if (typeof value === "string") {
      const size = utf8(value).byteLength;
      bytes += size;
      if (
        size > limits.maxStringBytes ||
        bytes > limits.maxInputBytes ||
        hasUnpairedSurrogate(value)
      ) {
        return { state: hasUnpairedSurrogate(value) ? "invalid" : "overflow" };
      }
      return { state: "valid", value };
    }
    if (typeof value !== "object" || value === undefined) return { state: "invalid" };
    if (seen.has(value)) return { state: "invalid" };
    seen.add(value);
    try {
      if (value instanceof Uint8Array) {
        const copy = Uint8Array.prototype.slice.call(value) as Uint8Array;
        bytes += copy.byteLength;
        return bytes > limits.maxInputBytes
          ? { state: "overflow" }
          : { state: "valid", value: copy };
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value))
        return { state: "invalid" };
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (Array.isArray(value)) {
        const lengthDescriptor = descriptors.length;
        if (
          !lengthDescriptor ||
          lengthDescriptor.get !== undefined ||
          lengthDescriptor.set !== undefined ||
          !Number.isSafeInteger(lengthDescriptor.value)
        )
          return { state: "invalid" };
        const length = Number(lengthDescriptor.value);
        if (length > limits.maxArrayElements) return { state: "overflow" };
        if (
          keys.some(
            (key) =>
              typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
          )
        )
          return { state: "invalid" };
        const output: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            !descriptor ||
            !descriptor.enumerable ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined
          )
            return { state: "invalid" };
          const nested = visit(descriptor.value, depth + 1);
          if (nested.state !== "valid") return nested;
          output.push(nested.value);
        }
        return { state: "valid", value: output };
      }
      if (keys.length > limits.maxObjectProperties) return { state: "overflow" };
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== "string") return { state: "invalid" };
        const keyBytes = utf8(key).byteLength;
        bytes += keyBytes;
        if (
          keyBytes > 256 ||
          bytes > limits.maxInputBytes ||
          ["__proto__", "prototype", "constructor"].includes(key.normalize("NFKC").toLowerCase())
        )
          return { state: keyBytes > 256 || bytes > limits.maxInputBytes ? "overflow" : "invalid" };
        const descriptor = descriptors[key];
        if (
          !descriptor ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        )
          return { state: "invalid" };
        const nested = visit(descriptor.value, depth + 1);
        if (nested.state !== "valid") return nested;
        output[key] = nested.value;
      }
      return { state: "valid", value: output };
    } catch {
      return { state: "invalid" };
    }
  };
  try {
    return visit(root, 0);
  } catch {
    return { state: "invalid" };
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function countMissingFields(
  source: unknown,
  output: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): number {
  if (depth > RECORDING_LIMITS.maxDepth) return 1;
  if (isRecord(source) && isRecord(output)) {
    if (seen.has(source)) return 1;
    seen.add(source);
    let count = 0;
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) count += 1;
      else count += countMissingFields(source[key], output[key], depth + 1, seen);
    }
    return count;
  }
  if (Array.isArray(source) && Array.isArray(output)) {
    if (seen.has(source)) return 1;
    seen.add(source);
    let count = 0;
    for (
      let index = 0;
      index < Math.min(source.length, RECORDING_LIMITS.maxArrayElements);
      index += 1
    ) {
      count += countMissingFields(source[index], output[index], depth + 1, seen);
    }
    return count + Math.max(0, source.length - RECORDING_LIMITS.maxArrayElements);
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function adapterReference(manifest: AdapterSanitizationManifest): RecordingAdapterReference {
  return {
    id: manifest.adapter.id,
    version: manifest.adapter.version,
    sourceVersions: [...manifest.adapter.sourceVersions],
    ...(manifest.raw === undefined
      ? {}
      : { raw: { namespace: manifest.raw.namespace, schemaVersion: manifest.raw.schemaVersion } }),
  };
}

export function adapterReferences(
  context: RecordingSanitizationContext,
): readonly RecordingAdapterReference[] {
  const manifests = [context.manifest, ...(context.adapters ?? [])];
  const unique = new Map<string, RecordingAdapterReference>();
  for (const manifest of manifests) {
    const reference = adapterReference(manifest);
    unique.set(JSON.stringify(reference), reference);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function policyReference(manifest: AdapterSanitizationManifest): RecordingPolicyReference {
  return {
    id: manifest.policy.id,
    version: manifest.policy.version,
    digest: manifest.policy.digest,
  };
}

function resolveOptions(options: RecordingOptions): ResolvedRecordingOptions {
  const sanitization = options.sanitization;
  if (sanitization === undefined) {
    throw new Error("Recording sanitization context is required");
  }
  if (
    !(sanitization.pseudonymKey instanceof Uint8Array) ||
    sanitization.pseudonymKey.byteLength < 32 ||
    sanitization.pseudonymKey.byteLength > 64
  ) {
    throw new Error("Recording sanitization context is invalid");
  }
  if (sanitization.adapters !== undefined && !Array.isArray(sanitization.adapters)) {
    throw new Error("Recording sanitization context is invalid");
  }
  const manifestSnapshot = snapshotInert(sanitization.manifest, RECORDING_LIMITS);
  if (manifestSnapshot.state !== "valid" || !isRecord(manifestSnapshot.value)) {
    throw new Error("Recording sanitization context is invalid");
  }
  const adapterManifests: AdapterSanitizationManifest[] = [];
  for (const adapter of sanitization.adapters ?? []) {
    const snapshot = snapshotInert(adapter, RECORDING_LIMITS);
    if (snapshot.state !== "valid" || !isRecord(snapshot.value)) {
      throw new Error("Recording sanitization context is invalid");
    }
    adapterManifests.push(snapshot.value as unknown as AdapterSanitizationManifest);
  }
  return {
    now: options.now ?? (() => new Date().toISOString()),
    limits: resolveLimits(options.limits),
    sanitization: {
      manifest: manifestSnapshot.value as unknown as AdapterSanitizationManifest,
      ...(adapterManifests.length === 0 ? {} : { adapters: adapterManifests }),
      pseudonymKey: sanitization.pseudonymKey.slice(),
    },
  };
}

function resolveLimits(overrides: Partial<RecordingLimits> | undefined): RecordingLimits {
  const values = {
    maxFileBytes: overrides?.maxFileBytes ?? RECORDING_LIMITS.maxFileBytes,
    maxRecords: overrides?.maxRecords ?? RECORDING_LIMITS.maxRecords,
    maxRecordBytes: overrides?.maxRecordBytes ?? RECORDING_LIMITS.maxRecordBytes,
    maxInputBytes: overrides?.maxInputBytes ?? RECORDING_LIMITS.maxInputBytes,
    maxDepth: overrides?.maxDepth ?? RECORDING_LIMITS.maxDepth,
    maxObjectProperties: overrides?.maxObjectProperties ?? RECORDING_LIMITS.maxObjectProperties,
    maxArrayElements: overrides?.maxArrayElements ?? RECORDING_LIMITS.maxArrayElements,
    maxStringBytes: overrides?.maxStringBytes ?? RECORDING_LIMITS.maxStringBytes,
  };
  if (
    !Number.isSafeInteger(values.maxFileBytes) ||
    !Number.isSafeInteger(values.maxRecords) ||
    !Number.isSafeInteger(values.maxRecordBytes) ||
    !Number.isSafeInteger(values.maxInputBytes) ||
    !Number.isSafeInteger(values.maxDepth) ||
    !Number.isSafeInteger(values.maxObjectProperties) ||
    !Number.isSafeInteger(values.maxArrayElements) ||
    !Number.isSafeInteger(values.maxStringBytes) ||
    values.maxFileBytes <= 0 ||
    values.maxRecords <= 0 ||
    values.maxRecordBytes <= 0 ||
    values.maxInputBytes <= 0 ||
    values.maxDepth <= 0 ||
    values.maxObjectProperties <= 0 ||
    values.maxArrayElements <= 0 ||
    values.maxStringBytes <= 0 ||
    values.maxFileBytes > RECORDING_LIMITS.maxFileBytes ||
    values.maxRecords > RECORDING_LIMITS.maxRecords ||
    values.maxRecordBytes > RECORDING_LIMITS.maxRecordBytes ||
    values.maxInputBytes > RECORDING_LIMITS.maxInputBytes ||
    values.maxDepth > RECORDING_LIMITS.maxDepth ||
    values.maxObjectProperties > RECORDING_LIMITS.maxObjectProperties ||
    values.maxArrayElements > RECORDING_LIMITS.maxArrayElements ||
    values.maxStringBytes > RECORDING_LIMITS.maxStringBytes
  ) {
    throw new Error("Recording limits are invalid");
  }
  return Object.freeze(values);
}

function encodeJson(value: unknown): Result<Uint8Array> {
  try {
    const text = JSON.stringify(canonicalJson(value));
    if (text === undefined) return invalid("Recording value is not JSON");
    return { ok: true, value: utf8(text) };
  } catch {
    return invalid("Recording value is not JSON");
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalJson(value[key]);
    return output;
  }
  return value;
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

function framedPayloadSize(
  type: "header" | "record" | "manifest" | "integrity",
  bytes: number,
): number {
  return (
    utf8(JSON.stringify(canonicalJson({ type, bytes, sha256: "0".repeat(64) }))).byteLength +
    bytes +
    2
  );
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

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  try {
    return new Date(parsed).toISOString() === value;
  } catch {
    return false;
  }
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
