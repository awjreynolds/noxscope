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
import {
  DEFAULT_RECORDING_MANIFEST,
  RECORDING_POLICY,
  defaultRecordingProvenanceRegistry,
  preflightRecordingProvenance,
  type RecordingProvenanceRegistry,
} from "./recording-provenance.js";

export interface RecordingSessionOptions {
  readonly store?: RecordingStore;
  readonly now?: () => string;
  /** Injected only for deterministic tests; production uses browser crypto. */
  readonly randomValues?: (bytes: Uint8Array) => Uint8Array;
  /** Checked-in/local adapter manifests trusted for importing portable Recordings. */
  readonly provenanceRegistry?: RecordingProvenanceRegistry;
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

interface TransitionToken {
  readonly kind: "import" | "load";
  readonly epoch: number;
}

export function createRecordingSession(
  core: Core,
  options: RecordingSessionOptions = {},
): RecordingSession {
  const store =
    options.store ??
    createMemoryRecordingStore(options.now === undefined ? {} : { now: options.now });
  const now = options.now ?? (() => new Date().toISOString());
  const randomValues = options.randomValues ?? secureRandomValues;
  const provenanceRegistry = options.provenanceRegistry ?? defaultRecordingProvenanceRegistry();
  const listeners = new Set<(state: RecordingSessionState) => void>();
  let currentView: CoreView = { runtimes: [], timeline: [], ordering: "display-time-only" };
  let current: RecordingSessionState = { phase: "idle", summaries: [] };
  let recorder: Recorder | undefined;
  let recordingContext: RecordingSanitizationContext | undefined;
  let recordingName = "noxscope-recording";
  let acceptedKeys = new Set<string>();
  let pendingKeys = new Set<string>();
  let appendTail: Promise<void> = Promise.resolve();
  let appendFailure: NoxscopeError | undefined;
  let disposed = false;
  let transitionEpoch = 0;
  let activeTransition: TransitionToken | undefined;
  let unsubscribeCore: () => void = () => undefined;

  const publish = (next: RecordingSessionState): void => {
    current = next;
    for (const listener of listeners) listener(current);
  };

  const receiveView = (next: CoreView): void => {
    currentView = next;
    const activeRecorder = recorder;
    if (
      current.phase !== "recording" ||
      activeRecorder === undefined ||
      appendFailure !== undefined
    )
      return;
    for (const item of next.timeline) {
      const key = recordKey(item.runtimeId, item.record);
      if (acceptedKeys.has(key) || pendingKeys.has(key)) continue;
      pendingKeys.add(key);
      appendTail = appendTail
        .then(async () => {
          let result: Result<void>;
          try {
            result = await activeRecorder.append(item.record);
          } catch {
            result = fail("internal", "Recording append failed", true);
          }
          pendingKeys.delete(key);
          if (result.ok) {
            acceptedKeys.add(key);
            return;
          }
          appendFailure ??= result.error;
          publish({ ...current, error: appendFailure });
        })
        .catch(() => undefined);
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

  function failedState(error: NoxscopeError): RecordingSessionState {
    return { phase: "error", summaries: current.summaries, error };
  }

  function beginTransition(kind: TransitionToken["kind"]): Result<TransitionToken> {
    if (activeTransition !== undefined) {
      return fail("rejected", "Another Recording transition is in progress", false);
    }
    const token = { kind, epoch: transitionEpoch } as const;
    activeTransition = token;
    return { ok: true, value: token };
  }

  function isCurrentTransition(token: TransitionToken): boolean {
    return activeTransition === token && transitionEpoch === token.epoch && !disposed;
  }

  function finishTransition(token: TransitionToken): void {
    if (activeTransition === token) activeTransition = undefined;
  }

  function supersedeTransitions(): void {
    transitionEpoch += 1;
    activeTransition = undefined;
  }

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
      supersedeTransitions();
      const key = createPseudonymKey(randomValues);
      if (!key.ok) {
        publish({ ...current, phase: "error", error: key.error });
        return key;
      }
      recordingName = name;
      const manifests = manifestsFor(currentView);
      const registered = provenanceRegistry.register(manifests);
      if (!registered.ok) {
        publish({ ...current, phase: "error", error: registered.error });
        return registered;
      }
      recordingContext = {
        manifest: manifests[0]!,
        adapters: manifests,
        pseudonymKey: key.value,
      };
      recorder = createRecorder({ now, sanitization: recordingContext });
      acceptedKeys = new Set();
      pendingKeys = new Set();
      appendTail = Promise.resolve();
      appendFailure = undefined;
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
      recordingContext = undefined;
      await appendTail;
      const exported = await activeRecorder.finalize();
      if (!exported.ok) {
        publish(failedState(exported.error));
        return exported;
      }
      if (appendFailure !== undefined) {
        const failure = appendFailure;
        appendFailure = undefined;
        acceptedKeys = new Set();
        pendingKeys = new Set();
        publish({ phase: "error", summaries: current.summaries, error: failure });
        return { ok: false, error: failure };
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
      const begun = beginTransition("import");
      if (!begun.ok) return begun;
      const token = begun.value;
      try {
        const read = await readRecordingFile(file);
        if (!isCurrentTransition(token)) return staleTransition();
        if (!read.ok) {
          publish(failedState(read.error));
          return read;
        }
        const imported = await importBytes(read.value);
        if (!isCurrentTransition(token)) return staleTransition();
        if (!imported.ok) {
          publish(failedState(imported.error));
          return imported;
        }
        const importedName = fileName(file);
        if (!isCurrentTransition(token)) return staleTransition();
        const saved = await store.save({
          name: validName(importedName ?? "") ? importedName! : "imported-recording",
          bytes: read.value,
          recordCount: imported.value.imported.records.length,
        });
        if (!isCurrentTransition(token)) {
          if (saved.ok) {
            try {
              await store.delete(saved.value.id);
            } catch {
              // A superseded import must never overwrite live state; cleanup is best effort.
            }
          }
          return staleTransition();
        }
        if (!saved.ok) {
          publish(failedState(saved.error));
          return saved;
        }
        const summaries = await summariesOrCurrent();
        if (!isCurrentTransition(token)) {
          try {
            await store.delete(saved.value.id);
          } catch {
            // A superseded import must never overwrite live state; cleanup is best effort.
          }
          return staleTransition();
        }
        publish({
          phase: "offline",
          summaries,
          offline: { name: saved.value.name, imported: imported.value.imported },
        });
        return saved;
      } finally {
        finishTransition(token);
      }
    },
    async load(id) {
      if (disposed) return fail("cancelled", "Recording session is disposed", false);
      if (current.phase === "recording" || current.phase === "finalizing") {
        return fail("rejected", "Stop the active Recording before loading", false);
      }
      const begun = beginTransition("load");
      if (!begun.ok) return begun;
      const token = begun.value;
      try {
        const loaded = await store.load(id);
        if (!isCurrentTransition(token)) return staleTransition();
        if (!loaded.ok) {
          publish(failedState(loaded.error));
          return loaded;
        }
        const imported = await importBytes(loaded.value.bytes);
        if (!isCurrentTransition(token)) return staleTransition();
        if (!imported.ok) {
          publish(failedState(imported.error));
          return imported;
        }
        const summaries = await summariesOrCurrent();
        if (!isCurrentTransition(token)) return staleTransition();
        publish({
          phase: "offline",
          summaries,
          offline: { name: loaded.value.name, imported: imported.value.imported },
        });
        return { ok: true, value: undefined };
      } finally {
        finishTransition(token);
      }
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
      supersedeTransitions();
      if (current.phase !== "offline") return;
      publish({ phase: "idle", summaries: current.summaries });
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      supersedeTransitions();
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
    const provenance = preflightRecordingProvenance(bytes);
    if (!provenance.ok) return provenance;
    const resolved = provenanceRegistry.resolve(provenance.value);
    if (!resolved.ok) return resolved;
    const manifests = resolved.value;
    const context = {
      manifest: manifests[0]!,
      adapters: manifests,
      pseudonymKey: createEphemeralKey(randomValues),
    };
    if (!context.pseudonymKey.ok) return context.pseudonymKey;
    const imported = await importRecording(bytes, {
      sanitization: {
        manifest: context.manifest,
        adapters: context.adapters,
        pseudonymKey: context.pseudonymKey.value,
      },
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
    if (!(buffer instanceof ArrayBuffer)) {
      return fail("invalid", "Recording file did not return binary data", false);
    }
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
  let url: string | undefined;
  let anchor: HTMLAnchorElement | undefined;
  try {
    url = env.value.createObjectURL(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }),
    );
    anchor = env.value.document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.hidden = true;
    if (env.value.document.body === null) throw new Error("document body is unavailable");
    env.value.document.body.append(anchor);
    anchor.click();
    return { ok: true, value: undefined };
  } catch {
    return fail("internal", "Recording download failed", true);
  } finally {
    try {
      anchor?.remove();
    } catch {
      // Hostile DOM implementations cannot prevent URL cleanup from being attempted.
    }
    if (url !== undefined) {
      try {
        env.value.revokeObjectURL(url);
      } catch {
        // URL cleanup is best-effort after the browser has accepted the download.
      }
    }
  }
}

function manifestsFor(view: CoreView): readonly AdapterSanitizationManifest[] {
  const manifests = view.runtimes.map((runtime) => ({
    adapter: {
      ...runtime.descriptor.adapter,
      sourceVersions: runtime.descriptor.runtime.versions
        .map((version) => `${version.subject}@${version.version}`)
        .sort(),
    },
    policy: RECORDING_POLICY,
    projections: [],
  }));
  return manifests.length === 0 ? [DEFAULT_RECORDING_MANIFEST] : manifests;
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
  try {
    if (typeof File !== "undefined" && file instanceof File) return file.name;
    const named = file as Blob & { readonly name?: unknown };
    return typeof named.name === "string" ? named.name : undefined;
  } catch {
    return undefined;
  }
}

function withoutError(state: RecordingSessionState): RecordingSessionState {
  const next = { ...state };
  delete next.error;
  return next;
}

function offlineDenied(): Result<never> {
  return fail("unsupported", "Offline replay cannot invoke runtime operations", false);
}

function staleTransition(): Result<never> {
  return fail("cancelled", "Recording transition was superseded", false);
}

function fail<T>(code: NoxscopeError["code"], message: string, retryable: boolean): Result<T> {
  return { ok: false, error: { code, message, retryable } };
}
