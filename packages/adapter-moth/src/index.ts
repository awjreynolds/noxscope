import { createSanitizer, type AdapterSanitizationManifest } from "@noxscope/core";
import {
  NOXSCOPE_PROTOCOL,
  validateOperationInput,
  validateRecord,
  type Balance,
  type CapabilityDeclaration,
  type CancelRequest,
  type DiagnosticEventRecord,
  type InvokeRequest,
  type NoxscopeAdapter,
  type NoxscopeError,
  type NoxscopeRecord,
  type OperationTerminal,
  type RequestOptions,
  type Result,
  type RuntimeDescriptor,
  type RuntimeSession,
  type Snapshot,
  type SnapshotRequest,
} from "@noxscope/protocol";
import { createConnection, type Socket } from "node:net";

export const MOTH_DAEMON_PROTOCOL = "moth-wallet-daemon/1" as const;
export const MOTH_FRAME_LIMIT = 16 * 1024 * 1024;
export const MOTH_ADAPTER_ID = "dev.noxscope.adapter-moth" as const;
export const MOTH_ADAPTER_VERSION = "0.1.0" as const;
export const MOTH_SOURCE_COMMIT = "e9a974eb6aa49e4db66c8910328f2f787dde541b" as const;

export type MothEndpoint =
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number; readonly token: string };

export interface MothTransport {
  request(
    method: string,
    params?: unknown,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<Result<unknown>>;
  close(): Promise<void>;
}

export interface MothTransportFactory {
  connect(
    endpoint: MothEndpoint,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<Result<MothTransport>>;
}

export interface MothAdapterOptions {
  readonly endpoint: MothEndpoint;
  readonly transportFactory?: MothTransportFactory;
  readonly now?: () => string;
  readonly pseudonymKey?: Uint8Array;
  readonly pollingIntervalMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface MothVersionResult {
  readonly protocol: string;
  readonly daemon?: string;
}

export interface MothSyncProgress {
  readonly percentage: number;
  readonly etaSeconds: number | null;
  readonly shieldedSynced: boolean;
  readonly unshieldedSynced: boolean;
  readonly dustSynced: boolean;
  readonly slowest: "shielded" | "unshielded" | "dust" | null;
}

export interface MothBalances {
  readonly shielded: Readonly<Record<string, string>>;
  readonly unshielded: Readonly<Record<string, string>>;
  readonly dust: string;
}

export interface MothGetStateResult {
  readonly ready: boolean;
  readonly walletName?: string;
  readonly networkId?: string;
  readonly synced?: boolean;
  readonly syncProgress?: MothSyncProgress;
  readonly balances?: MothBalances;
}

export const MOTH_SANITIZATION_MANIFEST: AdapterSanitizationManifest = Object.freeze({
  adapter: {
    id: MOTH_ADAPTER_ID,
    version: MOTH_ADAPTER_VERSION,
    sourceVersions: [MOTH_SOURCE_COMMIT],
  },
  policy: { id: "noxscope.moth.s2", version: "1", digest: "moth-s2-v1" },
  projections: [
    {
      source: "value",
      target: "value",
      classification: "S2" as const,
      transform: "pseudonym" as const,
    },
  ],
});

const DEFAULT_POLLING_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_POLLING_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * Creates a read-only Adapter for the audited Moth daemon protocol. The only
 * daemon methods reached by this module are version and getState.
 */
export function createMothAdapter(options: MothAdapterOptions): NoxscopeAdapter {
  const resolved = resolveOptions(options);
  return {
    async connect(connectOptions) {
      if (connectOptions.signal.aborted) return cancelled("Moth connection was cancelled");
      const transportResult = await resolved.transportFactory.connect(resolved.endpoint, {
        signal: connectOptions.signal,
        timeoutMs: resolved.requestTimeoutMs,
      });
      if (!transportResult.ok) return transportResult;
      const transport = transportResult.value;
      const versionResult = await transport.request("version", undefined, {
        signal: connectOptions.signal,
        timeoutMs: resolved.requestTimeoutMs,
      });
      if (!versionResult.ok) {
        await closeQuietly(transport);
        return publicError(versionResult.error, "Moth version negotiation failed");
      }
      const version = parseVersion(versionResult.value);
      if (!version.ok) {
        await closeQuietly(transport);
        return version;
      }
      if (version.value.protocol !== MOTH_DAEMON_PROTOCOL) {
        await closeQuietly(transport);
        return {
          ok: false,
          error: {
            code: "incompatible",
            message: "Moth daemon protocol is not supported",
            retryable: false,
          },
        };
      }
      const stateResult = await transport.request("getState", undefined, {
        signal: connectOptions.signal,
        timeoutMs: resolved.requestTimeoutMs,
      });
      if (!stateResult.ok) {
        await closeQuietly(transport);
        return publicError(stateResult.error, "Moth state request failed");
      }
      const state = parseState(stateResult.value);
      if (!state.ok) {
        await closeQuietly(transport);
        return state;
      }
      const sessionId = makeId("moth-session");
      const runtimeId = makeRuntimeId(resolved.endpoint);
      const initial = await snapshotFromState(state.value, {
        ...resolved,
        ...(version.value.daemon === undefined ? {} : { daemonVersion: version.value.daemon }),
        sessionId,
        runtimeId,
        consecutiveFailures: 0,
        lastSuccessAt: resolved.now(),
        sequence: 1,
      });
      if (!initial.ok) {
        await closeQuietly(transport);
        return initial;
      }
      return {
        ok: true,
        value: new MothRuntimeSession({
          transport,
          descriptor: descriptorFor(
            resolved,
            version.value,
            initial.value.snapshot,
            sessionId,
            runtimeId,
          ),
          initial: initial.value.snapshotRecord,
          options: resolved,
          lifetimeSignal: connectOptions.signal,
        }),
      };
    },
  };
}

/** Encodes the Moth daemon's 4-byte big-endian length-prefixed JSON frame. */
export function encodeMothFrame(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Moth frame is not JSON-serializable");
  const payload = new TextEncoder().encode(json);
  if (payload.byteLength > MOTH_FRAME_LIMIT) throw new Error("Moth frame exceeds size limit");
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** Decodes exactly one complete Moth frame; trailing or incomplete bytes fail closed. */
export function decodeMothFrame(frame: Uint8Array): unknown {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 4) {
    throw new Error("Moth frame is truncated");
  }
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (length > MOTH_FRAME_LIMIT) throw new Error("Moth frame exceeds size limit");
  if (frame.byteLength < length + 4) throw new Error("Moth frame is truncated");
  if (frame.byteLength !== length + 4) throw new Error("Moth frame has trailing bytes");
  const json = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4));
  if (hasDuplicateJsonKeys(json)) throw new Error("Moth frame has duplicate JSON keys");
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error("Moth frame JSON is malformed");
  }
}

