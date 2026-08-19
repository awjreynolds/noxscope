import { describe, expect, it } from "vitest";
import {
  MOTH_DAEMON_PROTOCOL,
  MOTH_FRAME_LIMIT,
  createMothAdapter,
  decodeMothFrame,
  encodeMothFrame,
  type MothTransport,
  type MothTransportFactory,
} from "./index.js";

const signal = () => new AbortController().signal;
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("Moth daemon wire contract", () => {
  it("encodes and decodes a big-endian length-prefixed JSON frame", () => {
    const frame = encodeMothFrame({ id: "1", type: "request", method: "version" });
    expect(frame.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 46]));
    expect(decodeMothFrame(frame)).toEqual({
      id: "1",
      type: "request",
      method: "version",
    });
  });

  it("rejects malformed, oversized, and trailing bytes", () => {
    expect(() => decodeMothFrame(new Uint8Array([0, 0, 0, 2, 123, 34]))).toThrow(
      /malformed|truncated/i,
    );
    expect(() => encodeMothFrame({ value: "x".repeat(MOTH_FRAME_LIMIT) })).toThrow(
      /frame|limit|large/i,
    );
    const frame = encodeMothFrame({ ok: true });
    expect(() => decodeMothFrame(new Uint8Array([...frame, 0]))).toThrow(/trailing/i);
    const duplicateJson = new TextEncoder().encode('{"id":"1","id":"2"}');
    const duplicateFrame = new Uint8Array(duplicateJson.byteLength + 4);
    new DataView(duplicateFrame.buffer).setUint32(0, duplicateJson.byteLength, false);
    duplicateFrame.set(duplicateJson, 4);
    expect(() => decodeMothFrame(duplicateFrame)).toThrow(/duplicate/i);
  });
});

describe("read-only Moth Adapter", () => {
  it("enforces connect deadlines and closes a factory transport that resolves late", async () => {
    let closes = 0;
    const transport: MothTransport = {
      request: async () => ({ ok: true, value: {} }),
      close: async () => {
        closes += 1;
      },
    };
    const factory: MothTransportFactory = {
      connect: () =>
        new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: transport }), 25)),
    };
    const result = await createMothAdapter({
      endpoint: { kind: "unix", path: "/tmp/moth.sock" },
      transportFactory: factory,
      requestTimeoutMs: 5,
      pollingIntervalMs: 60_000,
    }).connect({ signal: signal() });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "timeout" }) });
    await wait(35);
    expect(closes).toBe(1);
  });

  it("enforces request deadlines and closes a transport whose request resolves late", async () => {
    let closes = 0;
    const transport: MothTransport = {
      request: async (method) => {
        await wait(25);
        return method === "version"
          ? { ok: true, value: { protocol: MOTH_DAEMON_PROTOCOL } }
          : { ok: true, value: {} };
      },
      close: async () => {
        closes += 1;
      },
    };
    const result = await createMothAdapter({
      endpoint: { kind: "unix", path: "/tmp/moth.sock" },
      transportFactory: { connect: async () => ({ ok: true, value: transport }) },
      requestTimeoutMs: 5,
      pollingIntervalMs: 60_000,
    }).connect({ signal: signal() });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "timeout" }) });
    await wait(35);
    expect(closes).toBe(1);
  });

  it("negotiates, maps getState, and advertises real unsupported gaps", async () => {
    const calls: string[] = [];
    const transport: MothTransport = {
      async request(method) {
        calls.push(method);
        if (method === "version") {
          return { ok: true, value: { protocol: MOTH_DAEMON_PROTOCOL, daemon: "0.5.0" } };
        }
        return {
          ok: true,
          value: {
            ready: true,
            walletName: "private-wallet",
            networkId: "undeployed",
            synced: false,
            syncProgress: {
              percentage: 42,
              etaSeconds: 12,
              shieldedSynced: false,
              unshieldedSynced: true,
              dustSynced: false,
              slowest: "shielded",
            },
            balances: {
              shielded: { NIGHT: "10" },
              unshielded: { NIGHT: "2" },
              dust: "3",
            },
          },
        };
      },
      async close() {},
    };
    const factory: MothTransportFactory = { connect: async () => ({ ok: true, value: transport }) };
    const connected = await createMothAdapter({
      endpoint: { kind: "unix", path: "/tmp/moth.sock" },
      transportFactory: factory,
      now: () => "2026-08-18T12:00:00.000Z",
      pseudonymKey: new Uint8Array(32).fill(7),
      pollingIntervalMs: 60_000,
    }).connect({ signal: signal() });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(connected.value.descriptor.sessionId).toMatch(/^moth-session-/);
    expect(calls).toEqual(["version", "getState"]);
    expect(connected.value.descriptor.runtime.surface).toBe("daemon");
    expect(connected.value.descriptor.runtime.versions).toContainEqual({
      subject: "moth-daemon",
      version: "0.5.0",
    });
    expect(
      connected.value.descriptor.capabilities.find(
        (capability) => capability.id === "addresses.read",
      )?.support.state,
    ).toBe("unsupported");
    const first = await connected.value[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    if (first.done) return;
    expect(first.value.kind).toBe("snapshot");
    if (first.value.kind !== "snapshot") return;
    expect(first.value.meta.sessionId).toBe(connected.value.descriptor.sessionId);
    expect(first.value.snapshot.lifecycle?.state).toBe("ready");
    expect(first.value.snapshot.sync?.state).toBe("syncing");
    expect(first.value.snapshot.balances).toHaveLength(3);
    expect(first.value.snapshot.balances?.[0]?.assetId).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(first.value.snapshot.balances?.[0]?.amount).toBe("10");
    expect(first.value.snapshot.balances?.[2]).toEqual({
      assetId: "DUST",
      domain: "dust",
      amount: "3",
    });
    const snapshot = await connected.value.request({ kind: "snapshot", requestId: "snap-1" });
    expect(snapshot.ok).toBe(true);
    const invoke = await connected.value.request({
      kind: "invoke",
      requestId: "invoke-1",
      operationId: "transaction.submit",
      operation: { kind: "transaction.submit", artifact: {} },
    });
    expect(invoke.ok).toBe(false);
    if (!invoke.ok) expect(invoke.error.code).toBe("unsupported");
    await connected.value.request({ kind: "cancel", requestId: "cancel-1", operationId: "x" });
  });

  it("maps protocol mismatch and RPC authorization failures without leaking payloads", async () => {
    const transport: MothTransport = {
      async request(method) {
        if (method === "version") {
          return { ok: true, value: { protocol: "moth-wallet-daemon/0", daemon: "0.5.0" } };
        }
        return {
          ok: false,
          error: { code: "unauthorized", message: "token=secret", retryable: false },
        };
      },
      async close() {},
    };
    const result = await createMothAdapter({
      endpoint: { kind: "tcp", host: "127.0.0.1", port: 31337, token: "secret" },
      transportFactory: { connect: async () => ({ ok: true, value: transport }) },
    }).connect({ signal: signal() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("incompatible");
      expect(result.error.message).not.toContain("secret");
      expect(result.error.raw).toBeUndefined();
    }
  });
});
