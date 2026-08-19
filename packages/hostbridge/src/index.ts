import {
  NOXSCOPE_PROTOCOL,
  validateOperationInput,
  validateRecord,
  validateRuntimeDescriptor,
  type CancelRequest,
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

export const HOSTBRIDGE_PROTOCOL = "noxscope/hostbridge/1" as const;
export const HOSTBRIDGE_VERSION = "0.1.0" as const;

export const HOSTBRIDGE_LIMITS = Object.freeze({
  maxConnections: 8,
  maxMessageBytes: 256 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,
  maxMessagesPerConnection: 4_096,
  handshakeTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  maxDepth: 32,
  maxObjectProperties: 512,
  maxArrayElements: 4_096,
  maxStringBytes: 16 * 1024,
});

/** Frozen admission policy: only canonical descriptors, records, and Results cross HostBridge. */
export const HOSTBRIDGE_DENY_MANIFEST = Object.freeze({
  forbiddenFields: Object.freeze([
    "token",
    "secret",
    "password",
    "credential",
    "authorization",
    "privatekey",
    "seed",
    "mnemonic",
    "passphrase",
    "path",
    "command",
    "shell",
    "file",
    "stdin",
    "stdout",
    "stderr",
    "socket",
    "process",
    "proxy",
    "rawpayload",
  ]),
  allowedMessageTypes: Object.freeze([
    "hello",
    "welcome",
    "descriptor",
    "record",
    "request",
    "response",
    "gap",
    "close",
  ]),
});

export interface HostBridgeConnection {
  readonly origin: string;
  readonly loopback: boolean;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: () => void): () => void;
}

