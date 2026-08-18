import type { JsonValue, Result, SanitizedRawDetail } from "@noxscope/protocol";

export type DataClassification = "S0" | "S1" | "S2" | "S3" | "S4";
export type FieldTransform =
  "copy" | "pseudonym" | "url" | "headers" | "error" | "byte-length" | "item-count";

export interface FieldProjection {
  readonly source: string;
  readonly target: string;
  readonly classification: DataClassification;
  readonly transform: FieldTransform;
  readonly allowedHeaders?: readonly string[];
}

export interface AdapterSanitizationManifest {
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly sourceVersions: readonly string[];
  };
  readonly policy: { readonly id: string; readonly version: string; readonly digest: string };
  readonly projections: readonly FieldProjection[];
  readonly raw?: {
    readonly namespace: string;
    readonly schemaVersion: string;
    readonly projections: readonly FieldProjection[];
  };
}

export interface SanitizationAudit {
  readonly policy: AdapterSanitizationManifest["policy"];
  readonly manifest: { readonly id: string; readonly version: string };
  readonly decisions: {
    readonly copied: number;
    readonly pseudonymised: number;
    readonly transformed: number;
    readonly removed: number;
  };
  readonly redactions: readonly {
    readonly path: string;
    readonly reason: "secret" | "key-material" | "private-payload" | "policy";
  }[];
}

export interface SanitizedProjection {
  readonly value: JsonValue;
  readonly audit: SanitizationAudit;
}

export interface SanitizationOptions {
  readonly pseudonymKey?: Uint8Array;
}

export interface Sanitizer {
  sanitize(
    input: unknown,
    manifest: AdapterSanitizationManifest,
    options?: SanitizationOptions,
  ): Promise<Result<SanitizedProjection>>;
  sanitizeRawDetail(
    input: unknown,
    manifest: AdapterSanitizationManifest,
    options?: SanitizationOptions,
  ): Promise<Result<SanitizedRawDetail>>;
}

export const SANITIZER_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 256 * 1024,
  maxRawDetailBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxKeyBytes: 256,
  maxObjectProperties: 512,
  maxArrayElements: 4_096,
  maxDepth: 32,
});

const forbiddenReasons = new Map<string, SanitizationAudit["redactions"][number]["reason"]>([
  ["mnemonic", "secret"],
  ["seed", "secret"],
  ["seedbytes", "secret"],
  ["entropy", "secret"],
  ["recoveryphrase", "secret"],
  ["secret", "secret"],
  ["privatekey", "key-material"],
  ["spendingkey", "key-material"],
  ["viewingkey", "key-material"],
  ["signingkey", "key-material"],
  ["keymaterial", "key-material"],
  ["keymaterialprovider", "key-material"],
  ["passphrase", "secret"],
  ["password", "secret"],
  ["passwd", "secret"],
  ["pin", "secret"],
  ["authorization", "secret"],
  ["proxyauthorization", "secret"],
  ["apikey", "secret"],
  ["accesstoken", "secret"],
  ["refreshtoken", "secret"],
  ["sessiontoken", "secret"],
  ["token", "secret"],
  ["bearer", "secret"],
  ["cookie", "secret"],
  ["setcookie", "secret"],
  ["clientsecret", "secret"],
  ["credential", "secret"],
  ["witness", "private-payload"],
  ["redeemer", "private-payload"],
  ["proof", "private-payload"],
  ["provingkey", "key-material"],
  ["signature", "private-payload"],
  ["signedtx", "private-payload"],
  ["sealedtx", "private-payload"],
  ["unsealedtx", "private-payload"],
  ["rawtx", "private-payload"],
  ["rawtransaction", "private-payload"],
  ["transactionbytes", "private-payload"],
  ["cbor", "private-payload"],
  ["privatestate", "private-payload"],
  ["privateinput", "private-payload"],
  ["checkpoint", "private-payload"],
  ["vault", "private-payload"],
]);

export function createSanitizer(): Sanitizer {
  return new CentralSanitizer();
}

