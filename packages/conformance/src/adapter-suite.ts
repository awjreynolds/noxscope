import { createSanitizer, type AdapterSanitizationManifest } from "@noxscope/core";
import {
  NOXSCOPE_PROTOCOL,
  validateRecord,
  validateRuntimeDescriptor,
  type InvokeRequest,
  type NoxscopeRecord,
  type Result,
  type RuntimeDescriptor,
  type RuntimeSession,
  type Snapshot,
  type SnapshotRequest,
} from "@noxscope/protocol";
import {
  CONFORMANCE_SUITE_VERSION,
  type AdapterConformanceOptions,
  type AdmissionState,
  type AssertionResult,
  type CapabilityResult,
  type ConformanceRunResult,
  type EvidenceKind,
  type QualificationReport,
  type SafetyControls,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RECORDS = 128;
const MAX_RECORD_BYTES = 256 * 1024;
const REDACTION_POLICY = "noxscope.conformance.evidence";
const RESULT_ERROR_CODES = new Set([
  "unsupported",
  "unavailable",
  "incompatible",
  "unauthorized",
  "timeout",
  "cancelled",
  "invalid",
  "rejected",
  "failed",
  "protocol",
  "overflow",
  "internal",
]);

const CONFORMANCE_MANIFEST: AdapterSanitizationManifest = {
  adapter: {
    id: "org.noxscope.conformance",
    version: "1",
    sourceVersions: [CONFORMANCE_SUITE_VERSION],
  },
  policy: { id: REDACTION_POLICY, version: "1", digest: "conformance-evidence-v1" },
  projections: [
    { source: "target.id", target: "target.id", classification: "S4", transform: "copy" },
    { source: "target.name", target: "target.name", classification: "S3", transform: "copy" },
    {
      source: "target.surface",
      target: "target.surface",
      classification: "S4",
      transform: "copy",
    },
    {
      source: "environment",
      target: "environment",
      classification: "S4",
      transform: "copy",
    },
    { source: "evidence", target: "evidence", classification: "S4", transform: "copy" },
  ],
};

/**
 * Run the canonical Runtime Session suite against one Adapter.
 *
 * The suite deliberately accepts only the canonical Adapter interface. Native
 * transports, wallet SDK classes, and browser objects cannot influence the
 * assertions or the report shape. A fixture run is always admitted as
 * `fixture`, even when every assertion passes.
 */
export async function runAdapterConformance(
  options: AdapterConformanceOptions,
): Promise<ConformanceRunResult> {
  const requestedEvidence = options.evidence ?? "fixture";
  const environment = options.environment ?? "fixture";
  const normalizedTarget = normalizeQualificationTarget(options.target);
  const target = normalizedTarget.value;
  const trustedExercise =
    requestedEvidence === "exercised" &&
    environment !== "fixture" &&
    environment !== "mainnet" &&
    normalizedTarget.provenance &&
    isTrustedQualificationHarness(options.harness, environment);
  const evidence: EvidenceKind = trustedExercise ? "exercised" : "fixture";
  const timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxRecords = clampRecords(options.maxRecords ?? DEFAULT_MAX_RECORDS);
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = safeTimestamp(now);
  const assertions: AssertionResult[] = [];
  const capabilities: CapabilityResult[] = [];
  const records: NoxscopeRecord[] = [];
  let snapshot: Snapshot | undefined;
  let result: Result<unknown> | undefined;
  let redactionCount = 0;
  assertions.push(
    assertion(
      "P1.1",
      normalizedTarget.provenance && (requestedEvidence !== "exercised" || trustedExercise)
        ? "pass"
        : "fail",
      evidence,
      normalizedTarget.provenance && (requestedEvidence !== "exercised" || trustedExercise)
        ? "Target build, source, protocol, network, and harness provenance are present"
        : requestedEvidence === "exercised" && !trustedExercise
          ? "Exercised evidence lacks trusted non-mainnet harness provenance"
          : "Target provenance is incomplete; compatibility admission is blocked",
    ),
  );
  const controller = new AbortController();

  const connected = await settle(
    () => options.adapter.connect({ signal: controller.signal }),
    timeoutMs,
  );
  if (connected.state === "timeout") {
    controller.abort();
    assertions.push(assertion("A1.1", "fail", evidence, "Adapter connection exceeded its bound"));
    return finish({
      options,
      evidence,
      environment,
      startedAt,
      now,
      assertions,
      capabilities,
      controller,
      redactionCount,
    });
  }
  if (connected.state === "error") {
    assertions.push(assertion("A1.1", "fail", evidence, "Adapter connection threw an error"));
    return finish({
      options,
      evidence,
      environment,
      startedAt,
      now,
      assertions,
      capabilities,
      controller,
      redactionCount,
    });
  }
  const connection = connected.value;
  if (!isExactResult(connection)) {
    assertions.push(assertion("A1.1", "fail", evidence, "Adapter returned a malformed Result"));
    controller.abort();
    return finish({
      options,
      evidence,
      environment,
      startedAt,
      now,
      assertions,
      capabilities,
      controller,
      redactionCount,
    });
  }
  result = connection as Result<unknown>;
  if (!connection.ok) {
    const errorCode = safeRead(safeRead(connection, "error"), "code");
    assertions.push(
      assertion(
        "A1.1",
        "fail",
        evidence,
        typeof errorCode === "string"
          ? `Adapter connection failed with ${errorCode}`
          : "Adapter connection failed with a typed error",
      ),
    );
    controller.abort();
    return finish({
      options,
      evidence,
      environment,
      startedAt,
      now,
      assertions,
      capabilities,
      controller,
      redactionCount,
      result,
    });
  }

  const sessionValue = safeRead(connection, "value");
  if (!isObject(sessionValue)) {
    assertions.push(
      assertion("A1.1", "fail", evidence, "Adapter returned a non-object Runtime Session"),
    );
    controller.abort();
    return finish({
      options,
      evidence,
      environment,
      startedAt,
      now,
      assertions,
      capabilities,
      controller,
      redactionCount,
    });
  }
  const session = sessionValue as unknown as RuntimeSession;
  const descriptorValue = safeRead(sessionValue, "descriptor");
  let checkedDescriptor: ReturnType<typeof validateRuntimeDescriptor>;
  try {
    checkedDescriptor = validateRuntimeDescriptor(descriptorValue);
  } catch {
    checkedDescriptor = {
      ok: false,
      error: {
        code: "protocol",
        message: "Runtime descriptor could not be safely read",
        retryable: false,
      },
    };
  }
  if (!checkedDescriptor.ok) {
    assertions.push(assertion("A1.1", "fail", evidence, checkedDescriptor.error.message));
    controller.abort();
    return finish({
      options,
      evidence,
      environment,
      startedAt,
      now,
      assertions,
      capabilities,
      controller,
      redactionCount,
      result,
    });
  }
  const descriptor = checkedDescriptor.value;
  assertions.push(
    assertion(
      "A1.1",
      "pass",
      evidence,
      "Canonical protocol and Runtime Session identity are valid",
    ),
  );
  assertions.push(
    assertion(
      "A1.2",
      descriptor.sessionId.length > 0 && descriptor.runtimeId.length > 0 ? "pass" : "fail",
      evidence,
      "Runtime and session identifiers are present",
    ),
  );
  assertions.push(
    assertion(
      "A1.3",
      versionFactsValid(descriptor) ? "pass" : "fail",
      evidence,
      "Runtime versions are separate, non-empty facts",
    ),
  );
  assertions.push(
    assertion(
      "A2.1",
      capabilitiesValid(descriptor) ? "pass" : "fail",
      evidence,
      "Capability declarations carry evidence",
    ),
  );
  assertions.push(
    assertion(
      "A2.2",
      descriptor.capabilities.some((capability) => capability.support.state === "unsupported")
        ? "pass"
        : "skip",
      evidence,
      descriptor.capabilities.some((capability) => capability.support.state === "unsupported")
        ? "Unsupported capabilities are explicitly distinguished"
        : "No unsupported capability declaration was available for rejection testing",
    ),
  );
  assertions.push(
    assertion(
      "A1.4",
      (await reconnectCheck(options.adapter, descriptor, timeoutMs)) ? "pass" : "fail",
      evidence,
      "Reconnect negotiation creates a distinct Runtime Session identity",
    ),
  );

  const snapshotRequest: SnapshotRequest = {
    kind: "snapshot",
    requestId: "noxscope-conformance-snapshot-1",
  };
  const requestMethod = safeRead(sessionValue, "request");
  const requested =
    typeof requestMethod !== "function"
      ? ({ state: "error", error: new Error("Runtime Session request method is missing") } as const)
      : await settle(
          () =>
            (requestMethod as (request: unknown, options?: unknown) => Promise<unknown>).call(
              session,
              snapshotRequest,
              {
                signal: controller.signal,
                timeoutMs,
              },
            ),
          timeoutMs,
        );
  if (requested.state === "value" && isExactResult(requested.value)) {
    result = requested.value as Result<unknown>;
    if (requested.value.ok) {
      const candidateSnapshot = safeRead(requested.value, "value");
      if (!isSnapshotShape(candidateSnapshot)) {
        assertions.push(
          assertion("A4.1", "fail", evidence, "Snapshot Result value has an inexact schema"),
        );
        assertions.push(
          assertion("A4.2", "skip", evidence, "Snapshot freshness was not safely available"),
        );
      } else {
        snapshot = cloneSnapshot(candidateSnapshot);
        assertions.push(
          assertion(
            "A4.1",
            snapshot === undefined ? "fail" : "pass",
            evidence,
            snapshot === undefined
              ? "Snapshot Result value could not be safely reconstructed"
              : "Snapshot has a revision",
          ),
        );
        assertions.push(
          assertion(
            "A4.2",
            snapshot === undefined || !freshnessValid(snapshot) ? "fail" : "pass",
            evidence,
            "Snapshot freshness is explicit and bounded",
          ),
        );
      }
    } else {
      assertions.push(
        assertion("A4.1", "skip", evidence, "Snapshot request returned a typed error"),
      );
      assertions.push(assertion("A4.2", "skip", evidence, "Snapshot freshness was not available"));
    }
  } else if (requested.state === "timeout") {
    assertions.push(assertion("A4.1", "fail", evidence, "Snapshot request exceeded its bound"));
    assertions.push(assertion("A4.2", "skip", evidence, "Snapshot freshness was not available"));
  } else {
    assertions.push(
      assertion("A4.1", "fail", evidence, "Snapshot request threw or returned a malformed Result"),
    );
    assertions.push(assertion("A4.2", "skip", evidence, "Snapshot freshness was not available"));
  }

  const collected = await collectRecords(session, controller.signal, timeoutMs, maxRecords);
  records.push(...collected.records);
  const recordChecks = inspectRecords(records, descriptor, evidence);
  assertions.push(...recordChecks.assertions);
  assertions.push(
    assertion(
      "A5.1",
      operationCorrelationValid(records) ? "pass" : "fail",
      evidence,
      "Operation records preserve request and operation identity without duplicate terminals",
    ),
  );

  if (options.operations?.enabled) {
    const operationCheck = await runAllowedOperation(
      session,
      options,
      controller.signal,
      timeoutMs,
      evidence,
    );
    assertions.push(operationCheck.assertion);
    if (operationCheck.result !== undefined) result = operationCheck.result;
  } else {
    const unsupportedCheck = await runUnsupportedRequest(session, descriptor, timeoutMs, evidence);
    assertions.push(unsupportedCheck);
  }

  const abortedRequest = await runAbortedRequest(session, timeoutMs, evidence);
  assertions.push(abortedRequest);
  controller.abort();
  const closed = await settle(() => collected.iterator.next(), timeoutMs);
  assertions.push(
    assertion(
      "A3.6",
      closed.state === "value" && closed.value.done === true ? "pass" : "fail",
      evidence,
      "Orderly abort terminates the Runtime Session iterator within its bound",
    ),
  );

  for (const capability of descriptor.capabilities) {
    capabilities.push(capabilityResult(capability, snapshot, records, evidence));
  }
  const capabilityChecks = capabilities.flatMap((capability) => capability.assertions);
  assertions.push(
    assertion(
      "A2.3",
      capabilityChecks.some((item) => item.status === "fail") ? "fail" : "pass",
      evidence,
      capabilityChecks.some((item) => item.status === "fail")
        ? "A declared capability failed its specific evidence-bearing suite"
        : "Every declared supported capability passed its registered suite",
    ),
  );

  const sanitizer = createSanitizer();
  for (const record of records) {
    const encoded = safeJson(record);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_RECORD_BYTES) {
      assertions.push(
        assertion("A6.2", "fail", evidence, "Record exceeded the evidence size bound"),
      );
      continue;
    }
    if (containsSecretField(record)) {
      assertions.push(
        assertion(
          "A6.5",
          "fail",
          evidence,
          "Secret or private execution material crossed the canonical seam",
        ),
      );
    }
    const sanitized = await sanitizer.sanitize(
      { target, environment, evidence, record },
      CONFORMANCE_MANIFEST,
    );
    if (sanitized.ok) redactionCount += sanitized.value.audit.redactions.length;
    else
      assertions.push(assertion("A6.3", "fail", evidence, "Central sanitizer rejected evidence"));
  }
  assertions.push(
    assertion(
      "A6.1",
      records.every((record) => validateRecord(record).ok) ? "pass" : "fail",
      evidence,
      "Canonical records validate at the conformance seam",
    ),
  );
  assertions.push(
    assertion(
      "A4.3",
      snapshot === undefined
        ? "skip"
        : snapshot.freshness.state === "fresh" ||
            (snapshot.freshness.state === "stale" && snapshot.freshness.consecutiveFailures > 0)
          ? "pass"
          : "fail",
      evidence,
      "Snapshot freshness preserves the stale/last-good distinction",
    ),
  );
  if (!assertions.some((item) => item.id === "A6.2" && item.status === "fail")) {
    assertions.push(
      assertion("A6.2", "pass", evidence, "Hostile evidence remains within record limits"),
    );
  }
  if (!assertions.some((item) => item.id === "A6.3" && item.status === "fail")) {
    assertions.push(assertion("A6.3", "pass", evidence, "Evidence passed the central sanitizer"));
  }
  if (!assertions.some((item) => item.id === "A6.5" && item.status === "fail")) {
    assertions.push(assertion("A6.5", "pass", evidence, "No secret canary crossed the seam"));
  }

  return finish({
    options,
    evidence,
    environment,
    startedAt,
    now,
    assertions,
    capabilities,
    controller,
    redactionCount,
    descriptor,
    snapshot,
    result,
    records,
  });
}

