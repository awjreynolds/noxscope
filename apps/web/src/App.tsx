import type { Core, CoreView, RuntimeView, TimelineEntry } from "@noxscope/core";
import type {
  CapabilityDeclaration,
  DustState,
  NoxscopeError,
  NoxscopeRecord,
  SanitizedRawDetail,
} from "@noxscope/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createRecordingSession,
  type RecordingSession,
  type RecordingSessionState,
} from "./recording-session.js";
import { createMemoryRecordingStore } from "./recording-store.js";

const emptyView: CoreView = { runtimes: [], timeline: [], ordering: "display-time-only" };
const LEDGER_PAGE_SIZE = 100;
const SEARCH_TEXT_LIMIT = 2048;

export interface AppProps {
  readonly core: Core;
  readonly recordingSession?: RecordingSession;
}

type RecordFilter = "all" | NoxscopeRecord["kind"];

interface IndexedTimelineEntry extends TimelineEntry {
  readonly searchText: string;
}

interface FailureEntry {
  readonly id: string;
  readonly runtime: RuntimeView;
  readonly record?: NoxscopeRecord;
  readonly error: NoxscopeError;
  readonly source: string;
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
  const [selectedSession, setSelectedSession] = useState<string>();
  const [selectedRecord, setSelectedRecord] = useState<string>();
  const [focusedFailure, setFocusedFailure] = useState<FailureEntry>();
  const [query, setQuery] = useState("");
  const [recordFilter, setRecordFilter] = useState<RecordFilter>("all");
  const [failuresOnly, setFailuresOnly] = useState(false);
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
  const entries = useMemo<IndexedTimelineEntry[]>(() => {
    const source =
      offline === undefined
        ? view.timeline
        : offline.imported.records.map((record) => ({
            runtimeId: record.meta.runtimeId,
            record,
          }));
    return source.map(indexTimelineEntry);
  }, [offline, view.timeline]);
  const runtimes = offline === undefined ? view.runtimes : [];
  const runtime =
    runtimes.find((candidate) => candidate.descriptor.sessionId === selectedSession) ?? runtimes[0];
  const failures = useMemo(() => collectFailures(runtimes), [runtimes]);
  const filteredEntries = useMemo<IndexedTimelineEntry[]>(
    () => filterEntries(entries, query, recordFilter, failuresOnly),
    [entries, failuresOnly, query, recordFilter],
  );
  const selectedEntry = useMemo<IndexedTimelineEntry | undefined>(() => {
    if (focusedFailure !== undefined && focusedFailure.record === undefined) return undefined;
    if (selectedRecord !== undefined) {
      const matching = entries.find((entry) => recordKey(entry.record) === selectedRecord);
      if (matching !== undefined) return matching;
    }
    if (offline !== undefined) return entries.at(-1);
    if (runtime === undefined) return undefined;
    return lastEntryForSession(entries, runtime.descriptor.sessionId);
  }, [entries, focusedFailure, offline, runtime, selectedRecord]);

  useEffect(() => {
    if (selectedSession !== undefined && runtime === undefined) setSelectedSession(undefined);
  }, [runtime, selectedSession]);

  const selectFailure = (failure: FailureEntry) => {
    setFocusedFailure(failure);
    setSelectedSession(failure.runtime.descriptor.sessionId);
    if (failure.record !== undefined) setSelectedRecord(recordKey(failure.record));
    else setSelectedRecord(undefined);
  };

  const selectEntry = (entry: IndexedTimelineEntry) => {
    setFocusedFailure(undefined);
    setSelectedRecord(recordKey(entry.record));
    const matching = runtimes.find(
      (candidate) => candidate.descriptor.sessionId === entry.record.meta.sessionId,
    );
    if (matching !== undefined) setSelectedSession(matching.descriptor.sessionId);
  };

  const exportRecording = async (id: string) => {
    if (recordingSession === undefined) return;
    try {
      const result = await recordingSession.export(id);
      if (!result.ok) {
        setRecording((current) => ({ ...current, phase: "error", error: result.error }));
      }
    } catch {
      setRecording((current) => ({
        ...current,
        phase: "error",
        error: { code: "internal", message: "Recording export failed", retryable: true },
      }));
    }
  };

  const relatedEntry =
    selectedEntry === undefined ? undefined : findCausedByEntry(selectedEntry, entries);

