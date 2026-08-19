import { createSanitizer, type AdapterSanitizationManifest } from "@noxscope/core";
import { deriveAdmission } from "./adapter-suite.js";
import {
  CONFORMANCE_SUITE_VERSION,
  type AssertionResult,
  type ConnectorEvidence,
  type ConnectorQualificationOptions,
  type ConnectorProvider,
  type ConnectorSelection,
  type CapabilityResult,
  type DiscoveredProvider,
  type DiscoveryLifecycleResult,
  type DiscoveryResult,
  type EvidenceKind,
  type QualificationReport,
} from "./types.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9a-z.-]+)?$/iu;
const RDNS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/iu;
const DEFAULT_TIMEOUT_MS = 2_000;
const CONNECTOR_POLICY = "noxscope.conformance.connector-evidence";

const CONNECTOR_MANIFEST: AdapterSanitizationManifest = {
  adapter: {
    id: "org.noxscope.conformance",
    version: "1",
    sourceVersions: [CONFORMANCE_SUITE_VERSION],
  },
  policy: { id: CONNECTOR_POLICY, version: "1", digest: "connector-evidence-v1" },
  projections: [
    { source: "target.id", target: "target.id", classification: "S0", transform: "copy" },
    { source: "target.name", target: "target.name", classification: "S0", transform: "copy" },
    { source: "environment", target: "environment", classification: "S0", transform: "copy" },
    { source: "evidence", target: "evidence", classification: "S0", transform: "copy" },
  ],
};

/** Discover every provider in the standard UUID-keyed Midnight map. */
export function discoverMidnightProviders(source: unknown): DiscoveryResult {
  const map = unwrapMidnightMap(source);
  if (!isObject(map))
    return { providers: [], issues: ["window.midnight is absent or not an object"] };
  const providers: DiscoveredProvider[] = [];
  const issues: string[] = [];
  const byRdns = new Map<string, string[]>();
  for (const key of ownStringKeys(map)) {
    let value: unknown;
    try {
      value = map[key];
    } catch {
      providers.push({ discoveryKey: key, valid: false, issues: ["provider getter threw"] });
      issues.push(`${key}: provider getter threw`);
      continue;
    }
    const checked = validateProvider(key, value);
    providers.push(checked);
    if (checked.provider !== undefined) {
      const keys = byRdns.get(checked.provider.rdns) ?? [];
      keys.push(key);
      byRdns.set(checked.provider.rdns, keys);
    }
    issues.push(...checked.issues.map((issue) => `${key}: ${issue}`));
  }
  for (const [rdns, keys] of byRdns) {
    if (keys.length > 1) issues.push(`duplicate provider rdns ${rdns}: ${keys.join(",")}`);
  }
  return { providers, issues };
}

/** Select an exact connector major; ambiguity is never resolved by a wallet name. */
export function selectMidnightProvider(
  discovery: DiscoveryResult,
  requestedApiMajor?: number,
): ConnectorSelection {
  const valid = discovery.providers.filter(
    (provider) => provider.valid && provider.provider !== undefined,
  );
  const issues = [...discovery.issues];
  if (valid.length === 0)
    return { issues: [...issues, "no valid Midnight connector provider was discovered"] };
  const majors = new Set(valid.map((provider) => apiMajor(provider.provider?.apiVersion ?? "")));
  if (requestedApiMajor !== undefined) {
    const selected = valid
      .filter((provider) => apiMajor(provider.provider?.apiVersion ?? "") === requestedApiMajor)
      .sort((left, right) => left.discoveryKey.localeCompare(right.discoveryKey))[0];
    if (selected === undefined)
      return { issues: [...issues, `no provider advertises API major ${requestedApiMajor}`] };
    return { selected, issues };
  }
  if (majors.size > 1) issues.push("multiple connector API majors require explicit selection");
  const selected = valid
    .sort((left, right) => left.discoveryKey.localeCompare(right.discoveryKey))
    .sort(
      (left, right) =>
        apiMajor(right.provider?.apiVersion ?? "") - apiMajor(left.provider?.apiVersion ?? ""),
    )[0];
  return selected === undefined ? { issues } : { selected, issues };
}