function finish(input: {
  readonly options: AdapterConformanceOptions;
  readonly evidence: EvidenceKind;
  readonly environment: AdapterConformanceOptions["environment"];
  readonly startedAt: string;
  readonly now: () => string;
  readonly assertions: readonly AssertionResult[];
  readonly capabilities: readonly CapabilityResult[];
  readonly controller: AbortController;
  readonly redactionCount: number;
  readonly descriptor?: QualificationReport["descriptor"] | undefined;
  readonly snapshot?: Snapshot | undefined;
  readonly result?: Result<unknown> | undefined;
  readonly records?: readonly NoxscopeRecord[] | undefined;
}): ConformanceRunResult {
  input.controller.abort();
  const report: QualificationReport = {
    schemaVersion: "noxscope.qualification/1",
    kind: "adapter",
    suite: { id: CONFORMANCE_SUITE_VERSION, version: "1.0.0" },
    target: normalizeQualificationTarget(input.options.target).value,
    evidence: input.evidence,
    evidenceSource: evidenceSourceFor(input.evidence, input.environment ?? "fixture"),
    environment: input.environment ?? "fixture",
    startedAt: input.startedAt,
    endedAt: safeTimestamp(input.now),
    ...(input.descriptor === undefined
      ? {}
      : (() => {
          const safe = sanitizeDescriptor(input.descriptor);
          return safe === undefined ? {} : { descriptor: safe };
        })()),
    assertions: input.assertions,
    capabilities: input.capabilities,
    admission: deriveAdmission("adapter", input.evidence, input.assertions),
    safety: safetyFor(input.options),
    redactions: { count: input.redactionCount, policy: REDACTION_POLICY },
  };
  return {
    ...report,
    ...(input.snapshot === undefined
      ? {}
      : (() => {
          const safe = sanitizeSnapshot(input.snapshot);
          return safe === undefined ? {} : { snapshot: safe };
        })()),
    ...(input.result === undefined ? {} : { result: summarizeResult(input.result) }),
  };
}

