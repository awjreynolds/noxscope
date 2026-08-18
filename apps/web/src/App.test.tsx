// @vitest-environment jsdom

import { createMockAdapter, type MockScenario } from "@noxscope/adapter-mock";
import { createCore, type Core } from "@noxscope/core";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

describe("Overview", () => {
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
});