export interface HostBridgeServerOptions {
  readonly allowedOrigins: readonly string[];
  readonly token?: string;
  readonly tokenFactory?: () => string;
  readonly maxConnections?: number;
  readonly maxMessageBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface HostBridgeClientOptions {
  readonly connection: HostBridgeConnection;
  readonly token: string;
  readonly origin: string;
  readonly maxMessageBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface HostBridgeWelcome {
  readonly protocol: typeof HOSTBRIDGE_PROTOCOL;
  readonly version: string;
  readonly capabilities: readonly string[];
}

export interface HostBridgeSessionSource {
  readonly descriptor: RuntimeDescriptor;
  readonly records: () => AsyncIterable<NoxscopeRecord>;
  request(request: SnapshotRequest, options?: RequestOptions): Promise<Result<Snapshot>>;
  request(request: InvokeRequest, options?: RequestOptions): Promise<Result<OperationTerminal>>;
  request(
    request: CancelRequest,
    options?: RequestOptions,
  ): Promise<Result<{ readonly accepted: boolean }>>;
}

export interface HostBridgeServer {
  readonly token: string;
  accept(connection: HostBridgeConnection): void;
  attach(source: HostBridgeSessionSource): Promise<void>;
  connections(): number;
  close(): void;
}

export interface HostBridgeClient {
  connect(): Promise<Result<HostBridgeWelcome>>;
  close(): Promise<void>;
  waitForDescriptor(): Promise<Result<RuntimeDescriptor>>;
  request(
    sessionId: string,
    request: SnapshotRequest | InvokeRequest | CancelRequest,
    options?: RequestOptions,
  ): Promise<Result<unknown>>;
  onRecord(listener: (record: NoxscopeRecord) => void): () => void;
  onGap(listener: (gap: HostBridgeGap) => void): () => void;
}

export interface HostBridgeGap {
  readonly sessionId: string;
  readonly sourceStreamId: string;
  readonly firstLostSequence: string;
  readonly lastLostSequence: string;
}

type WireMessage =
  | {
      readonly type: "hello";
      readonly protocol: string;
      readonly token: string;
      readonly clientId: string;
      readonly capabilities?: readonly string[];
    }
  | {
      readonly type: "welcome";
      readonly protocol: typeof HOSTBRIDGE_PROTOCOL;
      readonly version: string;
      readonly capabilities: readonly string[];
    }
  | { readonly type: "descriptor"; readonly descriptor: RuntimeDescriptor }
  | { readonly type: "record"; readonly sessionId: string; readonly record: NoxscopeRecord }
  | {
      readonly type: "gap";
      readonly sessionId: string;
      readonly sourceStreamId: string;
      readonly firstLostSequence: string;
      readonly lastLostSequence: string;
    }
  | {
      readonly type: "request";
      readonly requestId: string;
      readonly sessionId: string;
      readonly request: SnapshotRequest | InvokeRequest | CancelRequest;
    }
  | { readonly type: "response"; readonly requestId: string; readonly result: Result<unknown> }
  | { readonly type: "close"; readonly reason: string };

const CAPABILITIES = Object.freeze([
  "canonical.descriptor.read",
  "canonical.records.read",
  "canonical.snapshot.request",
]);

export function createHostBridgeServer(options: HostBridgeServerOptions): HostBridgeServer {
  const origins = new Set(options.allowedOrigins);
  if (
    origins.size === 0 ||
    [...origins].some((origin) => origin === "*" || !isExactOrigin(origin))
  ) {
    throw new Error("HostBridge allowedOrigins must contain exact origins");
  }
  const token = options.token ?? options.tokenFactory?.() ?? launchToken();
  if (!nonEmpty(token) || byteLength(token) > 256)
    throw new Error("HostBridge launch token is invalid");
  const maxConnections = options.maxConnections ?? HOSTBRIDGE_LIMITS.maxConnections;
  const maxMessageBytes = options.maxMessageBytes ?? HOSTBRIDGE_LIMITS.maxMessageBytes;
  const maxBufferedBytes = options.maxBufferedBytes ?? HOSTBRIDGE_LIMITS.maxBufferedBytes;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HOSTBRIDGE_LIMITS.handshakeTimeoutMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? HOSTBRIDGE_LIMITS.requestTimeoutMs;
  const connections = new Set<ServerConnection>();
  const sessions = new Map<string, HostBridgeSessionSource>();
  const consumers = new Set<string>();
  const consume = async (attached: HostBridgeSessionSource): Promise<void> => {
    if (consumers.has(attached.descriptor.sessionId)) return;
    consumers.add(attached.descriptor.sessionId);
    try {
      for await (const candidate of attached.records()) {
        const checkedRecord = validateRecord(candidate);
        if (!checkedRecord.ok || !safeBridgeValue(checkedRecord.value)) continue;
        for (const connection of connections) {
          if (connection.authorized)
            connection.send({
              type: "record",
              sessionId: attached.descriptor.sessionId,
              record: checkedRecord.value,
            });
        }
      }
    } finally {
      consumers.delete(attached.descriptor.sessionId);
    }
  };

  const server: HostBridgeServer = {
    token,
    accept(connection) {
      if (
        !connection.loopback ||
        !origins.has(connection.origin) ||
        connections.size >= maxConnections
      ) {
        connection.close(1008, "HostBridge connection not admitted");
        return;
      }
      const serverConnection = new ServerConnection(connection, {
        token,
        maxMessageBytes,
        maxBufferedBytes,
        handshakeTimeoutMs,
        requestTimeoutMs,
        origin: connection.origin,
        onAuthorized() {
          for (const source of sessions.values()) {
            serverConnection.send({ type: "descriptor", descriptor: source.descriptor });
            void consume(source);
          }
        },
        onClose() {
          connections.delete(serverConnection);
        },
        onRequest(message: Extract<WireMessage, { type: "request" }>) {
          const source = sessions.get(message.sessionId);
          if (source === undefined) {
            serverConnection.send({
              type: "response",
              requestId: message.requestId,
              result: unsupported("Runtime Session is not attached"),
            });
            return;
          }
          void routeRequest(source, message.request, requestTimeoutMs).then((result) => {
            serverConnection.send({ type: "response", requestId: message.requestId, result });
          });
        },
      });
      connections.add(serverConnection);
      serverConnection.start();
    },
    async attach(source) {
      const checked = validateRuntimeDescriptor(source.descriptor);
      if (!checked.ok) throw new Error(checked.error.message);
      if (!safeBridgeValue(source.descriptor))
        throw new Error("Runtime descriptor contains denied HostBridge fields");
      if (sessions.has(source.descriptor.sessionId))
        throw new Error("Runtime Session is already attached");
      sessions.set(source.descriptor.sessionId, source);
      for (const connection of connections) {
        if (!connection.authorized) continue;
        connection.send({ type: "descriptor", descriptor: source.descriptor });
        void consume(source);
      }
    },
    connections: () => connections.size,
    close() {
      for (const connection of [...connections]) connection.close();
      connections.clear();
    },
  };
  return server;
}

export function createHostBridgeClient(options: HostBridgeClientOptions): HostBridgeClient {
  if (!isExactOrigin(options.origin) || options.connection.origin !== options.origin) {
    throw new Error("HostBridge client origin does not match its connection");
  }
  if (!nonEmpty(options.token)) throw new Error("HostBridge client token is required");
  const maxMessageBytes = options.maxMessageBytes ?? HOSTBRIDGE_LIMITS.maxMessageBytes;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HOSTBRIDGE_LIMITS.handshakeTimeoutMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? HOSTBRIDGE_LIMITS.requestTimeoutMs;
  const records = new Set<(record: NoxscopeRecord) => void>();
  const gaps = new Set<(gap: HostBridgeGap) => void>();
  const bufferedRecords = new Map<string, NoxscopeRecord[]>();
  const pending = new Map<
    string,
    { resolve: (result: Result<unknown>) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const descriptors = new Map<string, RuntimeDescriptor>();
  let welcome: HostBridgeWelcome | undefined;
  let closed = false;
  let descriptorWaiter: ((result: Result<RuntimeDescriptor>) => void) | undefined;
  let removeMessage: (() => void) | undefined;
  let removeClose: (() => void) | undefined;

  const client: HostBridgeClient = {
    async connect() {
      if (closed) return { ok: false, error: cancelled("HostBridge client is closed") };
      removeMessage = options.connection.onMessage((data) => onMessage(data));
      removeClose = options.connection.onClose(() => onClose());
      const hello: WireMessage = {
        type: "hello",
        protocol: HOSTBRIDGE_PROTOCOL,
        token: options.token,
        clientId: launchToken(),
        capabilities: CAPABILITIES,
      };
      send(hello);
      return new Promise<Result<HostBridgeWelcome>>((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: false, error: timeout("HostBridge handshake timed out") }),
          handshakeTimeoutMs,
        );
        const poll = () => {
          if (welcome !== undefined) {
            clearTimeout(timer);
            resolve({ ok: true, value: welcome });
            return;
          }
          if (closed) {
            clearTimeout(timer);
            resolve({ ok: false, error: unavailable("HostBridge disconnected during handshake") });
            return;
          }
          setTimeout(poll, 1);
        };
        poll();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      removeMessage?.();
      removeClose?.();
      options.connection.close(1000, "HostBridge client closed");
      onClose();
    },
    async waitForDescriptor() {
      if (descriptors.size > 0) return { ok: true, value: [...descriptors.values()][0]! };
      if (closed) return { ok: false, error: unavailable("HostBridge client is closed") };
      return new Promise((resolve) => {
        descriptorWaiter = resolve;
      });
    },
    request(sessionId, request, requestOptions) {
      if (closed)
        return Promise.resolve({ ok: false, error: unavailable("HostBridge client is closed") });
      if (!validRequest(request))
        return Promise.resolve({ ok: false, error: invalid("HostBridge request is malformed") });
      const requestId = `${launchToken()}-${pending.size}`;
      const message: WireMessage = { type: "request", requestId, sessionId, request };
      return new Promise((resolve) => {
        const timeoutMs = requestOptions?.timeoutMs ?? requestTimeoutMs;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({ ok: false, error: timeout("HostBridge request timed out") });
        }, timeoutMs);
        pending.set(requestId, { resolve, timer });
        send(message);
      });
    },
    onRecord(listener) {
      records.add(listener);
      for (const [sessionId, queued] of bufferedRecords) {
        for (const record of queued) listener(record);
        bufferedRecords.delete(sessionId);
      }
      return () => records.delete(listener);
    },
    onGap(listener) {
      gaps.add(listener);
      return () => gaps.delete(listener);
    },
  };
  return client;

