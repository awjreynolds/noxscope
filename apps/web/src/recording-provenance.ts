import {
  adapterReferences,
  NOXSCOPE_RECORDING_FORMAT,
  NOXSCOPE_RECORDING_MAGIC,
  NOXSCOPE_RECORDING_SCHEMA_VERSION,
  RECORDING_LIMITS,
  type AdapterSanitizationManifest,
  type RecordingAdapterReference,
  type RecordingPolicyReference,
} from "@noxscope/core";
import { NOXSCOPE_PROTOCOL, type NoxscopeError, type Result } from "@noxscope/protocol";

/** The only policy that this application is willing to use for portable Recordings. */
export const RECORDING_POLICY = Object.freeze({
  id: "noxscope.redaction",
  version: "1.0.0",
  digest: "core-v1",
});

export const DEFAULT_RECORDING_ADAPTER = Object.freeze({
  id: "noxscope.browser",
  version: "0.1.0",
  sourceVersions: ["noxscope/adapter/1"],
});

export const DEFAULT_RECORDING_MANIFEST: AdapterSanitizationManifest = {
  adapter: DEFAULT_RECORDING_ADAPTER,
  policy: RECORDING_POLICY,
  projections: [],
};

/** Checked-in adapter used by the deterministic browser workbench. */
export const MOCK_RECORDING_MANIFEST: AdapterSanitizationManifest = {
  adapter: {
    id: "dev.noxscope.adapter-mock",
    version: "0.1.0",
    sourceVersions: ["wallet-sdk@mock-1.0.0"],
  },
  policy: RECORDING_POLICY,
  projections: [],
};

export interface RecordingProvenance {
  readonly adapters: readonly RecordingAdapterReference[];
  readonly policies: readonly RecordingPolicyReference[];
}

/**
 * A small trust seam for import provenance. File declarations can select an
 * entry, but they can never add or alter an entry in this registry.
 */
export interface RecordingProvenanceRegistry {
  register(manifests: readonly AdapterSanitizationManifest[]): Result<void>;
  resolve(provenance: RecordingProvenance): Result<readonly AdapterSanitizationManifest[]>;
}

const MAX_CONTROL_BYTES = 4 * 1024;
const MAGIC_BYTES = new TextEncoder().encode(`${NOXSCOPE_RECORDING_MAGIC}\n`);
const defaultRegistry = createRecordingProvenanceRegistry([
  DEFAULT_RECORDING_MANIFEST,
  MOCK_RECORDING_MANIFEST,
]);

export function defaultRecordingProvenanceRegistry(): RecordingProvenanceRegistry {
  return defaultRegistry;
}

export function createRecordingProvenanceRegistry(
  initial: readonly AdapterSanitizationManifest[] = [],
): RecordingProvenanceRegistry {
  const entries = new Map<string, AdapterSanitizationManifest>();

  const register = (manifests: readonly AdapterSanitizationManifest[]): Result<void> => {
    try {
      if (!Array.isArray(manifests) || manifests.length === 0) {
        return incompatible("Recording provenance is unavailable");
      }
      const additions = new Map<string, AdapterSanitizationManifest>();
      for (const manifest of manifests) {
        const reference = trustedReference(manifest);
        if (!reference.ok) return reference;
        additions.set(referenceKey(reference.value), manifest);
      }
      for (const [key, manifest] of additions) entries.set(key, manifest);
      return { ok: true, value: undefined };
    } catch {
      return incompatible("Recording provenance is unavailable");
    }
  };

  const initialResult = register(initial);
  if (!initialResult.ok) {
    // The checked-in default is known-good. Keep construction total if a
    // caller supplies an empty/custom initial list, while still rejecting it
    // when registration is explicitly requested later.
    entries.clear();
  }

  return {
    register,
    resolve(provenance) {
      try {
        if (!samePolicy(provenance.policies)) {
          return incompatible("Recording provenance policy is incompatible");
        }
        if (!Array.isArray(provenance.adapters) || provenance.adapters.length === 0) {
          return incompatible("Recording provenance is incompatible");
        }
        const manifests: AdapterSanitizationManifest[] = [];
        const seen = new Set<string>();
        for (const reference of provenance.adapters) {
          const key = referenceKey(reference);
          if (seen.has(key)) return incompatible("Recording provenance is incompatible");
          seen.add(key);
          const manifest = entries.get(key);
          if (manifest === undefined) return incompatible("Recording adapter is not trusted");
          manifests.push(manifest);
        }
        return { ok: true, value: manifests };
      } catch {
        return incompatible("Recording provenance is incompatible");
      }
    },
  };
}

/**
 * Reads only the bounded header frame. The full importer remains the
 * authority for integrity, canonical shape, and record validation.
 */
export function preflightRecordingProvenance(bytes: Uint8Array): Result<RecordingProvenance> {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > RECORDING_LIMITS.maxFileBytes) {
      return overflow("Recording file exceeds the import limit");
    }
    if (!sameBytes(bytes, MAGIC_BYTES, 0)) return incompatible("Recording magic is incompatible");
    const controlEnd = findNewline(bytes, MAGIC_BYTES.byteLength);
    if (controlEnd < 0 || controlEnd - MAGIC_BYTES.byteLength > MAX_CONTROL_BYTES) {
      return invalid("Recording header is invalid");
    }
    const control = parseJson(bytes.slice(MAGIC_BYTES.byteLength, controlEnd));
    if (!control.ok || !isRecord(control.value)) return invalid("Recording header is invalid");
    const bytesLength = control.value.bytes;
    if (
      control.value.type !== "header" ||
      typeof bytesLength !== "number" ||
      !Number.isSafeInteger(bytesLength) ||
      bytesLength < 1 ||
      bytesLength > RECORDING_LIMITS.maxRecordBytes
    ) {
      return invalid("Recording header is invalid");
    }
    const payloadStart = controlEnd + 1;
    const payloadEnd = payloadStart + bytesLength;
    if (payloadEnd < payloadStart || payloadEnd >= bytes.byteLength || bytes[payloadEnd] !== 10) {
      return invalid("Recording header is truncated");
    }
    const header = parseJson(bytes.slice(payloadStart, payloadEnd));
    if (!header.ok) return invalid("Recording header is invalid");
    return validateHeader(header.value);
  } catch {
    return invalid("Recording header is invalid");
  }
}