/**
 * Poll a provider map through a bounded observation window. This catches
 * asynchronous extension injection and removal without assuming that a
 * provider has a friendly global property or that UUIDs are persistent.
 */
export async function observeMidnightDiscovery(
  read: () => unknown | Promise<unknown>,
  options: {
    readonly signal?: AbortSignal;
    readonly intervalMs?: number;
    readonly maxSamples?: number;
    readonly maxEvents?: number;
    readonly now?: () => string;
  } = {},
): Promise<DiscoveryLifecycleResult> {
  const intervalMs = clamp(options.intervalMs ?? 25, 1, 1_000);
  const maxSamples = clamp(options.maxSamples ?? 8, 1, 128);
  const maxEvents = clamp(options.maxEvents ?? 64, 1, 1_024);
  const now = options.now ?? (() => new Date().toISOString());
  const known = new Set<string>();
  const events: import("./types.js").DiscoveryLifecycleEvent[] = [];
  let samples = 0;
  let timedOut = false;
  while (samples < maxSamples && !options.signal?.aborted && events.length < maxEvents) {
    const readResult = await bounded(read, DEFAULT_TIMEOUT_MS);
    const value = readResult.state === "value" ? readResult.value : undefined;
    const current = new Set(
      discoverMidnightProviders(value)
        .providers.filter((provider) => provider.valid)
        .map((provider) => provider.discoveryKey),
    );
    for (const key of current) {
      if (!known.has(key) && events.length < maxEvents)
        events.push({ type: "added", discoveryKey: key, at: safeTimestamp(now) });
    }
    for (const key of known) {
      if (!current.has(key) && events.length < maxEvents)
        events.push({ type: "removed", discoveryKey: key, at: safeTimestamp(now) });
    }
    known.clear();
    for (const key of current) known.add(key);
    samples += 1;
    if (samples < maxSamples && events.length < maxEvents) await delay(intervalMs, options.signal);
  }
  timedOut = !options.signal?.aborted && samples >= maxSamples;
  return { events, samples, timedOut };
}

