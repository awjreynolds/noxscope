import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

const SECRET_KEYS = [
  "mnemonic",
  "recoveryphrase",
  "seed",
  "seedbytes",
  "privatekey",
  "viewingkey",
  "spendingkey",
  "signingkey",
  "passphrase",
  "password",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "clientsecret",
  "authorization",
];

const CONFUSABLES = new Map([
  ["а", "a"],
  ["β", "b"],
  ["в", "b"],
  ["δ", "d"],
  ["е", "e"],
  ["ё", "e"],
  ["ι", "i"],
  ["і", "i"],
  ["ı", "i"],
  ["к", "k"],
  ["λ", "l"],
  ["м", "m"],
  ["н", "h"],
  ["о", "o"],
  ["р", "p"],
  ["с", "c"],
  ["ѕ", "s"],
  ["σ", "s"],
  ["ς", "s"],
  ["τ", "t"],
  ["υ", "u"],
  ["х", "x"],
  ["у", "y"],
  ["ο", "o"],
  ["ρ", "p"],
  ["ν", "v"],
  ["κ", "k"],
  ["μ", "m"],
  ["χ", "x"],
]);

const ESCAPED_ENTITY = /&(colon|equals|lowbar|period|hyphen|amp);/giu;
const NUMERIC_ENTITY = /&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/giu;
const FORBIDDEN_LITERAL = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: "secret-key-id", pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+/u },
  { name: "credential-header", pattern: /\b(?:bearer|basic)\s+[A-Za-z0-9+/._=-]{16,}/iu },
  { name: "credential-url", pattern: /:\/\/[^\s/@:]+:[^\s/@]+@/u },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  },
];
const CODE_PLACEHOLDERS = new Set([
  "undefined",
  "null",
  "true",
  "false",
  "unknown",
  "value",
  "input",
  "output",
  "source",
  "options",
  "request",
  "response",
  "endpoint",
  "token",
  "this",
  "record",
  "candidate",
  "===",
  "!==",
  "==",
  "!=",
  "{",
  "[",
]);
const EXACT_CANARY_PATHS = new Set([
  "apps/web/src/App.test.tsx",
  "apps/web/src/recording-session.test.tsx",
  "apps/web/src/recording-store.test.tsx",
  "packages/adapter-gsd/fixtures/failure.json",
  "packages/adapter-gsd/fixtures/healthy.json",
  "packages/adapter-gsd/fixtures/hostile-secret.json",
  "packages/adapter-gsd/fixtures/README.md",
  "packages/adapter-gsd/fixtures/reconnect.json",
  "packages/adapter-gsd/fixtures/stalled.json",
  "packages/adapter-gsd/src/index.test.ts",
  "packages/adapter-mock/src/index.test.ts",
  "packages/adapter-moth/src/fixtures.ts",
  "packages/adapter-moth/src/index.test.ts",
  "packages/core/src/index.test.ts",
  "packages/core/src/recording-import.test.ts",
  "packages/core/src/recording.test.ts",
  "packages/core/src/sanitizer.test.ts",
  "packages/hostbridge/src/index.test.ts",
]);
/*
 * These values are deliberately explicit.  A test path is not a licence to
 * suppress arbitrary assignments: only a value registered here may be
 * present in one of the exact canary paths below.
 */
const SYNTHETIC_CANARY_VALUES = new Set([
  "abandon abandon abandon",
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "authority-canary",
  "authorization-canary",
  "canary",
  "carriage-secret-canary",
  "checkpoint-secret",
  "client-secret-canary",
  "connector-token",
  "connector-transaction",
  "count-canary",
  "credential",
  "detector-canary",
  "early-secret-canary",
  "fixture-private-payload",
  "fixture-secret-canary",
  "fixture-secret-checkpoint",
  "fixture-secret-key",
  "fixture-secret-vault",
  "fixture-seed-material-must-never-cross-the-adapter-seam",
  "fixture seed material must never cross the adapter seam",
  "fixture-token",
  "fragment-alias-canary",
  "fragment-secret-canary",
  "integrity-canary",
  "json-private-key-canary",
  "launch-token",
  "late-secret-canary",
  "line-separator-secret-canary",
  "moth-personal",
  "moth-token",
  "n0xscope-secret-assignment",
  "n0xscope-secret-token-value",
  "nested-assignment-canary",
  "never-cross-the-seam",
  "never-export",
  "never-publish",
  "newline-secret-canary",
  "paragraph-separator-secret-canary",
  "private-key-canary",
  "prose-secret-canary",
  "query-alias-canary",
  "query-token-canary",
  "second-secret-canary",
  "secret",
  "secret-vault-must-not-cross",
  "seed-canary",
  "session-token-canary",
  "signing-key-canary",
  "spending-key-canary",
  "spending-key-fixture",
  "stack-canary",
  "third-secret-canary",
  "token",
  "transaction-canary",
  "user:secret",
  "viewing-key-canary",
  "wallet-password",
  "ordinary-value",
  "bearer never-export",
  "bearer connector-token",
  "bearer authorization-canary",
  "bearer detector-canary",
  "wallet-user:wallet-password@node.example.test",
  "wallet-user:wallet-password@node.example:9944",
  "json-private-key-canary",
  "unicode-key-canary",
  "seed-authority-canary",
  "api_key=zero-width-canary",
  "apikey=zero-width-canary",
  "access-token=access-token-canary",
  "access-token-canary",
  "refresh token: refresh-token-canary",
  "refresh-token-canary",
  "zero-width-canary",
]);
const SYNTHETIC_JWT_VALUES = new Set([
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub3hzY29wZSJ9.c2lnbmF0dXJl",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuZXN0ZWQifQ.c2lnbmF0dXJl",
]);
const SYNTHETIC_PRIVATE_KEY_MARKERS = new Set(["zmfrzs1rzxk="]);
const FORBIDDEN_VALUE_CHARACTERS = `^"'${String.fromCharCode(96)},;}=<>\\[\\]`;