  function send(message: WireMessage): void {
    if (!safeWireMessage(message) || byteLength(JSON.stringify(message)) > maxMessageBytes) {
      void client.close();
      return;
    }
    options.connection.send(JSON.stringify(message));
  }
  function onMessage(data: string): void {
    if (closed || byteLength(data) > maxMessageBytes) {
      void client.close();
      return;
    }
    const parsed = parseWire(data);
    if (!parsed.ok) {
      void client.close();
      return;
    }
    const message = parsed.value;
    if (message.type === "welcome") {
      if (message.protocol !== HOSTBRIDGE_PROTOCOL || !Array.isArray(message.capabilities)) {
        void client.close();
        return;
      }
      welcome = {
        protocol: message.protocol,
        version: message.version,
        capabilities: [...message.capabilities],
      };
    } else if (message.type === "descriptor") {
      const checked = validateRuntimeDescriptor(message.descriptor);
      if (!checked.ok || !safeBridgeValue(checked.value)) {
        void client.close();
        return;
      }
      descriptors.set(checked.value.sessionId, checked.value);
      const waiter = descriptorWaiter;
      descriptorWaiter = undefined;
      waiter?.({ ok: true, value: checked.value });
    } else if (message.type === "record") {
      const checked = validateRecord(message.record);
      const descriptor = descriptors.get(message.sessionId);
      if (
        !checked.ok ||
        descriptor === undefined ||
        checked.value.meta.sessionId !== descriptor.sessionId ||
        checked.value.meta.runtimeId !== descriptor.runtimeId
      ) {
        void client.close();
        return;
      }
      const immutable = deepFreezeCopy(checked.value);
      if (records.size === 0) {
        const queued = bufferedRecords.get(message.sessionId) ?? [];
        queued.push(immutable);
        bufferedRecords.set(message.sessionId, queued);
      } else {
        for (const listener of records) listener(immutable);
      }
    } else if (message.type === "gap") {
      const gap = {
        sessionId: message.sessionId,
        sourceStreamId: message.sourceStreamId,
        firstLostSequence: message.firstLostSequence,
        lastLostSequence: message.lastLostSequence,
      };
      for (const listener of gaps) listener(gap);
    } else if (message.type === "response") {
      const request = pending.get(message.requestId);
      if (request === undefined || !safeBridgeValue(message.result)) {
        void client.close();
        return;
      }
      pending.delete(message.requestId);
      clearTimeout(request.timer);
      request.resolve(message.result);
    } else {
      void client.close();
    }
  }
  function onClose(): void {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, error: unavailable("HostBridge disconnected") });
    }
    pending.clear();
    descriptorWaiter?.({ ok: false, error: unavailable("HostBridge disconnected") });
    descriptorWaiter = undefined;
  }
}

