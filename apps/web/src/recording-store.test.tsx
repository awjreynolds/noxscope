import { describe, expect, it } from "vitest";
import { createMemoryRecordingStore, type RecordingStoreEntry } from "./recording-store.js";

describe("memory RecordingStore", () => {
  it("detaches bytes on save and load", async () => {
    const store = createMemoryRecordingStore({ now: () => "2026-08-19T12:00:00.000Z" });
    const source = new Uint8Array([1, 2, 3]);
    const saved = await store.save({ name: "session", bytes: source, recordCount: 2 });
    expect(saved.ok).toBe(true);
    source[0] = 99;

    if (!saved.ok) throw new Error("save failed");
    const loaded = await store.load(saved.value.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("load failed");
    expect([...loaded.value.bytes]).toEqual([1, 2, 3]);
    loaded.value.bytes[1] = 88;
    const loadedAgain = await store.load(saved.value.id);
    expect(loadedAgain.ok).toBe(true);
    if (!loadedAgain.ok) throw new Error("second load failed");
    expect([...loadedAgain.value.bytes]).toEqual([1, 2, 3]);
  });

  it("lists summaries, replaces by id, and deletes", async () => {
    const store = createMemoryRecordingStore({ now: () => "2026-08-19T12:00:00.000Z" });
    const first = await store.save({ name: "first", bytes: new Uint8Array([1]) });
    const second = await store.save({ name: "second", bytes: new Uint8Array([2, 3]) });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("save failed");
    const replacement = await store.save({
      id: first.value.id,
      name: "renamed",
      bytes: new Uint8Array([4]),
      recordCount: 5,
    });
    expect(replacement.ok).toBe(true);
    const listed = await store.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("list failed");
    expect(listed.value.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: first.value.id, name: "renamed" },
      { id: second.value.id, name: "second" },
    ]);
    expect((await store.delete(second.value.id)).ok).toBe(true);
    expect((await store.load(second.value.id)).ok).toBe(false);
  });

  it("returns a bounded quota error without changing stored data", async () => {
    const store = createMemoryRecordingStore({ maxBytes: 2 });
    const result = await store.save({ name: "too-large", bytes: new Uint8Array([1, 2, 3]) });
    expect(result).toEqual({
      ok: false,
      error: { code: "overflow", message: "Recording storage quota exceeded", retryable: true },
    });
    expect(await store.list()).toMatchObject({ ok: true, value: [] });
  });

  it("rejects invalid detached storage input", async () => {
    const store = createMemoryRecordingStore();
    const invalid = await store.save({ name: "", bytes: new Uint8Array() });
    expect(invalid.ok).toBe(false);
  });
});

const _typeCheck: RecordingStoreEntry | undefined = undefined;
void _typeCheck;
