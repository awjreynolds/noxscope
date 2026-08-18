import { RECORDING_LIMITS } from "@noxscope/core";
import type { Result } from "@noxscope/protocol";

const DATABASE_NAME = "noxscope-recordings";
const DATABASE_VERSION = 1;
const STORE_NAME = "recordings";

export interface RecordingStoreEntry {
  readonly id?: string;
  readonly name: string;
  readonly createdAt?: string;
  readonly bytes: Uint8Array;
  readonly recordCount?: number;
}

export interface RecordingSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly recordCount: number;
}

export type StoredRecording = Omit<RecordingSummary, "bytes"> & {
  readonly bytes: Uint8Array;
};

export interface RecordingStore {
  save(entry: RecordingStoreEntry): Promise<Result<RecordingSummary>>;
  list(): Promise<Result<readonly RecordingSummary[]>>;
  load(id: string): Promise<Result<StoredRecording>>;
  delete(id: string): Promise<Result<void>>;
}

export interface MemoryRecordingStoreOptions {
  readonly maxBytes?: number;
  readonly now?: () => string;
}

export interface IndexedDbRecordingStoreOptions {
  readonly databaseName?: string;
  readonly indexedDB?: IDBFactory;
  readonly now?: () => string;
}

interface StoredRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly bytes: ArrayBuffer;
  readonly recordCount: number;
}

const DEFAULT_MAX_BYTES = RECORDING_LIMITS.maxFileBytes * 4;

export function createMemoryRecordingStore(
  options: MemoryRecordingStoreOptions = {},
): RecordingStore {
  const rows = new Map<string, StoredRow>();
  let counter = 0;
  const now = options.now ?? (() => new Date().toISOString());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    async save(entry) {
      const prepared = prepareEntry(
        entry,
        () => `recording-${String(++counter).padStart(4, "0")}`,
        now,
      );
      if (!prepared.ok) return prepared;
      const previous = rows.get(prepared.value.id);
      const currentBytes = totalBytes(rows) - (previous?.bytes.byteLength ?? 0);
      if (currentBytes + prepared.value.bytes.byteLength > maxBytes) {
        return quotaError();
      }
      rows.set(prepared.value.id, prepared.value);
      return { ok: true, value: summary(prepared.value) };
    },
    async list() {
      return {
        ok: true,
        value: Object.freeze([...rows.values()].map(summary)),
      };
    },
    async load(id) {
      if (typeof id !== "string" || id.length === 0) return invalidId();
      const row = rows.get(id);
      if (row === undefined) return missing(id);
      return { ok: true, value: stored(row) };
    },
    async delete(id) {
      if (typeof id !== "string" || id.length === 0) return invalidId();
      rows.delete(id);
      return { ok: true, value: undefined };
    },
  };
}

export function createIndexedDbRecordingStore(
  options: IndexedDbRecordingStoreOptions = {},
): RecordingStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const databaseName = options.databaseName ?? DATABASE_NAME;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async save(entry) {
      const prepared = prepareEntry(entry, randomId, now);
      if (!prepared.ok) return prepared;
      const database = await openDatabase(factory, databaseName);
      if (!database.ok) return database;
      try {
        await transaction(database.value, "readwrite", (store) => {
          store.put(prepared.value);
        });
        return { ok: true, value: summary(prepared.value) };
      } catch (cause) {
        return mapStorageError(cause);
      } finally {
        database.value.close();
      }
    },
    async list() {
      const database = await openDatabase(factory, databaseName);
      if (!database.ok) return database;
      try {
        const rows = await request<StoredRow[]>(database.value, "readonly", (store) =>
          store.getAll(),
        );
        return { ok: true, value: Object.freeze(rows.map(summary)) };
      } catch (cause) {
        return mapStorageError(cause);
      } finally {
        database.value.close();
      }
    },
    async load(id) {
      if (typeof id !== "string" || id.length === 0) return invalidId();
      const database = await openDatabase(factory, databaseName);
      if (!database.ok) return database;
      try {
        const row = await request<StoredRow | undefined>(database.value, "readonly", (store) =>
          store.get(id),
        );
        return row === undefined ? missing(id) : { ok: true, value: stored(row) };
      } catch (cause) {
        return mapStorageError(cause);
      } finally {
        database.value.close();
      }
    },
    async delete(id) {
      if (typeof id !== "string" || id.length === 0) return invalidId();
      const database = await openDatabase(factory, databaseName);
      if (!database.ok) return database;
      try {
        await transaction(database.value, "readwrite", (store) => {
          store.delete(id);
        });
        return { ok: true, value: undefined };
      } catch (cause) {
        return mapStorageError(cause);
      } finally {
        database.value.close();
      }
    },
  };
}

