import type { Core, CoreView, RuntimeView } from "@noxscope/core";
import type { NoxscopeRecord } from "@noxscope/protocol";
import { useEffect, useRef, useState } from "react";
import {
  createRecordingSession,
  type RecordingSession,
  type RecordingSessionState,
} from "./recording-session.js";
import { createMemoryRecordingStore } from "./recording-store.js";

const emptyView: CoreView = {
  runtimes: [],
  timeline: [],
  ordering: "display-time-only",
};

export interface AppProps {
  readonly core: Core;
  readonly recordingSession?: RecordingSession;
}

export function App({ core, recordingSession: providedRecordingSession }: AppProps) {
  const [view, setView] = useState<CoreView>(emptyView);
  const [recordingSession, setRecordingSession] = useState<RecordingSession | undefined>(
    providedRecordingSession,
  );
  const [recording, setRecording] = useState<RecordingSessionState>({
    phase: "idle",
    summaries: [],
  });
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => core.subscribe(setView), [core]);
  useEffect(() => {
    if (providedRecordingSession !== undefined) {
      setRecordingSession(providedRecordingSession);
      return;
    }
    const owned = createRecordingSession(core, { store: createMemoryRecordingStore() });
    setRecordingSession(owned);
    return () => {
      owned.dispose();
      setRecordingSession((current) => (current === owned ? undefined : current));
    };
  }, [core, providedRecordingSession]);
  useEffect(() => {
    if (recordingSession === undefined) return;
    return recordingSession.subscribe(setRecording);
  }, [recordingSession]);

  const offline = recording.offline;

  return (
    <main className="workbench">
      <header className="topbar">
        <div>
          <p className="eyebrow">Midnight runtime observability</p>
          <h1>Noxscope</h1>
        </div>
        <div className="runtime-count">
          <strong>{view.runtimes.length}</strong>
          <span>Runtime Sessions</span>
        </div>
        <RecordingControls
          state={recording}
          disabled={recordingSession === undefined}
          onStart={() => void recordingSession?.start()}
          onStop={() => void recordingSession?.stop()}
          onImport={() => fileInput.current?.click()}
          onCloseOffline={() => recordingSession?.closeOffline()}
        />
      </header>

      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept=".noxscope,.recording,application/octet-stream"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) void recordingSession?.importFile(file);
        }}
      />

      <RecordingStatus state={recording} />

      {offline === undefined ? null : (
        <section className="offline-banner" aria-live="polite">
          <div>
            <p className="eyebrow">Offline inspection</p>
            <strong>{offline.name}</strong>
            <span>Replay-only view · no wallet, network, or runtime operations</span>
          </div>
          <button type="button" onClick={() => recordingSession?.closeOffline()}>
            Return to live view
          </button>
        </section>
      )}

      {offline !== undefined ? (
        <OfflineOverview records={offline.imported.records} />
      ) : view.runtimes.length === 0 ? (
        <section className="empty-panel">Waiting for a Runtime Session…</section>
      ) : (
        <div className="runtime-grid">
          {view.runtimes.map((runtime) => (
            <RuntimeOverview key={runtime.descriptor.sessionId} runtime={runtime} />
          ))}
        </div>
      )}

      <section className="panel timeline-panel">
        <PanelHeading kicker="Display-time projection" title="Ordered event stream" />
        <div className="timeline-head timeline-row">
          <span>Seq</span>
          <span>Runtime</span>
          <span>Kind</span>
          <span>Observation</span>
        </div>
        {(
          offline?.imported.records.map((record) => ({ runtimeId: "offline", record })) ??
          view.timeline
        ).map(({ runtimeId, record }) => (
          <div
            className="timeline-row"
            key={`${record.meta.sessionId}-${record.meta.streamId}-${record.meta.sequence}`}
          >
            <code>#{record.meta.sequence}</code>
            <span className="muted">{runtimeId}</span>
            <RecordKind record={record} />
            <strong>{recordLabel(record)}</strong>
          </div>
        ))}
      </section>

      <RecordingLibrary
        state={recording}
        disabled={recordingSession === undefined}
        onLoad={(id) => void recordingSession?.load(id)}
        onDelete={(id) => void recordingSession?.delete(id)}
        onExport={(id) => void recordingSession?.export(id)}
      />
    </main>
  );
}

