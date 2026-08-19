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
const qualifiedTarget = {
  ...target,
  platform: "test",
  distribution: "fixture-harness",
  buildDigest: "sha256:test-build",
  sourceCommit: "test-source-commit",
  nativeProtocol: "test/1",
};
const harness = {
  kind: "noxscope-qualification-harness" as const,
  version: "1" as const,
  artifactDigest: "sha256:qualification-artifact",
  isolatedProfile: true as const,
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
  options: {
    readonly records?: readonly NoxscopeRecord[];
    readonly hanging?: boolean;
    readonly descriptor?: RuntimeDescriptor;
    readonly requestResult?: unknown;
  } = {},
): NoxscopeAdapter {
  let attempts = 0;
  return {
    async connect() {
      attempts += 1;
      if (options.hanging === true) await new Promise<never>(() => undefined);
      const sessionDescriptor = {
        ...(options.descriptor ?? descriptor),
        sessionId: `session-${attempts}`,
      };
      const sessionRecords = (options.records ?? [snapshotRecord]).map((record) => ({
        ...record,
        meta: { ...record.meta, sessionId: sessionDescriptor.sessionId },
      }));
      return {
        ok: true,
        value: {
          descriptor: sessionDescriptor,
          async *[Symbol.asyncIterator]() {
            for (const record of sessionRecords) yield record;
          },
          async request(request: unknown, requestOptions?: { readonly signal?: AbortSignal }) {
            if (requestOptions?.signal?.aborted) {
              return {
                ok: false as const,
                error: { code: "cancelled" as const, message: "cancelled", retryable: false },
              };
            }
            if (
              typeof request === "object" &&
              request !== null &&
              (request as { readonly kind?: unknown }).kind === "invoke"
            ) {
              return {
                ok: false as const,
                error: { code: "unsupported" as const, message: "unsupported", retryable: false },
              };
            }
            return options.requestResult ?? { ok: true as const, value: snapshot };
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
    const report = await runConnectorQualification({
      source: { midnight: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": provider() } },
      target: { ...qualifiedTarget, surface: "dapp-connector" },
      requestedNetwork: "mainnet",
      evidence: "exercised",
      environment: "mainnet",
      harness,
      operations: {
        enabled: true,
        plan: {
          id: "connector.test-transfer",
          network: "preprod",
          destination: "noxscope-destination-test",
          testIdentity: "noxscope-test-wallet",
          amount: "1",
          maxSpend: "1",
          timeoutMs: 100,
        },
      },
      now: () => timestamp,
    });
    expect(report.assertions.find((assertion) => assertion.id === "D3.4")?.status).toBe("fail");
    expect(report.evidence).toBe("fixture");
    expect(report.admission).toBe("fixture");
  });

  it("enforces typed network, identity, amount, and spend policy before mutation", async () => {
    let invoked = false;
    const operationProvider = {
      ...provider(),
      connect: async (network: string) => ({
        network,
        runHarmlessOperation: async () => {
          invoked = true;
          return {
            ok: true,
            value: { state: "succeeded", operationId: "op-1", network },
          };
        },
      }),
    };
    const report = await runConnectorQualification({
      source: { midnight: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": operationProvider } },
      target: { ...qualifiedTarget, surface: "dapp-connector", network: "preprod" },
      requestedNetwork: "preprod",
      evidence: "exercised",
      environment: "preprod",
      harness,
      operations: {
        enabled: true,
        plan: {
          id: "connector.test-transfer",
          network: "preprod",
          destination: "noxscope-destination-test",
          testIdentity: "noxscope-test-wallet",
          amount: "2",
          maxSpend: "1",
          timeoutMs: 100,
        },
      },
      now: () => timestamp,
    });
    expect(invoked).toBe(false);
    expect(report.assertions.find((assertion) => assertion.id === "D3.4")?.status).toBe("fail");
  });

  it("cannot promote a fixture by relabelling it as exercised", async () => {
    const fixture = conformanceFixture("1am");
    const report = await runConnectorQualification({
      source: fixture.connector ?? {},
      target: fixture.target,
      requestedNetwork: "preprod",
      evidence: "exercised",
      environment: "preprod",
      now: () => timestamp,
    });
    expect(report.evidence).toBe("fixture");
    expect(report.admission).toBe("fixture");
  });

  it("bounds hostile maps and isolates proxy traps", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
        get: () => {
          throw new Error("trap");
        },
      },
    );
    expect(() => discoverMidnightProviders({ midnight: hostile })).not.toThrow();
    const many = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        provider(),
      ]),
    );
    const bounded = discoverMidnightProviders({ midnight: many });
    expect(bounded.providers.length).toBeLessThanOrEqual(1_024);
    expect(bounded.issues.some((issue) => issue.includes("bounded provider count"))).toBe(true);
  });

  it("rejects secret read results and keeps them out of the report", async () => {
    const secretProvider = {
      ...provider(),
      connect: async (network: string) => ({
        network,
        getShieldedBalances: async () => ({ seed: "fixture-secret" }),
      }),
    };
    const report = await runConnectorQualification({
      source: { midnight: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": secretProvider } },
      target: conformanceFixture("lace").target,
      requestedNetwork: "preprod",
      evidence: "fixture",
      environment: "fixture",
      now: () => timestamp,
    });
    expect(
      report.assertions.some(
        (assertion) => assertion.id === "D3.getShieldedBalances" && assertion.status === "fail",
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("fixture-secret");
    expect(Object.prototype.hasOwnProperty.call(report, "raw")).toBe(false);
  });
});

describe("adapter qualification", () => {
  it("admits a healthy exercised adapter only after the full A1-A6 gate", async () => {
    const report = await runAdapterConformance({
      adapter: fixtureAdapter(),
      target: qualifiedTarget,
      evidence: "exercised",
      environment: "localnet",
      harness,
      now: () => timestamp,
      timeoutMs: 20,
    });
    expect(report.evidence).toBe("exercised");
    expect(report.assertions.filter((item) => item.status === "fail")).toEqual([]);
    expect(report.admission).toBe("full");
    expect(report.assertions.find((item) => item.id === "A6.3")?.status).toBe("pass");
    expect(report.assertions.find((item) => item.id === "A6.5")?.status).toBe("pass");
  });

  it("validates canonical records while preserving fixture-only admission", async () => {
    const report = await runAdapterConformance({
      adapter: fixtureAdapter(),
      target: qualifiedTarget,
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
      target: qualifiedTarget,
      evidence: "exercised",
      environment: "localnet",
      harness,
      timeoutMs: 10,
      now: () => timestamp,
    });
    expect(report.admission).toBe("quarantined");
    expect(report.assertions.find((assertion) => assertion.id === "A1.1")?.status).toBe("fail");
  });

  it("fails an empty Runtime Session instead of treating it as conformant", async () => {
    const report = await runAdapterConformance({
      adapter: fixtureAdapter({ records: [] }),
      target: qualifiedTarget,
      evidence: "exercised",
      environment: "localnet",
      harness,
      timeoutMs: 20,
      now: () => timestamp,
    });
    expect(report.assertions.find((assertion) => assertion.id === "A3.1")?.status).toBe("fail");
    expect(report.admission).toBe("quarantined");
  });

  it("rejects additive Result envelopes without echoing hostile fields", async () => {
    const report = await runAdapterConformance({
      adapter: fixtureAdapter({
        requestResult: { ok: true, value: snapshot, evil: "must-not-echo" },
      }),
      target: qualifiedTarget,
      evidence: "exercised",
      environment: "localnet",
      harness,
      now: () => timestamp,
      timeoutMs: 20,
    });
    expect(report.assertions.find((item) => item.id === "A4.1")?.status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("must-not-echo");
  });

  it("contains hostile snapshot getters without crashing the report path", async () => {
    const hostileSnapshot = new Proxy(
      {},
      {
        get: () => {
          throw new Error("snapshot getter trap");
        },
        ownKeys: () => {
          throw new Error("snapshot key trap");
        },
      },
    );
    const report = await runAdapterConformance({
      adapter: fixtureAdapter({ requestResult: { ok: true, value: hostileSnapshot } }),
      target: qualifiedTarget,
      evidence: "exercised",
      environment: "localnet",
      harness,
      now: () => timestamp,
      timeoutMs: 20,
    });
    expect(report.assertions.find((item) => item.id === "A4.1")?.status).toBe("fail");
    expect(report.admission).toBe("quarantined");
  });

  it("does not auto-pass an unknown supported capability", async () => {
    const unknownDescriptor: RuntimeDescriptor = {
      ...descriptor,
      capabilities: [
        ...descriptor.capabilities,
        {
          id: "wallet.mystery",
          kind: "snapshot",
          support: {
            state: "supported",
            version: "1",
            evidence: {
              source: "runtime-declaration",
              observedAt: timestamp,
              summary: "declared for negative qualification coverage",
            },
          },
          availability: { state: "available" },
        },
      ],
    };
    const report = await runAdapterConformance({
      adapter: fixtureAdapter({ descriptor: unknownDescriptor }),
      target: qualifiedTarget,
      evidence: "exercised",
      environment: "localnet",
      harness,
      now: () => timestamp,
      timeoutMs: 20,
    });
    expect(
      report.capabilities
        .find((capability) => capability.id === "wallet.mystery")
        ?.assertions.find((item) => item.id === "CAP.wallet.mystery.suite")?.status,
    ).toBe("fail");
    expect(report.admission).toBe("quarantined");
  });
});