function evidenceSourceFor(
  evidence: EvidenceKind,
  environment: AdapterConformanceOptions["environment"],
): "fixture-corpus" | "installed-runtime" | "localnet-harness" | "preprod-harness" {
  if (evidence === "fixture") return "fixture-corpus";
  if (environment === "localnet") return "localnet-harness";
  if (environment === "preprod") return "preprod-harness";
  return "installed-runtime";
}

export function normalizeQualificationTarget(input: unknown): {
  readonly value: QualificationReport["target"];
  readonly provenance: boolean;
} {
  const read = (key: string): string | undefined => {
    if (!isObject(input)) return undefined;
    return safeString(safeRead(input, key));
  };
  const optional = [
    "platform",
    "distribution",
    "buildDigest",
    "sourceCommit",
    "nativeProtocol",
    "network",
  ] as const;
  const fields = new Map<string, string | undefined>();
  for (const key of ["id", "name", "surface", ...optional]) fields.set(key, read(key));
  const id = fields.get("id") ?? "invalid.target";
  const name = fields.get("name") ?? "Invalid target";
  const surface = fields.get("surface") ?? "unknown";
  const required =
    fields.get("id") !== undefined &&
    fields.get("name") !== undefined &&
    fields.get("surface") !== undefined;
  const value: QualificationReport["target"] = {
    id,
    name,
    surface,
    ...Object.fromEntries(
      optional.flatMap((key) => {
        const item = fields.get(key);
        return item === undefined ? [] : [[key, item]];
      }),
    ),
  } as QualificationReport["target"];
  return {
    value,
    provenance: required && optional.every((key) => fields.get(key) !== undefined),
  };
}

