/* global URL, console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const requiredFiles = ["LICENSE", "NOTICE", "docs/PROVENANCE.md", "docs/THIRD_PARTY_NOTICES.md"];
const failures = [];
for (const relative of requiredFiles) {
  try {
    if (readFileSync(resolve(root, relative), "utf8").trim().length === 0)
      failures.push(`${relative} is empty`);
  } catch {
    failures.push(`${relative} is missing`);
  }
}

const license = readFileSync(resolve(root, "LICENSE"), "utf8");
const notice = readFileSync(resolve(root, "NOTICE"), "utf8");
const provenance = readFileSync(resolve(root, "docs/PROVENANCE.md"), "utf8");
const thirdParty = readFileSync(resolve(root, "docs/THIRD_PARTY_NOTICES.md"), "utf8");
const gsdManifest = readFileSync(resolve(root, "packages/adapter-gsd/src/manifest.ts"), "utf8");
const mothSource = readFileSync(resolve(root, "packages/adapter-moth/src/index.ts"), "utf8");
if (!license.includes("Apache License") || !license.includes("Version 2.0"))
  failures.push("LICENSE is not Apache License 2.0");
if (!notice.includes("Noxscope") || !notice.includes("Copyright 2026"))
  failures.push("NOTICE is missing Noxscope attribution");
const sources = [
  {
    name: "GSD",
    url: "https://github.com/awjreynolds/gsd-wallet",
    commit: "3ec1b1ffd21c371cf769fe1c49e38f837a0f9255",
    manifest: "gsd-wallet@${GSD_SOURCE_COMMIT}",
    source: gsdManifest,
  },
  {
    name: "Moth",
    url: "https://github.com/shieldedtech/moth-wallet",
    commit: "e9a974eb6aa49e4db66c8910328f2f787dde541b",
    manifest: 'MOTH_SOURCE_COMMIT = "e9a974eb6aa49e4db66c8910328f2f787dde541b"',
    source: mothSource,
  },
];
for (const source of sources) {
  for (const value of [source.url, source.commit, source.name.toLowerCase()]) {
    if (!provenance.toLowerCase().includes(value.toLowerCase()))
      failures.push(`PROVENANCE.md lacks exact ${source.name} reference ${value}`);
  }
  if (!source.source.includes(source.commit))
    failures.push(`${source.name} manifest lacks reviewed commit`);
  if (!source.source.includes(source.manifest))
    failures.push(`${source.name} manifest does not bind the exact source revision`);
}
for (const required of ["GSD Adapter", "Moth Adapter", "Source provenance"]) {
  if (!provenance.toLowerCase().includes(required.toLowerCase()))
    failures.push(`PROVENANCE.md lacks ${required}`);
}
if (!thirdParty.includes("lockfile") || !thirdParty.includes("Apache-2.0"))
  failures.push("third-party audit must explain lockfile and Apache boundary");

if (failures.length > 0) {
  console.error(failures.map((failure) => `provenance: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("provenance: Apache-2.0, NOTICE, upstream pins, and third-party audit checks passed");
}
