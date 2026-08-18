import {
  NOXSCOPE_PROTOCOL,
  validateRecord,
  type NoxscopeRecord,
  type Result,
} from "@noxscope/protocol";
import {
  NOXSCOPE_RECORDING_FORMAT,
  NOXSCOPE_RECORDING_MAGIC,
  NOXSCOPE_RECORDING_SCHEMA_VERSION,
  RECORDING_LIMITS,
  sanitizeRecordingRecord,
  type RecordingAdapterReference,
  type RecordingCounts,
  type RecordingFrameDigest,
  type RecordingLimits,
  type RecordingManifest,
  type RecordingPolicyReference,
  type RecordingSanitizationContext,
} from "./recording.js";
import { markImportedRecordingRecord } from "./recording-internals.js";

export interface RecordingImportOptions {
  readonly sanitization: RecordingSanitizationContext;
  readonly limits?: Partial<RecordingLimits>;
}

export interface RecordingImportAudit {
  readonly warnings: readonly string[];
  readonly droppedRawDetails: number;
  readonly redactions: number;
  /** Source manifest claims retained for diagnostics only; never authoritative. */
  readonly sourceCounts: RecordingCounts;
}

export interface OfflineReplayOptions {
  readonly signal?: AbortSignal;
}

export interface OfflineReplaySession extends AsyncIterable<NoxscopeRecord> {
  request(request: unknown, options?: { readonly signal?: AbortSignal }): Promise<Result<never>>;
}

export interface ImportedRecording extends AsyncIterable<NoxscopeRecord> {
  readonly manifest: RecordingManifest;
  readonly records: readonly NoxscopeRecord[];
  readonly audit: RecordingImportAudit;
  replay(options?: OfflineReplayOptions): OfflineReplaySession;
}

interface ImportHeader {
  readonly format: typeof NOXSCOPE_RECORDING_FORMAT;
  readonly formatVersion: 1;
  readonly protocol: typeof NOXSCOPE_PROTOCOL;
  readonly schemaVersion: typeof NOXSCOPE_RECORDING_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly adapters: readonly RecordingAdapterReference[];
  readonly policies: readonly RecordingPolicyReference[];
}

interface FrameControl {
  readonly type: "header" | "record" | "manifest" | "integrity";
  readonly bytes: number;
  readonly sha256: string;
}

interface ParsedFrame {
  readonly start: number;
  readonly end: number;
  readonly control: FrameControl;
  readonly payload: Uint8Array;
  readonly parsed: unknown;
}

interface ImportState {
  readonly bytes: Uint8Array;
  readonly limits: RecordingLimits;
  readonly context: RecordingSanitizationContext;
  readonly warnings: string[];
  droppedRawDetails: number;
  droppedAttributes: number;
  redactions: number;
}

