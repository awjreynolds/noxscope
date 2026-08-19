import { describe, expect, it } from "vitest";
import { isTestOnlyPath, requireScanSet, scanText } from "./secret-scanner.mjs";

describe("release secret scanner", () => {
  it("detects encoded and separator-obscured assignments in production content", () => {
    expect(scanText("api%5Fkey=live-production-value")).not.toEqual([]);
    expect(scanText("access\u200b_token: live-production-value")).not.toEqual([]);
  });

  it("allows only synthetic canaries in explicitly test-only content", () => {
    expect(scanText('mnemonic: "fixture-secret-canary"', { testOnly: true })).toEqual([]);
    expect(scanText('mnemonic: "fixture-secret-canary"')).not.toEqual([]);
    expect(isTestOnlyPath("packages/adapter-gsd/fixtures/hostile-secret.json")).toBe(true);
    expect(isTestOnlyPath("packages/core/src/recording.ts")).toBe(false);
    expect(scanText("-----BEGIN PRIVATE KEY-----", { testOnly: true })).not.toEqual([]);
  });

  it("does not treat normal source identifiers as credentials", () => {
    expect(scanText("const token = endpoint.token; password === undefined;")).toEqual([]);
  });

  it("fails closed when a required scan set is empty", () => {
    expect(() => requireScanSet("fixture", [])).toThrow(/empty or was skipped/u);
    expect(() => requireScanSet("fixture", ["hostile-secret.json"])).not.toThrow();
  });
});