function RecordingControls({
  state,
  disabled,
  onStart,
  onStop,
  onImport,
  onCloseOffline,
}: {
  readonly state: RecordingSessionState;
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onImport: () => void;
  readonly onCloseOffline: () => void;
}) {
  const recording = state.phase === "recording" || state.phase === "finalizing";
  return (
    <div className="recording-controls" aria-label="Recording controls">
      {recording ? (
        <button type="button" onClick={onStop} disabled={state.phase === "finalizing" || disabled}>
          {state.phase === "finalizing" ? "Finalizing…" : "Stop Recording"}
        </button>
      ) : (
        <button type="button" onClick={onStart} disabled={state.phase === "offline" || disabled}>
          Start Recording
        </button>
      )}
      <button type="button" onClick={onImport} disabled={recording || disabled}>
        Import Recording
      </button>
      {state.phase === "offline" ? (
        <button type="button" onClick={onCloseOffline}>
          Close Offline Mode
        </button>
      ) : null}
    </div>
  );
}

function RecordingStatus({ state }: { readonly state: RecordingSessionState }) {
  if (state.error === undefined && state.phase === "idle") return null;
  return (
    <p
      className={`recording-status recording-status-${state.phase}`}
      role="status"
      aria-live="polite"
    >
      {state.error?.message ??
        (state.phase === "recording"
          ? "Recording live canonical events"
          : state.phase === "finalizing"
            ? "Sanitizing and finalizing Recording"
            : state.phase === "offline"
              ? "Offline replay is active; runtime operations are disabled"
              : "Recording storage is unavailable")}
    </p>
  );
}

