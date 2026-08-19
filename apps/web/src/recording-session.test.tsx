import { createRecorder, type Core, type CoreView } from "@noxscope/core";
import type { AdapterSanitizationManifest } from "@noxscope/core";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRecordingStore } from "./recording-store.js";
import {
  createRecordingSession,
  downloadRecording,
  readRecordingFile,
  type RecordingSessionState,
} from "./recording-session.js";

const view: CoreView = {
  runtimes: [],
  timeline: [
    {
      runtimeId: "runtime-1",
      record: {
        kind: "diagnostic-event",
        meta: {
          protocol: "noxscope/adapter/1",
          sessionId: "session-1",
          runtimeId: "runtime-1",
          streamId: "events",
          sequence: "1",
          observedAt: "2026-08-19T12:00:00.000Z",
          receivedAt: "2026-08-19T12:00:00.001Z",
        },
        event: {
          type: "diagnostic",
          name: "runtime.ready",
          category: "lifecycle",
          level: "info",
          source: "runtime",
          message: "ready",
        },
      },
    },
  ],
  ordering: "display-time-only",
};

function fakeCore(initial: CoreView = view): Core {
  return {
    async connect() {
      return { ok: true, value: "runtime-1" };
    },
    subscribe(next) {
      next(initial);
      return () => undefined;
    },
  };
}

