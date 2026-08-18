import { createMockAdapter } from "@noxscope/adapter-mock";
import { describe, expect, it } from "vitest";
import { createCore, type CoreView } from "./index.js";

describe("Core", () => {
  it("tracks multiple Runtime Sessions without replacing their independent stream order", async () => {
    const lifetime = new AbortController();
    const core = createCore({ signal: lifetime.signal });
    const completed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if (
          view.runtimes.length === 2 &&
          view.runtimes.every((runtime) => runtime.status === "complete")
        ) {
          resolve(view);
        }
      });
    });

    await Promise.all([
      core.connect(createMockAdapter("healthy")),
      core.connect(createMockAdapter("stalled-sync")),
    ]);
    const view = await completed;

    expect(
      view.runtimes.map((runtime) => ({
        name: runtime.descriptor.runtime.name,
        state: runtime.latestSnapshot?.sync?.state,
        sequences: runtime.records.map((record) => record.meta.sequence),
      })),
    ).toEqual([
      {
        name: "Deterministic Midnight Runtime — healthy",
        state: "synced",
        sequences: ["1", "2", "3", "4"],
      },
      {
        name: "Deterministic Midnight Runtime — stalled-sync",
        state: "stalled",
        sequences: ["1", "2", "3", "4"],
      },
    ]);
  });

  it("projects capability degradation and terminal operation failures into runtime views", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const completed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if (
          view.runtimes.length === 2 &&
          view.runtimes.every((runtime) => runtime.status === "complete")
        ) {
          resolve(view);
        }
      });
    });

    await Promise.all([
      core.connect(createMockAdapter("prover-failure")),
      core.connect(createMockAdapter("failed-transaction")),
    ]);
    const view = await completed;
    const prover = view.runtimes.find((runtime) => runtime.descriptor.runtimeId.includes("prover"));
    const failed = view.runtimes.find((runtime) =>
      runtime.descriptor.runtimeId.includes("transaction"),
    );

    expect({
      prover: prover?.capabilities.find((capability) => capability.id === "operation.submit")
        ?.availability.state,
      failure: failed?.failures[0]?.message,
    }).toEqual({
      prover: "degraded",
      failure: "Node rejected the deterministic transaction",
    });
  });
});