function hasDuplicateJsonKeys(json: string): boolean {
  let index = 0;
  let duplicate = false;
  const whitespace = () => {
    while (/\s/u.test(json[index] ?? "")) index += 1;
  };
  const string = (): string | undefined => {
    if (json[index] !== '"') return undefined;
    const start = index;
    index += 1;
    while (index < json.length) {
      const character = json[index++];
      if (character === "\\") {
        if (index >= json.length) return undefined;
        index += json[index] === "u" ? 5 : 1;
        continue;
      }
      if (character === '"') {
        try {
          return JSON.parse(json.slice(start, index)) as string;
        } catch {
          return undefined;
        }
      }
      if (character !== undefined && character < " ") return undefined;
    }
    return undefined;
  };
  const value = (): boolean => {
    whitespace();
    const character = json[index];
    if (character === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (json[index] === "}") {
        index += 1;
        return true;
      }
      while (index < json.length) {
        const key = string();
        if (key === undefined) return false;
        if (keys.has(key)) {
          duplicate = true;
          return false;
        }
        keys.add(key);
        whitespace();
        if (json[index++] !== ":") return false;
        if (!value()) return false;
        whitespace();
        if (json[index] === "}") {
          index += 1;
          return true;
        }
        if (json[index++] !== ",") return false;
        whitespace();
      }
      return false;
    }
    if (character === "[") {
      index += 1;
      whitespace();
      if (json[index] === "]") {
        index += 1;
        return true;
      }
      while (index < json.length) {
        if (!value()) return false;
        whitespace();
        if (json[index] === "]") {
          index += 1;
          return true;
        }
        if (json[index++] !== ",") return false;
        whitespace();
      }
      return false;
    }
    if (character === '"') return string() !== undefined;
    const literal = json
      .slice(index)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0];
    if (literal === undefined) return false;
    index += literal.length;
    return true;
  };
  if (!value()) return duplicate;
  whitespace();
  return duplicate;
}

/** Creates the production Node socket Adapter used by the Node Host. */
export function createMothNodeTransportFactory(): MothTransportFactory {
  return {
    async connect(endpoint, options = {}) {
      if (endpoint.kind === "tcp" && (!isLoopback(endpoint.host) || !validPort(endpoint.port))) {
        return {
          ok: false,
          error: {
            code: "invalid",
            message: "Moth TCP endpoints must be loopback and use a valid port",
            retryable: false,
          },
        };
      }
      if (endpoint.kind === "tcp" && endpoint.token.length === 0) {
        return {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Moth TCP authentication is required",
            retryable: false,
          },
        };
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_POLLING_INTERVAL_MS) {
        return {
          ok: false,
          error: {
            code: "invalid",
            message: "Moth connection timeout is invalid",
            retryable: false,
          },
        };
      }
      const socketResult = await openSocket(endpoint, options.signal, timeoutMs);
      if (!socketResult.ok) return socketResult;
      return { ok: true, value: new NodeMothTransport(socketResult.value, endpoint, timeoutMs) };
    },
  };
}