describe("recording session", () => {
  it("captures live records, finalizes safe bytes, persists, and exposes a summary", async () => {
    const store = createMemoryRecordingStore({ now: () => "2026-08-19T12:00:02.000Z" });
    const session = createRecordingSession(fakeCore(), {
      store,
      now: () => "2026-08-19T12:00:02.000Z",
      randomValues: (bytes) => bytes.fill(7),
    });
    const changes: RecordingSessionState[] = [];
    const stopListening = session.subscribe((state) => changes.push(state));

    expect(await session.start("capture")).toMatchObject({ ok: true });
    const stopped = await session.stop();
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) throw new Error(stopped.error.message);
    expect(stopped.value.name).toBe("capture");
    expect(stopped.value.recordCount).toBe(1);
    expect((await store.load(stopped.value.id)).ok).toBe(true);
    expect(changes.some((state) => state.phase === "recording")).toBe(true);
    expect(changes.at(-1)?.phase).toBe("idle");
    stopListening();
    session.dispose();
  });

  it("publishes export storage failures so the UI can show a bounded error", async () => {
    const base = createMemoryRecordingStore();
    const store = {
      ...base,
      load: async () => ({
        ok: false as const,
        error: {
          code: "unavailable" as const,
          message: "Recording store is offline",
          retryable: true,
        },
      }),
    };
    const session = createRecordingSession(fakeCore(), { store });
    const changes: RecordingSessionState[] = [];
    session.subscribe((state) => changes.push(state));

    const exported = await session.export("recording-missing");

    expect(exported).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(changes.at(-1)).toMatchObject({
      phase: "error",
      error: { code: "unavailable", message: "Recording store is offline" },
    });
    session.dispose();
  });

  it("publishes download failures after a stored Recording is found", async () => {
    const store = createMemoryRecordingStore();
    const saved = await store.save({ name: "capture", bytes: new Uint8Array([1, 2, 3]) });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const session = createRecordingSession(fakeCore(), { store });
    const changes: RecordingSessionState[] = [];
    session.subscribe((state) => changes.push(state));

    const exported = await session.export(saved.value.id);

    expect(exported).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(changes.at(-1)).toMatchObject({ phase: "error", error: { code: "unavailable" } });
    session.dispose();
  });

  it("records deterministic provenance for every distinct runtime adapter", async () => {
    const sourceRecord = view.timeline[0]!.record;
    if (sourceRecord.kind !== "diagnostic-event") throw new Error("fixture is not diagnostic");
    const secondRecord = {
      ...sourceRecord,
      meta: {
        ...sourceRecord.meta,
        sessionId: "session-b",
        runtimeId: "runtime-b",
      },
    };
    const multiRuntime: CoreView = {
      ...view,
      runtimes: [
        runtimeView("session-a", "runtime-a", "adapter.alpha", "1.0.0"),
        runtimeView("session-b", "runtime-b", "adapter.beta", "2.0.0"),
      ],
      timeline: [
        view.timeline[0]!,
        {
          runtimeId: "runtime-b",
          record: secondRecord,
        },
      ],
    };
    const store = createMemoryRecordingStore({ now: () => "2026-08-19T12:00:00.000Z" });
    const session = createRecordingSession(fakeCore(multiRuntime), {
      store,
      now: () => "2026-08-19T12:00:02.000Z",
      randomValues: (bytes) => bytes.fill(3),
    });
    expect(await session.start("multi")).toMatchObject({ ok: true });
    const stopped = await session.stop();
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) throw new Error(stopped.error.message);
    const loaded = await store.load(stopped.value.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const text = new TextDecoder().decode(loaded.value.bytes);
    expect(text.indexOf('"id":"adapter.alpha"')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('"id":"adapter.beta"')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('"id":"adapter.alpha"')).toBeLessThan(text.indexOf('"id":"adapter.beta"'));
    const fresh = createRecordingSession(fakeCore(), {
      store,
      randomValues: (bytes) => bytes.fill(11),
    });
    expect(await fresh.load(stopped.value.id)).toMatchObject({ ok: true });
    fresh.dispose();
    session.dispose();
  });

  it("imports an empty-live Recording in a fresh session through the trusted default provenance", async () => {
    const store = createMemoryRecordingStore({ now: () => "2026-08-19T12:00:00.000Z" });
    const source = createRecordingSession(fakeCore(), {
      store,
      now: () => "2026-08-19T12:00:02.000Z",
      randomValues: (bytes) => bytes.fill(12),
    });
    expect(await source.start("empty-live")).toMatchObject({ ok: true });
    const saved = await source.stop();
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const fresh = createRecordingSession(fakeCore(), {
      store,
      randomValues: (bytes) => bytes.fill(13),
    });
    expect(await fresh.load(saved.value.id)).toMatchObject({ ok: true });
    fresh.dispose();
    source.dispose();
  });

  it("rejects an unknown policy even when the file is otherwise a valid Recording", async () => {
    const foreignManifest: AdapterSanitizationManifest = {
      adapter: { id: "adapter.foreign", version: "9.0.0", sourceVersions: ["foreign"] },
      policy: { id: "unknown.policy", version: "9.0.0", digest: "unknown" },
      projections: [],
    };
    const recorder = createRecorder({
      now: () => "2026-08-19T12:00:02.000Z",
      sanitization: { manifest: foreignManifest, pseudonymKey: new Uint8Array(32).fill(14) },
    });
    const finalized = await recorder.finalize();
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(finalized.error.message);
    const store = createMemoryRecordingStore();
    const saved = await store.save({ name: "foreign", bytes: finalized.value.bytes });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const fresh = createRecordingSession(fakeCore(), { store });
    expect(await fresh.load(saved.value.id)).toMatchObject({
      ok: false,
      error: { code: "incompatible" },
    });
    fresh.dispose();
  });

  it("imports hostile input through the bounded parser and enters explicit offline replay", async () => {
    const store = createMemoryRecordingStore({ now: () => "2026-08-19T12:00:00.000Z" });
    const source = createRecordingSession(fakeCore(), {
      store,
      now: () => "2026-08-19T12:00:02.000Z",
      randomValues: (bytes) => bytes.fill(4),
    });
    expect(await source.start("source")).toMatchObject({ ok: true });
    const saved = await source.stop();
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const loaded = await store.load(saved.value.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);

    const session = createRecordingSession(fakeCore(), {
      store: createMemoryRecordingStore(),
      randomValues: (bytes) => bytes.fill(5),
    });
    const namedFile = Object.assign(new Blob([loaded.value.bytes.slice().buffer as ArrayBuffer]), {
      name: "imported.noxscope",
    });
    const imported = await session.importFile(namedFile);
    expect(imported.ok).toBe(true);
    const denied = await session.requestOperation({ kind: "invoke" });
    expect(denied.ok ? undefined : denied.error.code).toBe("unsupported");
    const recordingWhileOffline = await session.start();
    expect(recordingWhileOffline.ok ? undefined : recordingWhileOffline.error.code).toBe(
      "rejected",
    );

    const tooLarge = { size: 512 * 1024 * 1024 + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    const bounded = await readRecordingFile(tooLarge);
    expect(bounded).toMatchObject({ ok: false, error: { code: "overflow" } });
    expect((tooLarge.arrayBuffer as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    const failedImport = await session.importFile(tooLarge);
    expect(failedImport).toMatchObject({ ok: false, error: { code: "overflow" } });
    const restarted = await session.start("restarted");
    expect(restarted).toMatchObject({ ok: true });
    expect((await session.stop()).ok).toBe(true);
    expect((await session.requestOperation({ kind: "invoke" })).ok).toBe(false);
    source.dispose();
    session.dispose();
  });

  it("rejects load and import transitions while recording and leaves no active capture behind", async () => {
    const session = createRecordingSession(fakeCore(), {
      store: createMemoryRecordingStore(),
      randomValues: (bytes) => bytes.fill(6),
    });
    expect(await session.start()).toMatchObject({ ok: true });
    expect(await session.load("recording-unknown")).toMatchObject({
      ok: false,
      error: { code: "rejected" },
    });
    expect(await session.importFile(new Blob([new Uint8Array([1])]))).toMatchObject({
      ok: false,
      error: { code: "rejected" },
    });
    expect((await session.stop()).ok).toBe(true);
    expect(await session.stop()).toMatchObject({ ok: false, error: { code: "rejected" } });
    session.dispose();
  });

  it("supersedes deferred imports safely when a new live recording starts and stops", async () => {
    const gate = deferred<ArrayBuffer>();
    const file = { size: 1, arrayBuffer: () => gate.promise } as unknown as Blob;
    const session = createRecordingSession(fakeCore(), {
      store: createMemoryRecordingStore(),
      randomValues: (bytes) => bytes.fill(9),
    });
    const pending = session.importFile(file);
    await Promise.resolve();
    expect(await session.start("live-after-import")).toMatchObject({ ok: true });
    expect((await session.stop()).ok).toBe(true);
    gate.resolve(new ArrayBuffer(1));
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect((await session.start("restart")).ok).toBe(true);
    expect((await session.stop()).ok).toBe(true);
    const closeGate = deferred<ArrayBuffer>();
    const closePending = session.importFile({
      size: 1,
      arrayBuffer: () => closeGate.promise,
    } as Blob);
    session.closeOffline();
    closeGate.resolve(new ArrayBuffer(1));
    await expect(closePending).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    session.dispose();
  });

  it("supersedes deferred loads safely when a new live recording starts", async () => {
    const gate =
      deferred<Awaited<ReturnType<ReturnType<typeof createMemoryRecordingStore>["load"]>>>();
    const base = createMemoryRecordingStore();
    const store = { ...base, load: () => gate.promise };
    const session = createRecordingSession(fakeCore(), {
      store,
      randomValues: (bytes) => bytes.fill(10),
    });
    const pending = session.load("deferred");
    await Promise.resolve();
    expect(await session.start("live-after-load")).toMatchObject({ ok: true });
    expect((await session.stop()).ok).toBe(true);
    gate.resolve({
      ok: false,
      error: { code: "unavailable", message: "late load", retryable: false },
    });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    session.dispose();
  });

  it("observes append overflow, reports it, and does not save an empty Recording", async () => {
    const sourceRecord = view.timeline[0]!.record;
    if (sourceRecord.kind !== "diagnostic-event" || sourceRecord.event.type !== "diagnostic") {
      throw new Error("fixture is not diagnostic");
    }
    const oversizedView: CoreView = {
      ...view,
      timeline: [
        {
          ...view.timeline[0]!,
          record: {
            ...sourceRecord,
            event: {
              ...sourceRecord.event,
              message: "x".repeat(300_000),
            },
          },
        },
      ],
    };
    const store = createMemoryRecordingStore();
    const session = createRecordingSession(fakeCore(oversizedView), {
      store,
      randomValues: (bytes) => bytes.fill(8),
    });
    expect(await session.start("overflow")).toMatchObject({ ok: true });
    const stopped = await session.stop();
    expect(stopped).toMatchObject({ ok: false, error: { code: "overflow" } });
    expect(await store.list()).toMatchObject({ ok: true, value: [] });
    session.dispose();
  });

  it("revokes a temporary download URL and removes the anchor", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const revoked: string[] = [];
    const result = downloadRecording(new Uint8Array([1, 2]), "capture.noxscope", {
      document: {
        body: { append } as unknown as HTMLElement,
        createElement: () => ({
          click,
          remove,
          set href(value: string) {
            void value;
          },
          set download(value: string) {
            void value;
          },
          hidden: false,
        }),
      } as unknown as Document,
      createObjectURL: () => "blob:test",
      revokeObjectURL: (url) => revoked.push(url),
    });
    expect(result.ok).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revoked).toEqual(["blob:test"]);
  });

  it("contains hostile download DOM and File traps", async () => {
    expect(() =>
      downloadRecording(new Uint8Array([1]), "capture.noxscope", {
        document: {
          body: {
            append() {
              throw new Error("hostile append");
            },
          } as unknown as HTMLElement,
          createElement: () => {
            throw new Error("hostile create");
          },
        } as unknown as Document,
        createObjectURL: () => "blob:hostile",
        revokeObjectURL: () => undefined,
      }),
    ).not.toThrow();

    const hostile = new Blob([new Uint8Array([1])]);
    Object.defineProperty(hostile, "size", {
      configurable: true,
      get() {
        throw new Error("hostile size");
      },
    });
    await expect(readRecordingFile(hostile)).resolves.toMatchObject({ ok: false });

    const deceptive = {
      size: 1,
      arrayBuffer: async () => ({ byteLength: 1, length: 1, 0: 7 }),
    } as unknown as Blob;
    await expect(readRecordingFile(deceptive)).resolves.toMatchObject({ ok: false });

    const hostileThenable = {
      size: 1,
      arrayBuffer: () => ({
        then() {
          throw new Error("hostile thenable");
        },
      }),
    } as unknown as Blob;
    await expect(readRecordingFile(hostileThenable)).resolves.toMatchObject({ ok: false });
  });
});

function runtimeView(
  sessionId: string,
  runtimeId: string,
  adapterId: string,
  adapterVersion: string,
) {
  return {
    descriptor: {
      protocol: "noxscope/adapter/1" as const,
      sessionId,
      runtimeId,
      adapter: { id: adapterId, version: adapterVersion },
      runtime: {
        surface: "sdk" as const,
        identifiers: [],
        versions: [],
      },
      capabilities: [],
    },
    status: "observing" as const,
    capabilities: [],
    records: [],
    failures: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