const MAX_CONTROL_BYTES = 4 * 1024;
const MAX_WARNING_COUNT = 256;
const MAGIC_BYTES = new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`);

export async function importRecording(
  input: Uint8Array | string,
  options: RecordingImportOptions,
): Promise<Result<ImportedRecording>> {
  let limits: RecordingLimits;
  try {
    limits = resolveLimits(options.limits);
  } catch {
    return invalid("Recording import limits are invalid");
  }
  const bytes = toBytes(input, limits.maxFileBytes);
  if (!bytes.ok) return bytes;
  if (isArchive(bytes.value))
    return incompatible("Compressed or archived Recordings are unsupported");
  if (!sameBytes(bytes.value, MAGIC_BYTES, 0))
    return incompatible("Recording magic is incompatible");
  let sanitization: RecordingSanitizationContext;
  try {
    const candidate = options.sanitization;
    if (
      !candidate ||
      !(candidate.pseudonymKey instanceof Uint8Array) ||
      candidate.pseudonymKey.byteLength < 32 ||
      candidate.pseudonymKey.byteLength > 64
    ) {
      return invalid("Recording import sanitization context is invalid");
    }
    sanitization = {
      manifest: candidate.manifest,
      pseudonymKey: Uint8Array.prototype.slice.call(candidate.pseudonymKey) as Uint8Array,
      preserveRecordingPseudonyms: true,
    };
  } catch {
    return invalid("Recording import sanitization context is invalid");
  }
  const state: ImportState = {
    bytes: bytes.value,
    limits,
    context: sanitization,
    warnings: [],
    droppedRawDetails: 0,
    droppedAttributes: 0,
    redactions: 0,
  };
  try {
    return await parseRecording(state);
  } catch {
    return invalid("Recording import failed within a bounded parser");
  }
}

async function parseRecording(state: ImportState): Promise<Result<ImportedRecording>> {
  let offset = MAGIC_BYTES.byteLength;
  const headerFrame = await readFrame(state, offset);
  if (!headerFrame.ok) return headerFrame;
  if (headerFrame.value.control.type !== "header")
    return invalid("Recording frame order is invalid");
  offset = headerFrame.value.end;
  const header = validateHeader(headerFrame.value.parsed);
  if (!header.ok) return header;
  const provenance = verifyProvenance(header.value, state.context);
  if (!provenance.ok) return provenance;

  const records: NoxscopeRecord[] = [];
  const recordFrames: ParsedFrame[] = [headerFrame.value];
  while (true) {
    const frame = await readFrame(state, offset);
    if (!frame.ok) return frame;
    offset = frame.value.end;
    if (frame.value.control.type === "record") {
      if (records.length >= state.limits.maxRecords)
        return overflow("Recording record count exceeds a resource limit");
      const checked = validateRecord(frame.value.parsed);
      if (!checked.ok) return checked;
      const sanitized = await sanitizeRecordingRecord(checked.value, state.context);
      if (!sanitized.ok) return sanitized;
      state.droppedAttributes += sanitized.value.droppedAttributes;
      state.redactions += sanitized.value.redactions;
      accountUnknownRaw(state, checked.value);
      const rechecked = validateRecord(sanitized.value.record);
      if (!rechecked.ok) return rechecked;
      records.push(rechecked.value);
      recordFrames.push(frame.value);
      continue;
    }
    if (frame.value.control.type !== "manifest") return invalid("Recording frame order is invalid");
    const manifestFrame = frame.value;
    const manifest = validateManifest(
      manifestFrame.parsed,
      state.limits,
      header.value,
      state.context,
    );
    if (!manifest.ok) return manifest;
    if (offset >= state.bytes.byteLength) return invalid("Recording is truncated");
    const integrityFrame = await readFrame(state, offset);
    if (!integrityFrame.ok) return integrityFrame;
    if (integrityFrame.value.control.type !== "integrity")
      return invalid("Recording frame order is invalid");
    offset = integrityFrame.value.end;
    if (offset !== state.bytes.byteLength) return invalid("Recording has trailing data");
    const integrity = validateTerminalIntegrity(integrityFrame.value.parsed);
    if (!integrity.ok) return integrity;
    const verified = await verifyIntegrity(
      state,
      headerFrame.value,
      recordFrames,
      manifestFrame,
      integrityFrame.value,
      manifest.value,
      integrity.value,
      records,
    );
    if (!verified.ok) return verified;
    const audit: RecordingImportAudit = {
      warnings: Object.freeze([...state.warnings]),
      droppedRawDetails: state.droppedRawDetails,
      redactions: state.redactions,
      sourceCounts: deepFreeze(cloneJson(manifest.value.counts) as RecordingCounts),
    };
    const recomputedCounts = recomputeCounts(state, records);
    const returnedManifest = { ...manifest.value, counts: recomputedCounts };
    const frozenRecords = deepFreeze(records.map((record) => cloneJson(record) as NoxscopeRecord));
    for (const record of frozenRecords) markImportedRecordingRecord(record);
    const frozenManifest = deepFreeze(cloneJson(returnedManifest) as RecordingManifest);
    return {
      ok: true,
      value: new ImportedRecordingImpl(frozenManifest, frozenRecords, audit),
    };
  }
}

class ImportedRecordingImpl implements ImportedRecording {
  readonly manifest: RecordingManifest;
  readonly records: readonly NoxscopeRecord[];
  readonly audit: RecordingImportAudit;

  constructor(
    manifest: RecordingManifest,
    records: readonly NoxscopeRecord[],
    audit: RecordingImportAudit,
  ) {
    this.manifest = manifest;
    this.records = records;
    this.audit = Object.freeze({ ...audit, warnings: Object.freeze([...audit.warnings]) });
  }

  replay(options: OfflineReplayOptions = {}): OfflineReplaySession {
    return new OfflineReplayImpl(this.records, options.signal);
  }

  [Symbol.asyncIterator](): AsyncIterator<NoxscopeRecord> {
    return this.replay()[Symbol.asyncIterator]();
  }
}

class OfflineReplayImpl implements OfflineReplaySession {
  readonly #records: readonly NoxscopeRecord[];
  readonly #signal: AbortSignal | undefined;

  constructor(records: readonly NoxscopeRecord[], signal: AbortSignal | undefined) {
    this.#records = records;
    this.#signal = signal;
  }

  request(): Promise<Result<never>> {
    return Promise.resolve({
      ok: false,
      error: {
        code: "unsupported",
        message: "Offline replay cannot invoke runtime operations",
        retryable: false,
      },
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<NoxscopeRecord> {
    let index = 0;
    const records = this.#records;
    const signal = this.#signal;
    return {
      next: async () => {
        if (signal?.aborted || index >= records.length) return { done: true, value: undefined };
        const value = records[index++]!;
        return { done: false, value };
      },
    };
  }
}

async function readFrame(state: ImportState, start: number): Promise<Result<ParsedFrame>> {
  const controlLine = readLine(state.bytes, start, MAX_CONTROL_BYTES);
  if (!controlLine.ok) return controlLine;
  const control = parseCanonical(controlLine.value.bytes, state.limits);
  if (!control.ok || !isExactControl(control.value))
    return invalid("Recording frame control is invalid");
  const payloadStart = controlLine.value.next;
  const payloadEnd = payloadStart + control.value.bytes;
  if (
    control.value.bytes >
      (control.value.type === "record" ? state.limits.maxRecordBytes : state.limits.maxFileBytes) ||
    !Number.isSafeInteger(payloadEnd) ||
    payloadEnd < payloadStart ||
    payloadEnd + 1 > state.bytes.byteLength ||
    state.bytes[payloadEnd] !== 0x0a
  ) {
    return overflow("Recording frame exceeds a resource limit");
  }
  const payload = state.bytes.subarray(payloadStart, payloadEnd);
  let digest: string;
  try {
    digest = await sha256Hex(payload);
  } catch {
    return invalid("Recording integrity could not be computed");
  }
  if (digest !== control.value.sha256) return invalid("Recording frame digest does not match");
  const parsed = parseCanonical(payload, state.limits, control.value.type === "manifest");
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      start,
      end: payloadEnd + 1,
      control: control.value,
      payload,
      parsed: parsed.value,
    },
  };
}

function readLine(
  bytes: Uint8Array,
  start: number,
  maximum: number,
): Result<{ readonly bytes: Uint8Array; readonly next: number }> {
  const endLimit = Math.min(bytes.length, start + maximum + 1);
  for (let index = start; index < endLimit; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const line = bytes.slice(start, index);
    if (line.length === 0 || line.some((byte) => byte > 0x7f))
      return invalid("Recording control line is invalid");
    return { ok: true, value: { bytes: line, next: index + 1 } };
  }
  return invalid("Recording control line is truncated");
}

function parseCanonical(
  bytes: Uint8Array,
  limits: RecordingLimits,
  allowLargeManifestDigests = false,
): Result<unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("Recording payload is invalid UTF-8");
  }
  const parsed = new JsonParser(text, limits, allowLargeManifestDigests).parse();
  if (!parsed.ok) return parsed;
  try {
    const canonical = new TextEncoder().encode(JSON.stringify(canonicalJson(parsed.value)));
    if (!sameBytes(canonical, bytes, 0)) return invalid("Recording JSON is not canonical");
  } catch {
    return invalid("Recording JSON is invalid");
  }
  return parsed;
}

class JsonParser {
  readonly #text: string;
  readonly #limits: RecordingLimits;
  readonly #allowLargeManifestDigests: boolean;
  readonly #path: string[] = [];
  #index = 0;
  #depth = 0;

  constructor(text: string, limits: RecordingLimits, allowLargeManifestDigests: boolean) {
    this.#text = text;
    this.#limits = limits;
    this.#allowLargeManifestDigests = allowLargeManifestDigests;
  }

  parse(): Result<unknown> {
    try {
      const value = this.#value();
      this.#space();
      return this.#index === this.#text.length
        ? { ok: true, value }
        : invalid("Recording JSON has trailing data");
    } catch {
      return invalid("Recording JSON is invalid");
    }
  }

  #value(): unknown {
    this.#space();
    const character = this.#text[this.#index];
    if (character === "{") return this.#object();
    if (character === "[") {
      const maximum =
        this.#allowLargeManifestDigests && this.#path.join(".") === "integrity.frameDigests"
          ? this.#limits.maxRecords + 1
          : this.#limits.maxArrayElements;
      return this.#array(maximum);
    }
    if (character === '"') return this.#string();
    if (character === "t" && this.#text.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (character === "f" && this.#text.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (character === "n" && this.#text.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#number();
  }

  #object(): Record<string, unknown> {
    this.#depth += 1;
    if (this.#depth > this.#limits.maxDepth) throw new Error("depth");
    this.#index += 1;
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.#space();
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      this.#depth -= 1;
      return output;
    }
    let count = 0;
    while (true) {
      if (++count > this.#limits.maxObjectProperties) throw new Error("properties");
      this.#space();
      if (this.#text[this.#index] !== '"') throw new Error("key");
      const key = this.#string();
      const normalized = normalizeKey(key);
      if (keys.has(normalized) || ["proto", "prototype", "constructor"].includes(normalized))
        throw new Error("key");
      keys.add(normalized);
      this.#space();
      if (this.#text[this.#index++] !== ":") throw new Error("colon");
      this.#path.push(key);
      try {
        output[key] = this.#value();
      } finally {
        this.#path.pop();
      }
      this.#space();
      const separator = this.#text[this.#index++];
      if (separator === "}") break;
      if (separator !== ",") throw new Error("object");
    }
    this.#depth -= 1;
    return output;
  }

  #array(maximum: number): unknown[] {
    this.#depth += 1;
    if (this.#depth > this.#limits.maxDepth) throw new Error("depth");
    this.#index += 1;
    const output: unknown[] = [];
    this.#space();
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      this.#depth -= 1;
      return output;
    }
    while (true) {
      if (output.length >= maximum) throw new Error("array");
      output.push(this.#value());
      this.#space();
      const separator = this.#text[this.#index++];
      if (separator === "]") break;
      if (separator !== ",") throw new Error("array");
    }
    this.#depth -= 1;
    return output;
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index++];
      if (character === undefined) throw new Error("string");
      if (character === "\\") this.#index += 1;
      else if (character === '"') {
        const value = JSON.parse(this.#text.slice(start, this.#index)) as unknown;
        if (
          typeof value !== "string" ||
          hasUnpairedSurrogate(value) ||
          utf8(value).byteLength > this.#limits.maxStringBytes
        )
          throw new Error("string");
        return value;
      } else if (character.charCodeAt(0) < 0x20) throw new Error("string");
    }
    throw new Error("string");
  }

  #number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.#text.slice(this.#index),
    );
    if (!match) throw new Error("number");
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("number");
    return value;
  }

  #space(): void {
    while (/[\t\n\r ]/u.test(this.#text[this.#index] ?? "")) this.#index += 1;
  }
}

function validateHeader(value: unknown): Result<ImportHeader> {
  if (
    !isRecord(value) ||
    value.format !== NOXSCOPE_RECORDING_FORMAT ||
    value.formatVersion !== 1 ||
    value.protocol !== NOXSCOPE_PROTOCOL ||
    value.schemaVersion !== NOXSCOPE_RECORDING_SCHEMA_VERSION ||
    typeof value.exportedAt !== "string" ||
    !validTimestamp(value.exportedAt) ||
    !Array.isArray(value.adapters) ||
    !Array.isArray(value.policies)
  )
    return incompatible("Recording header is incompatible");
  return { ok: true, value: value as unknown as ImportHeader };
}

function validateManifest(
  value: unknown,
  limits: RecordingLimits,
  header: ImportHeader,
  context: RecordingSanitizationContext,
): Result<RecordingManifest> {
  if (
    !isRecord(value) ||
    value.format !== NOXSCOPE_RECORDING_FORMAT ||
    value.formatVersion !== 1 ||
    value.protocol !== NOXSCOPE_PROTOCOL ||
    value.schemaVersion !== NOXSCOPE_RECORDING_SCHEMA_VERSION ||
    typeof value.exportedAt !== "string" ||
    !validTimestamp(value.exportedAt) ||
    !Array.isArray(value.adapters) ||
    !Array.isArray(value.policies) ||
    value.adapters.length > limits.maxArrayElements ||
    value.policies.length > limits.maxArrayElements ||
    !isRecord(value.counts) ||
    !isRecord(value.integrity)
  )
    return incompatible("Recording manifest is incompatible");
  const counts = value.counts as unknown as RecordingCounts;
  if (
    !(["records", "gaps", "droppedRecords", "droppedAttributes", "redactions"] as const).every(
      (key) => nonNegativeInteger(counts[key]),
    ) ||
    counts.records > limits.maxRecords ||
    counts.gaps > limits.maxRecords ||
    counts.droppedRecords > limits.maxRecords ||
    counts.droppedAttributes > limits.maxRecords * limits.maxObjectProperties ||
    counts.redactions > limits.maxRecords * limits.maxObjectProperties
  )
    return invalid("Recording manifest counts are invalid");
  const integrity = value.integrity;
  if (
    integrity.algorithm !== "SHA-256" ||
    integrity.authenticated !== false ||
    typeof integrity.contentDigest !== "string" ||
    !Array.isArray(integrity.frameDigests) ||
    integrity.frameDigests.length > limits.maxRecords + 1 ||
    integrity.warning !==
      "Integrity digests detect accidental or modifying changes; they do not authenticate the producer." ||
    !integrity.frameDigests.every(isFrameDigest)
  )
    return invalid("Recording manifest integrity is invalid");
  const expected = expectedProvenance(context);
  if (
    value.exportedAt !== header.exportedAt ||
    !sameJson(value.adapters, header.adapters) ||
    !sameJson(value.policies, header.policies) ||
    !sameJson(value.adapters, expected.adapters) ||
    !sameJson(value.policies, expected.policies)
  ) {
    return incompatible("Recording manifest provenance is incompatible");
  }
  return { ok: true, value: value as unknown as RecordingManifest };
}

function validateTerminalIntegrity(
  value: unknown,
): Result<{ readonly contentDigest: string; readonly manifestFrameDigest: string }> {
  if (
    !isRecord(value) ||
    value.type !== "integrity" ||
    typeof value.contentDigest !== "string" ||
    typeof value.manifestFrameDigest !== "string"
  )
    return invalid("Recording terminal integrity is invalid");
  return {
    ok: true,
    value: { contentDigest: value.contentDigest, manifestFrameDigest: value.manifestFrameDigest },
  };
}

async function verifyIntegrity(
  state: ImportState,
  header: ParsedFrame,
  records: readonly ParsedFrame[],
  manifestFrame: ParsedFrame,
  terminalFrame: ParsedFrame,
  manifest: RecordingManifest,
  terminal: { readonly contentDigest: string; readonly manifestFrameDigest: string },
  sanitizedRecords: readonly NoxscopeRecord[],
): Promise<Result<void>> {
  const frameDigests: RecordingFrameDigest[] = [];
  for (const [index, frame] of records.entries()) {
    frameDigests.push({
      index,
      type: frame.control.type as "header" | "record",
      bytes: frame.payload.byteLength,
      sha256: frame.control.sha256,
    });
  }
  if (!sameJson(frameDigests, manifest.integrity.frameDigests))
    return invalid("Recording manifest frame digests are invalid");
  if (
    manifest.counts.records !== sanitizedRecords.length ||
    manifest.counts.records !== records.length - 1
  )
    return invalid("Recording manifest record count is invalid");
  const gaps = sanitizedRecords.filter(
    (record) => record.kind === "diagnostic-event" && record.event.type === "stream-gap",
  ).length;
  if (manifest.counts.gaps !== gaps) return invalid("Recording manifest gap count is invalid");
  let prefixDigest: string;
  let terminalDigest: string;
  let manifestDigest: string;
  try {
    prefixDigest = await sha256Hex(state.bytes.subarray(0, manifestFrame.start));
    terminalDigest = await sha256Hex(state.bytes.subarray(0, terminalFrame.start));
    manifestDigest = await sha256Hex(manifestFrame.payload);
  } catch {
    return invalid("Recording integrity could not be computed");
  }
  if (
    manifest.integrity.contentDigest !== prefixDigest ||
    terminal.contentDigest !== terminalDigest ||
    terminal.manifestFrameDigest !== manifestDigest
  )
    return invalid("Recording content digest does not match");
  return { ok: true, value: undefined };
}

function recomputeCounts(state: ImportState, records: readonly NoxscopeRecord[]): RecordingCounts {
  return {
    records: records.length,
    gaps: records.filter(
      (record) => record.kind === "diagnostic-event" && record.event.type === "stream-gap",
    ).length,
    droppedRecords: 0,
    droppedAttributes: state.droppedAttributes,
    redactions: state.redactions,
  };
}

function verifyProvenance(
  header: ImportHeader,
  context: RecordingSanitizationContext,
): Result<void> {
  const expected = expectedProvenance(context);
  if (
    !sameJson(header.adapters, expected.adapters) ||
    !sameJson(header.policies, expected.policies)
  )
    return incompatible("Recording provenance policy is incompatible");
  return { ok: true, value: undefined };
}

function expectedProvenance(context: RecordingSanitizationContext): {
  readonly adapters: readonly RecordingAdapterReference[];
  readonly policies: readonly RecordingPolicyReference[];
} {
  const adapter = context.manifest.adapter;
  return {
    adapters: [
      {
        id: adapter.id,
        version: adapter.version,
        sourceVersions: [...adapter.sourceVersions],
        ...(context.manifest.raw === undefined
          ? {}
          : {
              raw: {
                namespace: context.manifest.raw.namespace,
                schemaVersion: context.manifest.raw.schemaVersion,
              },
            }),
      },
    ],
    policies: [{ ...context.manifest.policy }],
  };
}

function accountUnknownRaw(state: ImportState, record: NoxscopeRecord): void {
  const raw =
    record.kind === "snapshot"
      ? record.snapshot.raw
      : record.kind === "diagnostic-event"
        ? record.event.type === "diagnostic"
          ? record.event.raw
          : undefined
        : record.operation.raw;
  if (raw === undefined) return;
  for (const detail of raw) {
    const allowed = state.context.manifest.raw;
    if (
      allowed === undefined ||
      detail.namespace !== allowed.namespace ||
      detail.schemaVersion !== allowed.schemaVersion
    ) {
      recordRawDrop(state, "Unknown raw detail namespace or schema was dropped during import");
    } else if (
      detail.sanitization.policy !== state.context.manifest.policy.id ||
      detail.sanitization.policyVersion !== state.context.manifest.policy.version ||
      !detail.sanitization.redactions.every(
        (redaction) =>
          typeof redaction.path === "string" &&
          redaction.path.length > 0 &&
          redaction.path.length <= 256 &&
          ["secret", "key-material", "private-payload", "policy"].includes(redaction.reason),
      )
    ) {
      recordRawDrop(
        state,
        "Raw detail sanitization provenance was incompatible and was dropped during import",
      );
    }
  }
}

function recordRawDrop(state: ImportState, warning: string): void {
  state.droppedRawDetails += 1;
  if (state.warnings.length < MAX_WARNING_COUNT) state.warnings.push(warning);
}

function isExactControl(value: unknown): value is FrameControl {
  if (!isRecord(value)) return false;
  const candidate = value as {
    readonly type?: unknown;
    readonly bytes?: unknown;
    readonly sha256?: unknown;
  };
  if (
    !["header", "record", "manifest", "integrity"].includes(candidate.type as string) ||
    !Number.isSafeInteger(candidate.bytes) ||
    (candidate.bytes as number) < 0 ||
    typeof candidate.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.sha256)
  )
    return false;
  return Object.keys(value).length === 3;
}

function isFrameDigest(value: unknown): value is RecordingFrameDigest {
  if (!isRecord(value)) return false;
  const candidate = value as {
    readonly index?: unknown;
    readonly type?: unknown;
    readonly bytes?: unknown;
    readonly sha256?: unknown;
  };
  return (
    Number.isSafeInteger(candidate.index) &&
    (candidate.index as number) >= 0 &&
    ["header", "record"].includes(candidate.type as string) &&
    Number.isSafeInteger(candidate.bytes) &&
    (candidate.bytes as number) >= 0 &&
    typeof candidate.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.sha256)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
  } catch {
    return false;
  }
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) output[key] = cloneJson(nested);
    return output;
  }
  return value;
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

function toBytes(input: Uint8Array | string, maximum: number): Result<Uint8Array> {
  if (typeof input === "string") {
    if (input.length > maximum || hasUnpairedSurrogate(input))
      return invalid("Recording input is invalid");
    try {
      const bytes = new TextEncoder().encode(input);
      return bytes.byteLength > maximum
        ? overflow("Recording file exceeds a resource limit")
        : { ok: true, value: bytes };
    } catch {
      return invalid("Recording input is invalid");
    }
  }
  if (!(input instanceof Uint8Array)) return invalid("Recording input is invalid");
  if (input.byteLength > maximum) return overflow("Recording file exceeds a resource limit");
  return { ok: true, value: input.slice() };
}

function isArchive(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    (bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(bytes[2] ?? -1) &&
      [0x04, 0x06, 0x08].includes(bytes[3] ?? -1)) ||
    (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) ||
    (bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array, offset: number): boolean {
  if (offset + right.byteLength > left.byteLength) return false;
  return right.every((byte, index) => left[offset + index] === byte);
}

function resolveLimits(overrides: Partial<RecordingLimits> | undefined): RecordingLimits {
  const values = { ...RECORDING_LIMITS, ...(overrides ?? {}) };
  const keys = Object.keys(RECORDING_LIMITS) as (keyof RecordingLimits)[];
  if (
    keys.some(
      (key) =>
        !Number.isSafeInteger(values[key]) ||
        values[key] <= 0 ||
        values[key] > RECORDING_LIMITS[key],
    )
  )
    throw new Error("limits");
  return Object.freeze(values);
}

function normalizeKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256Hex(value: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", value as BufferSource)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

function invalid(message: string): Result<never> {
  return { ok: false, error: { code: "invalid", message, retryable: false } };
}

function incompatible(message: string): Result<never> {
  return { ok: false, error: { code: "incompatible", message, retryable: false } };
}

function overflow(message: string): Result<never> {
  return { ok: false, error: { code: "overflow", message, retryable: false } };
}