/** Run discovery, negotiation, public read checks, and opt-in safe operation checks. */
export async function runConnectorQualification(
  options: ConnectorQualificationOptions,
): Promise<QualificationReport> {
  const evidence = options.evidence ?? "fixture";
  const environment = options.environment ?? "fixture";
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10, 30_000);
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = safeTimestamp(now);
  const assertions: AssertionResult[] = [];
  const connectorCapabilities: CapabilityResult[] = [];
  let redactionCount = 0;
  const source = await readSource(options.source);
  const discovery = discoverMidnightProviders(source);
  const valid = discovery.providers.filter((provider) => provider.valid);
  assertions.push(
    assertion(
      "D1.1",
      valid.length > 0 ? "pass" : "fail",
      evidence,
      "All own UUID-keyed Midnight providers were enumerated",
    ),
  );
  assertions.push(
    assertion(
      "D1.2",
      valid.every((provider) => provider.provider !== undefined) ? "pass" : "fail",
      evidence,
      "Provider identity requires rdns, name, icon, API version, and connect",
    ),
  );
  const duplicate = discovery.issues.some((issue) => issue.startsWith("duplicate provider rdns"));
  assertions.push(
    assertion(
      "D1.3",
      duplicate ? "fail" : "pass",
      evidence,
      duplicate
        ? "Duplicate stable rdns values were isolated and require qualification review"
        : "Provider stable identity is collision-free",
    ),
  );
  const selection = selectMidnightProvider(discovery, options.requestedApiMajor);
  assertions.push(
    assertion(
      "D1.4",
      selection.selected !== undefined &&
        !(
          options.requestedApiMajor === undefined &&
          selection.issues.some((issue) => issue.includes("multiple connector API majors"))
        )
        ? "pass"
        : "fail",
      evidence,
      selection.selected === undefined
        ? "No API-compatible provider could be selected"
        : "Connector API major selection is explicit and deterministic",
    ),
  );

  let connector: ConnectorEvidence | undefined;
  if (selection.selected !== undefined && selection.selected.provider !== undefined) {
    const provider = selection.selected.provider;
    const connected = await bounded(() => provider.connect(options.requestedNetwork), timeoutMs);
    if (connected.state === "value" && isObject(connected.value)) {
      const connectedRecord = connected.value;
      const connectedNetwork =
        stringAt(connectedRecord, "network") ?? stringAt(connectedRecord, "networkId");
      connector = {
        discoveryKey: selection.selected.discoveryKey,
        rdns: provider.rdns,
        name: provider.name,
        iconOrigin: iconOrigin(provider.icon),
        apiVersion: provider.apiVersion,
        requestedNetwork: options.requestedNetwork,
        ...(connectedNetwork === undefined ? {} : { connectedNetwork }),
        methods: methodNames(connectedRecord),
      };
      assertions.push(
        assertion(
          "D2.1",
          connectedNetwork === undefined || connectedNetwork === options.requestedNetwork
            ? "pass"
            : "fail",
          evidence,
          connectedNetwork === undefined
            ? "Provider did not expose a connected network value"
            : "Connected network matches the requested network",
        ),
      );
      assertions.push(
        assertion(
          "D2.2",
          "pass",
          evidence,
          "Authorization/connect returned an object within the bound",
        ),
      );
      const readResult = await runPublicReads(connectedRecord, timeoutMs, evidence);
      assertions.push(...readResult.assertions);
      connectorCapabilities.push(...readResult.capabilities);
      redactionCount += readResult.redactions;
      if (options.operations?.enabled) {
        const operation = await runConnectorOperation(
          connectedRecord,
          options,
          environment,
          timeoutMs,
          evidence,
        );
        assertions.push(operation.assertion);
        redactionCount += operation.redactions;
      } else {
        assertions.push(
          assertion("D3.4", "skip", evidence, "Connector mutation flow was not enabled"),
        );
      }
    } else {
      assertions.push(
        assertion(
          "D2.1",
          "fail",
          evidence,
          connected.state === "timeout"
            ? "Provider connect exceeded its bound"
            : "Provider connect did not return a connected object",
        ),
      );
      assertions.push(
        assertion(
          "D2.2",
          "fail",
          evidence,
          "Authorization/connect did not produce a usable session",
        ),
      );
      assertions.push(
        assertion(
          "D3.1",
          "skip",
          evidence,
          "Public reads require an authorized connected provider",
        ),
      );
    }
  } else {
    assertions.push(
      assertion(
        "D2.1",
        "skip",
        evidence,
        "No valid provider was available for network negotiation",
      ),
    );
    assertions.push(
      assertion("D2.2", "skip", evidence, "No valid provider was available for authorization"),
    );
  }

  if (options.observe !== undefined) {
    const lifecycle = await observeMidnightDiscovery(options.observe.read, {
      ...(options.observe.intervalMs === undefined
        ? {}
        : { intervalMs: options.observe.intervalMs }),
      ...(options.observe.maxSamples === undefined
        ? {}
        : { maxSamples: options.observe.maxSamples }),
      ...(options.observe.maxEvents === undefined ? {} : { maxEvents: options.observe.maxEvents }),
      now,
    });
    assertions.push(
      assertion(
        "D1.5",
        lifecycle.events.some((event) => event.type === "added") ? "pass" : "fail",
        evidence,
        "Asynchronous provider injection is observable without a friendly global name",
      ),
    );
    assertions.push(
      assertion(
        "D2.3",
        lifecycle.events.some((event) => event.type === "removed") ? "pass" : "skip",
        evidence,
        lifecycle.events.some((event) => event.type === "removed")
          ? "Provider removal is observable"
          : "Provider removal was not exercised",
      ),
    );
  } else {
    assertions.push(
      assertion(
        "D1.5",
        "skip",
        evidence,
        "Asynchronous injection/removal observation was not configured",
      ),
    );
    assertions.push(
      assertion("D2.3", "skip", evidence, "Provider removal observation was not configured"),
    );
  }

  const report: QualificationReport = {
    schemaVersion: "noxscope.qualification/1",
    kind: "connector",
    suite: { id: CONFORMANCE_SUITE_VERSION, version: "1.0.0" },
    target: options.target,
    evidence,
    evidenceSource: evidenceSourceFor(evidence, environment),
    environment,
    startedAt,
    endedAt: safeTimestamp(now),
    ...(connector === undefined ? {} : { connector }),
    assertions,
    capabilities: connectorCapabilities,
    admission: deriveAdmission("connector", evidence, assertions),
    safety: {
      isolatedProfile: true,
      noMainnetMutation: true,
      ...(options.operations?.expectedNetwork === undefined
        ? {}
        : { expectedNetwork: options.operations.expectedNetwork }),
      operationAllowlist: options.operations?.enabled ? ["connector.harmless-operation"] : [],
      maxOperations: options.operations?.maxOperations ?? 0,
      redactionRequired: true,
    },
    redactions: { count: redactionCount, policy: CONNECTOR_POLICY },
  };
  return report;
}