export function isTrustedQualificationHarness(
  harness: AdapterConformanceOptions["harness"],
  environment: AdapterConformanceOptions["environment"],
): boolean {
  return (
    harness?.kind === "noxscope-qualification-harness" &&
    harness.version === "1" &&
    harness.isolatedProfile === true &&
    typeof harness.artifactDigest === "string" &&
    harness.artifactDigest.length >= 16 &&
    environment !== "fixture" &&
    environment !== "mainnet"
  );
}

function sanitizeDescriptor(input: RuntimeDescriptor): RuntimeDescriptor | undefined {
  try {
    const runtime = input.runtime;
    const identifiers = runtime.identifiers.map((identifier) => ({
      scheme: identifier.scheme,
      value: identifier.value,
      stability: identifier.stability,
    }));
    const versions = runtime.versions.map((version) => ({
      subject: version.subject,
      version: version.version,
    }));
    const capabilities = input.capabilities.map((capability) => ({
      id: capability.id,
      kind: capability.kind,
      support:
        capability.support.state === "supported"
          ? {
              state: "supported" as const,
              version: capability.support.version,
              evidence: {
                source: capability.support.evidence.source,
                observedAt: capability.support.evidence.observedAt,
                summary: capability.support.evidence.summary,
              },
            }
          : {
              state: "unsupported" as const,
              reason: capability.support.reason,
              evidence: {
                source: capability.support.evidence.source,
                observedAt: capability.support.evidence.observedAt,
                summary: capability.support.evidence.summary,
              },
            },
      availability:
        capability.availability.state === "available"
          ? { state: "available" as const }
          : {
              state: capability.availability.state,
              reason: capability.availability.reason,
              retryable: capability.availability.retryable,
              ...(capability.availability.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: capability.availability.retryAfterMs }),
            },
    }));
    const sanitized: RuntimeDescriptor = {
      protocol: NOXSCOPE_PROTOCOL,
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      adapter: { id: input.adapter.id, version: input.adapter.version },
      runtime: {
        surface: runtime.surface,
        ...(runtime.name === undefined ? {} : { name: runtime.name }),
        identifiers,
        versions,
      },
      capabilities,
    };
    return validateRuntimeDescriptor(sanitized).ok ? sanitized : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeSnapshot(input: Snapshot): Snapshot | undefined {
  try {
    const freshness = {
      state: input.freshness.state,
      observedAt: input.freshness.observedAt,
      receivedAt: input.freshness.receivedAt,
      consecutiveFailures: input.freshness.consecutiveFailures,
      ...(input.freshness.pollingIntervalMs === undefined
        ? {}
        : { pollingIntervalMs: input.freshness.pollingIntervalMs }),
      ...(input.freshness.lastSuccessAt === undefined
        ? {}
        : { lastSuccessAt: input.freshness.lastSuccessAt }),
      source: input.freshness.source,
    };
    const safe: Snapshot = {
      revision: input.revision,
      freshness,
      ...(input.lifecycle === undefined ? {} : { lifecycle: { state: input.lifecycle.state } }),
      ...(input.network === undefined ? {} : { network: { id: input.network.id } }),
      ...(input.sync === undefined
        ? {}
        : {
            sync: {
              state: input.sync.state,
              ...(input.sync.percentage === undefined ? {} : { percentage: input.sync.percentage }),
              ...(input.sync.etaSeconds === undefined ? {} : { etaSeconds: input.sync.etaSeconds }),
              ...(input.sync.domains === undefined
                ? {}
                : {
                    domains: input.sync.domains.map((domain) => ({
                      domain: domain.domain,
                      state: domain.state,
                      ...(domain.percentage === undefined ? {} : { percentage: domain.percentage }),
                    })),
                  }),
            },
          }),
    };
    return safe;
  } catch {
    return undefined;
  }
}

function cloneSnapshot(input: unknown): Snapshot | undefined {
  try {
    if (!isSnapshotShape(input)) return undefined;
    const revision = safeString(safeRead(input, "revision"));
    const freshness = safeRead(input, "freshness");
    const state = safeRead(freshness, "state");
    const observedAt = safeString(safeRead(freshness, "observedAt"));
    const receivedAt = safeString(safeRead(freshness, "receivedAt"));
    const source = safeRead(freshness, "source");
    const consecutiveFailures = safeRead(freshness, "consecutiveFailures");
    if (
      revision === undefined ||
      !isObject(freshness) ||
      !["fresh", "stale", "unknown"].includes(state as string) ||
      observedAt === undefined ||
      receivedAt === undefined ||
      (source !== "runtime" && source !== "adapter") ||
      typeof consecutiveFailures !== "number" ||
      !Number.isInteger(consecutiveFailures) ||
      consecutiveFailures < 0
    )
      return undefined;
    type MutableSnapshot = { -readonly [Key in keyof Snapshot]: Snapshot[Key] };
    const safe = {
      revision,
      freshness: {
        state: state as Snapshot["freshness"]["state"],
        observedAt,
        receivedAt,
        source,
        consecutiveFailures,
      },
    } as unknown as MutableSnapshot;
    const lifecycle = safeRead(input, "lifecycle");
    if (lifecycle !== undefined) {
      const lifecycleState = safeString(safeRead(lifecycle, "state"));
      if (
        lifecycleState === undefined ||
        !["starting", "ready", "locked", "stopping", "stopped", "unknown"].includes(lifecycleState)
      )
        return undefined;
      safe.lifecycle = { state: lifecycleState as NonNullable<Snapshot["lifecycle"]>["state"] };
    }
    const network = safeRead(input, "network");
    if (network !== undefined) {
      const id = safeString(safeRead(network, "id"));
      if (id === undefined) return undefined;
      safe.network = { id };
    }
    const identity = safeRead(input, "identity");
    if (identity !== undefined) {
      if (!isObject(identity)) return undefined;
      const walletName = safeString(safeRead(identity, "walletName"));
      const account = safeString(safeRead(identity, "account"));
      safe.identity = {
        ...(walletName === undefined ? {} : { walletName }),
        ...(account === undefined ? {} : { account }),
      };
    }
    const sync = safeRead(input, "sync");
    if (sync !== undefined) {
      const syncState = safeString(safeRead(sync, "state"));
      if (
        syncState === undefined ||
        !["idle", "syncing", "synced", "stalled", "unknown"].includes(syncState)
      )
        return undefined;
      safe.sync = { state: syncState as NonNullable<Snapshot["sync"]>["state"] };
    }
    const dust = safeRead(input, "dust");
    if (dust !== undefined) {
      const dustState = safeString(safeRead(dust, "state"));
      const progress = safeRead(dust, "progress");
      if (
        dustState === undefined ||
        !["unregistered", "registering", "registered", "unknown"].includes(dustState) ||
        (progress !== undefined &&
          (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0))
      )
        return undefined;
      safe.dust = {
        state: dustState as NonNullable<Snapshot["dust"]>["state"],
        ...(progress === undefined ? {} : { progress }),
      };
    }
    for (const key of ["balances", "addresses"] as const) {
      const entries = safeRead(input, key);
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.length > 4_096) return undefined;
      if (key === "balances") {
        const balances = entries.map((entry) => ({
          assetId: safeString(safeRead(entry, "assetId")),
          domain: safeString(safeRead(entry, "domain")),
          amount: safeString(safeRead(entry, "amount")),
        }));
        if (balances.some((entry) => Object.values(entry).some((item) => item === undefined)))
          return undefined;
        safe.balances = balances as NonNullable<Snapshot["balances"]>;
      } else {
        const addresses = entries.map((entry) => ({
          domain: safeString(safeRead(entry, "domain")),
          value: safeString(safeRead(entry, "value")),
          account: safeString(safeRead(entry, "account")),
        }));
        if (addresses.some((entry) => entry.domain === undefined || entry.value === undefined))
          return undefined;
        safe.addresses = addresses as NonNullable<Snapshot["addresses"]>;
      }
    }
    return safe;
  } catch {
    return undefined;
  }
}

