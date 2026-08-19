import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

/** Canonicalized S0/S1 names from docs/security/REDACTION_AND_RECORDING.md. */
export const SECRET_KEY_VOCABULARY = Object.freeze([
  "mnemonic",
  "seed",
  "seedbytes",
  "entropy",
  "recoveryphrase",
  "secret",
  "privatekey",
  "spendingkey",
  "viewingkey",
  "signingkey",
  "keymaterial",
  "keymaterialprovider",
  "passphrase",
  "password",
  "passwd",
  "pin",
  "authorization",
  "proxyauthorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "bearer",
  "cookie",
  "setcookie",
  "clientsecret",
  "credential",
  "witness",
  "redeemer",
  "proof",
  "provingkey",
  "signature",
  "signedtx",
  "sealedtx",
  "unsealedtx",
  "rawtx",
  "rawtransaction",
  "transactionbytes",
  "cbor",
  "privatestate",
  "privateinput",
  "checkpoint",
  "vault",
]);
const SECRET_KEYS = SECRET_KEY_VOCABULARY;

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
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
  { name: "secret-key-id", pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+/gu },
  {
    name: "credential-header",
    pattern: /\b(?:bearer|basic)\s+[A-Za-z0-9+/._=-]{16,}/giu,
  },
  { name: "credential-url", pattern: /:\/\/[^\s/@:]+:[^\s/@]+@/gu },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
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
  "new",
  "===",
  "!==",
  "==",
  "!=",
  "{",
  "[",
]);
const CODE_REFERENCE = /^(?:this\.)?(?:#?[A-Za-z_$][\w$]*)(?:\.#?[A-Za-z_$][\w$]*)*$/u;
const TEMPLATE_REFERENCE = /^\$\{(?:this\.)?(?:#?[A-Za-z_$][\w$]*)(?:\.#?[A-Za-z_$][\w$]*)*\}$/u;
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
  "packages/conformance/fixtures/README.md",
  "packages/conformance/src/fixtures.ts",
  "packages/conformance/src/index.test.ts",
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
  "fixture-private-witness",
  "fixture-secret-canary",
  "fixture-secret",
  "fixture-secret-checkpoint",
  "fixture-secret-key",
  "fixture-secret-vault",
  "fixture-seed-material-must-never-cross-the-adapter-seam",
  "fixture seed material must never cross the adapter seam",
  "fixture-token",
  "fragment-alias-canary",
  "fragment-secret-canary",
  "checkpoint-fixture",
  "checkpoint-canary",
  "integrity-canary",
  "json-private-key-canary",
  "launch-token",
  "late-secret-canary",
  "line-separator-secret-canary",
  "moth-personal",
  "moth-token",
  "n0xscope-secret-assignment",
  "n0xscope-secret-token-value",
  "mnemonic abandon abandon abandon",
  "nested-assignment-canary",
  "nested-bearer-canary",
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
  "seed-vault-fixture",
  "seed-canary",
  "session-token-canary",
  "signing-key-canary",
  "spending-key-canary",
  "spending-key-fixture",
  "stack-canary",
  "third-secret-canary",
  "token",
  "t",
  "x",
  "transaction-canary",
  "signed-private-transaction",
  "signed-private-payload",
  "private-transaction-canary",
  "never-cross",
  "gsd-tx",
  "deadbeef",
  "witness-canary",
  "redeemer-canary",
  "proof-canary",
  "proving-key-canary",
  "raw-transaction-canary",
  "session-cookie-canary",
  "vault-canary",
  "theme=dark",
  "user:secret",
  "user",
  "viewing-key-canary",
  "wallet-password",
  "wallet-user",
  "wallet",
  "ordinary-value",
  "bearer never-export",
  "bearer connector-token",
  "bearer authorization-canary",
  "bearer detector-canary",
  "bearer n0xscope-secret-token-value",
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
  "password",
  "a3",
]);
const SYNTHETIC_JWT_VALUES = new Set([
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub3hzY29wZSJ9.c2lnbmF0dXJl",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuZXN0ZWQifQ.c2lnbmF0dXJl",
]);

const ASSIGNMENT_PATTERNS = SECRET_KEYS.map((key) => {
  const keyGap = `(?:(?!["'\`:=;,{}\\[\\]])[\\p{P}\\s])*?`;
  const letters = [...key].map((letter) => `${letter}${keyGap}`).join("");
  return {
    key,
    pattern: new RegExp(`(?:^|[^a-z0-9])${letters}\\s*(?:[:=])\\s*`, "giu"),
  };
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

function literalAllowed(name, context, canaryPath) {
  if (!canaryPath) return false;
  const normalized = normalize(context);
  if (name === "private-key") {
    const fixture = normalized.replace(/\r\n?/gu, "\n").replace(/\\n/gu, "\n");
    return (
      fixture === normalize("-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END PRIVATE KEY-----")
    );
  }
  if (name === "jwt")
    return [...SYNTHETIC_JWT_VALUES].some((value) => normalized === normalize(value));
  if (name === "credential-header")
    return syntheticValue(normalized.replace(/^(?:bearer|basic)\s+/iu, ""));
  if (name === "credential-url") {
    const authority = normalized.slice(3, -1);
    const separator = authority.lastIndexOf(":");
    return (
      separator > 0 &&
      syntheticValue(authority.slice(0, separator)) &&
      syntheticValue(authority.slice(separator + 1))
    );
  }
  return syntheticValue(normalized);
}

function detectorSpan(name, variant, index, match) {
  if (name !== "private-key") return match;
  const remainder = variant.slice(index + match.length, index + match.length + 16 * 1024);
  const nextHeader = remainder.indexOf("-----BEGIN ");
  const body = nextHeader < 0 ? remainder : remainder.slice(0, nextHeader);
  const suffix = body.match(/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u);
  if (suffix === null || suffix.index === undefined) return match;
  const end = index + match.length + suffix.index + suffix[0].length;
  return variant.slice(index, end);
}

function splitArrayElements(value) {
  const elements = [];
  let start = 1;
  let depth = 0;
  let quote = undefined;
  let escaped = false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      elements.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  elements.push(value.slice(start, -1).trim());
  return elements.filter((element) => element.length > 0);
}

function stripQuoted(value) {
  const trimmed = value.trim();
  return /^(["'`])[^]*\1$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function arrayValueAllowed(value, canaryPath) {
  const elements = splitArrayElements(value);
  if (elements.length === 0) return true;
  const reconstructed = elements.map(stripQuoted).join(" ");
  if (syntheticValue(reconstructed)) return true;
  const state = { nodes: 0 };
  const parsed = parseStructuredLiteral(value, 0, state);
  if (state.exhausted) return false;
  if (parsed?.node.type === "array") return structuredValueAllowed(parsed.node, canaryPath);
  return elements.every((element) => {
    const trimmed = element.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]"))
      return arrayValueAllowed(trimmed, canaryPath);
    if (trimmed.startsWith("{") && trimmed.endsWith("}"))
      return scanText(trimmed, { canaryPath }).length === 0;
    return syntheticValue(stripQuoted(trimmed));
  });
}

const MAX_STRUCTURED_BYTES = 16 * 1024;
const MAX_STRUCTURED_DEPTH = 32;
const MAX_STRUCTURED_NODES = 4096;
const STRUCTURED_SECRET_KEYS = new Set([...SECRET_KEYS, "token"]);
const STRUCTURED_KEY_CANDIDATE = new RegExp(
  `(?:^|[,\\{])\\s*["']?(${[...STRUCTURED_SECRET_KEYS].join("|")})["']?\\s*:`,
  "giu",
);
const MALFORMED_STRUCTURED_KEY = new RegExp(
  `["'](?:${[...STRUCTURED_SECRET_KEYS].join("|")})["']\\s*:`,
  "giu",
);

function skipWhitespace(text, index) {
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

function parseStructuredLiteral(text, start = 0, state = { nodes: 0 }, depth = 0) {
  if (text.length > MAX_STRUCTURED_BYTES || depth > MAX_STRUCTURED_DEPTH) {
    state.exhausted = true;
    return undefined;
  }
  let index = skipWhitespace(text, start);
  if (index >= text.length) return undefined;
  if (state.nodes >= MAX_STRUCTURED_NODES) {
    state.exhausted = true;
    return undefined;
  }
  state.nodes += 1;
  const valueStart = index;
  const first = text[index];
  if (first === '"' || first === "'" || first === "`") {
    const quote = first;
    let escaped = false;
    for (index += 1; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote)
        return {
          node: {
            type: quote === "`" ? "template" : "string",
            value: text.slice(valueStart + 1, index),
          },
          end: index + 1,
        };
    }
    return undefined;
  }
  if (first === "[") {
    const items = [];
    index += 1;
    while (true) {
      index = skipWhitespace(text, index);
      if (text[index] === "]") return { node: { type: "array", items }, end: index + 1 };
      const parsed = parseStructuredLiteral(text, index, state, depth + 1);
      if (parsed === undefined) return undefined;
      items.push(parsed.node);
      index = skipWhitespace(text, parsed.end);
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") return { node: { type: "array", items }, end: index + 1 };
      return undefined;
    }
  }
  if (first === "{") {
    const properties = [];
    index += 1;
    while (true) {
      index = skipWhitespace(text, index);
      if (text[index] === "}") return { node: { type: "object", properties }, end: index + 1 };
      let key;
      const keyParsed = parseStructuredLiteral(text, index, state, depth + 1);
      if (keyParsed?.node.type === "string") {
        key = keyParsed.node.value;
        index = keyParsed.end;
      } else {
        const keyStart = index;
        while (index < text.length && !/[\s:]/u.test(text[index])) index += 1;
        if (index === keyStart) return undefined;
        key = text.slice(keyStart, index);
      }
      index = skipWhitespace(text, index);
      if (text[index] !== ":") return undefined;
      const parsed = parseStructuredLiteral(text, index + 1, state, depth + 1);
      if (parsed === undefined) return undefined;
      properties.push({ key: normalize(key), value: parsed.node });
      index = skipWhitespace(text, parsed.end);
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") return { node: { type: "object", properties }, end: index + 1 };
      return undefined;
    }
  }
  const bareStart = index;
  while (index < text.length && !/[\s,}\]]/u.test(text[index])) index += 1;
  if (index === bareStart) return undefined;
  return { node: { type: "bare", value: text.slice(bareStart, index) }, end: index };
}

function structuredValueAllowed(node, canaryPath) {
  if (node.type === "string") return canaryPath && syntheticValue(node.value);
  if (node.type === "template") return TEMPLATE_REFERENCE.test(node.value);
  if (node.type === "bare")
    return (
      CODE_REFERENCE.test(node.value) ||
      CODE_PLACEHOLDERS.has(node.value.toLocaleLowerCase("en-US"))
    );
  if (node.type === "array")
    return node.items.every((item) => structuredValueAllowed(item, canaryPath));
  if (node.type === "object") return scanStructuredObject(node, canaryPath, true).length === 0;
  return false;
}

function scanStructuredObject(node, canaryPath, allowValue = false) {
  const findings = [];
  for (const property of node.properties) {
    if (STRUCTURED_SECRET_KEYS.has(property.key)) {
      if (!structuredValueAllowed(property.value, canaryPath))
        findings.push("assignment structured secret");
    } else if (allowValue && property.key === "value") {
      if (!structuredValueAllowed(property.value, canaryPath))
        findings.push("assignment structured secret");
    } else if (property.value.type === "object" || property.value.type === "array") {
      findings.push(...scanStructuredNode(property.value, canaryPath, allowValue));
    }
  }
  return findings;
}

function scanStructuredNode(node, canaryPath, allowValue = false) {
  if (node.type === "object") return scanStructuredObject(node, canaryPath, allowValue);
  if (node.type === "array")
    return node.items.flatMap((item) => scanStructuredNode(item, canaryPath, allowValue));
  return [];
}

function repairStructuredLiteral(text, start) {
  const stack = [];
  let quote;
  let escaped = false;
  for (let index = start; index < text.length && index < start + MAX_STRUCTURED_BYTES; index += 1) {
    const character = text[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      stack.push("}");
    } else if (character === "[") {
      stack.push("]");
    } else if (character === "}" || character === "]") {
      if (character !== stack.at(-1)) return undefined;
      stack.pop();
      if (stack.length === 0)
        return { text: text.slice(start, index + 1), end: index + 1, complete: true };
    }
  }
  if (quote !== undefined || stack.length === 0) return undefined;
  return { text: text.slice(start) + stack.reverse().join(""), end: text.length, complete: false };
}

function scanMalformedStructured(text, start) {
  const repaired = repairStructuredLiteral(text, start);
  if (repaired !== undefined) {
    const state = { nodes: 0 };
    const parsed = parseStructuredLiteral(repaired.text, 0, state);
    if (state.exhausted) return ["assignment structured limit"];
    if (parsed?.node.type === "object") return scanStructuredNode(parsed.node, false);
  }
  const remainder = text.slice(start, start + MAX_STRUCTURED_BYTES);
  for (const match of remainder.matchAll(MALFORMED_STRUCTURED_KEY)) {
    const valueStart = skipWhitespace(remainder, (match.index ?? 0) + match[0].length);
    if (
      remainder[valueStart] === '"' ||
      remainder[valueStart] === "'" ||
      remainder[valueStart] === "`"
    )
      return ["assignment malformed structured secret"];
  }
  return [];
}

function scanLargeStructuredCandidates(text, canaryPath, depth = 0) {
  if (depth > MAX_STRUCTURED_DEPTH) return ["structured scanner depth exceeded"];
  const findings = [];
  for (const match of text.matchAll(STRUCTURED_KEY_CANDIDATE)) {
    const valueStart = skipWhitespace(text, (match.index ?? 0) + match[0].length);
    const first = text[valueStart];
    if (first === '"' || first === "'" || first === "`") {
      let escaped = false;
      let end = valueStart + 1;
      for (; end < text.length && end < valueStart + MAX_STRUCTURED_BYTES; end += 1) {
        const character = text[end];
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === first) break;
      }
      if (end >= text.length || text[end] !== first) {
        findings.push("assignment malformed structured secret");
      } else if (!canaryPath || !syntheticValue(text.slice(valueStart + 1, end))) {
        findings.push("assignment structured secret");
      }
      continue;
    }
    if (first === "{" || first === "[") {
      if (text.length - valueStart > MAX_STRUCTURED_BYTES) {
        findings.push("assignment structured limit");
        continue;
      }
      const state = { nodes: 0 };
      const parsed = parseStructuredLiteral(
        text.slice(valueStart, valueStart + MAX_STRUCTURED_BYTES),
        0,
        state,
      );
      if (state.exhausted) {
        findings.push("assignment structured limit");
      } else if (parsed?.node.type === "object" || parsed?.node.type === "array") {
        findings.push(
          ...scanStructuredNode(
            parsed.node,
            canaryPath,
            STRUCTURED_SECRET_KEYS.has(normalize(match[1])),
          ),
        );
      } else if (depth < MAX_STRUCTURED_DEPTH) {
        findings.push(
          ...scanLargeStructuredCandidates(text.slice(valueStart + 1), canaryPath, depth + 1),
        );
      }
      continue;
    }
    let end = valueStart;
    while (end < text.length && !/[\s"'`,;}\]]/u.test(text[end])) end += 1;
    const value = text.slice(valueStart, end);
    if (
      value.length === 0 ||
      (!CODE_REFERENCE.test(value) &&
        !CODE_PLACEHOLDERS.has(value.toLocaleLowerCase("en-US")) &&
        (!canaryPath || !syntheticValue(value)))
    )
      findings.push("assignment structured secret");
  }
  return findings;
}

function readAssignmentValue(text, start) {
  if (start >= text.length) return undefined;
  const first = text[start];
  if (first === '"' || first === "'" || first === "`") {
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === first)
        return {
          value: text.slice(start + 1, index),
          end: index + 1,
          kind: first === "`" ? "template" : "literal",
        };
    }
    return undefined;
  }
  if (first === "[" || first === "{") {
    const closing = first === "[" ? "]" : "}";
    const stack = [closing];
    let quote = undefined;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (quote !== undefined) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") quote = character;
      else if (character === "[" || character === "{") stack.push(character === "[" ? "]" : "}");
      else if (character === "]" || character === "}") {
        if (character !== stack.at(-1)) return undefined;
        stack.pop();
        if (stack.length === 0)
          return {
            value: text.slice(start, index + 1),
            end: index + 1,
            kind: first === "[" ? "serialized" : "object",
          };
      }
    }
    return undefined;
  }
  if (/[=<>]/u.test(first)) return undefined;
  let end = start;
  while (end < text.length && !/[\s"'`,;}=<>[\]]/u.test(text[end])) end += 1;
  return end === start ? undefined : { value: text.slice(start, end), end, kind: "bare" };
}

function valueAllowed(value, _context, canaryPath) {
  if (!canaryPath) return false;
  if (value.startsWith("[") && value.endsWith("]")) return arrayValueAllowed(value, canaryPath);
  return syntheticValue(value);
}

function scanSerializedObjectLiterals(value, canaryPath, rootKey) {
  const parsed = parseStructuredLiteral(value);
  if (parsed?.node.type !== "object" && parsed?.node.type !== "array")
    return ["assignment structured secret"];
  return scanStructuredNode(
    parsed.node,
    canaryPath,
    rootKey !== undefined && STRUCTURED_SECRET_KEYS.has(normalize(rootKey)),
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
      for (const result of variant.matchAll(pattern)) {
        const match = result[0];
        const index = result.index ?? 0;
        const span = detectorSpan(name, variant, index, match);
        if (!literalAllowed(name, span, canaryPath)) findings.push(`literal ${name}`);
      }
    }
    if (variant.length > MAX_STRUCTURED_BYTES) {
      findings.push(...scanLargeStructuredCandidates(variant, canaryPath));
    } else {
      for (let index = 0; index < variant.length; index += 1) {
        if (variant[index] !== "{") continue;
        const state = { nodes: 0 };
        const parsed = parseStructuredLiteral(variant, index, state);
        if (state.exhausted) {
          findings.push("assignment structured limit");
        } else if (parsed?.node.type === "object") {
          const trailing = skipWhitespace(variant, parsed.end);
          if (trailing < variant.length && !/[;,)\]]/u.test(variant[trailing]))
            findings.push(...scanMalformedStructured(variant, index));
          else findings.push(...scanStructuredNode(parsed.node, canaryPath));
          index = parsed.end - 1;
        } else findings.push(...scanMalformedStructured(variant, index));
      }
    }
    for (const { key, pattern } of ASSIGNMENT_PATTERNS) {
      for (const match of variant.matchAll(pattern)) {
        const start = (match.index ?? 0) + match[0].length;
        const parsed = readAssignmentValue(variant, start);
        if (parsed === undefined) {
          if (/[=<>]/u.test(variant[start] ?? "")) continue;
          findings.push(`assignment ${match[0].slice(0, 80)}`);
          continue;
        }
        const value = parsed.value;
        if (value === "" || CODE_PLACEHOLDERS.has(value.toLocaleLowerCase("en-US"))) continue;
        const context = variant.slice(match.index ?? 0, parsed.end).slice(0, 256);
        if (parsed.kind === "object") {
          for (const finding of scanSerializedObjectLiterals(value, canaryPath, key))
            findings.push(`nested ${finding}`);
          continue;
        }
        if (parsed.kind === "bare" && CODE_REFERENCE.test(value)) continue;
        if (parsed.kind === "template" && TEMPLATE_REFERENCE.test(value)) continue;
        if (!valueAllowed(value, context, canaryPath))
          findings.push(`assignment ${context.slice(0, 80)}`);
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