function evidenceSourceFor(
  evidence: EvidenceKind,
  environment: QualificationReport["environment"],
): "fixture-corpus" | "installed-runtime" | "localnet-harness" | "preprod-harness" {
  if (evidence === "fixture") return "fixture-corpus";
  if (environment === "localnet") return "localnet-harness";
  if (environment === "preprod") return "preprod-harness";
  return "installed-runtime";
}

async function runPublicReads(
  connected: Record<string, unknown>,
  timeoutMs: number,
  evidence: EvidenceKind,
): Promise<{
  readonly assertions: readonly AssertionResult[];
  readonly redactions: number;
  readonly capabilities: readonly CapabilityResult[];
}> {
  const assertions: AssertionResult[] = [];
  const capabilities: CapabilityResult[] = [];
  let redactions = 0;
  const methods = [
    "getConfiguration",
    "getShieldedAddresses",
    "getUnshieldedAddresses",
    "getDustAddress",
    "getShieldedBalances",
    "getUnshieldedBalances",
    "getDustBalance",
    "getTransactionHistory",
  ];
  for (const method of methods) {
    const candidate = readProperty(connected, method);
    if (typeof candidate !== "function") {
      capabilities.push({
        id: `connector.${method}`,
        support: "unknown",
        availability: "not-tested",
        evidence,
        assertions: [
          assertion(
            `CAP.connector.${method}`,
            "skip",
            evidence,
            "Provider did not declare this public read method",
          ),
        ],
      });
      continue;
    }
    const called = await bounded(() => (candidate as () => Promise<unknown>)(), timeoutMs);
    if (called.state !== "value") {
      assertions.push(
        assertion(`D3.${method}`, "fail", evidence, `${method} exceeded its bounded read timeout`),
      );
      capabilities.push({
        id: `connector.${method}`,
        support: "supported",
        availability: "unavailable",
        evidence,
        assertions: [
          assertion(
            `CAP.connector.${method}`,
            "fail",
            evidence,
            `${method} was declared but unavailable within its bound`,
          ),
        ],
      });
      continue;
    }
    if (containsSecret(called.value)) {
      assertions.push(
        assertion(
          `D3.${method}`,
          "fail",
          evidence,
          `${method} returned secret or private execution material`,
        ),
      );
      capabilities.push({
        id: `connector.${method}`,
        support: "supported",
        availability: "available",
        evidence,
        assertions: [
          assertion(
            `CAP.connector.${method}`,
            "fail",
            evidence,
            `${method} returned unsafe material`,
          ),
        ],
      });
      continue;
    }
    const sanitized = await createSanitizer().sanitize(
      { result: called.value },
      CONNECTOR_MANIFEST,
    );
    if (!sanitized.ok) {
      assertions.push(
        assertion(`D3.${method}`, "fail", evidence, `${method} could not be centrally sanitized`),
      );
      capabilities.push({
        id: `connector.${method}`,
        support: "supported",
        availability: "available",
        evidence,
        assertions: [
          assertion(
            `CAP.connector.${method}`,
            "fail",
            evidence,
            `${method} failed central sanitization`,
          ),
        ],
      });
      continue;
    }
    redactions += sanitized.value.audit.redactions.length;
    assertions.push(
      assertion(
        `D3.${method}`,
        "pass",
        evidence,
        `${method} completed and only sanitized metadata was retained`,
      ),
    );
    capabilities.push({
      id: `connector.${method}`,
      support: "supported",
      availability: "available",
      evidence,
      assertions: [
        assertion(
          `CAP.connector.${method}`,
          "pass",
          evidence,
          `${method} completed through the public connector seam`,
        ),
      ],
    });
  }
  assertions.push(
    assertion(
      "D3.1",
      assertions.some((item) => item.status === "pass") ? "pass" : "skip",
      evidence,
      assertions.some((item) => item.status === "pass")
        ? "Advertised public read methods were exercised"
        : "No public read methods were declared by the connected provider",
    ),
  );
  return { assertions, redactions, capabilities };
}

