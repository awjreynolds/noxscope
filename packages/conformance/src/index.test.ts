import { describe, expect, it } from "vitest";
import {
  discoverMidnightProviders,
  observeMidnightDiscovery,
  runAdapterConformance,
  runConnectorQualification,
  selectMidnightProvider,
} from "./index.js";
import { conformanceFixture } from "./fixtures.js";
import {
  NOXSCOPE_PROTOCOL,
  type NoxscopeAdapter,
  type NoxscopeRecord,
  type RuntimeDescriptor,
  type Snapshot,
} from "@noxscope/protocol";

const timestamp = "2026-08-19T00:00:00.000Z";
const target = {
  id: "test.runtime",
  name: "Test Runtime",
  surface: "sdk" as const,
  network: "undeployed",
};

const descriptor: RuntimeDescriptor = {
  protocol: NOXSCOPE_PROTOCOL,
  sessionId: "session-1",
  runtimeId: "runtime-1",
  adapter: { id: "org.example.adapter", version: "1.0.0" },
  runtime: {
    surface: "sdk",
    identifiers: [{ scheme: "fixture", value: "runtime-1", stability: "installation" }],
    versions: [{ subject: "wallet-sdk", version: "1.0.0" }],
  },
  capabilities: [
    {
      id: "sync.observe",
      kind: "snapshot",
      support: {
        state: "supported",
        version: "1",
        evidence: {
          source: "runtime-declaration",
          observedAt: timestamp,
          summary: "fixture declaration",
        },
      },
      availability: { state: "available" },
    },
    {
      id: "operation.submit",
      kind: "operation",
      support: {
        state: "unsupported",
        reason: "fixture is read-only",
        evidence: {
          source: "static-wire-contract",
          observedAt: timestamp,
          summary: "fixture is read-only",
        },
      },
      availability: { state: "unavailable", reason: "read-only", retryable: false },
    },
  ],
};

const snapshot: Snapshot = {
  revision: "1",
  freshness: {
    state: "fresh",
    observedAt: timestamp,
    receivedAt: timestamp,
    source: "runtime",
    consecutiveFailures: 0,
    lastSuccessAt: timestamp,
  },
  lifecycle: { state: "ready" },
  identity: { walletName: "Fixture Wallet" },
  network: { id: "undeployed" },
  sync: { state: "synced", domains: [{ domain: "shielded", state: "synced" }] },
  balances: [{ assetId: "NIGHT", domain: "shielded", amount: "100" }],
};

const snapshotRecord: NoxscopeRecord = {
  kind: "snapshot",
  meta: {
    protocol: NOXSCOPE_PROTOCOL,
    sessionId: descriptor.sessionId,
    runtimeId: descriptor.runtimeId,
    streamId: "state",
    sequence: "1",
    observedAt: timestamp,
    receivedAt: timestamp,
  },
  snapshot,
};

function fixtureAdapter(
  options: { readonly records?: readonly NoxscopeRecord[]; readonly hanging?: boolean } = {},
): NoxscopeAdapter {
  return {
    async connect() {
      if (options.hanging === true) await new Promise<never>(() => undefined);
      return {
        ok: true,
        value: {
          descriptor,
          async *[Symbol.asyncIterator]() {
            for (const record of options.records ?? [snapshotRecord]) yield record;
          },
          async request() {
            return { ok: true as const, value: snapshot };
          },
        },
      };
    },
  } as unknown as NoxscopeAdapter;
}

function provider(apiVersion = "4.0.0", rdns = "org.example.wallet") {
  return {
    rdns,
    name: "Example Wallet",
    icon: "https://wallet.example/icon.svg",
    apiVersion,
    connect: async (network: string) => ({
      network,
      getConfiguration: async () => ({ networkId: network, node: "http://127.0.0.1:9944" }),
      getShieldedBalances: async () => ({ NIGHT: "100" }),
    }),
  };
}

describe("Midnight provider discovery seam", () => {
  it("enumerates own UUID providers and isolates malformed/colliding entries", () => {
    const source = {
      midnight: {
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": provider("4.0.0"),
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": provider("5.0.0"),
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc": provider("4.0.0"),
        "not-a-provider": provider("4.0.0", "org.bad.wallet"),
      },
    };
    const discovery = discoverMidnightProviders(source);
    expect(discovery.providers.filter((candidate) => candidate.valid)).toHaveLength(3);
    expect(discovery.issues.some((issue) => issue.includes("duplicate provider rdns"))).toBe(true);
    expect(selectMidnightProvider(discovery, 5).selected?.provider?.apiVersion).toBe("5.0.0");
    expect(selectMidnightProvider(discovery).issues).toContain(
      "multiple connector API majors require explicit selection",
    );
  });

  it("records asynchronous injection and removal without trusting a friendly property", async () => {
    const map = {
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": provider(),
    };
    let sample = 0;
    const lifecycle = await observeMidnightDiscovery(
      () => {
        sample += 1;
        if (sample === 1) return { midnight: {} };
        if (sample === 2) return { midnight: map };
        return { midnight: {} };
      },
      { intervalMs: 1, maxSamples: 3, now: () => timestamp },
    );
    expect(lifecycle.events.map((event) => event.type)).toEqual(["added", "removed"]);
  });
});

describe("connector qualification", () => {
  it("keeps fixture-shaped Lace evidence at fixture admission", async () => {
    const fixture = conformanceFixture("lace");
    const report = await runConnectorQualification({
      source: fixture.connector ?? {},
      target: fixture.target,
      requestedNetwork: "preprod",
      evidence: "fixture",
      environment: "fixture",
      now: () => timestamp,
    });
    expect(report.admission).toBe("fixture");
    expect(report.connector?.rdns).toBe("io.lace.wallet");
    expect(report.capabilities.some((capability) => capability.support === "supported")).toBe(true);
  });

  it("rejects a mainnet mutation configuration before invoking it", async () => {
    let invoked = false;
    const report = await runConnectorQualification({
      source: { midnight: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": provider() } },
      target: { ...target, surface: "dapp-connector" },
      requestedNetwork: "mainnet",
      evidence: "exercised",
      environment: "mainnet",
      operations: {
        enabled: true,
        expectedNetwork: "preprod",
        run: async () => {
          invoked = true;
          return { ok: true };
        },
      },
      now: () => timestamp,
    });
    expect(invoked).toBe(false);
    expect(report.assertions.find((assertion) => assertion.id === "D3.4")?.status).toBe("fail");
    expect(report.admission).toBe("quarantined");
  });
});

describe("adapter qualification", () => {
  it("validates canonical records while preserving fixture-only admission", async () => {
    const report = await runAdapterConformance({
      adapter: fixtureAdapter(),
      target,
      evidence: "fixture",
      environment: "fixture",
      now: () => timestamp,
      timeoutMs: 20,
    });
    expect(report.admission).toBe("fixture");
    expect(report.descriptor?.protocol).toBe(NOXSCOPE_PROTOCOL);
    expect(report.assertions.find((assertion) => assertion.id === "A3.1")?.status).toBe("pass");
    expect(report.assertions.find((assertion) => assertion.id === "A6.5")?.status).toBe("pass");
  });

  it("bounds a hanging adapter connection", async () => {
    const report = await runAdapterConformance({
      adapter: fixtureAdapter({ hanging: true }),
      target,
      evidence: "exercised",
      environment: "localnet",
      timeoutMs: 10,
      now: () => timestamp,
    });
    expect(report.admission).toBe("quarantined");
    expect(report.assertions.find((assertion) => assertion.id === "A1.1")?.status).toBe("fail");
  });
});
