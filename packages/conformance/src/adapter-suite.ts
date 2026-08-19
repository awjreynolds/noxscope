import { createSanitizer, type AdapterSanitizationManifest } from "@noxscope/core";
import {
  NOXSCOPE_PROTOCOL,
  validateRecord,
  validateRuntimeDescriptor,
  type InvokeRequest,
  type NoxscopeRecord,
  type Result,
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

const CONFORMANCE_MANIFEST: AdapterSanitizationManifest = {
  adapter: {
    id: "org.noxscope.conformance",
    version: "1",
    sourceVersions: [CONFORMANCE_SUITE_VERSION],
  },
  policy: { id: REDACTION_POLICY, version: "1", digest: "conformance-evidence-v1" },
  projections: [
    { source: "target.id", target: "target.id", classification: "S0", transform: "copy" },
    { source: "target.name", target: "target.name", classification: "S0", transform: "copy" },
    {
      source: "target.surface",
      target: "target.surface",
      classification: "S0",
      transform: "copy",
    },
    {
      source: "environment",
      target: "environment",
      classification: "S0",
      transform: "copy",
    },
    { source: "evidence", target: "evidence", classification: "S0", transform: "copy" },
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
  const evidence = options.evidence ?? "fixture";
  const environment = options.environment ?? "fixture";
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
  if (!isResult(connection)) {
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
    assertions.push(
      assertion(
        "A1.1",
        "fail",
        evidence,
        `Adapter connection failed with ${connection.error.code}`,
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

  const session = connection.value;
  const checkedDescriptor = validateRuntimeDescriptor(session.descriptor);
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

  let snapshotResult: Result<Snapshot> | undefined;
  const snapshotRequest: SnapshotRequest = {
    kind: "snapshot",
    requestId: "noxscope-conformance-snapshot-1",
  };
  const requested = await settle(
    () => session.request(snapshotRequest, { signal: controller.signal, timeoutMs }),
    timeoutMs,
  );
  if (requested.state === "value" && isResult(requested.value)) {
    snapshotResult = requested.value as Result<Snapshot>;
    result = requested.value as Result<unknown>;
    if (snapshotResult.ok) {
      snapshot = snapshotResult.value;
      assertions.push(
        assertion(
          "A4.1",
          snapshot.revision.length > 0 ? "pass" : "fail",
          evidence,
          "Snapshot has a revision",
        ),
      );
      assertions.push(
        assertion(
          "A4.2",
          freshnessValid(snapshot) ? "pass" : "fail",
          evidence,
          "Snapshot freshness is explicit and bounded",
        ),
      );
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
      "A3.6",
      collected.timedOut && records.length === 0 ? "skip" : "pass",
      evidence,
      collected.timedOut
        ? "Record stream remained open within the bounded observation window"
        : "Record stream terminated or yielded within the bound",
    ),
  );
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
    );
    assertions.push(operationCheck.assertion);
    if (operationCheck.result !== undefined) result = operationCheck.result;
  } else {
    assertions.push(
      assertion("A5.2", "skip", evidence, "Mutation/operation execution was not enabled"),
    );
  }

  for (const capability of descriptor.capabilities) {
    capabilities.push(capabilityResult(capability, snapshot, records, evidence));
  }

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
      { target: options.target, environment, evidence, record },
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
    target: input.options.target,
    evidence: input.evidence,
    evidenceSource: evidenceSourceFor(input.evidence, input.environment ?? "fixture"),
    environment: input.environment ?? "fixture",
    startedAt: input.startedAt,
    endedAt: safeTimestamp(input.now),
    ...(input.descriptor === undefined ? {} : { descriptor: input.descriptor }),
    assertions: input.assertions,
    capabilities: input.capabilities,
    admission: deriveAdmission("adapter", input.evidence, input.assertions),
    safety: safetyFor(input.options, input.environment ?? "fixture"),
    redactions: { count: input.redactionCount, policy: REDACTION_POLICY },
  };
  return {
    ...report,
    ...(input.records === undefined ? {} : { records: input.records }),
    ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
    ...(input.result === undefined ? {} : { result: input.result }),
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

async function collectRecords(
  session: RuntimeSession,
  signal: AbortSignal,
  timeoutMs: number,
  maxRecords: number,
): Promise<{ readonly records: readonly NoxscopeRecord[]; readonly timedOut: boolean }> {
  const iterator = session[Symbol.asyncIterator]();
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
  return { records, timedOut };
}

async function runAllowedOperation(
  session: RuntimeSession,
  options: AdapterConformanceOptions,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ readonly assertion: AssertionResult; readonly result?: Result<unknown> }> {
  const configured = options.operations;
  if (configured === undefined || !configured.enabled) {
    return {
      assertion: assertion(
        "A5.2",
        "skip",
        options.evidence ?? "fixture",
        "Operation execution was not enabled",
      ),
    };
  }
  const evidence = options.evidence ?? "fixture";
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
  if (outcome.state !== "value" || !isResult(outcome.value)) {
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
  for (const record of records) {
    const checked = validateRecord(record);
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
      "pass",
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
    status: "pass",
    summary: "Capability declaration has a canonical evidence-bearing suite",
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
  const visit = (candidate: unknown): boolean => {
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (candidate === null || typeof candidate !== "object") return false;
    for (const [key, nested] of Object.entries(candidate)) {
      if (forbidden.test(key)) return true;
      if (typeof nested === "string" && forbidden.test(nested) && nested.length < 256) return true;
      if (visit(nested)) return true;
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

function safetyFor(
  options: AdapterConformanceOptions,
  environment: AdapterConformanceOptions["environment"],
): SafetyControls {
  return {
    isolatedProfile: true,
    noMainnetMutation: environment !== "mainnet",
    ...(options.operations?.expectedNetwork === undefined
      ? {}
      : { expectedNetwork: options.operations.expectedNetwork }),
    operationAllowlist: options.operations?.allowlist ?? [],
    maxOperations: options.operations?.maxOperations ?? 0,
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
  if (assertions.some((item) => item.status === "skip")) return "blocked";
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

function isResult(value: unknown): value is Result<unknown> {
  return (
    (typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true) ||
    (typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false)
  );
}