function RecordingLibrary({
  state,
  disabled,
  onLoad,
  onDelete,
  onExport,
}: {
  readonly state: RecordingSessionState;
  readonly disabled: boolean;
  readonly onLoad: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onExport: (id: string) => void;
}) {
  return (
    <section className="panel recording-library" aria-labelledby="recordings-title">
      <div className="panel-heading">
        <div>
          <p>Local-only storage</p>
          <h3 id="recordings-title">Recordings</h3>
        </div>
        <span className="muted">No automatic upload</span>
      </div>
      {state.summaries.length === 0 ? (
        <p className="muted">No saved Recordings</p>
      ) : (
        <div className="recording-list">
          {state.summaries.map((summary) => (
            <div className="recording-row" key={summary.id}>
              <div>
                <strong>{summary.name}</strong>
                <small>
                  {summary.recordCount} records · {formatBytes(summary.bytes)} · {summary.createdAt}
                </small>
              </div>
              <div className="recording-row-actions">
                <button
                  type="button"
                  onClick={() => onLoad(summary.id)}
                  disabled={state.phase === "recording" || disabled}
                >
                  Inspect
                </button>
                <button
                  type="button"
                  onClick={() => onExport(summary.id)}
                  disabled={state.phase === "offline" || disabled}
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(summary.id)}
                  disabled={state.phase === "recording" || disabled}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function OfflineOverview({ records }: { readonly records: readonly NoxscopeRecord[] }) {
  return (
    <section className="panel offline-overview" aria-label="Offline replay summary">
      <PanelHeading kicker="ImportedRecording.replay" title="Replay-only evidence" />
      <p className="muted">
        {records.length} canonical Records are available for inspection. This mode does not connect
        to Adapters or issue runtime operations.
      </p>
      <button type="button" disabled aria-disabled="true">
        Runtime operations disabled offline
      </button>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function RuntimeOverview({ runtime }: { readonly runtime: RuntimeView }) {
  const snapshot = runtime.latestSnapshot;
  return (
    <article className="runtime-card">
      <div className="runtime-title">
        <div>
          <p className="eyebrow">{runtime.descriptor.runtime.surface}</p>
          <h2>{runtime.descriptor.runtime.name ?? runtime.descriptor.runtimeId}</h2>
          <code>{runtime.descriptor.runtimeId}</code>
        </div>
        <Status value={runtime.status} />
      </div>

      <div className="card-columns">
        <section className="panel inset">
          <PanelHeading kicker="Negotiated contract" title="Capabilities" />
          <div className="capability-list">
            {runtime.capabilities.map((capability) => (
              <div className="capability-row" key={capability.id}>
                <code>{capability.id}</code>
                <span>{capability.support.state}</span>
                <Status value={capability.availability.state} />
              </div>
            ))}
          </div>
        </section>

        <section className="panel inset">
          <PanelHeading
            kicker={snapshot?.network?.id ?? "unknown network"}
            title="Three-domain sync"
          />
          <div className="sync-list">
            {snapshot?.sync?.domains?.map((domain) => (
              <SyncBar
                key={domain.domain}
                label={domainLabel(domain.domain)}
                percentage={domain.percentage}
                state={domain.state}
              />
            )) ?? <p className="muted">Unsupported or unavailable</p>}
          </div>
        </section>
      </div>

      <section className="panel inset balances-panel">
        <PanelHeading kicker="Canonical decimal amounts" title="Balances" />
        <div className="balance-grid">
          {snapshot?.balances?.map((balance) => (
            <div className="balance" key={`${balance.assetId}-${balance.domain}`}>
              <span>{balance.assetId}</span>
              <strong>{formatDecimal(balance.amount)}</strong>
              <small>{balance.domain}</small>
            </div>
          )) ?? <p className="muted">Unsupported or unavailable</p>}
        </div>
      </section>
    </article>
  );
}

function PanelHeading({ kicker, title }: { readonly kicker: string; readonly title: string }) {
  return (
    <div className="panel-heading">
      <p>{kicker}</p>
      <h3>{title}</h3>
    </div>
  );
}

function Status({ value }: { readonly value: string }) {
  return <span className={`status status-${value}`}>{value}</span>;
}

function SyncBar({
  label,
  percentage,
  state,
}: {
  readonly label: string;
  readonly percentage?: number | undefined;
  readonly state: string;
}) {
  const knownPercentage = percentage !== undefined;
  return (
    <div className="sync-row">
      <div>
        <strong>{label}</strong>
        <span>{state}</span>
      </div>
      <div className="track">
        <span
          style={{
            width: knownPercentage ? `${Math.max(0, Math.min(100, percentage))}%` : undefined,
          }}
        />
      </div>
      <code>{knownPercentage ? `${percentage}%` : "Unknown progress"}</code>
    </div>
  );
}

function RecordKind({ record }: { readonly record: NoxscopeRecord }) {
  return <span className={`record-kind kind-${record.kind}`}>{record.kind}</span>;
}

function recordLabel(record: NoxscopeRecord): string {
  if (record.kind === "snapshot") return `snapshot · ${record.snapshot.sync?.state ?? "observed"}`;
  if (record.kind === "operation") return `${record.operation.kind} · ${record.operation.phase}`;
  if (record.event.type === "diagnostic") return record.event.name;
  if (record.event.type === "capability-availability") {
    return `${record.event.capabilityId} · ${record.event.availability.state}`;
  }
  return `stream gap ${record.event.firstLostSequence}–${record.event.lastLostSequence}`;
}

function domainLabel(domain: string): string {
  if (domain === "shielded") return "Shielded";
  if (domain === "unshielded") return "Unshielded";
  if (domain === "dust") return "DUST sync";
  return domain;
}

function formatDecimal(value: string): string {
  try {
    return new Intl.NumberFormat("en-GB").format(BigInt(value));
  } catch {
    return value;
  }
}
