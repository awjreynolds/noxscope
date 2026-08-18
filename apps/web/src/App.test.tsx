// @vitest-environment jsdom

import { createMockAdapter } from "@noxscope/adapter-mock";
import { createCore } from "@noxscope/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("Overview", () => {
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
});
