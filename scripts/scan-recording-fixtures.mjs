/* global URL, console, process */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isTestOnlyPath, requireScanSet, scanText } from "./secret-scanner.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const sourcePaths = tracked.filter(
  (path) =>
    /^(?:packages|apps)\/.+\.(?:[cm]?[jt]sx?|json)$/u.test(path) && !path.includes("/dist/"),
);
const fixturePaths = tracked.filter((path) =>
  /^(?:packages|apps)\/.*(?:\/fixtures\/|\/src\/fixtures\.[cm]?[jt]s$)/u.test(path),
);
const distPaths = [];
const visitDist = (directory) => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) visitDist(path);
    else distPaths.push(path);
  }
};
for (const packageName of readdirSync(`${root}/packages`))
  visitDist(`${root}/packages/${packageName}/dist`);

for (const [name, values] of [
  ["tracked production source", sourcePaths],
  ["tracked fixture", fixturePaths],
  ["built dist", distPaths],
]) {
  try {
    requireScanSet(name, values);
  } catch (error) {
    failures.push(error.message);
  }
}
for (const path of fixturePaths) {
  if (!isTestOnlyPath(path)) failures.push(`fixture path is not explicitly registered: ${path}`);
}

const scan = (relativePath) => {
  const absolute = `${root}/${relativePath}`;
  const findings = scanText(readFileSync(absolute, "utf8"), {
    canaryPath: isTestOnlyPath(relativePath),
  });
  for (const finding of findings) failures.push(`${relativePath}: ${finding}`);
};
for (const path of sourcePaths) scan(path);
for (const path of fixturePaths) {
  if (!sourcePaths.includes(path)) scan(path);
}
for (const absolute of distPaths) {
  const relativePath = absolute.slice(root.length + 1);
  scan(relativePath);
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `content-scan: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `content-scan: checked ${sourcePaths.length} tracked source, ${fixturePaths.length} fixture, and ${distPaths.length} dist file(s); synthetic test canaries are allowlisted only in test fixtures`,
  );
}