type ResolvedMothOptions = Required<
  Pick<MothAdapterOptions, "now" | "pollingIntervalMs" | "requestTimeoutMs">
> &
  Omit<
    MothAdapterOptions,
    "now" | "pollingIntervalMs" | "requestTimeoutMs" | "pseudonymKey" | "transportFactory"
  > & {
    readonly pseudonymKey: Uint8Array;
    readonly transportFactory: MothTransportFactory;
  };

function resolveOptions(options: MothAdapterOptions): ResolvedMothOptions {
  const pollingIntervalMs = options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isInteger(pollingIntervalMs) ||
    pollingIntervalMs < 50 ||
    pollingIntervalMs > MAX_POLLING_INTERVAL_MS
  ) {
    throw new Error("Moth pollingIntervalMs is outside the supported range");
  }
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > MAX_POLLING_INTERVAL_MS
  ) {
    throw new Error("Moth requestTimeoutMs is outside the supported range");
  }
  const key = options.pseudonymKey === undefined ? randomKey() : copyKey(options.pseudonymKey);
  return {
    ...options,
    now: options.now ?? (() => new Date().toISOString()),
    pollingIntervalMs,
    requestTimeoutMs,
    pseudonymKey: key,
    transportFactory: options.transportFactory ?? createMothNodeTransportFactory(),
  };
}

function copyKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 64) {
    throw new Error("Moth pseudonymKey must contain 32 to 64 bytes");
  }
  return Uint8Array.prototype.slice.call(value) as Uint8Array;
}

function randomKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

class MothRuntimeSession implements RuntimeSession {
  readonly descriptor: RuntimeDescriptor;
  readonly #transport: MothTransport;
  readonly #options: ResolvedMothOptions;
  readonly #queue = new RecordQueue();
  #latest: Snapshot;
  readonly #abort = new AbortController();
  readonly #sessionId: string;
  #consecutiveFailures = 0;
  #lastSuccessAt: string;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #polling = false;
  #recordSequence = 1;
  #diagnosticSequence = 0;