function summarizeResult(result: Result<unknown>): NonNullable<ConformanceRunResult["result"]> {
  try {
    if (result.ok) return { ok: true, value: { kind: "bounded-result" } };
    return {
      ok: false,
      error: {
        code: result.error.code,
        message: "Result error was intentionally redacted",
        retryable: result.error.retryable,
      },
    };
  } catch {
    return {
      ok: false,
      error: { code: "protocol", message: "Result metadata was invalid", retryable: false },
    };
  }
}

async function collectRecords(
  session: RuntimeSession,
  signal: AbortSignal,
  timeoutMs: number,
  maxRecords: number,
): Promise<{
  readonly records: readonly NoxscopeRecord[];
  readonly timedOut: boolean;
  readonly iterator: AsyncIterator<NoxscopeRecord>;
}> {
  let iterator: AsyncIterator<NoxscopeRecord>;
  try {
    const createIterator = safeRead(session, Symbol.asyncIterator);
    if (typeof createIterator !== "function")
      throw new Error("Runtime Session iterator is missing");
    iterator = (createIterator as () => AsyncIterator<NoxscopeRecord>).call(session);
  } catch {
    iterator = { next: async () => ({ done: true, value: undefined }) };
  }
  const records: NoxscopeRecord[] = [];
  let timedOut = false;
  for (let index = 0; index < maxRecords; index += 1) {
    const next = await settle<IteratorResult<NoxscopeRecord>>(() => iterator.next(), timeoutMs);
    if (next.state === "timeout") {
      timedOut = true;
      break;
    }
    if (next.state === "error" || next.value.done) break;
    if (signal.aborted) break;
    if (next.value.value !== undefined) records.push(next.value.value);
  }
  return { records, timedOut, iterator };
}

async function reconnectCheck(
  adapter: AdapterConformanceOptions["adapter"],
  descriptor: RuntimeDescriptor,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const connected = await settle(() => adapter.connect({ signal: controller.signal }), timeoutMs);
  controller.abort();
  if (connected.state !== "value" || !isExactResult(connected.value) || !connected.value.ok)
    return false;
  const value = safeRead(connected.value, "value");
  if (!isObject(value)) return false;
  let checked: ReturnType<typeof validateRuntimeDescriptor>;
  try {
    checked = validateRuntimeDescriptor(safeRead(value, "descriptor"));
  } catch {
    return false;
  }
  return checked.ok && checked.value.sessionId !== descriptor.sessionId;
}

