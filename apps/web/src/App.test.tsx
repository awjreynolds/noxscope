// @vitest-environment jsdom

import { createMockAdapter, type MockScenario } from "@noxscope/adapter-mock";
import { createCore, type Core, type CoreView } from "@noxscope/core";
import type { NoxscopeRecord } from "@noxscope/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { RecordingSession, RecordingSessionState } from "./recording-session.js";

describe("Overview", () => {
  afterEach(() => cleanup());
  it("balances Core subscriptions when StrictMode mounts and unmounts the default recording session", async () => {
    let activeSubscriptions = 0;
    const core = {
      async connect() {
        return { ok: true, value: "runtime-1" } as const;
      },
      subscribe(listener: (view: never) => void) {
        activeSubscriptions += 1;
        void listener;
        return () => {
          activeSubscriptions -= 1;
        };
      },
    } as unknown as Core;
    const rendered = render(
      <StrictMode>
        <App core={core} />
      </StrictMode>,
    );
    await waitFor(() => expect(activeSubscriptions).toBe(2));
    rendered.unmount();
    expect(activeSubscriptions).toBe(0);
  });

  it("renders runtime, capability, three-domain sync, balances, and ordered events from Core", async () => {
    const core = createCore({ signal: new AbortController().signal });
    render(<App core={core} />);
    await core.connect(createMockAdapter("healthy"));

    expect(await screen.findByText("Deterministic Midnight Runtime — healthy")).toBeTruthy();
    expect(screen.getByText("sync.observe")).toBeTruthy();
    expect(screen.getByText("Shielded")).toBeTruthy();
    expect(screen.getByText("Unshielded")).toBeTruthy();
    expect(screen.getByText("DUST sync")).toBeTruthy();
    expect(screen.getByText("42,000,000")).toBeTruthy();
    expect(screen.getByText("sync.complete")).toBeTruthy();
    expect(screen.getByText("#4")).toBeTruthy();
  });

  it("renders missing sync progress as unknown instead of zero", async () => {
    const core = createCore({ signal: new AbortController().signal });
    render(<App core={core} />);

    await core.connect(createMockAdapter("unknown-progress" as MockScenario));

    expect(await screen.findByText("Unknown progress")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("distinguishes an absent DUST state from unknown progress", async () => {
    const core = createCore({ signal: new AbortController().signal });
    render(<App core={core} />);
    await core.connect(createMockAdapter("unknown-progress" as MockScenario));

    const dust = await waitFor(() => screen.getByRole("heading", { name: "DUST diagnostics" }));
    expect(dust.parentElement?.parentElement?.textContent).toContain("unsupported");
    expect(screen.getByText("Unknown progress")).toBeTruthy();
  });

  it("keeps the split-pane inspector explicit and read-only during offline replay", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const record: NoxscopeRecord = {
      kind: "diagnostic-event",
      meta: {
        protocol: "noxscope/adapter/1",
        sessionId: "offline-session",
        runtimeId: "offline-runtime",
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
        message: "offline fixture",
      },
    };
    const state = {
      phase: "offline",
      summaries: [],
      offline: {
        name: "captured-fixture",
        imported: { records: [record] },
      },
    } as unknown as RecordingSessionState;
    const recordingSession = {
      subscribe(listener: (next: RecordingSessionState) => void) {
        listener(state);
        return () => undefined;
      },
    } as unknown as RecordingSession;

    render(<App core={core} recordingSession={recordingSession} />);

    expect(await screen.findByText("Replay-only evidence")).toBeTruthy();
    expect(screen.getByText("runtime.ready")).toBeTruthy();
    expect(screen.getByText("Canonical payload")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Runtime operations disabled offline" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("Imported Recording")).toBeTruthy();
  });

  it("surfaces an export Result failure instead of swallowing the promise", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const state: RecordingSessionState = {
      phase: "idle",
      summaries: [
        {
          id: "recording-export",
          name: "export fixture",
          createdAt: "2026-08-19T12:00:00.000Z",
          bytes: 3,
          recordCount: 1,
        },
      ],
    };
    const recordingSession = {
      subscribe(listener: (next: RecordingSessionState) => void) {
        listener(state);
        return () => undefined;
      },
      async export() {
        return {
          ok: false as const,
          error: {
            code: "unavailable" as const,
            message: "Downloads are unavailable",
            retryable: false,
          },
        };
      },
    } as unknown as RecordingSession;

    render(<App core={core} recordingSession={recordingSession} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some((status) => status.textContent?.includes("Downloads are unavailable")),
      ).toBe(true),
    );
  });

  it("renders reused stream identities from reconnect sessions without duplicate keys", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const adapter = createMockAdapter("reconnection" as MockScenario);
    const consoleErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      render(<App core={core} />);
      await core.connect(adapter);
      await core.connect(adapter);

      await waitFor(() => {
        expect(screen.getAllByText("Deterministic Midnight Runtime — reconnection")).toHaveLength(
          2,
        );
      });
      expect(consoleErrors.mock.calls.flat().join(" ")).not.toContain("same key");
    } finally {
      consoleErrors.mockRestore();
    }
  });

  it("selects duplicate runtime IDs by unique session identity", async () => {
    const core = createCore({ signal: new AbortController().signal });
    render(<App core={core} />);
    const adapter = createMockAdapter("reconnection" as MockScenario);
    await core.connect(adapter);
    await core.connect(adapter);

    const selectors = await waitFor(() =>
      screen.getAllByRole("button", { name: /Select Deterministic Midnight Runtime/ }),
    );
    expect(selectors).toHaveLength(2);
    expect(selectors[0]?.getAttribute("aria-label")).not.toBe(
      selectors[1]?.getAttribute("aria-label"),
    );
    fireEvent.click(selectors[1]!);
    expect(screen.getAllByText("session-reconnection-2").length).toBeGreaterThan(0);
  });

  it("keeps simultaneous Runtime Sessions independent and separates support from availability", async () => {
    const core = createCore({ signal: new AbortController().signal });
    render(<App core={core} />);
    await core.connect(createMockAdapter("healthy"));
    await core.connect(createMockAdapter("unavailable"));

    const unavailable = await waitFor(() =>
      screen.getByRole("button", {
        name: "Select Deterministic Midnight Runtime — unavailable",
      }),
    );
    expect(unavailable.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(unavailable);
    expect(screen.getAllByText("Availability: unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Support: supported").length).toBeGreaterThan(0);
  });

  it("filters the display-time ledger without changing its canonical stream records", async () => {
    const core = createCore({ signal: new AbortController().signal });
    render(<App core={core} />);
    await core.connect(createMockAdapter("multiple-streams"));

    await waitFor(() => expect(screen.getAllByText("sync.complete").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), {
      target: { value: "sync.complete" },
    });
    expect(screen.getAllByText("sync.complete").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), {
      target: { value: "does-not-exist" },
    });
    expect(screen.getByText("No records match the current filters.")).toBeTruthy();
  });

  it("routes a terminal operation failure into the failure inspector", async () => {
    const core = createCore({ signal: new AbortController().signal });
    render(<App core={core} />);
    await core.connect(createMockAdapter("failed-transaction"));

    await waitFor(() =>
      screen.getByRole("button", { name: /Node rejected the deterministic transaction/ }),
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), {
      target: { value: "operation-failed-fixture" },
    });
    expect(screen.getByText("transaction.submit · submitting · failed")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), {
      target: { value: "" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Node rejected the deterministic transaction/ }),
    );
    const failureInspector = screen.getByLabelText("Failure inspector");
    expect(failureInspector.textContent).toContain("rejected");
    expect(failureInspector.textContent).toContain("terminal");
    expect(screen.getByLabelText("Correlated operation timeline")).toBeTruthy();
  });

  it("orders the failure strip by severity, recency, and stable identity", () => {
    const meta = {
      protocol: "noxscope/adapter/1" as const,
      sessionId: "session-failures",
      runtimeId: "runtime-failures",
      streamId: "events",
      observedAt: "2026-08-19T12:00:00.000Z",
      receivedAt: "2026-08-19T12:00:00.000Z",
    };
    const records: NoxscopeRecord[] = [
      {
        kind: "diagnostic-event",
        meta: { ...meta, sequence: "1", receivedAt: "2026-08-19T12:00:01.000Z" },
        event: {
          type: "diagnostic",
          name: "older.failure",
          category: "test",
          level: "error",
          source: "runtime",
          message: "older terminal failure",
        },
      },
      {
        kind: "operation",
        meta: {
          ...meta,
          sequence: "2",
          receivedAt: "2026-08-19T12:00:02.000Z",
          correlation: { operationId: "operation-newer" },
        },
        operation: {
          kind: "transaction.submit",
          phase: "submitting",
          state: "failed",
          error: { code: "failed", message: "newer terminal failure", retryable: false },
        },
      },
      {
        kind: "diagnostic-event",
        meta: { ...meta, sequence: "3", receivedAt: "2026-08-19T12:00:03.000Z" },
        event: {
          type: "stream-gap",
          sourceStreamId: "events",
          firstLostSequence: "3",
          lastLostSequence: "4",
          reason: "overflow",
        },
      },
    ];
    render(<App core={staticCore(records)} />);

    const buttons = within(screen.getByLabelText("Current failures")).getAllByRole("button");
    expect(buttons[0]?.textContent).toContain("newer terminal failure");
    expect(buttons[1]?.textContent).toContain("older terminal failure");
    expect(buttons[2]?.textContent).toContain("Stream gap");
  });

  it("links a caused-by sequence to the record in the same session and stream", () => {
    const first: NoxscopeRecord = {
      kind: "diagnostic-event",
      meta: {
        protocol: "noxscope/adapter/1",
        sessionId: "session-correlation",
        runtimeId: "runtime-correlation",
        streamId: "events",
        sequence: "1",
        observedAt: "2026-08-19T12:00:00.000Z",
        receivedAt: "2026-08-19T12:00:00.000Z",
      },
      event: {
        type: "diagnostic",
        name: "request.started",
        category: "operation",
        level: "info",
        source: "runtime",
      },
    };
    const second: NoxscopeRecord = {
      kind: "operation",
      meta: {
        ...first.meta,
        sequence: "2",
        correlation: {
          operationId: "operation-correlation",
          causedBySequence: "1",
        },
        receivedAt: "2026-08-19T12:00:01.000Z",
      },
      operation: {
        kind: "transaction.submit",
        phase: "submitting",
        state: "running",
      },
    };
    render(<App core={staticCore([first, second])} />);

    expect(screen.getByText("Caused by sequence")).toBeTruthy();
    const link = screen.getByRole("button", { name: "Select caused-by record #1" });
    fireEvent.click(link);
    expect(screen.getByText("Record · request.started")).toBeTruthy();
  });

  it("bounds ledger rendering for a large timeline and loads the next page on demand", () => {
    const records = Array.from({ length: 10_001 }, (_, index): NoxscopeRecord => ({
      kind: "diagnostic-event",
      meta: {
        protocol: "noxscope/adapter/1",
        sessionId: "session-huge",
        runtimeId: "runtime-huge",
        streamId: "events",
        sequence: String(index + 1),
        observedAt: "2026-08-19T12:00:00.000Z",
        receivedAt: "2026-08-19T12:00:00.000Z",
      },
      event: {
        type: "diagnostic",
        name: `event-${index + 1}`,
        category: "test",
        level: "info",
        source: "runtime",
      },
    }));
    render(<App core={staticCore(records)} />);

    const stream = screen.getByLabelText("Ordered event stream");
    expect(within(stream).getAllByRole("button")).toHaveLength(101);
    fireEvent.click(within(stream).getByRole("button", { name: "Load next 100" }));
    expect(within(stream).getAllByRole("button")).toHaveLength(201);
    expect(within(stream).getByText("Showing 200 of 10,001 matching records.")).toBeTruthy();
  });
});

function staticCore(records: readonly NoxscopeRecord[]): Core {
  const sessionId = records[0]?.meta.sessionId ?? "session-static";
  const runtimeId = records[0]?.meta.runtimeId ?? "runtime-static";
  const runtime = {
    descriptor: {
      protocol: "noxscope/adapter/1" as const,
      sessionId,
      runtimeId,
      adapter: { id: "test.adapter", version: "1.0.0" },
      runtime: { surface: "sdk" as const, name: "Static Runtime", identifiers: [], versions: [] },
      capabilities: [],
    },
    status: "observing" as const,
    capabilities: [],
    records,
    failures: [],
  };
  const view = {
    runtimes: [runtime],
    timeline: records.map((record) => ({ runtimeId, record })),
    ordering: "display-time-only" as const,
  };
  return {
    async connect() {
      return { ok: true, value: sessionId } as const;
    },
    subscribe(listener: (view: CoreView) => void) {
      listener(view);
      return () => undefined;
    },
  } as unknown as Core;
}