class CentralSanitizer implements Sanitizer {
  async sanitize(
    input: unknown,
    manifest: AdapterSanitizationManifest,
    options: SanitizationOptions = {},
  ): Promise<Result<SanitizedProjection>> {
    const prepared = prepare(input, manifest);
    if (prepared.state !== "valid") {
      return prepared.state === "invalid" ? invalid() : overflow();
    }
    const preparedOptions = prepareOptions(options);
    if (preparedOptions.state === "invalid") return invalid();
    try {
      return await sanitizePrepared(
        prepared.input,
        prepared.manifest,
        prepared.manifest.projections,
        preparedOptions.value,
      );
    } catch {
      return invalid();
    }
  }

  async sanitizeRawDetail(
    input: unknown,
    manifest: AdapterSanitizationManifest,
    options: SanitizationOptions = {},
  ): Promise<Result<SanitizedRawDetail>> {
    const prepared = prepare(input, manifest);
    if (prepared.state !== "valid") {
      return prepared.state === "invalid" ? invalid() : overflow();
    }
    const raw = prepared.manifest.raw;
    if (raw === undefined) return invalid();
    const preparedOptions = prepareOptions(options);
    if (preparedOptions.state === "invalid") return invalid();
    let sanitized: Result<SanitizedProjection>;
    try {
      sanitized = await sanitizePrepared(
        prepared.input,
        prepared.manifest,
        raw.projections,
        preparedOptions.value,
      );
    } catch {
      return invalid();
    }
    if (!sanitized.ok) return sanitized;
    const detail: SanitizedRawDetail = {
      namespace: raw.namespace,
      schemaVersion: raw.schemaVersion,
      value: sanitized.value.value,
      sanitization: {
        policy: prepared.manifest.policy.id,
        policyVersion: prepared.manifest.policy.version,
        redactions: sanitized.value.audit.redactions,
      },
    };
    if (encodedSize(detail) > SANITIZER_LIMITS.maxRawDetailBytes) return overflow();
    return { ok: true, value: detail };
  }
}

function prepareOptions(
  options: SanitizationOptions,
):
  { readonly state: "invalid" } | { readonly state: "valid"; readonly value: SanitizationOptions } {
  try {
    const key = options.pseudonymKey;
    if (key === undefined) return { state: "valid", value: {} };
    if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 64) {
      return { state: "invalid" };
    }
    return {
      state: "valid",
      value: { pseudonymKey: Uint8Array.prototype.slice.call(key) as Uint8Array },
    };
  } catch {
    return { state: "invalid" };
  }
}