function prepareEntry(
  entry: RecordingStoreEntry,
  createId: () => string,
  now: () => string,
): Result<StoredRow> {
  try {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      entry.name.trim().length === 0 ||
      entry.name.length > 160 ||
      !(entry.bytes instanceof Uint8Array) ||
      entry.bytes.byteLength === 0 ||
      entry.bytes.byteLength > RECORDING_LIMITS.maxFileBytes
    ) {
      return invalidEntry();
    }
    const id = entry.id ?? createId();
    const createdAt = entry.createdAt ?? now();
    if (typeof id !== "string" || id.length === 0 || id.length > 160) return invalidEntry();
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return invalidEntry();
    const count = entry.recordCount ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) return invalidEntry();
    const bytes = entry.bytes.slice();
    return {
      ok: true,
      value: { id, name: entry.name, createdAt, bytes: bytes.buffer, recordCount: count },
    };
  } catch {
    return invalidEntry();
  }
}

function randomId(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function")
    return `recording-${cryptoObject.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (typeof cryptoObject?.getRandomValues !== "function")
    throw new Error("secure randomness unavailable");
  cryptoObject.getRandomValues(bytes);
  return `recording-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function summary(row: StoredRow): RecordingSummary {
  return Object.freeze({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    bytes: row.bytes.byteLength,
    recordCount: row.recordCount,
  });
}

function stored(row: StoredRow): StoredRecording {
  return Object.freeze({ ...summary(row), bytes: new Uint8Array(row.bytes).slice() });
}

function totalBytes(rows: Map<string, StoredRow>): number {
  let total = 0;
  for (const row of rows.values()) total += row.bytes.byteLength;
  return total;
}

function openDatabase(
  factory: IDBFactory | undefined,
  databaseName: string,
): Promise<Result<IDBDatabase>> {
  if (factory === undefined) return Promise.resolve(unavailable("IndexedDB is unavailable"));
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, DATABASE_VERSION);
    } catch (cause) {
      resolve(mapStorageError(cause));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve({ ok: true, value: request.result });
    request.onerror = () => resolve(mapStorageError(request.error));
    request.onblocked = () =>
      resolve({
        ok: false,
        error: {
          code: "failed",
          message: "Recording database upgrade is blocked",
          retryable: true,
        },
      });
  });
}

function request<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
      const requestValue = operation(transaction.objectStore(STORE_NAME));
      requestValue.onsuccess = () => resolve(requestValue.result as T);
      requestValue.onerror = () => reject(requestValue.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Recording transaction aborted"));
    } catch (cause) {
      reject(cause);
    }
  });
}

function transaction(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = database.transaction(STORE_NAME, mode);
      operation(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Recording transaction aborted"));
    } catch (cause) {
      reject(cause);
    }
  });
}

function mapStorageError(cause: unknown): Result<never> {
  const name =
    cause instanceof DOMException ? cause.name : cause instanceof Error ? cause.name : "";
  if (name === "QuotaExceededError") return quotaError();
  if (name === "NotFoundError") return unavailable("Recording database is unavailable");
  return {
    ok: false,
    error: { code: "internal", message: "Recording storage failed", retryable: true },
  };
}

function quotaError(): Result<never> {
  return {
    ok: false,
    error: { code: "overflow", message: "Recording storage quota exceeded", retryable: true },
  };
}
function invalidEntry(): Result<never> {
  return {
    ok: false,
    error: { code: "invalid", message: "Recording storage entry is invalid", retryable: false },
  };
}
function invalidId(): Result<never> {
  return {
    ok: false,
    error: { code: "invalid", message: "Recording identifier is invalid", retryable: false },
  };
}
function missing(id: string): Result<never> {
  return {
    ok: false,
    error: { code: "unavailable", message: `Recording ${id} was not found`, retryable: false },
  };
}
function unavailable(message: string): Result<never> {
  return { ok: false, error: { code: "unavailable", message, retryable: false } };
}
