import {
  createRecorder,
  importRecording,
  RECORDING_LIMITS,
  type ImportedRecording,
  type Recorder,
  type RecordingSanitizationContext,
} from "@noxscope/core";
import type { AdapterSanitizationManifest } from "@noxscope/core";
import type { Core, CoreView } from "@noxscope/core";
import type { NoxscopeError, Result } from "@noxscope/protocol";
import {
  createMemoryRecordingStore,
  type RecordingStore,
  type RecordingSummary,
} from "./recording-store.js";

export interface RecordingSessionOptions {
  readonly store?: RecordingStore;
  readonly now?: () => string;
  /** Injected only for deterministic tests; production uses browser crypto. */
  readonly randomValues?: (bytes: Uint8Array) => Uint8Array;
}

export type RecordingSessionPhase = "idle" | "recording" | "finalizing" | "offline" | "error";

export interface OfflineInspection {
  readonly name: string;
  readonly imported: ImportedRecording;
}

export interface RecordingSessionState {
  readonly phase: RecordingSessionPhase;
  readonly summaries: readonly RecordingSummary[];
  readonly offline?: OfflineInspection;
  readonly error?: NoxscopeError;
}

export interface RecordingSession {
  subscribe(listener: (state: RecordingSessionState) => void): () => void;
  start(name?: string): Promise<Result<void>>;
  stop(): Promise<Result<RecordingSummary>>;
  importFile(file: Blob): Promise<Result<RecordingSummary>>;
  load(id: string): Promise<Result<void>>;
  delete(id: string): Promise<Result<void>>;
  export(id: string): Promise<Result<void>>;
  requestOperation(request: unknown): Promise<Result<never>>;
  closeOffline(): void;
  refresh(): Promise<Result<readonly RecordingSummary[]>>;
  dispose(): void;
}

export interface DownloadEnvironment {
  readonly document: Document;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
}

const POLICY = Object.freeze({ id: "noxscope.redaction", version: "1.0.0", digest: "core-v1" });
const DEFAULT_ADAPTER = Object.freeze({
  id: "noxscope.browser",
  version: "0.1.0",
  sourceVersions: ["noxscope/adapter/1"],
});