async function sanitizePrepared(
  input: Record<string, unknown>,
  manifest: AdapterSanitizationManifest,
  projections: readonly FieldProjection[],
  options: SanitizationOptions,
): Promise<Result<SanitizedProjection>> {
  const output: Record<string, JsonValue> = {};
  const admitted = new Set<string>();
  const detected = new Map<string, SanitizationAudit["redactions"][number]["reason"]>();
  let copied = 0;
  let pseudonymised = 0;
  let transformed = 0;

  for (const projection of projections) {
    const value = readPath(input, projection.source);
    if (value === undefined) continue;
    const projected = await transformValue(value, projection, options.pseudonymKey);
    if (projected.state === "invalid") return invalid();
    if (projected.state === "removed") {
      detected.set(normalizePath(projection.source), projected.reason);
      continue;
    }
    writePath(output, projection.target, projected.value);
    for (const path of projected.admittedPaths) {
      admitted.add(normalizePath(`${projection.source}${path.length === 0 ? "" : `.${path}`}`));
    }
    if (projection.transform === "copy") copied += 1;
    else if (projection.transform === "pseudonym") pseudonymised += 1;
    else transformed += 1;
  }

  const redactions = collectLeaves(input)
    .filter(({ path }) => !admitted.has(normalizePath(path)))
    .map(({ path, value }) => {
      const normalizedPath = normalizePath(path);
      return {
        path: normalizedPath,
        reason:
          forbiddenReason(normalizedPath) ??
          detected.get(normalizedPath) ??
          detectValue(value) ??
          ("policy" as const),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const sanitized: SanitizedProjection = {
    value: output,
    audit: {
      policy: {
        id: manifest.policy.id,
        version: manifest.policy.version,
        digest: manifest.policy.digest,
      },
      manifest: { id: manifest.adapter.id, version: manifest.adapter.version },
      decisions: {
        copied,
        pseudonymised,
        transformed,
        removed: redactions.length,
      },
      redactions,
    },
  };
  if (encodedSize(sanitized) > SANITIZER_LIMITS.maxOutputBytes) {
    return overflow();
  }
  return {
    ok: true,
    value: sanitized,
  };
}

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

type TransformedValue =
  | { readonly state: "invalid" }
  | {
      readonly state: "removed";
      readonly reason: SanitizationAudit["redactions"][number]["reason"];
    }
  | {
      readonly state: "value";
      readonly value: JsonValue;
      readonly admittedPaths: readonly string[];
    };

async function transformValue(
  value: unknown,
  projection: FieldProjection,
  pseudonymKey: Uint8Array | undefined,
): Promise<TransformedValue> {
  if (projection.classification === "S0") return { state: "invalid" };
  if (projection.classification === "S1") {
    if (projection.transform === "byte-length") {
      const length = byteLength(value);
      return length === undefined
        ? { state: "invalid" }
        : { state: "value", value: length, admittedPaths: [""] };
    }
    if (projection.transform === "item-count") {
      const count = itemCount(value);
      return count === undefined
        ? { state: "invalid" }
        : { state: "value", value: count, admittedPaths: [""] };
    }
    return { state: "invalid" };
  }
  if (projection.transform === "copy") {
    if (!["S3", "S4"].includes(projection.classification) || !isJsonScalar(value)) {
      return { state: "invalid" };
    }
    const reason = detectValue(value);
    return reason === undefined
      ? { state: "value", value, admittedPaths: [""] }
      : { state: "removed", reason };
  }
  if (projection.transform === "pseudonym") {
    if (projection.classification !== "S2" || typeof value !== "string" || !pseudonymKey) {
      return { state: "invalid" };
    }
    return {
      state: "value",
      value: await pseudonymForRecording(value, projection.target, pseudonymKey),
      admittedPaths: [""],
    };
  }
  if (projection.transform === "url") {
    if (typeof value !== "string" || !["S2", "S3"].includes(projection.classification)) {
      return { state: "invalid" };
    }
    try {
      const url = new URL(value);
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return { state: "invalid" };
      return {
        state: "value",
        value: `${url.protocol}//${url.hostname}${url.port.length === 0 ? "" : `:${url.port}`}`,
        admittedPaths: [""],
      };
    } catch {
      return { state: "invalid" };
    }
  }
  if (projection.transform === "headers") {
    if (projection.classification !== "S3" || !isPlainObject(value)) return { state: "invalid" };
    const allowed = new Set(
      (projection.allowedHeaders ?? []).map((header) => header.toLowerCase()),
    );
    const headers: Record<string, JsonValue> = {};
    const admittedPaths: string[] = [];
    for (const [name, headerValue] of Object.entries(value)) {
      const normalized = name.toLowerCase();
      if (!allowed.has(normalized) || typeof headerValue !== "string") continue;
      if (forbiddenReason(name) !== undefined) continue;
      if (detectValue(headerValue) !== undefined) continue;
      headers[normalized] = headerValue;
      admittedPaths.push(name);
    }
    return { state: "value", value: headers, admittedPaths };
  }
  if (projection.transform === "error") {
    if (projection.classification !== "S3" || !isPlainObject(value)) return { state: "invalid" };
    const error: Record<string, JsonValue> = {};
    const admittedPaths: string[] = [];
    if (typeof value.code === "string" && detectValue(value.code) === undefined) {
      error.code = value.code.slice(0, 256);
      admittedPaths.push("code");
    }
    if (typeof value.message === "string" && detectValue(value.message) === undefined) {
      error.message = value.message.slice(0, 16 * 1024);
      admittedPaths.push("message");
    }
    if (typeof value.retryable === "boolean") {
      error.retryable = value.retryable;
      admittedPaths.push("retryable");
    }
    return { state: "value", value: error, admittedPaths };
  }
  return { state: "invalid" };
}

async function pseudonymForRecording(
  value: string,
  target: string,
  keyBytes: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = new TextEncoder().encode(`noxscope-recording\0${target}\0${value}`);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return `hmac-sha256:${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function byteLength(value: unknown): number | undefined {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) return value.length;
  return undefined;
}

function itemCount(value: unknown): number | undefined {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return undefined;
}

function invalid(): Result<never> {
  return {
    ok: false,
    error: {
      code: "invalid",
      message: "Sanitization input or manifest is invalid",
      retryable: false,
    },
  };
}

function overflow(): Result<never> {
  return {
    ok: false,
    error: {
      code: "overflow",
      message: "Sanitization input exceeds a resource limit",
      retryable: false,
    },
  };
}

type PreparedSanitization =
  | { readonly state: "invalid" | "overflow" }
  | {
      readonly state: "valid";
      readonly input: Record<string, unknown>;
      readonly manifest: AdapterSanitizationManifest;
    };

function prepare(input: unknown, manifest: unknown): PreparedSanitization {
  const manifestSnapshot = snapshotInert(manifest);
  if (manifestSnapshot.state !== "valid") return manifestSnapshot;
  if (!validManifest(manifestSnapshot.value)) return { state: "invalid" };
  const inputSnapshot = snapshotInert(input);
  if (inputSnapshot.state !== "valid") return inputSnapshot;
  if (!isPlainObject(inputSnapshot.value)) return { state: "invalid" };
  return {
    state: "valid",
    input: inputSnapshot.value,
    manifest: manifestSnapshot.value,
  };
}

type SnapshotResult =
  { readonly state: "invalid" | "overflow" } | { readonly state: "valid"; readonly value: unknown };

function snapshotInert(root: unknown): SnapshotResult {
  const seen = new WeakSet<object>();
  let bytes = 0;
  const visit = (value: unknown, depth: number): SnapshotResult => {
    if (depth > SANITIZER_LIMITS.maxDepth) return { state: "overflow" };
    if (value === null || typeof value === "boolean") return { state: "valid", value };
    if (typeof value === "number") {
      return Number.isFinite(value) ? { state: "valid", value } : { state: "invalid" };
    }
    if (typeof value === "string") {
      const length = new TextEncoder().encode(value).byteLength;
      bytes += length;
      if (length > SANITIZER_LIMITS.maxStringBytes || bytes > SANITIZER_LIMITS.maxInputBytes) {
        return { state: "overflow" };
      }
      return hasUnpairedSurrogate(value) ? { state: "invalid" } : { state: "valid", value };
    }
    if (typeof value !== "object" || value === undefined) return { state: "invalid" };
    if (seen.has(value)) return { state: "invalid" };
    seen.add(value);

    const prototype = Object.getPrototypeOf(value);
    if (prototype === Uint8Array.prototype) {
      const copy = Uint8Array.prototype.slice.call(value) as Uint8Array;
      bytes += copy.byteLength;
      if (bytes > SANITIZER_LIMITS.maxInputBytes) return { state: "overflow" };
      return { state: "valid", value: copy };
    }

    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
        PropertyKey,
        PropertyDescriptor
      >;
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor ||
        lengthDescriptor.get !== undefined ||
        lengthDescriptor.set !== undefined ||
        !Number.isSafeInteger(lengthDescriptor.value)
      ) {
        return { state: "invalid" };
      }
      const length = Number(lengthDescriptor.value);
      if (length > SANITIZER_LIMITS.maxArrayElements) return { state: "overflow" };
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some(
          (key) =>
            typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)),
        )
      ) {
        return { state: "invalid" };
      }
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return { state: "invalid" };
        }
        const result = visit(descriptor.value, depth + 1);
        if (result.state !== "valid") return result;
        copy.push(result.value);
      }
      return { state: "valid", value: Object.freeze(copy) };
    }

    if (prototype !== Object.prototype && prototype !== null) return { state: "invalid" };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > SANITIZER_LIMITS.maxObjectProperties) return { state: "overflow" };
    const normalizedKeys = new Set<string>();
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") return { state: "invalid" };
      const keyLength = new TextEncoder().encode(key).byteLength;
      bytes += keyLength;
      if (keyLength > SANITIZER_LIMITS.maxKeyBytes || bytes > SANITIZER_LIMITS.maxInputBytes) {
        return { state: "overflow" };
      }
      const normalized = normalizeKey(key);
      if (
        normalized.length === 0 ||
        normalizedKeys.has(normalized) ||
        ["proto", "prototype", "constructor"].includes(normalized)
      ) {
        return { state: "invalid" };
      }
      normalizedKeys.add(normalized);
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return { state: "invalid" };
      }
      const result = visit(descriptor.value, depth + 1);
      if (result.state !== "valid") return result;
      copy[key] = result.value;
    }
    return { state: "valid", value: Object.freeze(copy) };
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
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validManifest(value: unknown): value is AdapterSanitizationManifest {
  if (!isPlainObject(value)) return false;
  const adapter = value.adapter;
  const policy = value.policy;
  const projections = value.projections;
  const raw = value.raw;
  return (
    isPlainObject(adapter) &&
    nonEmptyString(adapter.id) &&
    nonEmptyString(adapter.version) &&
    Array.isArray(adapter.sourceVersions) &&
    adapter.sourceVersions.every(nonEmptyString) &&
    isPlainObject(policy) &&
    nonEmptyString(policy.id) &&
    nonEmptyString(policy.version) &&
    nonEmptyString(policy.digest) &&
    Array.isArray(projections) &&
    projections.every(validProjection) &&
    (raw === undefined || validRawManifest(raw))
  );
}

function validRawManifest(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.namespace === "string" &&
    isNamespaced(value.namespace) &&
    nonEmptyString(value.schemaVersion) &&
    Array.isArray(value.projections) &&
    value.projections.every(validProjection)
  );
}

function validProjection(value: unknown): value is FieldProjection {
  if (!isPlainObject(value)) return false;
  const projection = value;
  if (
    typeof projection.source !== "string" ||
    typeof projection.target !== "string" ||
    typeof projection.classification !== "string" ||
    typeof projection.transform !== "string" ||
    (projection.allowedHeaders !== undefined &&
      (!Array.isArray(projection.allowedHeaders) ||
        !projection.allowedHeaders.every((header) => typeof header === "string")))
  ) {
    return false;
  }
  if (!validManifestPath(projection.source) || !validManifestPath(projection.target)) return false;
  const derivedPrivateMetadata =
    projection.classification === "S1" &&
    ["byte-length", "item-count"].includes(projection.transform);
  const sourceReason = forbiddenReason(projection.source);
  if (
    (sourceReason !== undefined &&
      !(sourceReason === "private-payload" && derivedPrivateMetadata)) ||
    forbiddenReason(projection.target) !== undefined
  ) {
    return false;
  }
  if (projection.classification === "S0") return false;
  if (projection.classification === "S1") {
    return ["byte-length", "item-count"].includes(projection.transform);
  }
  if (projection.classification === "S2") {
    return ["pseudonym", "url"].includes(projection.transform);
  }
  if (projection.classification === "S3") {
    return ["copy", "url", "headers", "error"].includes(projection.transform);
  }
  return projection.classification === "S4" && projection.transform === "copy";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validManifestPath(path: string): boolean {
  const segments = path.split(".");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        !["__proto__", "prototype", "constructor"].includes(segment.toLowerCase()),
    )
  );
}

function isNamespaced(value: string): boolean {
  return (
    value.split(".").length >= 2 &&
    value.split(".").every((part) => /^[a-z][a-z0-9-]*$/i.test(part))
  );
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    const key = Object.keys(current).find(
      (candidate) => normalizeKey(candidate) === normalizeKey(segment),
    );
    if (key === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function writePath(target: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const segments = path.split(".");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!isPlainObject(existing)) current[segment] = {};
    current = current[segment] as Record<string, JsonValue>;
  }
  current[segments.at(-1)!] = value;
}

function collectLeaves(
  value: Record<string, unknown>,
  parent = "",
): { path: string; value: unknown }[] {
  const leaves: { path: string; value: unknown }[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = parent.length === 0 ? key : `${parent}.${key}`;
    if (forbiddenReasons.has(normalizeKey(key)) || !isPlainObject(nested)) {
      leaves.push({ path, value: nested });
    } else {
      leaves.push(...collectLeaves(nested, path));
    }
  }
  return leaves;
}

function detectValue(
  value: unknown,
): SanitizationAudit["redactions"][number]["reason"] | undefined {
  if (Array.isArray(value)) {
    if (
      value.length >= 16 &&
      value.every((item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255)
    ) {
      return "private-payload";
    }
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/i.test(normalized)) return "key-material";
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized)) {
    return "secret";
  }
  if (/^(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+$/i.test(normalized)) return "secret";
  const uriReason = detectUriCredentials(normalized);
  if (uriReason !== undefined) return uriReason;
  const assignmentReason = detectForbiddenAssignment(normalized);
  if (assignmentReason !== undefined) return assignmentReason;
  const structuredReason = detectStructuredSecretText(normalized);
  if (structuredReason !== undefined) return structuredReason;
  const words = normalized.split(/\s+/u);
  if (
    [12, 15, 18, 21, 24].includes(words.length) &&
    words.every((word) => {
      const length = Array.from(word).length;
      return /^[\p{L}\p{M}]+$/u.test(word) && length >= 1 && length <= 16;
    })
  ) {
    return "secret";
  }
  const compact = normalized.replace(/\s+/g, "");
  if (
    /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(compact) ||
    /^(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]{80,}$/i.test(compact) ||
    (!/^(?:xpub|tpub)/i.test(compact) &&
      /^[1-9A-HJ-NP-Za-km-z]{100,}$/.test(compact) &&
      new Set(compact).size >= 24)
  ) {
    return "key-material";
  }
  if (
    /^[0-9a-f]{128,}$/i.test(compact) ||
    (/^[A-Za-z0-9+/]{64,}={0,2}$/.test(compact) && /[g-z+/]/i.test(compact))
  ) {
    return "private-payload";
  }
  return undefined;
}

function detectUriCredentials(
  value: string,
): SanitizationAudit["redactions"][number]["reason"] | undefined {
  try {
    const url = new URL(value);
    if (
      ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
      (url.username.length > 0 ||
        url.password.length > 0 ||
        [...url.searchParams.keys()].some(
          (name) => forbiddenReasons.get(normalizeKey(name)) !== undefined,
        ) ||
        [...new URLSearchParams(url.hash.slice(1)).keys()].some(
          (name) => forbiddenReasons.get(normalizeKey(name)) !== undefined,
        ))
    ) {
      return "secret";
    }
  } catch {
    // A non-URL may still match another detector.
  }
  return undefined;
}

function detectForbiddenAssignment(
  value: string,
): SanitizationAudit["redactions"][number]["reason"] | undefined {
  for (const segment of value.split(/[?&;,{}]/u)) {
    const match = /^\s*([\p{L}\p{N}_.\-\s]{1,64}?)\s*[:=]\s*\S+/u.exec(segment);
    if (!match) continue;
    const reason = forbiddenReasons.get(normalizeKey(match[1]!));
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function detectStructuredSecretText(
  value: string,
): SanitizationAudit["redactions"][number]["reason"] | undefined {
  if (!(value.startsWith("{") || value.startsWith("["))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  const pending: unknown[] = [parsed];
  let visited = 0;
  while (pending.length > 0 && visited < SANITIZER_LIMITS.maxObjectProperties * 4) {
    visited += 1;
    const current = pending.pop();
    if (typeof current === "string") {
      const reason = detectValue(current);
      if (reason !== undefined) return reason;
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isPlainObject(current)) continue;
    const keys = Object.keys(current);
    const normalizedKeys = new Set(keys.map(normalizeKey));
    if (
      normalizedKeys.has("crypto") &&
      ["cipher", "ciphertext", "kdf", "mac"].filter((key) =>
        JSON.stringify(current.crypto).toLocaleLowerCase("en-US").includes(key),
      ).length >= 3
    ) {
      return "key-material";
    }
    for (const key of keys) {
      const reason = forbiddenReasons.get(normalizeKey(key));
      if (reason !== undefined) return reason;
      pending.push(current[key]);
    }
  }
  return undefined;
}

function forbiddenReason(
  path: string,
): SanitizationAudit["redactions"][number]["reason"] | undefined {
  for (const segment of path.split(".")) {
    const reason = forbiddenReasons.get(normalizeKey(segment));
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function normalizePath(path: string): string {
  return path.split(".").map(normalizeKey).join(".");
}

function normalizeKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/g, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonScalar(value: unknown): value is null | boolean | number | string {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