  return (
    <main className="workbench">
      <header className="topbar">
        <div className="brand-lockup">
          <p className="eyebrow">Canonical runtime observability</p>
          <h1>Noxscope</h1>
          <p className="topbar-note">Dense evidence for every observed Runtime Session.</p>
        </div>
        <div className="header-facts" aria-label="Workbench summary">
          <Fact label="Sessions" value={String(runtimes.length)} />
          <Fact label="Records" value={String(entries.length)} />
          <Fact label="Failures" value={String(failures.length)} />
        </div>
        <RecordingControls
          state={recording}
          disabled={recordingSession === undefined}
          onStart={() => void recordingSession?.start()}
          onStop={() => void recordingSession?.stop()}
          onImport={() => fileInput.current?.click()}
        />
      </header>

      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept=".noxscope,.recording,application/octet-stream"
        aria-label="Import a Noxscope recording"
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
            <span>Replay-only evidence · no wallet, network, or runtime operations</span>
          </div>
          <button type="button" onClick={() => recordingSession?.closeOffline()}>
            Return to live view
          </button>
        </section>
      )}
      <FailureStrip failures={failures} onSelect={selectFailure} />

      <div className="inspector-shell">
        {offline !== undefined ? (
          <OfflineRail name={offline.name} recordCount={entries.length} />
        ) : (
          <RuntimeRail
            runtimes={runtimes}
            selected={runtime}
            showNames={runtimes.length > 1}
            totalRecords={entries.length}
            totalFailures={failures.length}
            onSelect={(next) => {
              setFocusedFailure(undefined);
              setSelectedSession(next.descriptor.sessionId);
              setSelectedRecord(undefined);
            }}
          />
        )}
        <section className="state-pane" aria-label="Canonical runtime state">
          {offline !== undefined ? (
            <OfflineState name={offline.name} recordCount={entries.length} />
          ) : runtime === undefined ? (
            <EmptyState />
          ) : (
            <RuntimeState runtime={runtime} showName={runtimes.length === 1} />
          )}
        </section>
        <section className="ledger-pane" aria-label="Evidence ledger">
          <TraceToolbar
            query={query}
            filter={recordFilter}
            failuresOnly={failuresOnly}
            resultCount={filteredEntries.length}
            onQuery={setQuery}
            onFilter={setRecordFilter}
            onFailuresOnly={setFailuresOnly}
          />
          <TraceTable entries={filteredEntries} selected={selectedEntry} onSelect={selectEntry} />
          <RecordInspector
            entry={selectedEntry}
            runtime={runtime}
            failure={focusedFailure}
            relatedEntry={relatedEntry}
            onSelectEntry={selectEntry}
          />
        </section>
      </div>
      <RecordingLibrary
        state={recording}
        disabled={recordingSession === undefined}
        onLoad={(id) => void recordingSession?.load(id)}
        onDelete={(id) => void recordingSession?.delete(id)}
        onExport={exportRecording}
      />
    </main>
  );
}

function RuntimeRail({
  runtimes,
  selected,
  showNames,
  totalRecords,
  totalFailures,
  onSelect,
}: {
  readonly runtimes: readonly RuntimeView[];
  readonly selected: RuntimeView | undefined;
  readonly showNames: boolean;
  readonly totalRecords: number;
  readonly totalFailures: number;
  readonly onSelect: (runtime: RuntimeView) => void;
}) {
  return (
    <nav className="runtime-rail" aria-label="Runtime Sessions">
      <div className="rail-heading">
        <div>
          <p className="eyebrow">Inventory</p>
          <h2>Runtime Sessions</h2>
        </div>
        <span className="rail-count">{runtimes.length}</span>
      </div>
      {runtimes.length === 0 ? (
        <p className="rail-empty">No connected Runtime Sessions.</p>
      ) : (
        runtimes.map((candidate, index) => {
          const isSelected = selected?.descriptor.sessionId === candidate.descriptor.sessionId;
          const duplicateName =
            runtimes.filter((other) => runtimeName(other) === runtimeName(candidate)).length > 1;
          const duplicateRuntimeId =
            runtimes.filter(
              (other) => other.descriptor.runtimeId === candidate.descriptor.runtimeId,
            ).length > 1;
          const contextLabel = `${candidate.descriptor.runtimeId} · session ${candidate.descriptor.sessionId}`;
          return (
            <button
              className={`runtime-selector${isSelected ? " is-selected" : ""}`}
              key={candidate.descriptor.sessionId}
              type="button"
              aria-pressed={isSelected}
              aria-label={`Select ${runtimeName(candidate)}${
                duplicateName || duplicateRuntimeId ? ` (${contextLabel})` : ""
              }`}
              onClick={() => onSelect(candidate)}
            >
              <span className="runtime-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="runtime-selector-copy">
                <strong title={runtimeName(candidate)}>
                  {showNames ? runtimeName(candidate) : candidate.descriptor.runtimeId}
                </strong>
                <small>
                  {candidate.descriptor.runtime.surface} · {candidate.descriptor.runtimeId}
                </small>
                {duplicateName || duplicateRuntimeId ? (
                  <small>session {candidate.descriptor.sessionId}</small>
                ) : null}
                <small>
                  {candidate.latestSnapshot?.network?.id ?? "network unknown"} ·{" "}
                  {candidate.records.length} records
                </small>
              </span>
              <Status value={candidate.status} />
              {candidate.failures.length > 0 ? (
                <span className="runtime-error-count">{candidate.failures.length} errors</span>
              ) : null}
            </button>
          );
        })
      )}
      <div className="rail-summary" aria-label="Runtime inventory totals">
        <span>{totalRecords} records</span>
        <span>{totalFailures} failures</span>
      </div>
    </nav>
  );
}

