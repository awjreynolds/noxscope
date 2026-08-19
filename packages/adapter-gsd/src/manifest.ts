import type { AdapterSanitizationManifest } from "@noxscope/core";

/**
 * The GSD manifest is deliberately a projection, not a filter applied after
 * cloning a native message.  Every value that crosses the worker/Connect
 * seam has to be named here first.  The source version is the audited GSD
 * revision from docs/architecture/CURRENT_GSD.md.
 */
export const GSD_SOURCE_COMMIT = "3ec1b1ffd21c371cf769fe1c49e38f837a0f9255" as const;

export const GSD_SANITIZATION_MANIFEST: AdapterSanitizationManifest = deepFreeze({
  adapter: {
    id: "org.noxscope.adapter-gsd",
    version: "0.1.0",
    sourceVersions: [`gsd-wallet@${GSD_SOURCE_COMMIT}`],
  },
  policy: {
    id: "noxscope.redaction",
    version: "1.0.0",
    digest: "noxscope-gsd-v1",
  },
  projections: [
    projection("version", "envelope.version", "S3"),
    projection("type", "envelope.type", "S3"),
    projection("stream", "envelope.stream", "S3"),
    projection("sequence", "envelope.sequence", "S3"),
    projection("observedAt", "envelope.observedAt", "S3"),
    projection("requestId", "envelope.requestId", "S3"),
    projection("requestID", "envelope.requestId", "S3"),
    projection("request_id", "envelope.requestId", "S3"),
    projection("operationId", "envelope.operationId", "S3"),
    projection("operationID", "envelope.operationId", "S3"),
    projection("operation_id", "envelope.operationId", "S3"),
    // Runtime descriptor / handshake facts.
    projection("runtime.id", "runtime.id", "S3"),
    projection("runtime.name", "runtime.name", "S3"),
    projection("runtime.surface", "runtime.surface", "S3"),
    projection("runtime.walletVersion", "runtime.walletVersion", "S3"),
    projection("runtime.sdkVersion", "runtime.sdkVersion", "S3"),
    projection("runtime.network", "runtime.network", "S3"),

    // Canonical state fields. Addresses and account identifiers are scoped
    // pseudonyms; balances and progress are safe numeric observations.
    projection("payload.lifecycle", "canonical.lifecycle", "S3"),
    projection("payload.network", "canonical.network", "S3"),
    projection("payload.account", "canonical.account", "S2", "pseudonym"),
    projection("payload.addresses.shielded", "canonical.addresses.shielded", "S2", "pseudonym"),
    projection("payload.addresses.unshielded", "canonical.addresses.unshielded", "S2", "pseudonym"),
    projection("payload.addresses.dust", "canonical.addresses.dust", "S2", "pseudonym"),
    ...syncProjections("shielded"),
    ...syncProjections("unshielded"),
    ...syncProjections("dust"),
    projection("payload.balances.shielded.assetId", "canonical.balances.shielded.assetId", "S3"),
    projection("payload.balances.shielded.amount", "canonical.balances.shielded.amount", "S3"),
    projection(
      "payload.balances.unshielded.assetId",
      "canonical.balances.unshielded.assetId",
      "S3",
    ),
    projection("payload.balances.unshielded.amount", "canonical.balances.unshielded.amount", "S3"),
    projection("payload.balances.dust.assetId", "canonical.balances.dust.assetId", "S3"),
    projection("payload.balances.dust.amount", "canonical.balances.dust.amount", "S3"),
    projection("payload.dependencies.node", "canonical.dependencies.node", "S3"),
    projection("payload.dependencies.indexer", "canonical.dependencies.indexer", "S3"),
    projection("payload.dependencies.prover", "canonical.dependencies.prover", "S3"),

    // Diagnostic fields are individually allowlisted. The arbitrary GSD
    // payload is never copied into attributes or raw detail.
    projection("payload.name", "diagnostic.name", "S3"),
    projection("payload.category", "diagnostic.category", "S3"),
    projection("payload.level", "diagnostic.level", "S3"),
    projection("payload.message", "diagnostic.message", "S3"),
    projection("payload.code", "diagnostic.code", "S3"),
    projection("payload.subsystem", "diagnostic.subsystem", "S3"),
    projection("payload.operationId", "diagnostic.operationId", "S3"),
    projection("payload.operationID", "diagnostic.operationId", "S3"),
    projection("payload.operation_id", "diagnostic.operationId", "S3"),
    projection("payload.requestId", "diagnostic.requestId", "S3"),
    projection("payload.requestID", "diagnostic.requestId", "S3"),
    projection("payload.request_id", "diagnostic.requestId", "S3"),
    projection("payload.kind", "diagnostic.kind", "S3"),
    projection("payload.phase", "diagnostic.phase", "S3"),
    projection("payload.state", "diagnostic.state", "S3"),
    projection("payload.progress", "diagnostic.progress", "S3"),
    projection("payload.error", "diagnostic.error", "S3", "error"),
    projection("payload.detail.source", "diagnosticDetail.source", "S3"),
    projection("payload.detail.subsystem", "diagnosticDetail.subsystem", "S3"),
    projection("payload.detail.code", "diagnosticDetail.code", "S3"),
    projection("payload.detail.phase", "diagnosticDetail.phase", "S3"),
    projection("payload.detail.state", "diagnosticDetail.state", "S3"),
  ],
  raw: {
    namespace: "org.noxscope.gsd.detail",
    schemaVersion: "1",
    projections: [
      projection("source", "source", "S3"),
      projection("subsystem", "subsystem", "S3"),
      projection("code", "code", "S3"),
      projection("phase", "phase", "S3"),
      projection("state", "state", "S3"),
    ],
  },
});

function projection(
  source: string,
  target: string,
  classification: "S2" | "S3",
  transform: "copy" | "pseudonym" | "error" = "copy",
) {
  return { source, target, classification, transform } as const;
}

function syncProjections(domain: "shielded" | "unshielded" | "dust") {
  return [
    projection(`payload.sync.${domain}.state`, `canonical.sync.${domain}.state`, "S3"),
    projection(`payload.sync.${domain}.percentage`, `canonical.sync.${domain}.percentage`, "S3"),
  ];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