export function createRecordingSession(
  core: Core,
  options: RecordingSessionOptions = {},
): RecordingSession {
  const store =
    options.store ??
    createMemoryRecordingStore(options.now === undefined ? {} : { now: options.now });
  const now = options.now ?? (() => new Date().toISOString());
  const randomValues = options.randomValues ?? secureRandomValues;
  const listeners = new Set<(state: RecordingSessionState) => void>();
  let currentView: CoreView = { runtimes: [], timeline: [], ordering: "display-time-only" };
  let current: RecordingSessionState = { phase: "idle", summaries: [] };
  let recorder: Recorder | undefined;
  let recordingContext: RecordingSanitizationContext | undefined;
  let recordingName = "noxscope-recording";
  let seen = new Set<string>();
  let disposed = false;
  let unsubscribeCore: () => void = () => undefined;

  const publish = (next: RecordingSessionState): void => {
    current = next;
    for (const listener of listeners) listener(current);
  };

  const receiveView = (next: CoreView): void => {
    currentView = next;
    if (current.phase !== "recording" || recorder === undefined) return;
    for (const item of next.timeline) {
      const key = recordKey(item.runtimeId, item.record);
      if (seen.has(key)) continue;
      seen.add(key);
      void recorder.append(item.record);
    }
  };
  unsubscribeCore = core.subscribe(receiveView);

  const refresh = async (): Promise<Result<readonly RecordingSummary[]>> => {
    const result = await store.list();
    if (!result.ok) {
      publish({ ...current, phase: "error", error: result.error });
      return result;
    }
    publish(withoutError({ ...current, summaries: result.value }));
    return result;
  };
  void refresh();

  const session: RecordingSession = {
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    async start(name = "noxscope-recording") {
      if (disposed) return fail("cancelled", "Recording session is disposed", false);
      if (current.phase === "recording" || current.phase === "finalizing") {
        return fail("rejected", "A Recording is already in progress", false);
      }
      if (current.phase === "offline") {
        return fail("rejected", "Close offline inspection before recording", false);
      }
      if (!validName(name)) return fail("invalid", "Recording name is invalid", false);
      const key = createPseudonymKey(randomValues);
      if (!key.ok) {
        publish({ ...current, phase: "error", error: key.error });
        return key;
      }
      recordingName = name;
      recordingContext = { manifest: manifestFor(currentView), pseudonymKey: key.value };
      recorder = createRecorder({ now, sanitization: recordingContext });
      seen = new Set();
      publish(withoutError({ ...current, phase: "recording" }));
      receiveView(currentView);
      return { ok: true, value: undefined };
    },
    async stop() {
      if (disposed) return fail("cancelled", "Recording session is disposed", false);
      if (
        recorder === undefined ||
        recordingContext === undefined ||
        current.phase !== "recording"
      ) {
        return fail("rejected", "No Recording is in progress", false);
      }
      publish(withoutError({ ...current, phase: "finalizing" }));
      const activeRecorder = recorder;
      recorder = undefined;
      const context = recordingContext;
      recordingContext = undefined;
      const exported = await activeRecorder.finalize();
      if (!exported.ok) {
        publish({ ...current, phase: "error", error: exported.error });
        return exported;
      }
      const saved = await store.save({
        name: recordingName,
        bytes: exported.value.bytes,
        recordCount: exported.value.manifest.counts.records,
      });
      if (!saved.ok) {
        publish({ ...current, phase: "error", error: saved.error });
        return saved;
      }
      void context;
      const listed = await store.list();
      if (listed.ok) {
        publish({ phase: "idle", summaries: listed.value });
      } else {
        publish({ phase: "idle", summaries: [saved.value], error: listed.error });
      }
      return saved;
    },
    async importFile(file) {
      if (disposed) return fail("cancelled", "Recording session is disposed", false);
      if (current.phase === "recording" || current.phase === "finalizing") {
        return fail("rejected", "Stop the active Recording before importing", false);
      }
      const read = await readRecordingFile(file);
      if (!read.ok) {
        publish({ ...current, phase: "error", error: read.error });
        return read;
      }
      const imported = await importBytes(read.value);
      if (!imported.ok) {
        publish({ ...current, phase: "error", error: imported.error });
        return imported;
      }
      const saved = await store.save({
        name: validName(fileName(file) ?? "") ? (fileName(file) as string) : "imported-recording",
        bytes: read.value,
        recordCount: imported.value.imported.records.length,
      });
      if (!saved.ok) {
        publish({ ...current, phase: "error", error: saved.error });
        return saved;
      }
      publish({
        phase: "offline",
        summaries: await summariesOrCurrent(),
        offline: { name: saved.value.name, imported: imported.value.imported },
      });
      return saved;
    },
    async load(id) {
      if (disposed) return fail("cancelled", "Recording session is disposed", false);
      const loaded = await store.load(id);
      if (!loaded.ok) {
        publish({ ...current, phase: "error", error: loaded.error });
        return loaded;
      }
      const imported = await importBytes(loaded.value.bytes);
      if (!imported.ok) {
        publish({ ...current, phase: "error", error: imported.error });
        return imported;
      }
      publish({
        phase: "offline",
        summaries: await summariesOrCurrent(),
        offline: { name: loaded.value.name, imported: imported.value.imported },
      });
      return { ok: true, value: undefined };
    },
    async delete(id) {
      if (current.phase === "recording" || current.phase === "finalizing") {
        return fail("rejected", "Stop the active Recording before deleting", false);
      }
      const result = await store.delete(id);
      if (!result.ok) {
        publish({ ...current, phase: "error", error: result.error });
        return result;
      }
      const listed = await store.list();
      publish({
        phase: current.phase === "offline" ? "offline" : "idle",
        summaries: listed.ok ? listed.value : current.summaries,
        ...(current.offline === undefined ? {} : { offline: current.offline }),
        ...(listed.ok ? {} : { error: listed.error }),
      });
      return result;
    },
    async export(id) {
      if (current.phase === "offline") return offlineDenied();
      const loaded = await store.load(id);
      if (!loaded.ok) return loaded;
      return downloadRecording(loaded.value.bytes, loaded.value.name);
    },
    async requestOperation() {
      if (current.phase === "offline") return offlineDenied();
      return fail(
        "unsupported",
        "No runtime operation is attached to this recording session",
        false,
      );
    },
    closeOffline() {
      if (current.phase !== "offline") return;
      publish({ phase: "idle", summaries: current.summaries });
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeCore();
      recorder = undefined;
      recordingContext = undefined;
      listeners.clear();
    },
  };

  return session;

  async function importBytes(
    bytes: Uint8Array,
  ): Promise<Result<{ readonly imported: ImportedRecording }>> {
    const context = {
      manifest: manifestFor(currentView),
      pseudonymKey: createEphemeralKey(randomValues),
    };
    if (!context.pseudonymKey.ok) return context.pseudonymKey;
    const imported = await importRecording(bytes, {
      sanitization: { manifest: context.manifest, pseudonymKey: context.pseudonymKey.value },
    });
    return imported.ok ? { ok: true, value: { imported: imported.value } } : imported;
  }

  async function summariesOrCurrent(): Promise<readonly RecordingSummary[]> {
    const listed = await store.list();
    return listed.ok ? listed.value : current.summaries;
  }
}