export interface HostBridgeRemoteAdapterOptions {
  readonly client: HostBridgeClient;
}

export function createHostBridgeRemoteAdapter(
  options: HostBridgeRemoteAdapterOptions,
): NoxscopeAdapter {
  return {
    async connect(connectOptions) {
      if (connectOptions.signal.aborted)
        return { ok: false, error: cancelled("HostBridge connection was cancelled") };
      const handshake = await options.client.connect();
      if (!handshake.ok) return handshake;
      const descriptor = await options.client.waitForDescriptor();
      if (!descriptor.ok) return descriptor;
      return {
        ok: true,
        value: new RemoteRuntimeSession(descriptor.value, options.client, connectOptions.signal),
      };
    },
  };
}

/** Alias kept explicit for browser callers that want to name the remote-session Adapter. */
export const createRemoteSessionAdapter = createHostBridgeRemoteAdapter;

class RemoteRuntimeSession implements RuntimeSession {
  readonly descriptor: RuntimeDescriptor;
  readonly #client: HostBridgeClient;
  readonly #queue = new RemoteQueue();
  readonly #removeRecord: () => void;
  readonly #removeGap: () => void;
  constructor(descriptor: RuntimeDescriptor, client: HostBridgeClient, signal: AbortSignal) {
    this.descriptor = deepFreezeCopy(descriptor);
    this.#client = client;
    this.#removeRecord = client.onRecord((record) => {
      if (record.meta.sessionId === descriptor.sessionId) this.#queue.push(record);
    });
    this.#removeGap = client.onGap((gap) => {
      if (gap.sessionId === descriptor.sessionId) this.#queue.push(makeGapRecord(descriptor, gap));
    });
    signal.addEventListener("abort", () => this.close(), { once: true });
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
    const result = await this.#client.request(this.descriptor.sessionId, request, options);
    return result as Result<Snapshot | OperationTerminal | { readonly accepted: boolean }>;
  }
  close(): void {
    this.#removeRecord();
    this.#removeGap();
    this.#queue.close();
  }
}