const ASSIGNMENT_PATTERNS = SECRET_KEYS.map((key) => {
  const letters = [...key].map((letter) => `${letter}[\\W_]*?`).join("");
  return new RegExp(
    `(?:^|[^a-z0-9])${letters}\\s*(?:[:=])\\s*(?:"([^"]*)"|'([^']*)'|(\\[[^\\]]*\\])|([^${FORBIDDEN_VALUE_CHARACTERS}\\s]+))`,
    "giu",
  );
});

function decodeEscapes(value) {
  const codePoint = (raw, radix, original) => {
    const point = Number.parseInt(raw, radix);
    return Number.isInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : original;
  };
  let decoded = value;
  for (let round = 0; round < 3; round += 1) {
    const before = decoded;
    decoded = decoded
      .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex) => codePoint(hex, 16, _match))
      .replace(/\\u([0-9a-f]{4})/giu, (_match, hex) => codePoint(hex, 16, _match))
      .replace(/\\x([0-9a-f]{2})/giu, (_match, hex) => codePoint(hex, 16, _match))
      .replace(
        ESCAPED_ENTITY,
        (_match, name) =>
          ({ colon: ":", equals: "=", lowbar: "_", period: ".", hyphen: "-", amp: "&" })[
            name.toLocaleLowerCase("en-US")
          ],
      )
      .replace(NUMERIC_ENTITY, (_match, hex, decimal) =>
        codePoint(hex ?? decimal, hex === undefined ? 10 : 16, _match),
      );
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Preserve malformed percent encodings for a second conservative scan.
    }
    if (decoded === before) break;
  }
  return decoded;
}

function normalize(value) {
  return decodeEscapes(value)
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(
      /[\u0370-\u03ff\u0400-\u04ffı]/giu,
      (character) => CONFUSABLES.get(character.toLocaleLowerCase("en-US")) ?? character,
    )
    .toLocaleLowerCase("en-US");
}

function syntheticValue(value) {
  const normalized = normalize(value).trim();
  return SYNTHETIC_CANARY_VALUES.has(normalized);
}

function containsSyntheticValue(value) {
  const normalized = normalize(value);
  return [...SYNTHETIC_CANARY_VALUES].some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const simple = /^[a-z0-9]+$/u.test(candidate);
    const boundary = simple ? "[^a-z0-9-]" : "[^a-z0-9]";
    return new RegExp(`(?:^|${boundary})${escaped}(?:$|${boundary})`, "u").test(normalized);
  });
}

function literalAllowed(name, context, canaryPath) {
  if (!canaryPath) return false;
  const normalized = normalize(context);
  if (name === "private-key")
    return [...SYNTHETIC_PRIVATE_KEY_MARKERS].some((marker) => normalized.includes(marker));
  if (name === "jwt")
    return [...SYNTHETIC_JWT_VALUES].some((value) => normalized.includes(normalize(value)));
  return containsSyntheticValue(normalized);
}

function valueAllowed(value, _context, canaryPath) {
  return (
    canaryPath &&
    (syntheticValue(value) || (value.startsWith("[") && containsSyntheticValue(value)))
  );
}

function variants(text) {
  const values = new Set([text, decodeEscapes(text)]);
  for (const value of [...values]) {
    values.add(normalize(value));
  }
  return [...values];
}

/**
 * Scan text without treating field names alone as leaked secrets. Synthetic
 * values are admitted only when the caller supplies one of the exact,
 * registered test/fixture paths; `testOnly` is deliberately not a bypass.
 */
export function scanText(text, { canaryPath = false } = {}) {
  const findings = [];
  for (const variant of variants(text)) {
    for (const { name, pattern } of FORBIDDEN_LITERAL) {
      const match = variant.match(pattern)?.[0];
      if (match === undefined) continue;
      const index = variant.indexOf(match);
      const context = variant.slice(Math.max(0, index - 96), index + match.length + 160);
      if (!literalAllowed(name, context, canaryPath)) findings.push(`literal ${name}`);
    }
    for (const pattern of ASSIGNMENT_PATTERNS) {
      for (const match of variant.matchAll(pattern)) {
        const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
        if (value === "" || CODE_PLACEHOLDERS.has(value.toLocaleLowerCase("en-US"))) continue;
        const context = match[0].slice(0, 256);
        if (!valueAllowed(value, context, canaryPath))
          findings.push(`assignment ${match[0].slice(0, 80)}`);
      }
    }
  }
  return [...new Set(findings)];
}

export function scanBytes(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("scanBytes expects Uint8Array");
  if (bytes.byteLength > 16 * 1024 * 1024) return ["file exceeds bounded scanner input"];
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const latin1 = Buffer.from(bytes).toString("latin1");
  return [...new Set([...scanText(utf8, options), ...scanText(latin1, options)])];
}

export function isTestOnlyPath(path) {
  return EXACT_CANARY_PATHS.has(path);
}

export function requireScanSet(name, values) {
  if (!Array.isArray(values) || values.length === 0)
    throw new Error(`${name} scan set is empty or was skipped`);
}
