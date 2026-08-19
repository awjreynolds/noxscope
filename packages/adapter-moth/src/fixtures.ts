import { MOTH_DAEMON_PROTOCOL, type MothGetStateResult } from "./index.js";

/** Captured wire-shaped fixtures for the audited Moth daemon contract. */
export const MOTH_FIXTURES = Object.freeze({
  version: Object.freeze({ protocol: MOTH_DAEMON_PROTOCOL, daemon: "0.5.0" }),
  notReady: Object.freeze({ ready: false }),
  ready: Object.freeze({
    ready: true,
    walletName: "fixture-wallet",
    networkId: "undeployed",
    synced: true,
    syncProgress: Object.freeze({
      percentage: 100,
      etaSeconds: null,
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: true,
      slowest: null,
    }),
    balances: Object.freeze({
      shielded: Object.freeze({ NIGHT: "100" }),
      unshielded: Object.freeze({ NIGHT: "20" }),
      dust: "4",
    }),
  }),
  syncing: Object.freeze({
    ready: true,
    networkId: "preprod",
    synced: false,
    syncProgress: Object.freeze({
      percentage: 42,
      etaSeconds: 12,
      shieldedSynced: false,
      unshieldedSynced: true,
      dustSynced: false,
      slowest: "shielded",
    }),
  }),
  authorizationError: Object.freeze({ code: "UNAUTHORIZED", message: "authorization failed" }),
  malformed: Object.freeze({ ready: "yes", balances: [] }),
  oversized: Object.freeze({ ready: true, walletName: "x".repeat(16 * 1024 + 1) }),
  stall: Object.freeze({ code: "TIMEOUT", message: "request timed out" }),
  reconnect: Object.freeze({ code: "CLOSED", message: "socket closed" }),
  secretPayload: Object.freeze({
    seed: "fixture seed material must never cross the Adapter seam",
    authorization: "fixture-token",
    rawTransaction: "fixture-private-payload",
  }),
} satisfies Record<string, unknown>);

export type MothFixtureName = keyof typeof MOTH_FIXTURES;

export function mothStateFixture(name: "notReady" | "ready" | "syncing"): MothGetStateResult {
  return MOTH_FIXTURES[name] as MothGetStateResult;
}