function validateHeader(value: unknown): Result<RecordingProvenance> {
  if (!isRecord(value)) return invalid("Recording header is invalid");
  if (
    value.format !== NOXSCOPE_RECORDING_FORMAT ||
    value.formatVersion !== 1 ||
    value.protocol !== NOXSCOPE_PROTOCOL ||
    value.schemaVersion !== NOXSCOPE_RECORDING_SCHEMA_VERSION ||
    !Array.isArray(value.adapters) ||
    !Array.isArray(value.policies) ||
    value.adapters.length === 0 ||
    value.adapters.length > RECORDING_LIMITS.maxArrayElements ||
    value.policies.length === 0 ||
    value.policies.length > RECORDING_LIMITS.maxArrayElements
  ) {
    return invalid("Recording header is invalid");
  }
  const adapters: RecordingAdapterReference[] = [];
  for (const candidate of value.adapters) {
    const adapter = validateAdapterReference(candidate);
    if (!adapter.ok) return adapter;
    adapters.push(adapter.value);
  }
  const policies: RecordingPolicyReference[] = [];
  for (const candidate of value.policies) {
    const policy = validatePolicyReference(candidate);
    if (!policy.ok) return policy;
    policies.push(policy.value);
  }
  return { ok: true, value: { adapters, policies } };
}

function validateAdapterReference(value: unknown): Result<RecordingAdapterReference> {
  if (!isRecord(value)) return invalid("Recording header is invalid");
  if (
    !boundedString(value.id) ||
    !boundedString(value.version) ||
    !Array.isArray(value.sourceVersions) ||
    value.sourceVersions.length > RECORDING_LIMITS.maxArrayElements ||
    !value.sourceVersions.every(boundedString)
  ) {
    return invalid("Recording header is invalid");
  }
  if (value.raw === undefined) {
    return {
      ok: true,
      value: { id: value.id, version: value.version, sourceVersions: [...value.sourceVersions] },
    };
  }
  if (
    !isRecord(value.raw) ||
    !boundedString(value.raw.namespace) ||
    !boundedString(value.raw.schemaVersion)
  ) {
    return invalid("Recording header is invalid");
  }
  return {
    ok: true,
    value: {
      id: value.id,
      version: value.version,
      sourceVersions: [...value.sourceVersions],
      raw: { namespace: value.raw.namespace, schemaVersion: value.raw.schemaVersion },
    },
  };
}

function validatePolicyReference(value: unknown): Result<RecordingPolicyReference> {
  if (
    !isRecord(value) ||
    !boundedString(value.id) ||
    !boundedString(value.version) ||
    !boundedString(value.digest)
  ) {
    return invalid("Recording header is invalid");
  }
  return { ok: true, value: { id: value.id, version: value.version, digest: value.digest } };
}

function trustedReference(
  manifest: AdapterSanitizationManifest,
): Result<RecordingAdapterReference> {
  try {
    if (!samePolicy([manifest.policy])) return incompatible("Recording policy is not trusted");
    const references = adapterReferences({ manifest, pseudonymKey: new Uint8Array(32) });
    if (references.length !== 1) return incompatible("Recording adapter is not trusted");
    return { ok: true, value: references[0]! };
  } catch {
    return incompatible("Recording adapter is not trusted");
  }
}

function samePolicy(policies: readonly RecordingPolicyReference[]): boolean {
  return (
    Array.isArray(policies) &&
    policies.length === 1 &&
    policies[0]?.id === RECORDING_POLICY.id &&
    policies[0]?.version === RECORDING_POLICY.version &&
    policies[0]?.digest === RECORDING_POLICY.digest
  );
}

function referenceKey(reference: RecordingAdapterReference): string {
  return JSON.stringify({
    id: reference.id,
    version: reference.version,
    sourceVersions: [...reference.sourceVersions],
    ...(reference.raw === undefined ? {} : { raw: { ...reference.raw } }),
  });
}

function parseJson(bytes: Uint8Array): Result<unknown> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return invalid("Recording header is invalid");
  }
}

function findNewline(bytes: Uint8Array, start: number): number {
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 10) return index;
    if (index - start >= MAX_CONTROL_BYTES) return -1;
  }
  return -1;
}

function sameBytes(left: Uint8Array, right: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + right.byteLength > left.byteLength) return false;
  for (let index = 0; index < right.byteLength; index += 1) {
    if (left[offset + index] !== right[index]) return false;
  }
  return true;
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= RECORDING_LIMITS.maxStringBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function incompatible(message: string): Result<never> {
  return error("incompatible", message, false);
}

function invalid(message: string): Result<never> {
  return error("invalid", message, false);
}

function overflow(message: string): Result<never> {
  return error("overflow", message, false);
}

function error<T>(code: NoxscopeError["code"], message: string, retryable: boolean): Result<T> {
  return { ok: false, error: { code, message, retryable } };
}
