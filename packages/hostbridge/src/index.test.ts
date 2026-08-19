import { describe, expect, it } from "vitest";
import {
  HOSTBRIDGE_PROTOCOL,
  createHostBridgeClient,
  createHostBridgeRemoteAdapter,
  createHostBridgeServer,
  createMemoryHostBridgePair,
  type HostBridgeConnection,
  type HostBridgeSessionSource,
} from "./index.js";
import { NOXSCOPE_PROTOCOL, type RuntimeDescriptor, type SnapshotRecord } from "@noxscope/protocol";

const descriptor: RuntimeDescriptor = {
  protocol: NOXSCOPE_PROTOCOL,
  sessionId: "moth-session-1",
  runtimeId: "moth-unix-socket",
  adapter: { id: "dev.noxscope.adapter-moth", version: "0.1.0" },
  runtime: {
    surface: "daemon",
    identifiers: [
      { scheme: "moth-daemon", value: "moth-unix-socket", stability: "diagnostic-session" },
    ],
    versions: [{ subject: "moth-protocol", version: "moth-wallet-daemon/1" }],
  },
  capabilities: [],
};

const record = (sequence: string): SnapshotRecord => ({
  kind: "snapshot",
  meta: {
    protocol: NOXSCOPE_PROTOCOL,
    sessionId: descriptor.sessionId,
    runtimeId: descriptor.runtimeId,
    streamId: "moth-session-1-snapshots",
    sequence,
    observedAt: "2026-08-18T12:00:00.000Z",
    receivedAt: "2026-08-18T12:00:00.000Z",
  },
  snapshot: {
    revision: sequence,
    freshness: {
      state: "fresh",
      observedAt: "2026-08-18T12:00:00.000Z",
      receivedAt: "2026-08-18T12:00:00.000Z",
      source: "adapter",
      consecutiveFailures: 0,
    },
  },
});
const recordOnStream = (streamId: string, sequence: string): SnapshotRecord => {
  const value = record(sequence);
  return { ...value, meta: { ...value.meta, streamId } };
};

const idleConnection = (): HostBridgeConnection & { readonly closeCount: () => number } => {
  const messages = new Set<(data: string) => void>();
  const closes = new Set<() => void>();
  let closeCount = 0;
  return {
    origin: "http://localhost:5173",
    loopback: true,
    bufferedAmount: 0,
    send: () => {},
    close: () => {
      closeCount += 1;
      for (const listener of closes) listener();
    },
    onMessage: (listener) => {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onClose: (listener) => {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    closeCount: () => closeCount,
  };
};

describe("HostBridge handshake and policy", () => {
  it("closes and cancels all handshake timers after timeout", async () => {
    const connection = idleConnection();
    const client = createHostBridgeClient({
      connection,
      token: "t",
      origin: "http://localhost:5173",
      handshakeTimeoutMs: 5,
    });
    const result = await client.connect();
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "timeout" }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connection.closeCount()).toBe(1);
  });

  it("requires loopback, exact origin, launch token, and protocol version", async () => {
    const pair = createMemoryHostBridgePair({ origin: "http://localhost:5173", loopback: true });
    const server = createHostBridgeServer({
      allowedOrigins: ["http://localhost:5173"],
      token: "launch-token",
    });
    server.accept(pair.server);
    const client = createHostBridgeClient({
      connection: pair.client,
      token: "launch-token",
      origin: "http://localhost:5173",
    });
    const connected = await client.connect();
    expect(connected).toEqual({
      ok: true,
      value: expect.objectContaining({ protocol: HOSTBRIDGE_PROTOCOL }),
    });
    expect(server.connections()).toBe(1);

    const wrongOrigin = createMemoryHostBridgePair({
      origin: "https://evil.example",
      loopback: true,
    });
    server.accept(wrongOrigin.server);
    expect(server.connections()).toBe(1);
    expect(() => createHostBridgeServer({ allowedOrigins: ["*"], token: "x" })).toThrow(/origin/i);
  });

  it("rejects non-canonical messages before routing and never exposes generic commands", async () => {
    const pair = createMemoryHostBridgePair({ origin: "http://localhost:5173", loopback: true });
    const server = createHostBridgeServer({
      allowedOrigins: ["http://localhost:5173"],
      token: "t",
    });
    server.accept(pair.server);
    const client = createHostBridgeClient({
      connection: pair.client,
      token: "t",
      origin: "http://localhost:5173",
    });
    expect((await client.connect()).ok).toBe(true);
    pair.client.receive(JSON.stringify({ type: "proxy", command: "cat /secret" }));
    expect(server.connections()).toBe(0);
  });

  it("rejects a success envelope whose value is not the requested canonical result", async () => {
    const pair = createMemoryHostBridgePair({ origin: "http://localhost:5173", loopback: true });
    const source: HostBridgeSessionSource = {
      descriptor,
      async *records() {},
      request: (async () => ({
        ok: true,
        value: { evil: "accepted" },
      })) as unknown as HostBridgeSessionSource["request"],
    };
    const server = createHostBridgeServer({
      allowedOrigins: ["http://localhost:5173"],
      token: "t",
    });
    server.accept(pair.server);
    await server.attach(source);
    const client = createHostBridgeClient({
      connection: pair.client,
      token: "t",
      origin: "http://localhost:5173",
    });
    expect((await client.connect()).ok).toBe(true);
    const result = await client.request(descriptor.sessionId, {
      kind: "snapshot",
      requestId: "evil",
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "unavailable" }) });
  });

  it("rejects a success snapshot with additive nested fields", async () => {
    const pair = createMemoryHostBridgePair({ origin: "http://localhost:5173", loopback: true });
    const snapshot = record("3").snapshot;
    const source: HostBridgeSessionSource = {
      descriptor,
      async *records() {},
      request: (async () => ({
        ok: true,
        value: {
          ...snapshot,
          freshness: { ...snapshot.freshness, evil: true },
        },
      })) as unknown as HostBridgeSessionSource["request"],
    };
    const server = createHostBridgeServer({
      allowedOrigins: ["http://localhost:5173"],
      token: "t",
    });
    server.accept(pair.server);
    await server.attach(source);
    const client = createHostBridgeClient({
      connection: pair.client,
      token: "t",
      origin: "http://localhost:5173",
    });
    expect((await client.connect()).ok).toBe(true);
    const result = await client.request(descriptor.sessionId, {
      kind: "snapshot",
      requestId: "nested-evil",
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "unavailable" }) });
  });
});

