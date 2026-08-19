// @vitest-environment jsdom

import { createMockAdapter, type MockScenario } from "@noxscope/adapter-mock";
import { createCore, type Core } from "@noxscope/core";
import type { NoxscopeRecord } from "@noxscope/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    const failure = await waitFor(() =>
      screen.getByRole("button", { name: /Node rejected the deterministic transaction/ }),
    );
    fireEvent.click(failure);
    const failureInspector = screen.getByLabelText("Failure inspector");
    expect(failureInspector.textContent).toContain("rejected");
    expect(failureInspector.textContent).toContain("terminal");
    expect(screen.getByLabelText("Correlated operation timeline")).toBeTruthy();
  });
});