class ServerConnection {
  readonly #connection: HostBridgeConnection;
  readonly #config: {
    readonly token: string;
    readonly maxMessageBytes: number;
    readonly maxBufferedBytes: number;
    readonly handshakeTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly origin: string;
    readonly onAuthorized: () => void;
    readonly onClose: () => void;
    readonly onRequest: (message: Extract<WireMessage, { type: "request" }>) => void;
  };
  readonly #removeMessage: () => void;
  readonly #removeClose: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #authorized = false;
  #messageCount = 0;
  constructor(
    connection: HostBridgeConnection,
    config: {
      readonly token: string;
      readonly maxMessageBytes: number;
      readonly maxBufferedBytes: number;
      readonly handshakeTimeoutMs: number;
      readonly requestTimeoutMs: number;
      readonly origin: string;
      readonly onAuthorized: () => void;
      readonly onClose: () => void;
      readonly onRequest: (message: Extract<WireMessage, { type: "request" }>) => void;
    },
  ) {
    this.#connection = connection;
    this.#config = config;
    this.#removeMessage = connection.onMessage((data) => this.#onMessage(data));
    this.#removeClose = connection.onClose(() => this.close());
  }
  get authorized(): boolean {
    return this.#authorized;
  }
  start(): void {
    this.#timer = setTimeout(() => {
      if (!this.#authorized) this.close();
    }, this.#config.handshakeTimeoutMs);
  }
  send(message: WireMessage): void {
    if (!this.#authorized && message.type !== "welcome") return;
    const json = JSON.stringify(message);
    if (byteLength(json) > this.#config.maxMessageBytes) {
      this.close();
      return;
    }
    const buffered = this.#connection.bufferedAmount ?? 0;
    if (
      buffered > this.#config.maxBufferedBytes ||
      buffered + byteLength(json) > this.#config.maxBufferedBytes
    ) {
      if (message.type === "record")
        this.#connection.send(
          JSON.stringify({
            type: "gap",
            sessionId: message.sessionId,
            sourceStreamId: message.record.meta.streamId,
            firstLostSequence: message.record.meta.sequence,
            lastLostSequence: message.record.meta.sequence,
          } satisfies WireMessage),
        );
      return;
    }
    this.#connection.send(json);
  }
  close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#removeMessage();
    this.#removeClose();
    this.#connection.close(1000, "HostBridge closed");
    this.#config.onClose();
  }
  #onMessage(data: string): void {
    this.#messageCount += 1;
    if (
      this.#messageCount > HOSTBRIDGE_LIMITS.maxMessagesPerConnection ||
      byteLength(data) > this.#config.maxMessageBytes
    ) {
      this.close();
      return;
    }
    const parsed = parseWire(data);
    if (!parsed.ok) {
      this.close();
      return;
    }
    const message = parsed.value;
    if (!this.#authorized) {
      if (
        message.type !== "hello" ||
        message.protocol !== HOSTBRIDGE_PROTOCOL ||
        message.token !== this.#config.token ||
        !nonEmpty(message.clientId) ||
        !safeWireMessage(message)
      ) {
        this.close();
        return;
      }
      this.#authorized = true;
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.send({
        type: "welcome",
        protocol: HOSTBRIDGE_PROTOCOL,
        version: HOSTBRIDGE_VERSION,
        capabilities: CAPABILITIES,
      });
      this.#config.onAuthorized();
      return;
    }
    if (message.type === "request") {
      if (
        message.type !== "request" ||
        !validRequest(message.request) ||
        !nonEmpty(message.sessionId) ||
        !nonEmpty(message.requestId)
      ) {
        this.close();
        return;
      }
      this.#config.onRequest(message);
      return;
    }
    this.close();
  }
}