export async function readRecordingFile(
  file: Blob,
  maxBytes = RECORDING_LIMITS.maxFileBytes,
): Promise<Result<Uint8Array>> {
  try {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > maxBytes) {
      return fail("overflow", "Recording file exceeds the import limit", false);
    }
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > maxBytes)
      return fail("overflow", "Recording file exceeds the import limit", false);
    return { ok: true, value: new Uint8Array(buffer).slice() };
  } catch {
    return fail("invalid", "Recording file could not be read", false);
  }
}

export function downloadRecording(
  bytes: Uint8Array,
  name: string,
  environment?: DownloadEnvironment,
): Result<void> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || !validName(name)) {
    return fail("invalid", "Recording download is invalid", false);
  }
  const env: Result<DownloadEnvironment> =
    environment === undefined ? browserDownloadEnvironment() : { ok: true, value: environment };
  if (!env.ok) return env;
  const url = env.value.createObjectURL(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }),
  );
  const anchor = env.value.document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  env.value.document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    env.value.revokeObjectURL(url);
  }
  return { ok: true, value: undefined };
}

function manifestFor(view: CoreView): AdapterSanitizationManifest {
  const runtime = view.runtimes[0];
  return {
    adapter:
      runtime === undefined
        ? DEFAULT_ADAPTER
        : {
            ...runtime.descriptor.adapter,
            sourceVersions: runtime.descriptor.runtime.versions.map(
              (version) => `${version.subject}@${version.version}`,
            ),
          },
    policy: POLICY,
    projections: [],
  };
}

function recordKey(
  runtimeId: string,
  record: {
    readonly meta: {
      readonly sessionId: string;
      readonly streamId: string;
      readonly sequence: string;
    };
  },
): string {
  return `${runtimeId}\u0000${record.meta.sessionId}\u0000${record.meta.streamId}\u0000${record.meta.sequence}`;
}

function createPseudonymKey(randomValues: (bytes: Uint8Array) => Uint8Array): Result<Uint8Array> {
  try {
    const key = new Uint8Array(32);
    const result = randomValues(key);
    if (!(result instanceof Uint8Array) || result.byteLength !== key.byteLength) {
      return fail("internal", "Secure recording randomness failed", true);
    }
    return { ok: true, value: key.slice() };
  } catch {
    return fail("internal", "Secure recording randomness failed", true);
  }
}

function createEphemeralKey(randomValues: (bytes: Uint8Array) => Uint8Array): Result<Uint8Array> {
  return createPseudonymKey(randomValues);
}

function secureRandomValues(bytes: Uint8Array): Uint8Array {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.getRandomValues !== "function")
    throw new Error("secure randomness unavailable");
  return cryptoObject.getRandomValues(bytes);
}

function browserDownloadEnvironment(): Result<DownloadEnvironment> {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    return fail("unavailable", "Recording downloads are unavailable", false);
  }
  return {
    ok: true,
    value: {
      document,
      createObjectURL: URL.createObjectURL.bind(URL),
      revokeObjectURL: URL.revokeObjectURL.bind(URL),
    },
  };
}

function validName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name.length <= 160 &&
    !Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return (code >= 0 && code <= 31) || code === 127;
    })
  );
}

function fileName(file: Blob): string | undefined {
  if (typeof File !== "undefined" && file instanceof File) return file.name;
  const named = file as Blob & { readonly name?: unknown };
  return typeof named.name === "string" ? named.name : undefined;
}

function withoutError(state: RecordingSessionState): RecordingSessionState {
  const next = { ...state };
  delete next.error;
  return next;
}

function offlineDenied(): Result<never> {
  return fail("unsupported", "Offline replay cannot invoke runtime operations", false);
}

function fail<T>(code: NoxscopeError["code"], message: string, retryable: boolean): Result<T> {
  return { ok: false, error: { code, message, retryable } };
}
