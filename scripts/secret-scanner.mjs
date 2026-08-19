const forbiddenAssignments =
  /(?:mnemonic|recoveryphrase|seed(?:bytes)?|privatekey|viewingkey|spendingkey|signingkey|passphrase|password|apikey|accesstoken|refreshtoken|sessiontoken|clientsecret|credential)\s*["']?\s*[:=]\s*["']?([^"'`,;}\s]+)/giu;

const forbiddenLiteral = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+/u,
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/._=-]{16,}/iu,
  /:\/\/[^\s/@:]+:[^\s/@]+@/u,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

const codePlaceholders = new Set([
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
]);

function variants(text) {
  const values = new Set([text, text.normalize("NFKC")]);
  try {
    values.add(decodeURIComponent(text));
  } catch {
    // Invalid percent encoding is still scanned in its original form.
  }
  return [...values].map((value) =>
    value.replace(/\p{Default_Ignorable_Code_Point}/gu, "").normalize("NFKC"),
  );
}

function synthetic(value) {
  return /(?:fixture|canary|never[-_ ](?:export|cross|publish)|must[-_ ]not|n0xscope|secret|token|password|credential|fake|nested|signature|zmfrzs)/iu.test(
    value,
  );
}

/**
 * Scan text without treating field names alone as leaked secrets. Test-only
 * fixtures may contain synthetic canaries, but never real credential-shaped
 * literals. Production and distribution content must contain neither.
 */
export function scanText(text, { testOnly = false } = {}) {
  const findings = [];
  for (const variant of variants(text)) {
    const compactKeys = variant.replace(/(?<=[a-z])[_\-\s]+(?=[a-z])/giu, "");
    for (const pattern of forbiddenLiteral) {
      const match = variant.match(pattern)?.[0];
      const matchIndex = match === undefined ? -1 : variant.indexOf(match);
      const context =
        matchIndex < 0
          ? ""
          : variant.slice(Math.max(0, matchIndex - 64), matchIndex + match.length + 128);
      if (match !== undefined && !(testOnly && synthetic(context)))
        findings.push(`literal ${pattern}`);
    }
    for (const match of compactKeys.matchAll(forbiddenAssignments)) {
      const value = match[1] ?? "";
      if (testOnly || codePlaceholders.has(value.toLocaleLowerCase("en-US"))) continue;
      findings.push(`assignment ${match[0].slice(0, 80)}`);
    }
  }
  return [...new Set(findings)];
}

export function isTestOnlyPath(path) {
  return (
    /(?:^|\/)(?:fixtures|__fixtures__)(?:\/|$)/u.test(path) ||
    /(?:^|\/)[^/]+\.test\.[cm]?[jt]sx?$/u.test(path) ||
    /(?:^|\/)fixtures\.[cm]?[jt]s$/u.test(path)
  );
}

export function requireScanSet(name, values) {
  if (!Array.isArray(values) || values.length === 0)
    throw new Error(`${name} scan set is empty or was skipped`);
}