  constructor(args: {
    readonly transport: MothTransport;
    readonly descriptor: RuntimeDescriptor;
    readonly initial: NoxscopeRecord;
    readonly options: ReturnType<typeof resolveOptions>;
    readonly lifetimeSignal: AbortSignal;
  }) {
    this.#transport = args.transport;
    this.descriptor = args.descriptor;
    this.#options = args.options;
    this.#latest =
      args.initial.kind === "snapshot" ? args.initial.snapshot : emptySnapshot(args.options.now());
    this.#sessionId = args.descriptor.sessionId;
    this.#lastSuccessAt = this.#latest.freshness.lastSuccessAt ?? this.#latest.freshness.observedAt;
    this.#queue.push(args.initial);
    this.#startPolling();
    args.lifetimeSignal.addEventListener("abort", () => void this.close(), { once: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<NoxscopeRecord> {
    return this.#queue.iterator();
  }

  request(request: SnapshotRequest, options?: RequestOptions): Promise<Result<Snapshot>>;
  request(request: InvokeRequest, options?: RequestOptions): Promise<Result<OperationTerminal>>;
  request(
    request: CancelRequest,
    options?: RequestOptions,
  ): Promise<Result<{ readonly accepted: boolean }>>;
  async request(
    request: SnapshotRequest | InvokeRequest | CancelRequest,
    options?: RequestOptions,
  ): Promise<Result<Snapshot | OperationTerminal | { readonly accepted: boolean }>> {
    if (this.#abort.signal.aborted || options?.signal?.aborted)
      return cancelled("Moth request was cancelled");
    if (request.kind !== "snapshot") {
      if (request.kind === "invoke") validateOperationInput(request.operation);
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "The read-only Moth Adapter exposes no mutation Operations",
          retryable: false,
          capability: "operation.*",
        },
      };
    }
    const result = await this.#fetchSnapshot(options?.signal);
    return result.ok ? { ok: true, value: result.value } : result;
  }

  async close(): Promise<void> {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort();
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#queue.close();
    await closeQuietly(this.#transport);
  }

  async #fetchSnapshot(signal?: AbortSignal): Promise<Result<Snapshot>> {
    const requestOptions = {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.#options.requestTimeoutMs,
    };
    const result = await this.#transport.request("getState", undefined, requestOptions);
    if (!result.ok) {
      this.#consecutiveFailures += 1;
      return { ok: false, error: publicErrorValue(result.error, "Moth state request failed") };
    }
    const state = parseState(result.value);
    if (!state.ok) {
      this.#consecutiveFailures += 1;
      return { ok: false, error: state.error };
    }
    const mapped = await snapshotFromState(state.value, {
      ...this.#options,
      ...(this.descriptor.runtime.versions.find((fact) => fact.subject === "moth-daemon")
        ?.version === undefined
        ? {}
        : {
            daemonVersion: this.descriptor.runtime.versions.find(
              (fact) => fact.subject === "moth-daemon",
            )!.version,
          }),
      sessionId: this.#sessionId,
      runtimeId: this.descriptor.runtimeId,
      consecutiveFailures: 0,
      lastSuccessAt: this.#options.now(),
      sequence: this.#recordSequence + 1,
    });
    if (!mapped.ok) {
      this.#consecutiveFailures += 1;
      return { ok: false, error: mapped.error };
    }
    this.#consecutiveFailures = 0;
    this.#lastSuccessAt = this.#options.now();
    this.#recordSequence += 1;
    this.#latest = mapped.value.snapshot;
    this.#queue.push(mapped.value.snapshotRecord);
    return { ok: true, value: mapped.value.snapshot };
  }

  #startPolling(): void {
    if (this.#polling) return;
    this.#polling = true;
    const loop = async () => {
      if (this.#abort.signal.aborted) return;
      const result = await this.#fetchSnapshot(this.#abort.signal);
      if (!result.ok && !this.#abort.signal.aborted) {
        const receivedAt = this.#options.now();
        const stale = staleSnapshot(
          this.#latest,
          receivedAt,
          this.#consecutiveFailures,
          this.#lastSuccessAt,
        );
        this.#recordSequence += 1;
        this.#queue.push(snapshotRecord(this.descriptor, stale, receivedAt, this.#recordSequence));
        this.#diagnosticSequence += 1;
        this.#queue.push(
          diagnostic(this.descriptor, "moth.poll.failed", receivedAt, this.#diagnosticSequence),
        );
      }
      if (!this.#abort.signal.aborted)
        this.#pollTimer = setTimeout(() => void loop(), this.#options.pollingIntervalMs);
    };
    this.#pollTimer = setTimeout(() => void loop(), this.#options.pollingIntervalMs);
  }
}

function descriptorFor(
  options: ReturnType<typeof resolveOptions>,
  version: MothVersionResult,
  snapshot: Snapshot,
  sessionId: string,
  runtimeId: string,
): RuntimeDescriptor {
  const observedAt = snapshot.freshness.observedAt;
  const supported = ["sync.observe", "balances.read", "runtime.identity"];
  const unsupported = [
    ["addresses.read", "Moth getState does not expose addresses or public keys"],
    ["dust.details", "Moth getState exposes only aggregate DUST balance and sync progress"],
    ["transactions.read", "Moth daemon has no read-only transaction history method"],
    ["dependencies.observe", "Moth getState does not expose dependency health"],
    ["diagnostics.observe", "Moth daemon has no diagnostic event subscription"],
    ["operations.invoke", "The first Moth Adapter is read-only"],
  ] as const;
  return {
    protocol: NOXSCOPE_PROTOCOL,
    sessionId,
    runtimeId,
    adapter: { id: MOTH_ADAPTER_ID, version: MOTH_ADAPTER_VERSION },
    runtime: {
      surface: "daemon",
      ...(snapshot.identity?.walletName === undefined
        ? {}
        : { name: snapshot.identity.walletName }),
      identifiers: [
        { scheme: "moth-daemon", value: runtimeId, stability: "diagnostic-session" },
        ...(snapshot.network === undefined
          ? []
          : [{ scheme: "network", value: snapshot.network.id, stability: "reported" as const }]),
      ],
      versions: [
        { subject: "moth-protocol", version: MOTH_DAEMON_PROTOCOL },
        ...(version.daemon === undefined
          ? []
          : [{ subject: "moth-daemon", version: version.daemon }]),
      ],
    },
    capabilities: [
      ...supported.map((id) => capability(id, "snapshot", "supported", observedAt)),
      ...unsupported.map(([id, reason]) =>
        capability(
          id,
          id === "diagnostics.observe"
            ? "event"
            : id === "operations.invoke"
              ? "operation"
              : "snapshot",
          "unsupported",
          observedAt,
          reason,
        ),
      ),
    ],
  };
}

function capability(
  id: string,
  kind: CapabilityDeclaration["kind"],
  state: "supported" | "unsupported",
  observedAt: string,
  reason?: string,
): CapabilityDeclaration {
  return {
    id,
    kind,
    support:
      state === "supported"
        ? {
            state,
            version: "1",
            evidence: {
              source: "handshake",
              observedAt,
              summary: "Observed through Moth version/getState",
            },
          }
        : {
            state,
            reason: reason ?? "Not exposed by the audited Moth daemon contract",
            evidence: {
              source: "static-wire-contract",
              observedAt,
              summary: "Absent from Moth version/getState",
            },
          },
    availability: { state: "available" },
  };
}

async function snapshotFromState(
  state: MothGetStateResult,
  options: ReturnType<typeof resolveOptions> & {
    readonly daemonVersion?: string;
    readonly sessionId: string;
    readonly runtimeId: string;
    readonly consecutiveFailures: number;
    readonly lastSuccessAt: string;
    readonly sequence: number;
  },
): Promise<Result<{ readonly snapshot: Snapshot; readonly snapshotRecord: NoxscopeRecord }>> {
  const observedAt = options.now();
  const walletName =
    state.walletName === undefined
      ? undefined
      : await pseudonym(state.walletName, "walletName", options.pseudonymKey);
  if (walletName !== undefined && !walletName.ok) return { ok: false, error: walletName.error };
  const balances =
    state.balances === undefined
      ? undefined
      : await mapBalances(state.balances, options.pseudonymKey);
  if (balances !== undefined && !balances.ok) return { ok: false, error: balances.error };
  const sync =
    state.syncProgress === undefined && state.synced === undefined ? undefined : mapSync(state);
  const snapshot: Snapshot = {
    revision: `${options.sessionId}:${observedAt}`,
    freshness: {
      state: "fresh",
      observedAt,
      receivedAt: observedAt,
      source: "adapter",
      pollingIntervalMs: options.pollingIntervalMs,
      consecutiveFailures: options.consecutiveFailures,
      lastSuccessAt: options.lastSuccessAt,
    },
    lifecycle: { state: state.ready ? "ready" : "starting" },
    ...(walletName === undefined ? {} : { identity: { walletName: walletName.value } }),
    ...(state.networkId === undefined ? {} : { network: { id: state.networkId } }),
    ...(sync === undefined ? {} : { sync }),
    ...(balances === undefined ? {} : { balances: balances.value }),
  };
  const record = snapshotRecord(
    {
      protocol: NOXSCOPE_PROTOCOL,
      sessionId: options.sessionId,
      runtimeId: options.runtimeId,
    },
    snapshot,
    observedAt,
    options.sequence,
  );
  return { ok: true, value: { snapshot, snapshotRecord: record } };
}

function mapSync(state: MothGetStateResult): NonNullable<Snapshot["sync"]> {
  if (state.syncProgress === undefined) {
    return { state: state.synced === true ? "synced" : state.ready ? "unknown" : "idle" };
  }
  const progress = state.syncProgress;
  const allSynced = progress.shieldedSynced && progress.unshieldedSynced && progress.dustSynced;
  return {
    state: allSynced || state.synced === true ? "synced" : "syncing",
    percentage: progress.percentage,
    etaSeconds: progress.etaSeconds,
    domains: [
      {
        domain: "shielded",
        state: progress.shieldedSynced ? "synced" : "syncing",
        percentage: progress.percentage,
      },
      {
        domain: "unshielded",
        state: progress.unshieldedSynced ? "synced" : "syncing",
        percentage: progress.percentage,
      },
      {
        domain: "dust",
        state: progress.dustSynced ? "synced" : "syncing",
        percentage: progress.percentage,
      },
    ],
  };
}

async function mapBalances(
  balances: MothBalances,
  key: Uint8Array,
): Promise<Result<readonly Balance[]>> {
  const result: Balance[] = [];
  for (const domain of ["shielded", "unshielded"] as const) {
    const entries = Object.entries(balances[domain]).sort(([a], [b]) => a.localeCompare(b));
    for (const [assetId, amount] of entries) {
      const pseudonymized = await pseudonym(assetId, `balances.${domain}.assetId`, key);
      if (!pseudonymized.ok) return pseudonymized;
      result.push({ assetId: pseudonymized.value, domain, amount });
    }
  }
  result.push({ assetId: "DUST", domain: "dust", amount: balances.dust });
  return { ok: true, value: result };
}

async function pseudonym(value: string, target: string, key: Uint8Array): Promise<Result<string>> {
  const sanitizer = createSanitizer();
  const manifest = {
    ...MOTH_SANITIZATION_MANIFEST,
    projections: [{ ...MOTH_SANITIZATION_MANIFEST.projections[0]!, target }],
  } satisfies AdapterSanitizationManifest;
  const result = await sanitizer.sanitize({ value }, manifest, { pseudonymKey: key });
  if (!result.ok) return result;
  const projected = result.value.value;
  if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
    return {
      ok: false,
      error: { code: "invalid", message: "Moth S2 projection failed", retryable: false },
    };
  }
  let leaf: unknown = projected;
  for (const segment of target.split(".")) {
    if (typeof leaf !== "object" || leaf === null || Array.isArray(leaf) || !(segment in leaf)) {
      return {
        ok: false,
        error: { code: "invalid", message: "Moth S2 projection failed", retryable: false },
      };
    }
    leaf = leaf[segment as keyof typeof leaf];
  }
  return typeof leaf === "string"
    ? { ok: true, value: leaf }
    : {
        ok: false,
        error: { code: "invalid", message: "Moth S2 projection failed", retryable: false },
      };
}

function snapshotRecord(
  descriptor: Pick<RuntimeDescriptor, "protocol" | "sessionId" | "runtimeId">,
  snapshot: Snapshot,
  at: string,
  sequence = 1,
): NoxscopeRecord {
  return {
    kind: "snapshot",
    meta: {
      protocol: descriptor.protocol,
      sessionId: descriptor.sessionId,
      runtimeId: descriptor.runtimeId,
      streamId: `${descriptor.sessionId}-snapshots`,
      sequence: sequence.toString(),
      observedAt: snapshot.freshness.observedAt,
      receivedAt: at,
    },
    snapshot,
  };
}

function staleSnapshot(
  snapshot: Snapshot,
  receivedAt: string,
  failures: number,
  lastSuccessAt: string,
): Snapshot {
  return {
    ...snapshot,
    freshness: {
      ...snapshot.freshness,
      state: "stale",
      receivedAt,
      consecutiveFailures: failures,
      lastSuccessAt,
    },
  };
}

function emptySnapshot(at: string): Snapshot {
  return {
    revision: at,
    freshness: {
      state: "unknown",
      observedAt: at,
      receivedAt: at,
      source: "adapter",
      consecutiveFailures: 0,
    },
  };
}

function diagnostic(
  descriptor: RuntimeDescriptor,
  name: string,
  at: string,
  sequence: number,
): DiagnosticEventRecord {
  return {
    kind: "diagnostic-event",
    meta: {
      protocol: descriptor.protocol,
      sessionId: descriptor.sessionId,
      runtimeId: descriptor.runtimeId,
      streamId: `${descriptor.sessionId}-diagnostics`,
      sequence: sequence.toString(),
      observedAt: at,
      receivedAt: at,
    },
    event: {
      type: "diagnostic",
      name,
      category: "moth.polling",
      level: "warn",
      source: "adapter",
      message: "Moth getState polling failed; the last successful snapshot is retained",
    },
  };
}

function parseVersion(value: unknown): Result<MothVersionResult> {
  if (!isRecord(value) || typeof value.protocol !== "string") {
    return {
      ok: false,
      error: { code: "protocol", message: "Moth version response is malformed", retryable: false },
    };
  }
  if (value.daemon !== undefined && typeof value.daemon !== "string") {
    return {
      ok: false,
      error: { code: "protocol", message: "Moth daemon version is malformed", retryable: false },
    };
  }
  return {
    ok: true,
    value: {
      protocol: value.protocol,
      ...(value.daemon === undefined ? {} : { daemon: value.daemon }),
    },
  };
}

function parseState(value: unknown): Result<MothGetStateResult> {
  if (!isRecord(value) || typeof value.ready !== "boolean") return malformedState();
  if (value.walletName !== undefined && !safeLabel(value.walletName)) return malformedState();
  if (value.networkId !== undefined && !safeLabel(value.networkId)) return malformedState();
  if (value.synced !== undefined && typeof value.synced !== "boolean") return malformedState();
  let syncProgress: MothSyncProgress | undefined;
  if (value.syncProgress !== undefined) {
    if (
      !isRecord(value.syncProgress) ||
      !percentage(value.syncProgress.percentage) ||
      (value.syncProgress.etaSeconds !== null && !nonNegative(value.syncProgress.etaSeconds)) ||
      typeof value.syncProgress.shieldedSynced !== "boolean" ||
      typeof value.syncProgress.unshieldedSynced !== "boolean" ||
      typeof value.syncProgress.dustSynced !== "boolean" ||
      !["shielded", "unshielded", "dust", null].includes(value.syncProgress.slowest as never)
    )
      return malformedState();
    syncProgress = value.syncProgress as unknown as MothSyncProgress;
  }
  let balances: MothBalances | undefined;
  if (value.balances !== undefined) {
    if (
      !isRecord(value.balances) ||
      !isBalancesMap(value.balances.shielded) ||
      !isBalancesMap(value.balances.unshielded) ||
      !decimal(value.balances.dust)
    )
      return malformedState();
    balances = {
      shielded: value.balances.shielded as Record<string, string>,
      unshielded: value.balances.unshielded as Record<string, string>,
      dust: value.balances.dust,
    };
  }
  return {
    ok: true,
    value: {
      ready: value.ready,
      ...(value.walletName === undefined ? {} : { walletName: value.walletName }),
      ...(value.networkId === undefined ? {} : { networkId: value.networkId }),
      ...(value.synced === undefined ? {} : { synced: value.synced }),
      ...(syncProgress === undefined ? {} : { syncProgress }),
      ...(balances === undefined ? {} : { balances }),
    },
  };
}

function malformedState(): Result<never> {
  return {
    ok: false,
    error: { code: "protocol", message: "Moth getState response is malformed", retryable: false },
  };
}

function publicErrorValue(error: NoxscopeError, fallback: string): NoxscopeError {
  const code = [
    "unauthorized",
    "timeout",
    "unavailable",
    "incompatible",
    "protocol",
    "overflow",
  ].includes(error.code)
    ? error.code
    : "failed";
  return { code, message: fallback, retryable: code === "timeout" || code === "unavailable" };
}

function publicError(error: NoxscopeError, fallback: string): Result<never> {
  return { ok: false, error: publicErrorValue(error, fallback) };
}

function cancelled(message: string): Result<never> {
  return { ok: false, error: { code: "cancelled", message, retryable: false } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 16 * 1024 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
  );
}
function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value);
}
function isBalancesMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 4_096 &&
    Object.entries(value).every(([key, amount]) => safeLabel(key) && decimal(amount))
  );
}
function percentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
function makeRuntimeId(endpoint: MothEndpoint): string {
  return `moth-${endpoint.kind}-${endpoint.kind === "unix" ? "socket" : `${endpoint.host}:${endpoint.port}`}`;
}
function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}
async function closeQuietly(transport: MothTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    /* best effort */
  }
}

