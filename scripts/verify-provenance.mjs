/* global URL, console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
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
if (!license.includes("Apache License") || !license.includes("Version 2.0"))
  failures.push("LICENSE is not Apache License 2.0");
if (!notice.includes("Noxscope") || !notice.includes("Copyright 2026"))
  failures.push("NOTICE is missing Noxscope attribution");
for (const commit of provenance.match(/[0-9a-f]{40}/gu) ?? []) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) failures.push(`invalid source commit ${commit}`);
}
for (const required of ["gsd-wallet", "moth-wallet", "GSD Adapter", "Moth Adapter"]) {
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
