/* global URL, console, process */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(root, "packages");
const expected = [
  "@noxscope/protocol",
  "@noxscope/core",
  "@noxscope/adapter-mock",
  "@noxscope/adapter-gsd",
  "@noxscope/adapter-moth",
  "@noxscope/hostbridge",
];
const failures = [];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const packageDirs = readdirSync(packageRoot).filter((name) =>
  statSync(join(packageRoot, name)).isDirectory(),
);
const packages = packageDirs.map((name) => readJson(join(packageRoot, name, "package.json")));

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (rootPackage.private !== true) failures.push("root package must remain private");
if (rootPackage.repository?.url !== "https://github.com/awjreynolds/noxscope.git")
  failures.push("root package must point repository at the Noxscope GitHub source");
if (rootPackage.homepage !== "https://github.com/awjreynolds/noxscope#readme")
  failures.push("root package must declare the Noxscope homepage");
if (rootPackage.bugs?.url !== "https://github.com/awjreynolds/noxscope/issues")
  failures.push("root package must declare the Noxscope issue tracker");
if (readJson(join(root, "apps/web/package.json")).private !== true)
  failures.push("apps/web package must remain private");
for (const name of expected) {
  if (!packages.some((pkg) => pkg.name === name))
    failures.push(`missing publishable package ${name}`);
}

for (const pkg of packages) {
  if (pkg.private === true) failures.push(`${pkg.name} must not be private`);
  if (pkg.license !== "Apache-2.0") failures.push(`${pkg.name} must declare Apache-2.0`);
  if (pkg.repository?.url !== "https://github.com/awjreynolds/noxscope.git")
    failures.push(`${pkg.name} must point repository at the Noxscope GitHub source`);
  if (pkg.homepage !== "https://github.com/awjreynolds/noxscope#readme")
    failures.push(`${pkg.name} must declare the Noxscope homepage`);
  if (pkg.bugs?.url !== "https://github.com/awjreynolds/noxscope/issues")
    failures.push(`${pkg.name} must declare the Noxscope issue tracker`);
  if (pkg.engines?.node !== ">=24.0.0") failures.push(`${pkg.name} must require Node >=24.0.0`);
  if (
    !Array.isArray(pkg.files) ||
    !["dist", "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"].every((file) =>
      pkg.files.includes(file),
    )
  )
    failures.push(`${pkg.name} must publish dist, README, LICENSE, NOTICE, and third-party audit`);
  if (pkg.scripts?.build !== "node ../../scripts/build-package.mjs")
    failures.push(`${pkg.name} must clean and build through the release build helper`);
  if (pkg.main !== "./dist/index.js" || pkg.types !== "./dist/index.d.ts")
    failures.push(`${pkg.name} must point main/types at dist`);
  const rootExport = pkg.exports?.["."];
  if (rootExport?.import !== "./dist/index.js" || rootExport?.types !== "./dist/index.d.ts")
    failures.push(`${pkg.name} root export must point at dist`);
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (subpath === ".") continue;
    if (
      subpath.includes("fixture") ||
      target?.import?.startsWith("./src/") ||
      target?.types?.startsWith("./src/")
    )
      failures.push(`${pkg.name} export ${subpath} must not publish source paths`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `metadata: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `metadata: ${packages.length} publishable packages and private app/root checks passed`,
  );
}
