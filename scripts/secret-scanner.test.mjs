import { describe, expect, it } from "vitest";
import { TextEncoder } from "node:util";
import { isTestOnlyPath, requireScanSet, scanBytes, scanText } from "./secret-scanner.mjs";

describe("release secret scanner", () => {
  it("detects encoded and separator-obscured assignments in production content", () => {
    expect(scanText("api%5Fkey=live-production-value")).not.toEqual([]);
    expect(scanText("access\u200b_token: live-production-value")).not.toEqual([]);
    expect(scanText("private.key: real-production-value", { canaryPath: true })).not.toEqual([]);
    expect(
      scanText(String.raw`private\u004bey: real-production-value`, { canaryPath: true }),
    ).not.toEqual([]);
    expect(
      scanText("ｐｒｉｖａｔｅ．ｋｅｙ=real-production-value", { canaryPath: true }),
    ).not.toEqual([]);
    expect(scanText("private&#x2e;key=real-production-value", { canaryPath: true })).not.toEqual(
      [],
    );
    expect(() => scanText("private&#x110000;key=real-production-value")).not.toThrow();
    expect(scanText("private%2Ekey=real-production-value", { canaryPath: true })).not.toEqual([]);
    expect(scanText("private&#46;key=real-production-value", { canaryPath: true })).not.toEqual([]);
    expect(scanText("private-key=real-production-value", { canaryPath: true })).not.toEqual([]);
    expect(scanText("private key=real-production-value", { canaryPath: true })).not.toEqual([]);
    expect(scanText("рrivаte.key=real-production-value", { canaryPath: true })).not.toEqual([]);
    expect(scanText("раѕѕword=real-production-value", { canaryPath: true })).not.toEqual([]);
    expect(scanText("ѕeed=real-production-value", { canaryPath: true })).not.toEqual([]);
  });

  it("allows only synthetic canaries in explicitly test-only content", () => {
    expect(scanText('mnemonic: "fixture-secret-canary"', { canaryPath: true })).toEqual([]);
    expect(scanText('mnemonic: "fixture-secret-canary"')).not.toEqual([]);
    expect(scanText('mnemonic: "fixture-secret-canary"', { testOnly: true })).not.toEqual([]);
    expect(isTestOnlyPath("packages/adapter-gsd/fixtures/hostile-secret.json")).toBe(true);
    expect(isTestOnlyPath("packages/core/src/recording.ts")).toBe(false);
    expect(isTestOnlyPath("packages/other/src/index.test.ts")).toBe(false);
    expect(scanText("privateKey: real-production-value", { canaryPath: true })).not.toEqual([]);
    expect(scanText('mnemonic: ["real-production-value"]', { canaryPath: true })).not.toEqual([]);
    expect(scanText('mnemonic: ["fixture-secret-canary"]', { canaryPath: true })).toEqual([]);
    expect(scanText("-----BEGIN PRIVATE KEY-----", { canaryPath: true })).not.toEqual([]);
    expect(scanText('"token": "-----BEGIN PRIVATE KEY-----"', { canaryPath: true })).not.toEqual(
      [],
    );
  });

  it("does not treat normal source identifiers as credentials", () => {
    expect(scanText("const token = endpoint.token; password === undefined;")).toEqual([]);
  });

  it("scans bounded bytes rather than relying on file extensions", () => {
    const binary = new Uint8Array([
      0xff,
      ...new TextEncoder().encode("opaque\0privateKey: real-production-value\0"),
    ]);
    expect(scanBytes(binary)).not.toEqual([]);
    expect(scanBytes(new Uint8Array(16 * 1024 * 1024 + 1))).toEqual([
      "file exceeds bounded scanner input",
    ]);
  });

  it("fails closed when a required scan set is empty", () => {
    expect(() => requireScanSet("fixture", [])).toThrow(/empty or was skipped/u);
    expect(() => requireScanSet("fixture", ["hostile-secret.json"])).not.toThrow();
  });
});
