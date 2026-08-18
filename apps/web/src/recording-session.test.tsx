import type { Core, CoreView } from "@noxscope/core";
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
    expect((await session.requestOperation({ kind: "invoke" })).ok).toBe(false);
    session.closeOffline();
    source.dispose();
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
});
