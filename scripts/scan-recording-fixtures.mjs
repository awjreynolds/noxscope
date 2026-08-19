/* global URL, console, process */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixtureRoot = join(root, "fixtures", "recordings");
const candidates = [];
const visit = (directory) => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else candidates.push(path);
  }
};
visit(fixtureRoot);
for (const packageName of readdirSync(join(root, "packages"))) {
  const directory = join(root, "packages", packageName, "fixtures", "recordings");
  visit(directory);
}

const failures = [];
const magic = "NOXSCOPE-RECORDING/1";
const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+/u,
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/._=-]{12,}/iu,
  /\b(?:mnemonic|recoveryPhrase|seed(?:Bytes)?|privateKey|viewingKey|passphrase|password|apiKey|accessToken)\s*[:=]/iu,
  /\b(?:witness|redeemer|signedTx|rawTransaction|transactionBytes|provingKey)\s*[:=]/iu,
];
for (const path of candidates) {
  const bytes = readFileSync(path);
  if (!bytes.toString("utf8", 0, Math.min(bytes.length, 64)).startsWith(magic))
    failures.push(`${relative(root, path)} does not start with Recording v1 magic`);
  const text = bytes.toString("utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text)) failures.push(`${relative(root, path)} matches ${pattern}`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `recording-fixture: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `recording-fixture: scanned ${candidates.length} committed Recording fixture(s); independent secret scan passed`,
  );
}