async function runUnsupportedRequest(
  session: RuntimeSession,
  descriptor: RuntimeDescriptor,
  timeoutMs: number,
  evidence: EvidenceKind,
): Promise<AssertionResult> {
  const unsupported = descriptor.capabilities.find(
    (capability) => capability.support.state === "unsupported" && capability.kind === "operation",
  );
  if (unsupported === undefined)
    return assertion(
      "A5.2",
      "skip",
      evidence,
      "No unsupported operation declaration was available",
    );
  const requestMethod = safeRead(session, "request");
  if (typeof requestMethod !== "function")
    return assertion("A5.2", "fail", evidence, "Runtime Session request method is missing");
  const request: InvokeRequest = {
    kind: "invoke",
    requestId: "noxscope-conformance-unsupported-1",
    operationId: "noxscope.conformance.unsupported.1",
    operation: { kind: "org.noxscope.conformance.unsupported", input: {} },
  };
  const outcome = await settle(
    () =>
      (requestMethod as (request: unknown, options?: unknown) => Promise<unknown>).call(
        session,
        request,
        {
          timeoutMs,
        },
      ),
    timeoutMs,
  );
  if (outcome.state !== "value" || !isExactResult(outcome.value))
    return assertion(
      "A5.2",
      "fail",
      evidence,
      "Unsupported operation returned a malformed or unbounded Result",
    );
  if (outcome.value.ok)
    return assertion("A5.2", "fail", evidence, "Unsupported operation was incorrectly accepted");
  const error = safeRead(outcome.value, "error");
  return assertion(
    "A5.2",
    isObject(error) && safeRead(error, "code") === "unsupported" ? "pass" : "fail",
    evidence,
    "Unsupported operation returns a typed unsupported Result",
  );
}

async function runAbortedRequest(
  session: RuntimeSession,
  timeoutMs: number,
  evidence: EvidenceKind,
): Promise<AssertionResult> {
  const requestMethod = safeRead(session, "request");
  if (typeof requestMethod !== "function")
    return assertion("A5.3", "fail", evidence, "Runtime Session request method is missing");
  const controller = new AbortController();
  controller.abort();
  const request: SnapshotRequest = {
    kind: "snapshot",
    requestId: "noxscope-conformance-aborted-1",
  };
  const outcome = await settle(
    () =>
      (requestMethod as (request: unknown, options?: unknown) => Promise<unknown>).call(
        session,
        request,
        {
          signal: controller.signal,
          timeoutMs,
        },
      ),
    timeoutMs,
  );
  if (outcome.state !== "value" || !isExactResult(outcome.value))
    return assertion(
      "A5.3",
      "fail",
      evidence,
      "Aborted request did not return a bounded typed Result",
    );
  if (outcome.value.ok)
    return assertion(
      "A5.3",
      "fail",
      evidence,
      "Aborted request was incorrectly reported as successful",
    );
  const error = safeRead(outcome.value, "error");
  return assertion(
    "A5.3",
    isObject(error) && safeRead(error, "code") === "cancelled" ? "pass" : "fail",
    evidence,
    "Aborted caller wait returns typed cancellation without claiming wallet work stopped",
  );
}

async function runAllowedOperation(
  session: RuntimeSession,
  options: AdapterConformanceOptions,
  signal: AbortSignal,
  timeoutMs: number,
  evidence: EvidenceKind,
): Promise<{ readonly assertion: AssertionResult; readonly result?: Result<unknown> }> {
  const configured = options.operations;
  if (configured === undefined || !configured.enabled) {
    return {
      assertion: assertion("A5.2", "skip", evidence, "Operation execution was not enabled"),
    };
  }
  const environment = options.environment ?? "fixture";
  if (
    (environment !== "localnet" && environment !== "preprod") ||
    configured.expectedNetwork !== environment
  ) {
    return {
      assertion: assertion(
        "A5.2",
        "fail",
        evidence,
        "Operation safety requires an exact localnet or Preprod network",
      ),
    };
  }
  const operation = configured.allowlist.find((item) => item === "wallet.sync");
  if (operation === undefined || (configured.maxOperations ?? 1) < 1) {
    return {
      assertion: assertion("A5.2", "skip", evidence, "No harmless operation is allowlisted"),
    };
  }
  const invoke: InvokeRequest = {
    kind: "invoke",
    requestId: "noxscope-conformance-operation-1",
    operationId: "noxscope.conformance.sync.1",
    operation: { kind: "wallet.sync", action: "start" },
  };
  const outcome = await settle(() => session.request(invoke, { signal, timeoutMs }), timeoutMs);
  if (outcome.state !== "value" || !isExactResult(outcome.value)) {
    return {
      assertion: assertion(
        "A5.2",
        "fail",
        evidence,
        "Allowlisted operation exceeded its bound or returned malformed data",
      ),
    };
  }
  const typed = outcome.value as Result<unknown>;
  return {
    assertion: assertion(
      "A5.2",
      typed.ok || typed.error.code === "unsupported" || typed.error.code === "unavailable"
        ? "pass"
        : "fail",
      evidence,
      typed.ok
        ? "Allowlisted operation completed with a typed terminal result"
        : `Operation returned typed ${typed.error.code}`,
    ),
    result: typed,
  };
}

function inspectRecords(
  records: readonly NoxscopeRecord[],
  descriptor: NonNullable<QualificationReport["descriptor"]>,
  evidence: EvidenceKind,
): { readonly assertions: readonly AssertionResult[] } {
  const assertions: AssertionResult[] = [];
  const lastByStream = new Map<string, bigint>();
  let valid = true;
  let gapValid = true;
  let sourceValid = true;
  if (records.length === 0) valid = false;
  for (const record of records) {
    let checked: ReturnType<typeof validateRecord>;
    try {
      checked = validateRecord(record);
    } catch {
      valid = false;
      continue;
    }
    if (!checked.ok) {
      valid = false;
      continue;
    }
    if (
      record.meta.protocol !== NOXSCOPE_PROTOCOL ||
      record.meta.runtimeId !== descriptor.runtimeId ||
      record.meta.sessionId !== descriptor.sessionId
    ) {
      valid = false;
    }
    if (record.kind === "diagnostic-event" && record.event.type === "diagnostic") {
      if (record.event.source !== "runtime" && record.event.source !== "adapter")
        sourceValid = false;
    }
    const sequence = BigInt(record.meta.sequence);
    const previous = lastByStream.get(record.meta.streamId);
    if (previous !== undefined && sequence <= previous) valid = false;
    lastByStream.set(record.meta.streamId, sequence);
    if (record.kind === "diagnostic-event" && record.event.type === "stream-gap") {
      if (BigInt(record.event.firstLostSequence) > BigInt(record.event.lastLostSequence))
        gapValid = false;
    }
  }
  assertions.push(
    assertion(
      "A3.1",
      valid ? "pass" : "fail",
      evidence,
      "Record identity and per-stream sequence ordering are valid",
    ),
  );
  assertions.push(
    assertion(
      "A3.4",
      gapValid ? "pass" : "fail",
      evidence,
      "Backpressure gaps are explicit and ordered",
    ),
  );
  assertions.push(
    assertion(
      "A3.5",
      sourceValid ? "pass" : "fail",
      evidence,
      "Runtime and Adapter records retain their declared source domains",
    ),
  );
  return { assertions };
}