function OfflineRail({
  name,
  recordCount,
}: {
  readonly name: string;
  readonly recordCount: number;
}) {
  return (
    <nav className="runtime-rail offline-rail" aria-label="Offline recording">
      <div className="rail-heading">
        <div>
          <p className="eyebrow">Replay inventory</p>
          <h2>Offline Recording</h2>
        </div>
        <span className="rail-count">{recordCount}</span>
      </div>
      <div className="offline-rail-card">
        <strong>{name}</strong>
        <span>Imported Recording</span>
        <small>All values are immutable, sanitised evidence.</small>
      </div>
      <div className="rail-summary">
        <span>{recordCount} records</span>
        <span>read-only</span>
      </div>
    </nav>
  );
}

function OfflineState({
  name,
  recordCount,
}: {
  readonly name: string;
  readonly recordCount: number;
}) {
  return (
    <div className="state-content offline-state">
      <header className="pane-heading">
        <div>
          <p className="eyebrow">ImportedRecording.replay</p>
          <h2>Replay-only evidence</h2>
          <p className="subtitle">{name}</p>
        </div>
        <Status value="offline" />
      </header>
      <div className="offline-state-card">
        <strong>{recordCount} canonical Records</strong>
        <p>
          This view cannot connect to an Adapter, mutate a wallet, or issue a runtime operation.
        </p>
        <button type="button" disabled aria-disabled="true">
          Runtime operations disabled offline
        </button>
      </div>
      <p className="empty-copy">
        Select a record in the ledger to inspect its metadata, correlations, and sanitised raw
        detail.
      </p>
    </div>
  );
}

function RuntimeState({
  runtime,
  showName,
}: {
  readonly runtime: RuntimeView;
  readonly showName: boolean;
}) {
  const snapshot = runtime.latestSnapshot;
  return (
    <div className="state-content">
      <header className="pane-heading">
        <div>
          <p className="eyebrow">Selected Runtime Session</p>
          <h2 title={runtimeName(runtime)}>
            {showName ? runtimeName(runtime) : runtime.descriptor.runtimeId}
          </h2>
          <p className="subtitle">
            {runtime.descriptor.runtime.surface} · {runtime.descriptor.adapter.id}@
            {runtime.descriptor.adapter.version}
          </p>
        </div>
        <Status value={runtime.status} />
      </header>
      <dl className="identity-facts">
        <Fact label="Runtime ID" value={runtime.descriptor.runtimeId} />
        <Fact label="Session ID" value={runtime.descriptor.sessionId} />
        <Fact label="Network" value={snapshot?.network?.id ?? "unknown"} />
        <Fact label="Freshness" value={freshnessLabel(runtime)} />
        <Fact label="Last success" value={snapshot?.freshness.lastSuccessAt ?? "unknown"} />
        <Fact label="Versions" value={versionFacts(runtime)} />
      </dl>
      <section className="state-section" aria-labelledby="sync-title">
        <SectionHeading
          kicker="Shielded · unshielded · DUST"
          title="Sync domains"
          id="sync-title"
        />
        {snapshot?.sync?.domains === undefined || snapshot.sync.domains.length === 0 ? (
          <p className="empty-copy">Sync domains are unsupported or currently unavailable.</p>
        ) : (
          <div className="sync-list">
            {snapshot.sync.domains.map((domain) => (
              <SyncDomain key={domain.domain} domain={domain} />
            ))}
          </div>
        )}
        {snapshot?.sync?.state === "unknown" ? (
          <p className="indeterminate-note">Overall sync state is explicitly unknown.</p>
        ) : null}
      </section>
      <section className="state-section" aria-labelledby="balances-title">
        <SectionHeading kicker="Canonical decimal amounts" title="Balances" id="balances-title" />
        {snapshot?.balances === undefined ? (
          <p className="empty-copy">Balances are unsupported or currently unavailable.</p>
        ) : snapshot.balances.length === 0 ? (
          <p className="empty-copy">No balances were observed.</p>
        ) : (
          <div className="balance-grid">
            {snapshot.balances.map((balance) => (
              <div className="balance-card" key={JSON.stringify([balance.assetId, balance.domain])}>
                <span>{balance.assetId}</span>
                <strong>{formatDecimal(balance.amount)}</strong>
                <small>{balance.domain}</small>
              </div>
            ))}
          </div>
        )}
      </section>
      <DustDiagnostics runtime={runtime} />
      <Capabilities capabilities={runtime.capabilities} />
    </div>
  );
}

function DustDiagnostics({ runtime }: { readonly runtime: RuntimeView }) {
  const dust = runtime.latestSnapshot?.dust;
  const capability = runtime.capabilities.find((candidate) => candidate.id.includes("dust"));
  const status = dustStatus(runtime, dust, capability);
  return (
    <section className="state-section dust-section" aria-labelledby="dust-title">
      <SectionHeading kicker="Capability evidence" title="DUST diagnostics" id="dust-title" />
      <div className="dust-grid">
        <div>
          <span className="field-label">Snapshot state</span>
          <strong>{status}</strong>
          <small>
            {dust?.progress === undefined
              ? dustStatusExplanation(status, capability)
              : `${dust.progress}% observed`}
          </small>
        </div>
        {capability === undefined ? (
          <p className="empty-copy">No DUST-specific capability declaration.</p>
        ) : (
          <CapabilityEvidence capability={capability} compact />
        )}
      </div>
    </section>
  );
}