async function runConnectorOperation(
  connected: Record<string, unknown>,
  options: ConnectorQualificationOptions,
  environment: QualificationReport["environment"],
  timeoutMs: number,
  evidence: EvidenceKind,
): Promise<{ readonly assertion: AssertionResult; readonly redactions: number }> {
  const configured = options.operations;
  if (configured === undefined || !configured.enabled)
    return {
      assertion: assertion("D3.4", "skip", evidence, "Connector operation was not enabled"),
      redactions: 0,
    };
  if (
    (environment !== "localnet" && environment !== "preprod") ||
    configured.expectedNetwork !== environment ||
    options.requestedNetwork !== configured.expectedNetwork
  ) {
    return {
      assertion: assertion(
        "D3.4",
        "fail",
        evidence,
        "Connector operation requires an exact localnet or Preprod network",
      ),
      redactions: 0,
    };
  }
  if (configured.run === undefined || (configured.maxOperations ?? 1) < 1) {
    return {
      assertion: assertion(
        "D3.4",
        "fail",
        evidence,
        "Connector operation was enabled without a bounded operation runner",
      ),
      redactions: 0,
    };
  }
  const outcome = await bounded(() => configured.run?.(connected), timeoutMs);
  if (outcome.state !== "value")
    return {
      assertion: assertion("D3.4", "fail", evidence, "Connector operation exceeded its timeout"),
      redactions: 0,
    };
  if (containsSecret(outcome.value))
    return {
      assertion: assertion(
        "D3.4",
        "fail",
        evidence,
        "Connector operation returned private transaction/proof material",
      ),
      redactions: 0,
    };
  const sanitized = await createSanitizer().sanitize(
    { operation: outcome.value },
    CONNECTOR_MANIFEST,
  );
  if (!sanitized.ok)
    return {
      assertion: assertion(
        "D3.4",
        "fail",
        evidence,
        "Connector operation evidence could not be centrally sanitized",
      ),
      redactions: 0,
    };
  return {
    assertion: assertion(
      "D3.4",
      "pass",
      evidence,
      "Bounded harmless connector operation completed with sanitized evidence",
    ),
    redactions: sanitized.value.audit.redactions.length,
  };
}

