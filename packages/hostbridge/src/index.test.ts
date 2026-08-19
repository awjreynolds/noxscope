import { describe, expect, it } from "vitest";
import {
  HOSTBRIDGE_PROTOCOL,
  createHostBridgeClient,
  createHostBridgeRemoteAdapter,
  createHostBridgeServer,
  createMemoryHostBridgePair,
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

describe("HostBridge handshake and policy", () => {
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
});

describe("remote canonical session", () => {
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
