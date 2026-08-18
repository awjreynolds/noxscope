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
    _options: SanitizationOptions = {},
  ): Promise<Result<SanitizedProjection>> {
    if (!isPlainObject(input) || !validManifest(manifest)) return invalid();
    const shape = validateInputShape(input);
    if (shape === "invalid") return invalid();
    if (shape === "overflow") return overflow();
    const output: Record<string, JsonValue> = {};
    const admitted = new Set<string>();
    const detected = new Map<string, SanitizationAudit["redactions"][number]["reason"]>();
    let copied = 0;
    let pseudonymised = 0;
    let transformed = 0;

    for (const projection of manifest.projections) {
      const value = readPath(input, projection.source);
      if (value === undefined) continue;
      const projected = await transformValue(value, projection, _options.pseudonymKey);
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
      .map(({ path, value }) => ({
        path,
        reason:
          forbiddenReason(path) ??
          detected.get(normalizePath(path)) ??
          detectValue(value) ??
          ("policy" as const),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    const sanitized: SanitizedProjection = {
      value: output,
      audit: {
        policy: manifest.policy,
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
    if (
      new TextEncoder().encode(JSON.stringify(sanitized)).byteLength >
      SANITIZER_LIMITS.maxOutputBytes
    ) {
      return overflow();
    }
    return {
      ok: true,
      value: sanitized,
    };
  }

  async sanitizeRawDetail(
    input: unknown,
    manifest: AdapterSanitizationManifest,
    options: SanitizationOptions = {},
  ): Promise<Result<SanitizedRawDetail>> {
    if (
      manifest.raw === undefined ||
      !isNamespaced(manifest.raw.namespace) ||
      manifest.raw.schemaVersion.length === 0
    ) {
      return invalid();
    }
    const sanitized = await this.sanitize(
      input,
      { ...manifest, projections: manifest.raw.projections },
      options,
    );
    if (!sanitized.ok) return sanitized;
    return {
      ok: true,
      value: {
        namespace: manifest.raw.namespace,
        schemaVersion: manifest.raw.schemaVersion,
        value: sanitized.value.value,
        sanitization: {
          policy: manifest.policy.id,
          policyVersion: manifest.policy.version,
          redactions: sanitized.value.audit.redactions,
        },
      },
    };
  }
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

function validateInputShape(root: unknown): "valid" | "invalid" | "overflow" {
  const seen = new WeakSet<object>();
  let bytes = 0;
  const visit = (value: unknown, depth: number): "valid" | "invalid" | "overflow" => {
    if (depth > SANITIZER_LIMITS.maxDepth) return "overflow";
    if (value === null || typeof value === "boolean") return "valid";
    if (typeof value === "number") return Number.isFinite(value) ? "valid" : "invalid";
    if (typeof value === "string") {
      const length = new TextEncoder().encode(value).byteLength;
      bytes += length;
      if (length > SANITIZER_LIMITS.maxStringBytes || bytes > SANITIZER_LIMITS.maxInputBytes) {
        return "overflow";
      }
      return hasUnpairedSurrogate(value) ? "invalid" : "valid";
    }
    if (typeof value !== "object" || value === undefined) return "invalid";
    if (seen.has(value)) return "invalid";
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > SANITIZER_LIMITS.maxArrayElements) return "overflow";
      for (const item of value) {
        const result = visit(item, depth + 1);
        if (result !== "valid") return result;
      }
      return "valid";
    }
    if (!isPlainObject(value)) return "invalid";
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > SANITIZER_LIMITS.maxObjectProperties) return "overflow";
    const normalizedKeys = new Set<string>();
    for (const key of keys) {
      if (typeof key !== "string") return "invalid";
      const keyLength = new TextEncoder().encode(key).byteLength;
      bytes += keyLength;
      if (keyLength > SANITIZER_LIMITS.maxKeyBytes || bytes > SANITIZER_LIMITS.maxInputBytes) {
        return "overflow";
      }
      const normalized = normalizeKey(key);
      if (
        normalizedKeys.has(normalized) ||
        ["__proto__", "prototype", "constructor"].includes(key.toLowerCase())
      ) {
        return "invalid";
      }
      normalizedKeys.add(normalized);
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
        return "invalid";
      }
      const result = visit(descriptor.value, depth + 1);
      if (result !== "valid") return result;
    }
    return "valid";
  };
  return visit(root, 0);
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

function validManifest(manifest: AdapterSanitizationManifest): boolean {
  return (
    manifest.adapter.id.length > 0 &&
    manifest.adapter.version.length > 0 &&
    manifest.policy.id.length > 0 &&
    manifest.policy.version.length > 0 &&
    manifest.policy.digest.length > 0 &&
    manifest.projections.every(validProjection)
  );
}

function validProjection(projection: FieldProjection): boolean {
  if (!validManifestPath(projection.source) || !validManifestPath(projection.target)) return false;
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
  if (
    /(?:^|[?&;,\s{])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential)\s*[:=]\s*\S+/i.test(
      normalized,
    )
  ) {
    return "secret";
  }
  const words = normalized.toLocaleLowerCase("en-US").split(/\s+/u);
  if (
    [12, 15, 18, 21, 24].includes(words.length) &&
    words.every((word) => /^[a-z]+$/u.test(word) && word.length >= 2 && word.length <= 10)
  ) {
    return "secret";
  }
  const compact = normalized.replace(/\s+/g, "");
  if (/^(?:[0-9a-f]{64,}|[A-Za-z0-9+/]{64,}={0,2})$/i.test(compact)) {
    return "private-payload";
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