class RecordQueue {
  static readonly MAX_ITEMS = 1_024;
  static readonly MAX_WAITERS = 128;
  readonly #items: NoxscopeRecord[] = [];
  readonly #waiters: ((result: IteratorResult<NoxscopeRecord>) => void)[] = [];
  readonly #gaps = new Map<
    string,
    { readonly meta: NoxscopeRecord["meta"]; firstLostSequence: string; lastLostSequence: string }
  >();
  #gapSequence = 0;
  #closed = false;
  push(item: NoxscopeRecord): void {
    const checked = validateRecord(item);
    if (!checked.ok || this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: checked.value });
    else if (this.#items.length < RecordQueue.MAX_ITEMS) {
      this.#flushGaps();
      if (this.#items.length < RecordQueue.MAX_ITEMS) this.#items.push(checked.value);
      else this.#rememberGap(checked.value);
    } else this.#rememberGap(checked.value);
  }
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
    this.#items.length = 0;
    this.#gaps.clear();
  }
  iterator(): AsyncIterator<NoxscopeRecord> {
    let returned = false;
    return {
      next: async () => {
        if (returned) return { done: true, value: undefined };
        const item = this.#items.shift();
        if (item) return { done: false, value: item };
        if (this.#closed) {
          returned = true;
          return { done: true, value: undefined };
        }
        if (this.#waiters.length >= RecordQueue.MAX_WAITERS) {
          returned = true;
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<NoxscopeRecord>>((resolve) =>
          this.#waiters.push(resolve),
        );
      },
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    };
  }
  #rememberGap(record: NoxscopeRecord): void {
    const current = this.#gaps.get(record.meta.streamId);
    if (current === undefined) {
      if (this.#gaps.size >= 128) return;
      this.#gaps.set(record.meta.streamId, {
        meta: record.meta,
        firstLostSequence: record.meta.sequence,
        lastLostSequence: record.meta.sequence,
      });
      return;
    }
    if (BigInt(record.meta.sequence) > BigInt(current.lastLostSequence))
      current.lastLostSequence = record.meta.sequence;
  }
  #flushGaps(): void {
    for (const [streamId, gap] of this.#gaps) {
      if (this.#items.length >= RecordQueue.MAX_ITEMS) return;
      this.#items.push({
        kind: "diagnostic-event",
        meta: {
          protocol: gap.meta.protocol,
          sessionId: gap.meta.sessionId,
          runtimeId: gap.meta.runtimeId,
          streamId: `${gap.meta.sessionId}-diagnostics`,
          sequence: (++this.#gapSequence).toString(),
          observedAt: gap.meta.observedAt,
          receivedAt: gap.meta.receivedAt,
        },
        event: {
          type: "stream-gap",
          sourceStreamId: streamId,
          firstLostSequence: gap.firstLostSequence,
          lastLostSequence: gap.lastLostSequence,
          reason: "overflow",
        },
      });
      this.#gaps.delete(streamId);
    }
  }
}