function capabilityResult(
  capability: NonNullable<QualificationReport["descriptor"]>["capabilities"][number],
  snapshot: Snapshot | undefined,
  records: readonly NoxscopeRecord[],
  evidence: EvidenceKind,
): CapabilityResult {
  const assertions: AssertionResult[] = [];
  const support = capability.support.state;
  const availability = support === "unsupported" ? "not-tested" : capability.availability.state;
  assertions.push(
    assertion(
      `CAP.${capability.id}.support`,
      "pass",
      evidence,
      `${support} is explicitly evidenced`,
    ),
  );
  if (support === "supported" && capability.availability.state === "available") {
    const specific = capabilitySpecificCheck(capability.id, snapshot, records);
    assertions.push(
      assertion(`CAP.${capability.id}.suite`, specific.status, evidence, specific.summary),
    );
  } else {
    assertions.push(
      assertion(
        `CAP.${capability.id}.suite`,
        "skip",
        evidence,
        "Capability is unsupported or unavailable; no false execution was attempted",
      ),
    );
  }
  return { id: capability.id, support, availability, evidence, assertions };
}

function capabilitySpecificCheck(
  id: string,
  snapshot: Snapshot | undefined,
  records: readonly NoxscopeRecord[],
): { readonly status: "pass" | "fail"; readonly summary: string } {
  const normalized = id.toLowerCase();
  if (normalized.includes("sync"))
    return {
      status: snapshot?.sync === undefined ? "fail" : "pass",
      summary: "Sync capability has an observed canonical sync section",
    };
  if (normalized.includes("balance"))
    return {
      status: snapshot?.balances === undefined ? "fail" : "pass",
      summary: "Balance capability has an observed canonical balance section",
    };
  if (normalized.includes("address"))
    return {
      status: snapshot?.addresses === undefined ? "fail" : "pass",
      summary: "Address capability has an observed canonical address section",
    };
  if (normalized.includes("dust"))
    return {
      status: snapshot?.dust === undefined || snapshot.balances === undefined ? "fail" : "pass",
      summary: "DUST capability has an observed state and balance section",
    };
  if (normalized.includes("identity"))
    return {
      status: snapshot?.identity === undefined ? "fail" : "pass",
      summary: "Identity capability has an observed canonical identity section",
    };
  if (normalized.includes("event") || normalized.includes("diagnostic"))
    return {
      status: records.some((record) => record.kind === "diagnostic-event") ? "pass" : "fail",
      summary: "Event capability has an observed diagnostic record",
    };
  if (normalized.includes("operation"))
    return {
      status: records.some((record) => record.kind === "operation") ? "pass" : "fail",
      summary: "Operation capability has an observed operation record",
    };
  return {
    status: "fail",
    summary: "No registered capability-specific suite exists for this declaration",
  };
}

function operationCorrelationValid(records: readonly NoxscopeRecord[]): boolean {
  const terminals = new Set<string>();
  for (const record of records) {
    if (record.kind !== "operation") continue;
    const operationId = record.meta.correlation?.operationId;
    if (operationId === undefined) return false;
    if (
      record.operation.state !== "succeeded" &&
      record.operation.state !== "failed" &&
      record.operation.state !== "cancelled"
    )
      continue;
    if (terminals.has(operationId)) return false;
    terminals.add(operationId);
  }
  return true;
}

function freshnessValid(snapshot: Snapshot): boolean {
  return (
    snapshot.freshness.observedAt.length > 0 &&
    snapshot.freshness.receivedAt.length > 0 &&
    snapshot.freshness.consecutiveFailures >= 0
  );
}

function versionFactsValid(descriptor: NonNullable<QualificationReport["descriptor"]>): boolean {
  const subjects = new Set<string>();
  return descriptor.runtime.versions.every((fact) => {
    if (subjects.has(fact.subject) || fact.subject.length === 0 || fact.version.length === 0)
      return false;
    subjects.add(fact.subject);
    return true;
  });
}

function capabilitiesValid(descriptor: NonNullable<QualificationReport["descriptor"]>): boolean {
  return descriptor.capabilities.every(
    (capability) => capability.id.length > 0 && capability.support.evidence.summary.length > 0,
  );
}

function containsSecretField(value: unknown): boolean {
  const forbidden =
    /(?:seed|mnemonic|private.?key|signing.?key|passphrase|password|authorization|access.?token|witness|proof|signature|raw.?transaction|checkpoint|vault|credential)/iu;
  const visit = (candidate: unknown, depth = 0): boolean => {
    if (depth > 16) return true;
    if (Array.isArray(candidate)) {
      try {
        return candidate.slice(0, 4_096).some((item) => visit(item, depth + 1));
      } catch {
        return true;
      }
    }
    if (!isObject(candidate)) return false;
    let keys: string[];
    try {
      keys = Object.getOwnPropertyNames(candidate).slice(0, 4_096);
    } catch {
      return true;
    }
    for (const key of keys) {
      if (forbidden.test(key)) return true;
      const nested = safeRead(candidate, key);
      if (typeof nested === "string" && forbidden.test(nested) && nested.length < 256) return true;
      if (visit(nested, depth + 1)) return true;
    }
    return false;
  };
  return visit(value);
}