/** Deterministic in-memory transport used by conformance tests and local composition. */
export function createMemoryHostBridgePair(options: {
  readonly origin: string;
  readonly loopback: boolean;
}): { readonly client: HostBridgeMemoryConnection; readonly server: HostBridgeMemoryConnection } {
  const client = new HostBridgeMemoryConnection(options.origin, options.loopback);
  const server = new HostBridgeMemoryConnection(options.origin, options.loopback);
  client.peer = server;
  server.peer = client;
  return { client, server };
}

export class HostBridgeMemoryConnection implements HostBridgeConnection {
  readonly origin: string;
  readonly loopback: boolean;
  readonly #messages = new Set<(data: string) => void>();
  readonly #closes = new Set<() => void>();
  peer: HostBridgeMemoryConnection | undefined;
  #closed = false;
  constructor(origin: string, loopback: boolean) {
    this.origin = origin;
    this.loopback = loopback;
  }
  send(data: string): void {
    if (!this.#closed) this.peer?.receive(data);
  }
  receive(data: string): void {
    if (!this.#closed) for (const listener of this.#messages) listener(data);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closes) listener();
    this.peer?.remoteClose();
  }
  remoteClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closes) listener();
  }
  onMessage(listener: (data: string) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }
}

function parseWire(data: string): Result<WireMessage> {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return { ok: false, error: invalid("HostBridge message is malformed") };
  }
  const basicResponse = isRecord(value) && value.type === "response" && isRecord(value.result);
  if (
    (!basicResponse && !safeWireMessage(value)) ||
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !HOSTBRIDGE_DENY_MANIFEST.allowedMessageTypes.includes(value.type)
  )
    return { ok: false, error: invalid("HostBridge message is not admitted") };
  return { ok: true, value: value as WireMessage };
}

function safeWireMessage(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "hello") return safeBridgeValue(value);
  if (typeof value.token !== "string" || byteLength(value.token) > 256) return false;
  const withoutToken = { ...value };
  delete withoutToken.token;
  return safeBridgeValue(withoutToken);
}

