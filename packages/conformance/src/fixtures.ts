import type { ConnectorSource, QualificationTarget } from "./types.js";

export interface QualificationFixture {
  readonly id: "official-wallet-sdk" | "lace" | "1am" | "gero" | "moth-extension";
  readonly target: QualificationTarget;
  readonly evidence: "fixture";
  readonly fixtureLabel: "deterministic-baseline" | "non-live-qualification";
  readonly provenance: {
    readonly source: string;
    readonly sourceCommit?: string;
    readonly license: "Apache-2.0" | "proprietary" | "unknown";
  };
  readonly network: "undeployed" | "preprod" | "not-tested";
  readonly connector?: ConnectorSource;
}

const fixtureConnect = (network: string): Record<string, unknown> => ({
  network,
  getConfiguration: async () => ({ networkId: network, node: "http://127.0.0.1:9944" }),
  getShieldedAddresses: async () => ["fixture-shielded-address"],
  getUnshieldedAddresses: async () => ["fixture-unshielded-address"],
  getDustAddress: async () => "fixture-dust-address",
  getShieldedBalances: async () => ({ NIGHT: "100" }),
  getUnshieldedBalances: async () => ({ NIGHT: "20" }),
  getDustBalance: async () => "4",
  getTransactionHistory: async () => [],
});

function connectorFixture(
  discoveryKey: string,
  rdns: string,
  name: string,
  apiVersion: string,
): ConnectorSource {
  return {
    midnight: {
      [discoveryKey]: {
        rdns,
        name,
        icon: `https://${rdns}/icon.svg`,
        apiVersion,
        connect: async (network: string) => fixtureConnect(network),
      },
    },
  };
}

/**
 * Retained deterministic metadata and connector-shaped fixtures. These are
 * intentionally not live evidence: fixture admission is enforced by the
 * conformance runner and cannot be promoted by a passing replay.
 */
export const CONFORMANCE_FIXTURES: readonly QualificationFixture[] = Object.freeze([
  {
    id: "official-wallet-sdk",
    target: {
      id: "midnight.official.wallet-sdk",
      name: "Official Midnight Wallet SDK/runtime",
      surface: "sdk",
      distribution: "source-package",
      sourceCommit: "fixture-pinned-sdk-reference",
      nativeProtocol: "midnight-wallet-specification",
      network: "undeployed",
    },
    evidence: "fixture",
    fixtureLabel: "deterministic-baseline",
    provenance: {
      source: "https://github.com/midnightntwrk/midnight-wallet",
      license: "Apache-2.0",
    },
    network: "undeployed",
  },
  {
    id: "lace",
    target: {
      id: "io.lace.wallet",
      name: "Lace browser connector",
      surface: "dapp-connector",
      platform: "browser-extension",
      distribution: "official-extension-store",
      nativeProtocol: "midnight-dapp-connector",
      network: "preprod",
    },
    evidence: "fixture",
    fixtureLabel: "deterministic-baseline",
    provenance: { source: "https://github.com/input-output-hk/lace", license: "Apache-2.0" },
    network: "preprod",
    connector: connectorFixture(
      "11111111-1111-4111-8111-111111111111",
      "io.lace.wallet",
      "Lace",
      "4.0.0",
    ),
  },
  {
    id: "1am",
    target: {
      id: "xyz.1am.wallet",
      name: "1AM browser connector",
      surface: "dapp-connector",
      platform: "browser-extension",
      distribution: "official-extension-store",
      nativeProtocol: "midnight-dapp-connector",
      network: "preprod",
    },
    evidence: "fixture",
    fixtureLabel: "non-live-qualification",
    provenance: { source: "https://1am.xyz/", license: "proprietary" },
    network: "preprod",
    connector: connectorFixture(
      "22222222-2222-4222-8222-222222222222",
      "xyz.1am.wallet",
      "1AM",
      "4.0.0",
    ),
  },
  {
    id: "gero",
    target: {
      id: "io.gero.wallet",
      name: "Gero browser connector",
      surface: "dapp-connector",
      platform: "browser-extension",
      distribution: "official-extension-store",
      nativeProtocol: "midnight-dapp-connector",
      network: "preprod",
    },
    evidence: "fixture",
    fixtureLabel: "non-live-qualification",
    provenance: { source: "https://github.com/Gero-Labs/gerowallet", license: "Apache-2.0" },
    network: "preprod",
    connector: connectorFixture(
      "33333333-3333-4333-8333-333333333333",
      "io.gero.wallet",
      "Gero",
      "4.0.0",
    ),
  },
  {
    id: "moth-extension",
    target: {
      id: "dev.moth.wallet.connector",
      name: "Moth extension connector",
      surface: "dapp-connector",
      platform: "browser-extension",
      distribution: "source-fixture",
      nativeProtocol: "midnight-dapp-connector",
      network: "undeployed",
    },
    evidence: "fixture",
    fixtureLabel: "deterministic-baseline",
    provenance: {
      source: "docs/architecture/MOTH_INTEGRATION.md",
      sourceCommit: "e9a974eb6aa49e4db66c8910328f2f787dde541b",
      license: "Apache-2.0",
    },
    network: "undeployed",
    connector: connectorFixture(
      "44444444-4444-4444-8444-444444444444",
      "dev.moth.wallet",
      "Moth",
      "4.0.1",
    ),
  },
]);

export function conformanceFixture(id: QualificationFixture["id"]): QualificationFixture {
  const fixture = CONFORMANCE_FIXTURES.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`Unknown conformance fixture: ${id}`);
  return fixture;
}
