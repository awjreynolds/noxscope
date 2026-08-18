import type { Core, CoreView, RuntimeView } from "@noxscope/core";
import type { NoxscopeRecord } from "@noxscope/protocol";
import { useEffect, useState } from "react";

const emptyView: CoreView = {
  runtimes: [],
  timeline: [],
  ordering: "display-time-only",
};

export interface AppProps {
  readonly core: Core;
}

export function App({ core }: AppProps) {
  const [view, setView] = useState<CoreView>(emptyView);
  useEffect(() => core.subscribe(setView), [core]);

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
      </header>

      {view.runtimes.length === 0 ? (
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
        {view.timeline.map(({ runtimeId, record }) => (
          <div className="timeline-row" key={`${record.meta.streamId}-${record.meta.sequence}`}>
            <code>#{record.meta.sequence}</code>
            <span className="muted">{runtimeId}</span>
            <RecordKind record={record} />
            <strong>{recordLabel(record)}</strong>
          </div>
        ))}
      </section>
    </main>
  );
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