function validRequest(value: unknown): value is SnapshotRequest | InvokeRequest | CancelRequest {
  if (
    !isRecord(value) ||
    !nonEmpty(value.requestId) ||
    !["snapshot", "invoke", "cancel"].includes(value.kind as string)
  )
    return false;
  if (value.kind === "snapshot")
    return (
      value.select === undefined ||
      (Array.isArray(value.select) &&
        value.select.every((item) => typeof item === "string" && item.length > 0))
    );
  if (value.kind === "cancel") return nonEmpty(value.operationId);
  return nonEmpty(value.operationId) && validateOperationInput(value.operation).ok;
}

async function routeRequest(
  source: HostBridgeSessionSource,
  request: SnapshotRequest | InvokeRequest | CancelRequest,
  timeoutMs: number,
): Promise<Result<unknown>> {
  try {
    const result = await Promise.race([
      source.request(request as never),
      new Promise<Result<never>>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, error: timeout("HostBridge request timed out") }),
          timeoutMs,
        ),
      ),
    ]);
    return result;
  } catch {
    return {
      ok: false,
      error: { code: "failed", message: "HostBridge request failed", retryable: true },
    };
  }
}

function makeGapRecord(descriptor: RuntimeDescriptor, gap: HostBridgeGap): NoxscopeRecord {
  return {
    kind: "diagnostic-event",
    meta: {
      protocol: NOXSCOPE_PROTOCOL,
      sessionId: descriptor.sessionId,
      runtimeId: descriptor.runtimeId,
      streamId: `${descriptor.sessionId}-hostbridge`,
      sequence: gap.firstLostSequence,
      observedAt: "1970-01-01T00:00:00.000Z",
      receivedAt: "1970-01-01T00:00:00.000Z",
    },
    event: {
      type: "stream-gap",
      sourceStreamId: gap.sourceStreamId,
      firstLostSequence: gap.firstLostSequence,
      lastLostSequence: gap.lastLostSequence,
      reason: "overflow",
    },
  };
}

class RemoteQueue {
  readonly #items: NoxscopeRecord[] = [];
  readonly #waiters: ((result: IteratorResult<NoxscopeRecord>) => void)[] = [];
  #closed = false;
  push(record: NoxscopeRecord): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: record });
    else this.#items.push(record);
  }
  close(): void {
    this.#closed = true;
    this.#items.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  iterator(): AsyncIterator<NoxscopeRecord> {
    return {
      next: async () => {
        const item = this.#items.shift();
        if (item) return { done: false, value: item };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: async () => ({ done: true, value: undefined }),
    };
  }
}

function safeBridgeValue(value: unknown): boolean {
  const denied = new Set(HOSTBRIDGE_DENY_MANIFEST.forbiddenFields);
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > HOSTBRIDGE_LIMITS.maxDepth) return false;
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current === "string") return byteLength(current) <= HOSTBRIDGE_LIMITS.maxStringBytes;
    if (typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current))
      return (
        current.length <= HOSTBRIDGE_LIMITS.maxArrayElements &&
        current.every((item) => visit(item, depth + 1))
      );
    const object = current as Record<string, unknown>;
    const keys = Object.keys(object);
    return (
      keys.length <= HOSTBRIDGE_LIMITS.maxObjectProperties &&
      keys.every((key) => !denied.has(normalize(key)) && visit(object[key], depth + 1))
    );
  };
  return visit(value, 0);
}

function deepFreezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (typeof current !== "object" || current === null || Object.isFrozen(current)) return;
    for (const child of Object.values(current as Record<string, unknown>)) freeze(child);
    Object.freeze(current);
  };
  freeze(copy);
  return copy;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
function launchToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function invalid(message: string): NoxscopeError {
  return { code: "invalid", message, retryable: false };
}
function unavailable(message: string): NoxscopeError {
  return { code: "unavailable", message, retryable: true };
}
function timeout(message: string): NoxscopeError {
  return { code: "timeout", message, retryable: true };
}
function cancelled(message: string): NoxscopeError {
  return { code: "cancelled", message, retryable: false };
}
function unsupported(message: string): Result<never> {
  return { ok: false, error: { code: "unsupported", message, retryable: false } };
}