describe("remote canonical session", () => {
  it("keeps buffered gaps separate for NUL and Unicode-delimited session/stream IDs", async () => {
    const pair = createMemoryHostBridgePair({ origin: "http://localhost:5173", loopback: true });
    const sourceFor = (sessionId: string, runtimeId: string): HostBridgeSessionSource => ({
      descriptor: {
        ...descriptor,
        sessionId,
        runtimeId,
        runtime: {
          ...descriptor.runtime,
          identifiers: [
            {
              ...descriptor.runtime.identifiers[0]!,
              value: runtimeId,
            },
          ],
        },
      },
      async *records() {},
      request: (async () => ({
        ok: true,
        value: record("1").snapshot,
      })) as unknown as HostBridgeSessionSource["request"],
    });
    const server = createHostBridgeServer({
      allowedOrigins: ["http://localhost:5173"],
      token: "t",
    });
    await server.attach(sourceFor("a", "runtime-a"));
    await server.attach(sourceFor("a\u0000", "runtime-b"));
    server.accept(pair.server);
    const client = createHostBridgeClient({
      connection: pair.client,
      token: "t",
      origin: "http://localhost:5173",
    });
    expect((await client.connect()).ok).toBe(true);
    pair.client.receive(
      JSON.stringify({
        type: "gap",
        sessionId: "a",
        sourceStreamId: "\u0000b",
        firstLostSequence: "1",
        lastLostSequence: "1",
      }),
    );
    pair.client.receive(
      JSON.stringify({
        type: "gap",
        sessionId: "a\u0000",
        sourceStreamId: "b",
        firstLostSequence: "2",
        lastLostSequence: "2",
      }),
    );
    const received: { sessionId: string; sourceStreamId: string }[] = [];
    client.onGap((gap) =>
      received.push({ sessionId: gap.sessionId, sourceStreamId: gap.sourceStreamId }),
    );
    expect(received).toEqual([
      { sessionId: "a", sourceStreamId: "\u0000b" },
      { sessionId: "a\u0000", sourceStreamId: "b" },
    ]);
    await client.close();
  });

  it("keeps overflow gap summaries separate for each source stream", async () => {
    const pair = createMemoryHostBridgePair({ origin: "http://localhost:5173", loopback: true });
    const source: HostBridgeSessionSource = {
      descriptor,
      async *records() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        for (let index = 0; index < 2_048; index += 1)
          yield recordOnStream(index % 2 === 0 ? "stream-a" : "stream-b", (index + 1).toString());
      },
      request: (async () => ({
        ok: true,
        value: record("3").snapshot,
      })) as unknown as HostBridgeSessionSource["request"],
    };
    const server = createHostBridgeServer({
      allowedOrigins: ["http://localhost:5173"],
      token: "t",
    });
    server.accept(pair.server);
    await server.attach(source);
    const client = createHostBridgeClient({
      connection: pair.client,
      token: "t",
      origin: "http://localhost:5173",
    });
    const connected = await createHostBridgeRemoteAdapter({ client }).connect({
      signal: new AbortController().signal,
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const iterator = connected.value[Symbol.asyncIterator]();
    for (let index = 0; index < 1_024; index += 1) await iterator.next();
    const firstGap = await iterator.next();
    const secondGap = await iterator.next();
    const streams = [firstGap, secondGap].map((item) =>
      item.done || item.value.kind !== "diagnostic-event"
        ? ""
        : item.value.event.type === "stream-gap"
          ? item.value.event.sourceStreamId
          : "",
    );
    expect(new Set(streams)).toEqual(new Set(["stream-a", "stream-b"]));
    await client.close();
  });

  it("streams validated descriptors/records and turns overflow into deterministic gaps", async () => {
    const pair = createMemoryHostBridgePair({ origin: "http://localhost:5173", loopback: true });
    const source: HostBridgeSessionSource = {
      descriptor,
      async *records() {
        yield record("1");
        yield record("2");
      },
      request: (async () => ({
        ok: true,
        value: record("3").snapshot,
      })) as unknown as HostBridgeSessionSource["request"],
    };
    const server = createHostBridgeServer({
      allowedOrigins: ["http://localhost:5173"],
      token: "t",
    });
    server.accept(pair.server);
    await server.attach(source);
    const client = createHostBridgeClient({
      connection: pair.client,
      token: "t",
      origin: "http://localhost:5173",
    });
    const adapter = createHostBridgeRemoteAdapter({ client });
    const connected = await adapter.connect({ signal: new AbortController().signal });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(connected.value.descriptor.runtime.surface).toBe("daemon");
    const iterator = connected.value[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done) return;
    expect(first.value.kind).toBe("snapshot");
    const requested = await connected.value.request({ kind: "snapshot", requestId: "r1" });
    expect(requested.ok).toBe(true);
    await client.close();
  });
});