function safeJson(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : encoded;
  } catch {
    return undefined;
  }
}

function safetyFor(options: AdapterConformanceOptions): SafetyControls {
  const enabled = options.operations?.enabled === true;
  return {
    isolatedProfile: true,
    noMainnetMutation: true,
    ...(options.operations?.expectedNetwork === undefined
      ? {}
      : { expectedNetwork: options.operations.expectedNetwork }),
    operationAllowlist: enabled ? ["wallet.sync"] : [],
    maxOperations: enabled ? 1 : 0,
    redactionRequired: true,
  };
}

export function deriveAdmission(
  kind: "adapter" | "connector",
  evidence: EvidenceKind,
  assertions: readonly AssertionResult[],
): AdmissionState {
  if (evidence === "fixture") return "fixture";
  if (assertions.some((item) => item.status === "fail")) return "quarantined";
  const mandatory =
    kind === "adapter"
      ? [
          "P1.1",
          "A1.1",
          "A1.2",
          "A1.3",
          "A1.4",
          "A2.1",
          "A2.2",
          "A2.3",
          "A3.1",
          "A3.4",
          "A3.5",
          "A3.6",
          "A4.1",
          "A4.2",
          "A4.3",
          "A5.1",
          "A5.2",
          "A5.3",
          "A6.1",
          "A6.2",
          "A6.3",
          "A6.5",
        ]
      : ["P1.1", "D1.1", "D1.2", "D1.3", "D1.4", "D2.1", "D2.2", "D3.1"];
  if (mandatory.some((id) => assertions.find((item) => item.id === id)?.status !== "pass"))
    return "blocked";
  return kind === "adapter" ? "full" : "connector";
}

function assertion(
  id: string,
  status: AssertionResult["status"],
  evidence: EvidenceKind,
  summary: string,
  details?: readonly string[],
): AssertionResult {
  return {
    id,
    status,
    required: status !== "skip",
    evidence,
    summary,
    ...(details === undefined ? {} : { details }),
  };
}

function clampTimeout(value: number): number {
  return Number.isFinite(value)
    ? Math.max(10, Math.min(30_000, Math.floor(value)))
    : DEFAULT_TIMEOUT_MS;
}

function clampRecords(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(4_096, Math.floor(value)))
    : DEFAULT_MAX_RECORDS;
}

function safeTimestamp(now: () => string): string {
  try {
    const value = now();
    return typeof value === "string" && !Number.isNaN(Date.parse(value))
      ? value
      : new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

type Settled<T> =
  | { readonly state: "value"; readonly value: T }
  | { readonly state: "timeout" }
  | { readonly state: "error"; readonly error: unknown };

async function settle<T>(task: () => Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<Settled<T>>((resolve) => {
      timer = setTimeout(() => resolve({ state: "timeout" }), timeoutMs);
    });
    const value = task();
    return await Promise.race([
      value.then(
        (result) => ({ state: "value", value: result }) as const,
        (error) => ({ state: "error", error }) as const,
      ),
      timeout,
    ]);
  } catch (error) {
    return { state: "error", error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isExactResult(value: unknown): value is Result<unknown> {
  if (!isObject(value)) return false;
  const ok = safeRead(value, "ok");
  if (ok === true) return hasExactKeys(value, ["ok", "value"]);
  if (ok !== false || !hasExactKeys(value, ["ok", "error"])) return false;
  const error = safeRead(value, "error");
  if (!isObject(error)) return false;
  const allowed = ["code", "message", "retryable", "retryAfterMs", "capability", "raw"] as const;
  if (!hasAllowedKeys(error, ["code", "message", "retryable"], allowed)) return false;
  const code = safeRead(error, "code");
  const message = safeRead(error, "message");
  const retryable = safeRead(error, "retryable");
  if (
    typeof code !== "string" ||
    !RESULT_ERROR_CODES.has(code) ||
    safeString(message) === undefined ||
    typeof retryable !== "boolean"
  )
    return false;
  const retryAfterMs = safeRead(error, "retryAfterMs");
  if (
    retryAfterMs !== undefined &&
    (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0)
  )
    return false;
  const capability = safeRead(error, "capability");
  if (capability !== undefined && safeString(capability) === undefined) return false;
  const raw = safeRead(error, "raw");
  return raw === undefined || (Array.isArray(raw) && raw.length <= 64);
}

function isSnapshotShape(value: unknown): value is Snapshot {
  if (!isObject(value)) return false;
  const revision = safeRead(value, "revision");
  const freshness = safeRead(value, "freshness");
  if (typeof revision !== "string" || !isObject(freshness)) return false;
  const state = safeRead(freshness, "state");
  const observedAt = safeRead(freshness, "observedAt");
  const receivedAt = safeRead(freshness, "receivedAt");
  const failures = safeRead(freshness, "consecutiveFailures");
  return (
    ["fresh", "stale", "unknown"].includes(state as string) &&
    typeof observedAt === "string" &&
    typeof receivedAt === "string" &&
    typeof failures === "number" &&
    Number.isInteger(failures) &&
    failures >= 0
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    return (
      keys.length === expected.length &&
      expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
  } catch {
    return false;
  }
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
): boolean {
  try {
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    return (
      keys.length <= allowed.length &&
      keys.every((key) => allowed.includes(key)) &&
      required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
  } catch {
    return false;
  }
}

function safeRead(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) return undefined;
  try {
    return (value as Record<PropertyKey, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return new TextEncoder().encode(value).byteLength <= 16 * 1024 ? value : undefined;
  } catch {
    return undefined;
  }
}