function validateProvider(discoveryKey: string, value: unknown): DiscoveredProvider {
  const issues: string[] = [];
  if (!UUID_V4.test(discoveryKey)) issues.push("discovery key is not a UUIDv4");
  if (!isObject(value))
    return { discoveryKey, valid: false, issues: [...issues, "provider is not an object"] };
  const rdns = stringAt(value, "rdns");
  const name = stringAt(value, "name");
  const icon = stringAt(value, "icon");
  const apiVersion = stringAt(value, "apiVersion");
  if (rdns === undefined || !RDNS.test(rdns)) issues.push("stable rdns is invalid");
  if (name === undefined || name.length === 0) issues.push("provider name is missing");
  if (icon === undefined || iconOrigin(icon) === "") issues.push("provider icon URL is invalid");
  if (apiVersion === undefined || !SEMVER.test(apiVersion)) issues.push("apiVersion is not semver");
  const connect = readProperty(value, "connect");
  if (typeof connect !== "function") issues.push("connect method is missing");
  if (
    issues.length > 0 ||
    rdns === undefined ||
    name === undefined ||
    icon === undefined ||
    apiVersion === undefined ||
    typeof connect !== "function"
  ) {
    return { discoveryKey, valid: false, issues };
  }
  const provider: ConnectorProvider = {
    rdns,
    name,
    icon,
    apiVersion,
    connect: (network: string) =>
      (connect as (network: string) => Promise<unknown>).call(value, network),
  };
  return { discoveryKey, provider, valid: true, issues: [] };
}

function unwrapMidnightMap(source: unknown): unknown {
  if (!isObject(source)) return source;
  if (Object.prototype.hasOwnProperty.call(source, "midnight")) {
    try {
      return source.midnight;
    } catch {
      return undefined;
    }
  }
  return source;
}

async function readSource(source: ConnectorQualificationOptions["source"]): Promise<unknown> {
  try {
    if (typeof source === "function") return await source();
    return source;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownStringKeys(value: Record<string, unknown>): string[] {
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    return [];
  }
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  try {
    const candidate = value[key];
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function iconOrigin(icon: string): string {
  try {
    const parsed = new URL(icon);
    return parsed.origin === "null" ? `${parsed.protocol}//` : parsed.origin;
  } catch {
    return "";
  }
}

function methodNames(value: Record<string, unknown>): string[] {
  return ownStringKeys(value)
    .filter((key) => typeof readProperty(value, key) === "function")
    .sort();
}

function readProperty(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function apiMajor(version: string): number {
  const match = SEMVER.exec(version);
  return match === null ? -1 : Number(match[1]);
}

function assertion(
  id: string,
  status: AssertionResult["status"],
  evidence: EvidenceKind,
  summary: string,
): AssertionResult {
  return { id, status, required: status !== "skip", evidence, summary };
}

function containsSecret(value: unknown): boolean {
  const forbidden =
    /(?:seed|mnemonic|private.?key|signing.?key|passphrase|password|authorization|access.?token|witness|proof|signature|raw.?transaction|checkpoint|vault|credential)/iu;
  if (Array.isArray(value)) return value.some(containsSecret);
  if (!isObject(value)) return false;
  return ownStringKeys(value).some((key) => {
    const nested = readProperty(value, key);
    return (
      forbidden.test(key) ||
      (typeof nested === "string" && forbidden.test(nested) && nested.length < 256) ||
      containsSecret(nested)
    );
  });
}

type Bounded<T> =
  | { readonly state: "value"; readonly value: T }
  | { readonly state: "timeout" }
  | { readonly state: "error"; readonly error: unknown };

async function bounded<T>(task: () => T | Promise<T>, timeoutMs: number): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const taskPromise = Promise.resolve().then(task);
    const timeout = new Promise<Bounded<T>>((resolve) => {
      timer = setTimeout(() => resolve({ state: "timeout" }), timeoutMs);
    });
    return await Promise.race([
      taskPromise.then(
        (value) => ({ state: "value", value }) as const,
        (error) => ({ state: "error", error }) as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : minimum;
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
