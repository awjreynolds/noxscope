import { createMockAdapter, type MockScenario } from "@noxscope/adapter-mock";
import type {
  NoxscopeAdapter,
  NoxscopeRecord,
  RuntimeDescriptor,
  RuntimeSession,
} from "@noxscope/protocol";
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

  it("keeps reconnect sessions separate when they reuse a stream identity", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const adapter = createMockAdapter("reconnection" as MockScenario);
    const observed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if (
          view.runtimes.length === 2 &&
          view.runtimes.every((runtime) => runtime.records.length >= 4)
        ) {
          resolve(view);
        }
      });
    });

    await core.connect(adapter);
    await core.connect(adapter);
    const timeline = (await observed).timeline;

    expect(timeline.map(({ record }) => [record.meta.sessionId, record.meta.sequence])).toEqual([
      ["session-reconnection-2", "1"],
      ["session-reconnection-2", "2"],
      ["session-reconnection-2", "3"],
      ["session-reconnection-2", "4"],
      ["session-reconnection-1", "1"],
      ["session-reconnection-1", "2"],
      ["session-reconnection-1", "3"],
      ["session-reconnection-1", "4"],
    ]);
  });

  it("keeps stream grouping distinct for NUL and control-character identities", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const first = descriptor("s\u0000t", "u");
    const second = descriptor("s", "t\u0000u");
    const third = descriptor("ユニコード🙂\u0001", "runtime\u0002");
    const firstRecords = [
      diagnosticRecord(first, "1", "2026-08-19T12:00:02.000Z"),
      diagnosticRecord(first, "2", "2026-08-19T12:00:04.000Z"),
    ];
    const secondRecords = [
      diagnosticRecord(second, "1", "2026-08-19T12:00:01.000Z"),
      diagnosticRecord(second, "2", "2026-08-19T12:00:03.000Z"),
    ];
    const thirdRecords = [
      diagnosticRecord(third, "1", "2026-08-19T12:00:00.500Z", "events\u0003"),
      diagnosticRecord(third, "2", "2026-08-19T12:00:05.000Z", "events\u0003"),
    ];
    const completed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        if (
          view.runtimes.length === 3 &&
          view.runtimes.every((runtime) => runtime.records.length === 2)
        )
          resolve(view);
      });
    });

    await Promise.all([
      core.connect(staticAdapter(first, firstRecords)),
      core.connect(staticAdapter(second, secondRecords)),
      core.connect(staticAdapter(third, thirdRecords)),
    ]);
    const timeline = await completed;

    expect(
      timeline.timeline.map(({ record }) => [record.meta.sessionId, record.meta.sequence]),
    ).toEqual([
      ["ユニコード🙂\u0001", "1"],
      ["s", "1"],
      ["s\u0000t", "1"],
      ["s", "2"],
      ["s\u0000t", "2"],
      ["ユニコード🙂\u0001", "2"],
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

  it("keeps generated gaps unique when source streams use core-like and control identities", async () => {
    const core = createCore({ signal: new AbortController().signal });
    const runtime = descriptor("s-hyphen", "runtime");
    const coreLikeStream = "s-hyphen-core";
    const controlStream = "events\u0000\u0001🙂";
    const unicodeStream = "ユニコード-core";
    const records = [
      diagnosticRecord(runtime, "1", "2026-08-19T12:00:00.000Z", coreLikeStream),
      diagnosticRecord(runtime, "1", "2026-08-19T12:00:00.500Z", controlStream),
      diagnosticRecord(runtime, "1", "2026-08-19T12:00:01.000Z", unicodeStream),
      diagnosticRecord(runtime, "4", "2026-08-19T12:00:03.000Z", coreLikeStream),
      diagnosticRecord(runtime, "3", "2026-08-19T12:00:02.000Z", unicodeStream),
      diagnosticRecord(runtime, "5", "2026-08-19T12:00:04.000Z", controlStream),
      diagnosticRecord(runtime, "6", "2026-08-19T12:00:05.000Z", coreLikeStream),
      diagnosticRecord(runtime, "7", "2026-08-19T12:00:06.000Z", controlStream),
    ];
    const observed = new Promise<CoreView>((resolve) => {
      core.subscribe((view) => {
        const current = view.runtimes[0];
        if (
          current !== undefined &&
          (current.records.length >= 13 ||
            current.status === "complete" ||
            current.status === "failed")
        )
          resolve(view);
      });
    });

    await core.connect(staticAdapter(runtime, records));
    const view = await observed;
    const accepted = view.runtimes[0]?.records ?? [];
    const identities = accepted.map((record) =>
      JSON.stringify([record.meta.sessionId, record.meta.streamId, record.meta.sequence]),
    );
    const gaps = accepted.filter(
      (record) => record.kind === "diagnostic-event" && record.event.type === "stream-gap",
    );

    expect(new Set(identities).size).toBe(accepted.length);
    expect(view.timeline).toHaveLength(accepted.length);
    expect(
      new Set(
        view.timeline.map(({ record }) =>
          JSON.stringify([record.meta.sessionId, record.meta.streamId, record.meta.sequence]),
        ),
      ).size,
    ).toBe(view.timeline.length);
    expect(
      [coreLikeStream, controlStream, unicodeStream].map((streamId) =>
        view.timeline
          .filter(({ record }) => record.meta.streamId === streamId)
          .map(({ record }) => record.meta.sequence),
      ),
    ).toEqual([
      ["1", "2", "4", "5", "6"],
      ["1", "2", "5", "6", "7"],
      ["1", "2", "3"],
    ]);
    expect(
      gaps.map((record) =>
        record.kind === "diagnostic-event" && record.event.type === "stream-gap"
          ? {
              stream: record.meta.streamId,
              source: record.event.sourceStreamId,
              sequence: record.meta.sequence,
              first: record.event.firstLostSequence,
              last: record.event.lastLostSequence,
            }
          : undefined,
      ),
    ).toEqual([
      {
        stream: coreLikeStream,
        source: coreLikeStream,
        sequence: "2",
        first: "2",
        last: "3",
      },
      {
        stream: unicodeStream,
        source: unicodeStream,
        sequence: "2",
        first: "2",
        last: "2",
      },
      {
        stream: controlStream,
        source: controlStream,
        sequence: "2",
        first: "2",
        last: "4",
      },
      {
        stream: coreLikeStream,
        source: coreLikeStream,
        sequence: "5",
        first: "5",
        last: "5",
      },
      {
        stream: controlStream,
        source: controlStream,
        sequence: "6",
        first: "6",
        last: "6",
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

function descriptor(sessionId: string, runtimeId: string): RuntimeDescriptor {
  return {
    protocol: "noxscope/adapter/1",
    sessionId,
    runtimeId,
    adapter: { id: "test.adapter", version: "1.0.0" },
    runtime: { surface: "sdk", identifiers: [], versions: [] },
    capabilities: [],
  };
}

function diagnosticRecord(
  runtime: RuntimeDescriptor,
  sequence: string,
  receivedAt: string,
  streamId = "events",
): NoxscopeRecord {
  return {
    kind: "diagnostic-event",
    meta: {
      protocol: "noxscope/adapter/1",
      sessionId: runtime.sessionId,
      runtimeId: runtime.runtimeId,
      streamId,
      sequence,
      observedAt: receivedAt,
      receivedAt,
    },
    event: {
      type: "diagnostic",
      name: `event-${sequence}`,
      category: "test",
      level: "info",
      source: "runtime",
    },
  };
}

function staticAdapter(
  runtime: RuntimeDescriptor,
  records: readonly NoxscopeRecord[],
): NoxscopeAdapter {
  return {
    async connect() {
      const session = {
        descriptor: runtime,
        async *[Symbol.asyncIterator]() {
          yield* records;
        },
        async request() {
          return {
            ok: false as const,
            error: { code: "unsupported" as const, message: "test", retryable: false },
          };
        },
      } as unknown as RuntimeSession;
      return { ok: true as const, value: session };
    },
  };
}
