import type {
  CapabilityAvailability,
  NoxscopeAdapter,
  NoxscopeError,
  RuntimeDescriptor,
  Snapshot,
} from "@noxscope/protocol";

export const CONFORMANCE_SUITE_VERSION = "noxscope-conformance/1" as const;

export type EvidenceKind = "fixture" | "exercised";
export type EvidenceSource =
  "fixture-corpus" | "installed-runtime" | "localnet-harness" | "preprod-harness";
export interface QualificationHarnessAttestation {
  readonly kind: "noxscope-qualification-harness";
  readonly version: "1";
  readonly artifactDigest: string;
  readonly isolatedProfile: true;
}
export type EnvironmentKind = "fixture" | "localnet" | "preprod" | "preview" | "mainnet";
export type AssertionStatus = "pass" | "fail" | "skip";
export type AdmissionState =
  "full" | "connector" | "fixture" | "watch" | "historical" | "blocked" | "quarantined";

export interface QualificationTarget {
  readonly id: string;
  readonly name: string;
  readonly surface: "sdk" | "daemon" | "worker" | "dapp-connector" | "mobile" | string;
  readonly platform?: string;
  readonly distribution?: string;
  readonly buildDigest?: string;
  readonly sourceCommit?: string;
  readonly nativeProtocol?: string;
  readonly network?: string;
}

export type HarmlessConnectorOperationId = "connector.test-transfer";

/**
 * The only connector mutation admitted by this package. The provider receives
 * this typed plan, never the connected provider object or a caller callback.
 */
export interface HarmlessConnectorOperationPlan {
  readonly id: HarmlessConnectorOperationId;
  readonly network: "localnet" | "preprod";
  readonly destination: string;
  readonly testIdentity: string;
  readonly amount: string;
  readonly maxSpend: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface AssertionResult {
  readonly id: string;
  readonly status: AssertionStatus;
  readonly required: boolean;
  readonly evidence: EvidenceKind;
  readonly summary: string;
  readonly details?: readonly string[];
}

export interface CapabilityResult {
  readonly id: string;
  readonly support: "supported" | "unsupported" | "unknown";
  readonly availability: CapabilityAvailability["state"] | "not-tested";
  readonly evidence: EvidenceKind;
  readonly assertions: readonly AssertionResult[];
}

export interface SafetyControls {
  readonly isolatedProfile: boolean;
  readonly noMainnetMutation: boolean;
  readonly expectedNetwork?: string;
  readonly operationAllowlist: readonly string[];
  readonly maxOperations: number;
  readonly redactionRequired: true;
}

export interface QualificationReport {
  readonly schemaVersion: "noxscope.qualification/1";
  readonly kind: "adapter" | "connector";
  readonly suite: { readonly id: typeof CONFORMANCE_SUITE_VERSION; readonly version: string };
  readonly target: QualificationTarget;
  readonly evidence: EvidenceKind;
  readonly evidenceSource: EvidenceSource;
  readonly environment: EnvironmentKind;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly descriptor?: RuntimeDescriptor;
  readonly connector?: ConnectorEvidence;
  readonly assertions: readonly AssertionResult[];
  readonly capabilities: readonly CapabilityResult[];
  readonly admission: AdmissionState;
  readonly safety: SafetyControls;
  readonly redactions: { readonly count: number; readonly policy: string };
}

export interface AdapterConformanceOptions {
  readonly adapter: NoxscopeAdapter;
  readonly target: QualificationTarget;
  readonly evidence?: EvidenceKind;
  readonly environment?: EnvironmentKind;
  readonly timeoutMs?: number;
  readonly maxRecords?: number;
  readonly now?: () => string;
  readonly harness?: QualificationHarnessAttestation;
  readonly operations?: {
    readonly enabled: boolean;
    readonly expectedNetwork: "localnet" | "preprod";
    readonly allowlist: readonly string[];
    readonly maxOperations?: number;
  };
}

export interface ConnectorEvidence {
  readonly discoveryKey: string;
  readonly rdns: string;
  readonly name: string;
  readonly iconOrigin: string;
  readonly apiVersion: string;
  readonly requestedNetwork?: string;
  readonly connectedNetwork?: string;
  readonly methods: readonly string[];
}

export interface ConnectorProvider {
  readonly rdns: string;
  readonly name: string;
  readonly icon: string;
  readonly apiVersion: string;
  readonly connect: (network: string) => Promise<unknown>;
  readonly [key: string]: unknown;
}

export interface DiscoveredProvider {
  readonly discoveryKey: string;
  readonly provider?: ConnectorProvider;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface DiscoveryResult {
  readonly providers: readonly DiscoveredProvider[];
  readonly issues: readonly string[];
}

export interface ConnectorSource {
  readonly midnight?: unknown;
}

export interface ConnectorQualificationOptions {
  readonly source: ConnectorSource | (() => unknown);
  readonly target: QualificationTarget;
  readonly requestedNetwork: string;
  readonly requestedApiMajor?: number;
  readonly evidence?: EvidenceKind;
  readonly environment?: EnvironmentKind;
  readonly timeoutMs?: number;
  readonly now?: () => string;
  readonly harness?: QualificationHarnessAttestation;
  readonly observe?: {
    readonly read: () => unknown | Promise<unknown>;
    readonly intervalMs?: number;
    readonly maxSamples?: number;
    readonly maxEvents?: number;
  };
  readonly operations?: {
    readonly enabled: boolean;
    readonly plan?: HarmlessConnectorOperationPlan;
  };
}

export interface DiscoveryLifecycleEvent {
  readonly type: "added" | "removed";
  readonly discoveryKey: string;
  readonly at: string;
}

export interface DiscoveryLifecycleResult {
  readonly events: readonly DiscoveryLifecycleEvent[];
  readonly samples: number;
  readonly timedOut: boolean;
}

export interface ConnectorSelection {
  readonly selected?: DiscoveredProvider;
  readonly issues: readonly string[];
}

export interface ConformanceRunResult extends QualificationReport {
  readonly snapshot?: Snapshot;
  readonly result?:
    | { readonly ok: true; readonly value: { readonly kind: "bounded-result" } }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: NoxscopeError["code"];
          readonly message:
            "Result error was intentionally redacted" | "Result metadata was invalid";
          readonly retryable: boolean;
        };
      };
}