async function openSocket(
  endpoint: MothEndpoint,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Result<Socket>> {
  return new Promise((resolve) => {
    const socket =
      endpoint.kind === "unix"
        ? createConnection(endpoint.path)
        : createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    let abort: (() => void) | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      finish({
        ok: false,
        error: { code: "timeout", message: "Moth daemon connection timed out", retryable: true },
      });
    }, timeoutMs);
    const finish = (result: Result<Socket>) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (abort !== undefined) signal?.removeEventListener("abort", abort);
        resolve(result);
      }
    };
    socket.once("connect", () => finish({ ok: true, value: socket }));
    socket.once("error", () =>
      finish({
        ok: false,
        error: {
          code: "unavailable",
          message: "Moth daemon socket is unavailable",
          retryable: true,
        },
      }),
    );
    if (signal) {
      abort = () => {
        socket.destroy();
        finish(cancelled("Moth socket connection was cancelled"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
}

class NodeMothTransport implements MothTransport {
  readonly #socket: Socket;
  readonly #endpoint: MothEndpoint;
  #nextId = 0;
  readonly #pending = new Map<
    string,
    {
      resolve: (result: Result<unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
      cleanup: () => void;
    }
  >();
  readonly #requestTimeoutMs: number;
  #buffer = new Uint8Array(0);
  #closed = false;
  constructor(socket: Socket, endpoint: MothEndpoint, requestTimeoutMs: number) {
    this.#socket = socket;
    this.#endpoint = endpoint;
    this.#requestTimeoutMs = requestTimeoutMs;
    socket.on("data", (chunk: Buffer) => this.#onData(new Uint8Array(chunk)));
    socket.on("close", () => {
      this.#closed = true;
      this.#failAll({ code: "unavailable", message: "Moth daemon socket closed", retryable: true });
    });
    socket.on("error", () => {
      this.#closed = true;
      this.#failAll({ code: "unavailable", message: "Moth daemon socket failed", retryable: true });
    });
  }
  request(
    method: string,
    params?: unknown,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<Result<unknown>> {
    if (options.signal?.aborted)
      return Promise.resolve(cancelled("Moth daemon request was cancelled"));
    if (this.#closed)
      return Promise.resolve({
        ok: false,
        error: { code: "unavailable", message: "Moth daemon transport is closed", retryable: true },
      });
    const id = `${++this.#nextId}`;
    if (this.#pending.size >= 128) {
      return Promise.resolve({
        ok: false,
        error: { code: "overflow", message: "Moth request queue is full", retryable: true },
      });
    }
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_POLLING_INTERVAL_MS)
      return Promise.resolve({
        ok: false,
        error: { code: "invalid", message: "Moth request timeout is invalid", retryable: false },
      });
    const wireParams =
      this.#endpoint.kind === "tcp"
        ? {
            ...(isRecord(params) ? params : {}),
            authorization: { token: this.#endpoint.token, scope: "read" },
          }
        : params;
    let frame: Uint8Array;
    try {
      frame = encodeMothFrame({
        id,
        type: "request",
        method,
        ...(wireParams === undefined ? {} : { params: wireParams }),
      });
    } catch {
      return Promise.resolve({
        ok: false,
        error: { code: "invalid", message: "Moth request is not serializable", retryable: false },
      });
    }
    return new Promise((resolve) => {
      const finish = (result: Result<unknown>) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pending.cleanup();
        this.#pending.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: { code: "timeout", message: "Moth daemon request timed out", retryable: true },
        });
      }, timeoutMs);
      const abort = () => finish(cancelled("Moth daemon request was cancelled"));
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      this.#pending.set(id, { resolve: finish, timer, cleanup });
      this.#socket.write(frame, (error) => {
        if (error) {
          finish({
            ok: false,
            error: {
              code: "unavailable",
              message: "Moth daemon request could not be sent",
              retryable: true,
            },
          });
        }
      });
      const signal = options.signal;
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#failAll({ code: "cancelled", message: "Moth daemon transport closed", retryable: false });
  }
  #onData(chunk: Uint8Array): void {
    const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    next.set(this.#buffer);
    next.set(chunk, this.#buffer.byteLength);
    this.#buffer = next;
    while (this.#buffer.byteLength >= 4) {
      const length = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      ).getUint32(0, false);
      if (length > MOTH_FRAME_LIMIT) {
        void this.close();
        return;
      }
      if (this.#buffer.byteLength < length + 4) return;
      const frame = this.#buffer.slice(0, length + 4);
      this.#buffer = this.#buffer.slice(length + 4);
      let value: unknown;
      try {
        value = decodeMothFrame(frame);
      } catch {
        void this.close();
        return;
      }
      if (!isRecord(value) || typeof value.id !== "string" || value.type !== "response") {
        void this.close();
        return;
      }
      const pending = this.#pending.get(value.id);
      if (!pending) {
        void this.close();
        return;
      }
      const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
      const hasError = Object.prototype.hasOwnProperty.call(value, "error");
      if (hasResult === hasError) {
        void this.close();
        return;
      }
      if (hasError) pending.resolve({ ok: false, error: mapRpcError(value.error) });
      else pending.resolve({ ok: true, value: value.result });
    }
  }
  #failAll(error: NoxscopeError): void {
    for (const pending of this.#pending.values()) {
      pending.resolve({ ok: false, error });
    }
  }
}

function mapRpcError(value: unknown): NoxscopeError {
  const code = isRecord(value) && typeof value.code === "string" ? value.code : "failed";
  const mapped =
    code === "UNAUTHORIZED"
      ? "unauthorized"
      : code === "TIMEOUT"
        ? "timeout"
        : code === "NOT_READY"
          ? "unavailable"
          : "failed";
  return {
    code: mapped,
    message: "Moth daemon returned an RPC error",
    retryable: mapped === "timeout" || mapped === "unavailable",
  };
}