function dustStatus(
  runtime: RuntimeView,
  dust: DustState | undefined,
  capability: CapabilityDeclaration | undefined,
): string {
  if (runtime.latestSnapshot?.freshness.state === "stale") return "stale";
  if (dust !== undefined && typeof dust === "object" && dust !== null && "state" in dust)
    return dust.state;
  if (capability?.support.state === "unsupported") return "unsupported";
  if (capability?.availability.state !== undefined && capability.availability.state !== "available")
    return "unavailable";
  return runtime.latestSnapshot === undefined ? "unavailable" : "absent";
}

function dustStatusExplanation(status: string, capability: CapabilityDeclaration | undefined) {
  if (status === "unsupported")
    return capability?.support.state === "unsupported"
      ? capability.support.reason
      : "DUST is not supported.";
  if (status === "unavailable") return "DUST state is currently unavailable.";
  if (status === "stale") return "DUST state is from a stale snapshot.";
  if (status === "absent") return "No DUST state was included in this snapshot.";
  return "Progress indeterminate";
}

function Capabilities({
  capabilities,
}: {
  readonly capabilities: readonly CapabilityDeclaration[];
}) {
  return (
    <section className="state-section" aria-labelledby="capabilities-title">
      <SectionHeading
        kicker="Support ≠ availability"
        title="Capabilities"
        id="capabilities-title"
      />
      {capabilities.length === 0 ? (
        <p className="empty-copy">No capability declarations were received.</p>
      ) : (
        <div className="capability-list">
          {capabilities.map((capability) => (
            <CapabilityEvidence capability={capability} key={capability.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function CapabilityEvidence({
  capability,
  compact = false,
}: {
  readonly capability: CapabilityDeclaration;
  readonly compact?: boolean;
}) {
  return (
    <div className={`capability-row${compact ? " compact" : ""}`}>
      <code>{capability.id}</code>
      <span className="capability-kind">{capability.kind}</span>
      <span>
        <b className={`support-${capability.support.state}`}>Support: {capability.support.state}</b>
        {capability.support.state === "unsupported" ? (
          <small>{capability.support.reason}</small>
        ) : (
          <small>v{capability.support.version}</small>
        )}
      </span>
      <span>
        <b className={`availability-${capability.availability.state}`}>
          Availability: {capability.availability.state}
        </b>
        {capability.availability.state !== "available" ? (
          <small>{capability.availability.reason}</small>
        ) : null}
      </span>
      <small className="evidence-copy">
        Evidence: {capability.support.evidence.source} · {capability.support.evidence.summary}
      </small>
    </div>
  );
}

function TraceToolbar({
  query,
  filter,
  failuresOnly,
  resultCount,
  onQuery,
  onFilter,
  onFailuresOnly,
}: {
  readonly query: string;
  readonly filter: RecordFilter;
  readonly failuresOnly: boolean;
  readonly resultCount: number;
  readonly onQuery: (value: string) => void;
  readonly onFilter: (value: RecordFilter) => void;
  readonly onFailuresOnly: (value: boolean) => void;
}) {
  return (
    <div className="trace-toolbar">
      <div className="pane-heading ledger-heading">
        <div>
          <p className="eyebrow">Display-time projection · per-stream order retained</p>
          <h2>Evidence ledger</h2>
        </div>
        <span className="result-count">{resultCount} matching</span>
      </div>
      <div className="trace-filters" aria-label="Trace filters">
        <label>
          <span>Search records</span>
          <input
            type="search"
            value={query}
            placeholder="kind, operation, stream…"
            onChange={(event) => onQuery(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Record type</span>
          <select
            value={filter}
            onChange={(event) => onFilter(event.currentTarget.value as RecordFilter)}
          >
            <option value="all">All records</option>
            <option value="snapshot">Snapshots</option>
            <option value="diagnostic-event">Diagnostics & gaps</option>
            <option value="operation">Operations</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(event) => onFailuresOnly(event.currentTarget.checked)}
          />
          <span>Failures only</span>
        </label>
      </div>
    </div>
  );
}

function TraceTable({
  entries,
  selected,
  onSelect,
}: {
  readonly entries: readonly IndexedTimelineEntry[];
  readonly selected: IndexedTimelineEntry | undefined;
  readonly onSelect: (entry: IndexedTimelineEntry) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(LEDGER_PAGE_SIZE);
  useEffect(() => setVisibleCount(LEDGER_PAGE_SIZE), [entries]);
  const visibleEntries = entries.slice(0, visibleCount);
  return (
    <section className="trace-table" aria-label="Ordered event stream">
      <div className="trace-row trace-header" role="row">
        <span>Received</span>
        <span>Runtime / stream</span>
        <span>Sequence</span>
        <span>Record</span>
      </div>
      {entries.length === 0 ? (
        <p className="trace-empty">No records match the current filters.</p>
      ) : (
        visibleEntries.map((entry) => {
          const isSelected =
            selected !== undefined && recordKey(selected.record) === recordKey(entry.record);
          return (
            <button
              className={`trace-row trace-record${isSelected ? " is-selected" : ""} tone-${recordTone(entry.record)}`}
              key={recordKey(entry.record)}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(entry)}
            >
              <time dateTime={entry.record.meta.receivedAt}>
                {formatTime(entry.record.meta.receivedAt)}
              </time>
              <span>
                <strong>{entry.runtimeId}</strong>
                <small>{entry.record.meta.streamId}</small>
              </span>
              <code>#{entry.record.meta.sequence}</code>
              <span>
                <strong>{recordTitle(entry.record)}</strong>
                <small>{entry.record.kind}</small>
              </span>
            </button>
          );
        })
      )}
      {entries.length > visibleEntries.length ? (
        <div className="trace-pagination">
          <p>
            Showing {visibleEntries.length.toLocaleString()} of {entries.length.toLocaleString()}{" "}
            matching records.
          </p>
          <button
            type="button"
            onClick={() => setVisibleCount((count) => count + LEDGER_PAGE_SIZE)}
          >
            Load next {LEDGER_PAGE_SIZE}
          </button>
        </div>
      ) : entries.length > 0 ? (
        <p className="trace-pagination-count">
          Showing {visibleEntries.length.toLocaleString()} of {entries.length.toLocaleString()}{" "}
          matching records.
        </p>
      ) : null}
    </section>
  );
}

function RecordInspector({
  entry,
  runtime,
  failure,
  relatedEntry,
  onSelectEntry,
}: {
  readonly entry: IndexedTimelineEntry | undefined;
  readonly runtime: RuntimeView | undefined;
  readonly failure: FailureEntry | undefined;
  readonly relatedEntry: IndexedTimelineEntry | undefined;
  readonly onSelectEntry: (entry: IndexedTimelineEntry) => void;
}) {
  if (entry === undefined && failure !== undefined)
    return (
      <section className="record-inspector" aria-label="Record inspector">
        <FailureInspector error={failure.error} />
      </section>
    );
  if (entry === undefined)
    return (
      <section className="record-inspector empty-inspector" aria-label="Record inspector">
        <p className="eyebrow">Inspector</p>
        <h3>Select an observed record</h3>
        <p>Record metadata, correlations, failures, and sanitised raw detail will appear here.</p>
      </section>
    );
  const record = entry.record;
  const error = recordError(record);
  const canonicalPayload = useMemo(() => JSON.stringify(recordPayload(record), null, 2), [record]);
  return (
    <section className="record-inspector" aria-label="Record inspector">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">Selected evidence</p>
          <h3>Record · {recordTitle(record)}</h3>
        </div>
        <RecordKind record={record} />
      </div>
      <dl className="record-facts">
        <Fact label="Runtime" value={entry.runtimeId} />
        <Fact label="Session" value={record.meta.sessionId} />
        <Fact label="Stream" value={record.meta.streamId} />
        <Fact label="Sequence" value={record.meta.sequence} />
        <Fact label="Observed" value={record.meta.observedAt} />
        <Fact label="Received" value={record.meta.receivedAt} />
      </dl>
      <Correlation record={record} relatedEntry={relatedEntry} onSelectEntry={onSelectEntry} />
      {error === undefined ? null : <FailureInspector error={error} record={record} />}
      {record.kind === "operation" ? (
        <OperationTimeline runtime={runtime} operationId={record.meta.correlation.operationId} />
      ) : null}
      <details className="payload-disclosure">
        <summary>Canonical payload</summary>
        <pre>{canonicalPayload}</pre>
      </details>
      <RawDetailDisclosure record={record} />
    </section>
  );
}

function OperationTimeline({
  runtime,
  operationId,
}: {
  readonly runtime: RuntimeView | undefined;
  readonly operationId: string;
}) {
  const updates =
    runtime?.records.filter(
      (candidate) =>
        candidate.kind === "operation" && candidate.meta.correlation.operationId === operationId,
    ) ?? [];
  return (
    <section className="operation-timeline" aria-label="Correlated operation timeline">
      <div className="subheading">
        <span className="eyebrow">Correlation: {operationId}</span>
        <strong>Operation timeline</strong>
      </div>
      {updates.length === 0 ? (
        <p className="empty-copy">No sibling updates observed for this operation.</p>
      ) : (
        <ol>
          {updates.map((candidate) =>
            candidate.kind !== "operation" ? null : (
              <li key={recordKey(candidate)}>
                <code>#{candidate.meta.sequence}</code>
                <span>{candidate.operation.phase}</span>
                <Status value={candidate.operation.state} />
                {candidate.operation.progress === undefined ? null : (
                  <small>{candidate.operation.progress}%</small>
                )}
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}

function FailureStrip({
  failures,
  onSelect,
}: {
  readonly failures: readonly FailureEntry[];
  readonly onSelect: (failure: FailureEntry) => void;
}) {
  return (
    <section
      className={`failure-strip${failures.length === 0 ? " is-clear" : ""}`}
      aria-label="Current failures"
    >
      <div className="failure-strip-heading">
        <span className="eyebrow">Current incident signal</span>
        <strong>
          {failures.length === 0 ? "No active failures" : `${failures.length} active failures`}
        </strong>
      </div>
      {failures.length === 0 ? (
        <span className="failure-clear-copy">
          Failures, gaps, and terminal operation errors appear here.
        </span>
      ) : (
        <div className="failure-items">
          {sortFailures(failures)
            .slice(0, 4)
            .map((failure) => (
              <button type="button" key={failure.id} onClick={() => onSelect(failure)}>
                <b>{failure.error.code}</b>
                <span>{failure.error.message}</span>
                <small>
                  {failure.source} · {failure.error.retryable ? "retryable" : "terminal"}
                </small>
              </button>
            ))}
        </div>
      )}
    </section>
  );
}

function FailureInspector({
  error,
  record,
}: {
  readonly error: NoxscopeError;
  readonly record?: NoxscopeRecord;
}) {
  return (
    <section className="failure-inspector" aria-label="Failure inspector">
      <div className="subheading">
        <span className="eyebrow">Failure inspector</span>
        <strong>{error.code}</strong>
      </div>
      <p>{error.message}</p>
      <dl className="failure-facts">
        <Fact label="Retryability" value={error.retryable ? "retryable" : "terminal"} />
        <Fact
          label="Source"
          value={record === undefined ? "Runtime Session" : recordSource(record)}
        />
        <Fact label="Capability" value={error.capability ?? "not specified"} />
        <Fact
          label="Retry after"
          value={error.retryAfterMs === undefined ? "not specified" : `${error.retryAfterMs} ms`}
        />
      </dl>
      <RawDetailDisclosure raw={error.raw ?? []} />
    </section>
  );
}

function Correlation({
  record,
  relatedEntry,
  onSelectEntry,
}: {
  readonly record: NoxscopeRecord;
  readonly relatedEntry: IndexedTimelineEntry | undefined;
  readonly onSelectEntry: (entry: IndexedTimelineEntry) => void;
}) {
  const correlation = record.meta.correlation;
  return (
    <section className="correlation-block" aria-label="Record correlation">
      <div className="subheading">
        <span className="eyebrow">Observed relationships</span>
        <strong>Correlation</strong>
      </div>
      {correlation === undefined ? (
        <p className="empty-copy">No correlation was observed for this record.</p>
      ) : (
        <dl className="record-facts">
          <Fact label="Request" value={correlation.requestId ?? "not observed"} />
          <Fact label="Operation" value={correlation.operationId ?? "not observed"} />
          <Fact label="Parent" value={correlation.parentOperationId ?? "not observed"} />
          <Fact label="Caused by sequence" value={correlation.causedBySequence ?? "not observed"} />
          <Fact label="Trace" value={correlation.traceId ?? "not observed"} />
        </dl>
      )}
      {correlation?.causedBySequence === undefined ? null : relatedEntry === undefined ? (
        <p className="empty-copy">Caused-by record is not present in this projection.</p>
      ) : (
        <button
          className="related-record-link"
          type="button"
          onClick={() => onSelectEntry(relatedEntry)}
        >
          Select caused-by record #{relatedEntry.record.meta.sequence}
        </button>
      )}
    </section>
  );
}

function RawDetailDisclosure({
  record,
  raw,
}: {
  readonly record?: NoxscopeRecord;
  readonly raw?: readonly SanitizedRawDetail[];
}) {
  const details = useMemo(
    () => raw ?? (record === undefined ? [] : rawDetailFor(record)),
    [raw, record],
  );
  const formattedDetails = useMemo(
    () => details.map((detail) => ({ detail, value: JSON.stringify(detail.value, null, 2) })),
    [details],
  );
  if (details.length === 0) return null;
  return (
    <details className="raw-disclosure">
      <summary>Sanitised raw detail · {details.length}</summary>
      <div className="raw-detail-list">
        {formattedDetails.map(({ detail, value }, index) => (
          <div
            className="raw-detail-entry"
            key={JSON.stringify([detail.namespace, detail.schemaVersion, index])}
          >
            <strong>{detail.namespace}</strong>
            <span>
              schema {detail.schemaVersion} · policy {detail.sanitization.policy}
            </span>
            <pre>{value}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function RecordingControls({
  state,
  disabled,
  onStart,
  onStop,
  onImport,
}: {
  readonly state: RecordingSessionState;
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onImport: () => void;
}) {
  const active = state.phase === "recording" || state.phase === "finalizing";
  return (
    <div className="recording-controls" aria-label="Recording controls">
      <span className="recording-label">Local Recorder</span>
      {active ? (
        <button type="button" onClick={onStop} disabled={state.phase === "finalizing" || disabled}>
          {state.phase === "finalizing" ? "Finalizing…" : "Stop Recording"}
        </button>
      ) : (
        <button type="button" onClick={onStart} disabled={state.phase === "offline" || disabled}>
          Start Recording
        </button>
      )}
      <button type="button" onClick={onImport} disabled={active || disabled}>
        Import
      </button>
    </div>
  );
}

function RecordingStatus({ state }: { readonly state: RecordingSessionState }) {
  if (state.error === undefined && state.phase === "idle") return null;
  const message =
    state.error?.message ??
    (state.phase === "recording"
      ? "Recording live canonical events"
      : state.phase === "finalizing"
        ? "Sanitising and finalising Recording"
        : state.phase === "offline"
          ? "Offline replay is active; runtime operations are disabled"
          : "Recording storage is unavailable");
  return (
    <p
      className={`recording-status recording-status-${state.phase}`}
      role="status"
      aria-live="polite"
    >
      {message}
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
    <section className="recording-library" aria-labelledby="recordings-title">
      <div className="library-heading">
        <div>
          <p className="eyebrow">IndexedDB or injected local store</p>
          <h2 id="recordings-title">Recording library</h2>
        </div>
        <span>No automatic upload</span>
      </div>
      {state.summaries.length === 0 ? (
        <p className="empty-copy">No saved Recordings.</p>
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
              <div className="recording-actions">
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

function SyncDomain({
  domain,
}: {
  readonly domain: { domain: string; state: string; percentage?: number };
}) {
  const known = domain.percentage !== undefined;
  return (
    <div className="sync-domain">
      <div className="sync-domain-label">
        <strong>{domainLabel(domain.domain)}</strong>
        <Status value={domain.state} />
      </div>
      <div
        className="sync-meter"
        role="progressbar"
        aria-label={`${domainLabel(domain.domain)} sync progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(known
          ? { "aria-valuenow": domain.percentage }
          : { "aria-valuetext": "Unknown progress" })}
      >
        <span
          className={known ? "" : "indeterminate"}
          style={
            known ? { width: `${Math.max(0, Math.min(100, domain.percentage!))}%` } : undefined
          }
        />
      </div>
      <code>{known ? `${domain.percentage}%` : "Unknown progress"}</code>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <p className="eyebrow">No live evidence</p>
      <h2>Waiting for a Runtime Session…</h2>
      <p>Connect an Adapter to begin observing canonical snapshots, events, and operations.</p>
    </div>
  );
}
function SectionHeading({
  kicker,
  title,
  id,
}: {
  readonly kicker: string;
  readonly title: string;
  readonly id?: string;
}) {
  return (
    <div className="section-heading">
      <p className="eyebrow">{kicker}</p>
      <h3 id={id}>{title}</h3>
    </div>
  );
}
function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
function Status({ value }: { readonly value: string }) {
  return <span className={`status status-${value}`}>{value}</span>;
}
function RecordKind({ record }: { readonly record: NoxscopeRecord }) {
  return <span className={`record-kind kind-${record.kind}`}>{record.kind}</span>;
}

function indexTimelineEntry(entry: TimelineEntry): IndexedTimelineEntry {
  return { ...entry, searchText: buildSearchText(entry) };
}

function buildSearchText(entry: TimelineEntry): string {
  const { record } = entry;
  const correlation = record.meta.correlation;
  const error = recordError(record);
  const fields = [
    entry.runtimeId,
    record.kind,
    recordTitle(record),
    record.meta.sessionId,
    record.meta.streamId,
    record.meta.sequence,
    correlation?.requestId,
    correlation?.operationId,
    correlation?.parentOperationId,
    correlation?.causedBySequence,
    correlation?.traceId,
    error?.code,
    error?.message,
  ];
  return fields
    .filter((field): field is string => field !== undefined)
    .map((field) => field.slice(0, 256))
    .join(" ")
    .toLowerCase()
    .slice(0, SEARCH_TEXT_LIMIT);
}

function lastEntryForSession(
  entries: readonly IndexedTimelineEntry[],
  sessionId: string,
): IndexedTimelineEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.record.meta.sessionId === sessionId) return entry;
  }
  return undefined;
}

function findCausedByEntry(
  entry: IndexedTimelineEntry,
  entries: readonly IndexedTimelineEntry[],
): IndexedTimelineEntry | undefined {
  const causedBySequence = entry.record.meta.correlation?.causedBySequence;
  if (causedBySequence === undefined) return undefined;
  return entries.find(
    (candidate) =>
      candidate.record.meta.sessionId === entry.record.meta.sessionId &&
      candidate.record.meta.streamId === entry.record.meta.streamId &&
      candidate.record.meta.sequence === causedBySequence,
  );
}

function filterEntries(
  entries: readonly IndexedTimelineEntry[],
  query: string,
  filter: RecordFilter,
  failuresOnly: boolean,
) {
  const needle = query.trim().toLowerCase();
  return entries.filter(({ record, searchText }) => {
    if (filter !== "all" && record.kind !== filter) return false;
    if (failuresOnly && !isFailureRecord(record)) return false;
    if (needle.length === 0) return true;
    return searchText.includes(needle);
  });
}
function collectFailures(runtimes: readonly RuntimeView[]): FailureEntry[] {
  const failures: FailureEntry[] = [];
  for (const runtime of runtimes) {
    const relatedRecords = new Map<string, NoxscopeRecord[]>();
    for (const record of runtime.records) {
      const error = recordError(record);
      if (error === undefined) continue;
      const key = errorIdentity(error);
      const records = relatedRecords.get(key) ?? [];
      records.push(record);
      relatedRecords.set(key, records);
    }
    const relatedIndexes = new Map<string, number>();
    runtime.failures.forEach((error, failureIndex) => {
      const key = errorIdentity(error);
      const records = relatedRecords.get(key) ?? [];
      const relatedIndex = relatedIndexes.get(key) ?? 0;
      const relatedRecord = records[relatedIndex];
      relatedIndexes.set(key, relatedIndex + 1);
      failures.push({
        id: failureIdentity(runtime, error, relatedRecord, failureIndex),
        runtime,
        error,
        source: "Runtime Session",
        ...(relatedRecord === undefined ? {} : { record: relatedRecord }),
      });
    });
    for (const record of runtime.records) {
      const error = recordError(record);
      if (
        error !== undefined &&
        !(
          record.kind === "operation" &&
          runtime.failures.some(
            (candidate) => candidate.code === error.code && candidate.message === error.message,
          )
        )
      )
        failures.push({
          id: failureIdentity(runtime, error, record),
          runtime,
          record,
          error,
          source: recordSource(record),
        });
    }
  }
  return sortFailures(failures);
}

function errorIdentity(error: NoxscopeError): string {
  return JSON.stringify([error.code, error.message, error.retryable, error.capability]);
}

function failureIdentity(
  runtime: RuntimeView,
  error: NoxscopeError,
  record: NoxscopeRecord | undefined,
  occurrence = 0,
): string {
  return JSON.stringify([
    "failure",
    runtime.descriptor.sessionId,
    record === undefined ? "runtime" : recordKey(record),
    error.code,
    error.message,
    occurrence,
  ]);
}

function sortFailures(failures: readonly FailureEntry[]): FailureEntry[] {
  return [...failures].sort((left, right) => {
    const severity = failureSeverity(right) - failureSeverity(left);
    if (severity !== 0) return severity;
    const current = failureCurrentAt(right).localeCompare(failureCurrentAt(left));
    if (current !== 0) return current;
    return left.id.localeCompare(right.id);
  });
}

function failureSeverity(failure: FailureEntry): number {
  if (!failure.error.retryable) return 3;
  if (failure.runtime.status === "failed") return 2;
  return 1;
}

function failureCurrentAt(failure: FailureEntry): string {
  if (failure.record !== undefined) return failure.record.meta.receivedAt;
  return failure.runtime.records.at(-1)?.meta.receivedAt ?? "";
}

function recordError(record: NoxscopeRecord): NoxscopeError | undefined {
  if (record.kind === "operation") return record.operation.error;
  if (
    record.kind === "diagnostic-event" &&
    record.event.type === "diagnostic" &&
    record.event.level === "error"
  )
    return {
      code: "failed",
      message: record.event.message ?? record.event.name,
      retryable: false,
      ...(record.event.raw === undefined ? {} : { raw: record.event.raw }),
    };
  if (record.kind === "diagnostic-event" && record.event.type === "stream-gap")
    return {
      code: "overflow",
      message: `Stream gap ${record.event.firstLostSequence}–${record.event.lastLostSequence}`,
      retryable: true,
    };
  return undefined;
}
function isFailureRecord(record: NoxscopeRecord) {
  return recordError(record) !== undefined;
}
function recordSource(record: NoxscopeRecord): string {
  if (record.kind === "snapshot") return record.snapshot.freshness.source;
  if (record.kind === "operation") return "operation update";
  if (record.event.type === "diagnostic") return record.event.source;
  return "core ordering";
}
function recordPayload(record: NoxscopeRecord) {
  if (record.kind === "snapshot") return record.snapshot;
  if (record.kind === "operation") return record.operation;
  return record.event;
}
function rawDetailFor(record: NoxscopeRecord): readonly SanitizedRawDetail[] {
  if (record.kind === "snapshot") return record.snapshot.raw ?? [];
  if (record.kind === "operation") return record.operation.raw ?? [];
  return record.event.type === "diagnostic" ? (record.event.raw ?? []) : [];
}
function recordKey(record: NoxscopeRecord) {
  return JSON.stringify([record.meta.sessionId, record.meta.streamId, record.meta.sequence]);
}
function recordTone(record: NoxscopeRecord) {
  if (recordError(record) !== undefined) return "danger";
  if (record.kind === "operation") return "operation";
  if (record.kind === "diagnostic-event") return "event";
  return "snapshot";
}
function recordTitle(record: NoxscopeRecord): string {
  if (record.kind === "snapshot") return `Snapshot · ${record.snapshot.sync?.state ?? "observed"}`;
  if (record.kind === "operation")
    return `${record.operation.kind} · ${record.operation.phase} · ${record.operation.state}`;
  if (record.event.type === "diagnostic") return record.event.name;
  if (record.event.type === "capability-availability")
    return `${record.event.capabilityId} · ${record.event.availability.state}`;
  return `Stream gap ${record.event.firstLostSequence}–${record.event.lastLostSequence}`;
}
function runtimeName(runtime: RuntimeView): string {
  return runtime.descriptor.runtime.name ?? runtime.descriptor.runtimeId;
}
function freshnessLabel(runtime: RuntimeView): string {
  const freshness = runtime.latestSnapshot?.freshness;
  return freshness === undefined
    ? "unknown · no snapshot"
    : `${freshness.state} · ${freshness.source} · ${formatTime(freshness.observedAt)}`;
}
function versionFacts(runtime: RuntimeView): string {
  const versions = runtime.descriptor.runtime.versions.map(
    (version) => `${version.subject} ${version.version}`,
  );
  return versions.length === 0 ? "unknown" : versions.join(" · ");
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
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(date);
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
