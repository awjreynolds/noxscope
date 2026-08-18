import { createMockAdapter, type MockScenario } from "@noxscope/adapter-mock";
import { describe, expect, it } from "vitest";
import { createCore, type CoreView } from "./index.js";

describe("Core", () => {
  it("rejects a Runtime Session whose nested capability evidence is malformed", async () => {
    const core = createCore({ signal: new AbortController().signal });

    const result = await core.connect(createMockAdapter("malformed-descriptor" as MockScenario));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "protocol",
        message: "Runtime descriptor capabilities are invalid",
        retryable: false,
      },
    });
  });

  it("rejects a diagnostic event containing malformed nested raw detail", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const observed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        const runtime = view.runtimes[0];
        if (runtime?.status === "complete" || runtime?.status === "failed") resolve(view);
      });
    });

    await core.connect(createMockAdapter("malformed-raw-detail" as MockScenario));
    const view = await observed;

    expect({
      acceptedRecords: view.runtimes[0]?.records.length,
      failure: view.runtimes[0]?.failures[0]?.message,
    }).toEqual({
      acceptedRecords: 3,
      failure: "Diagnostic event payload is invalid",
    });
  });

  it("tracks multiple Runtime Sessions without replacing their independent stream order", async () => {
    const lifetime = new AbortController();
    const core = createCore({ signal: lifetime.signal });
    const completed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if (
          view.runtimes.length === 2 &&
          view.runtimes.every((runtime) => runtime.records.length >= 4)
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

  it("tracks sequence monotonicity independently for each stream in a Runtime Session", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const observed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        const runtime = view.runtimes[0];
        if (runtime !== undefined && (runtime.records.length >= 4 || runtime.status === "failed")) {
          resolve(view);
        }
      });
    });

    await core.connect(createMockAdapter("multiple-streams" as MockScenario));
    const runtime = (await observed).runtimes[0];

    expect({
      streams: [...new Set(runtime?.records.map((record) => record.meta.streamId))],
      failures: runtime?.failures,
    }).toEqual({
      streams: ["session-multiple-streams-1-state", "session-multiple-streams-1-events"],
      failures: [],
    });
  });

  it("keeps same-stream sequence order when received timestamps are skewed", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const observed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if ((view.runtimes[0]?.records.length ?? 0) >= 4) resolve(view);
      });
    });

    await core.connect(createMockAdapter("timestamp-skew" as MockScenario));
    const timeline = (await observed).timeline;

    expect(
      timeline.slice(0, 2).map(({ record }) => [record.meta.sequence, record.meta.receivedAt]),
    ).toEqual([
      ["1", "2026-08-18T12:00:03.000Z"],
      ["2", "2026-08-18T12:00:02.000Z"],
    ]);
  });

  it("turns a missing source sequence range into canonical stream-gap evidence", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const observed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if ((view.runtimes[0]?.records.length ?? 0) >= 5) resolve(view);
      });
    });

    await core.connect(createMockAdapter("stream-gap" as MockScenario));
    const runtime = (await observed).runtimes[0];
    const gaps = runtime?.records.filter(
      (record) => record.kind === "diagnostic-event" && record.event.type === "stream-gap",
    );

    expect(
      gaps?.map((record) =>
        record.kind === "diagnostic-event" && record.event.type === "stream-gap"
          ? {
              source: record.event.sourceStreamId,
              first: record.event.firstLostSequence,
              last: record.event.lastLostSequence,
            }
          : undefined,
      ),
    ).toEqual([
      {
        source: "session-stream-gap-1-stream",
        first: "2",
        last: "2",
      },
    ]);
  });

  it("projects capability degradation and terminal operation failures into runtime views", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const completed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if (
          view.runtimes.length === 2 &&
          view.runtimes.every((runtime) => runtime.records.length >= 4)
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

  it("publishes retained Core views as immutable point-in-time snapshots", async () => {
    const core = createCore({ signal: new AbortController().signal });
    let first: CoreView | undefined;
    const observed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if (view.runtimes[0]?.records.length === 1) first = view;
        if ((view.runtimes[0]?.records.length ?? 0) >= 4) resolve(view);
      });
    });

    await core.connect(createMockAdapter("healthy"));
    await observed;

    expect({
      retainedRecordCount: first?.runtimes[0]?.records.length,
      viewFrozen: Object.isFrozen(first),
      runtimeFrozen: Object.isFrozen(first?.runtimes[0]),
      recordsFrozen: Object.isFrozen(first?.runtimes[0]?.records),
    }).toEqual({
      retainedRecordCount: 1,
      viewFrozen: true,
      runtimeFrozen: true,
      recordsFrozen: true,
    });
  });

  it("rejects new Runtime Sessions after Core shutdown", async () => {
    const lifetime = new AbortController();
    const core = createCore({ signal: lifetime.signal });
    lifetime.abort();

    const result = await core.connect(createMockAdapter("healthy"));

    expect(result).toEqual({
      ok: false,
      error: { code: "cancelled", message: "Core is shut down", retryable: false },
    });
  });
});
