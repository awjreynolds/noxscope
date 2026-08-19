/* global URL, console, process */

import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanBytes } from "./secret-scanner.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = ["protocol", "core", "adapter-mock", "adapter-gsd", "adapter-moth", "hostbridge"];
const failures = [];
const staging = mkdtempSync(join(tmpdir(), "noxscope-pack-")).replace(/\\/gu, "/");

const parsePackJson = (output, context) => {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed[0] === undefined) throw new Error("empty pack result");
    return parsed[0];
  } catch (error) {
    failures.push(`${context}: npm pack JSON was invalid (${error.message})`);
    return undefined;
  }
};

const packageEntries = (packageName, cwd, args) => {
  const output = execFileSync("npm", ["pack", "--json", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(staging, "npm-cache") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parsePackJson(output, `${packageName} ${args.includes("--dry-run") ? "dry-run" : "pack"}`);
};

try {
  for (const packageName of packages) {
    const cwd = resolve(root, "packages", packageName);
    const dryRun = packageEntries(packageName, cwd, ["--dry-run"]);
    const dryFiles = new Set((dryRun?.files ?? []).map((entry) => normalizeEntry(entry.path)));
    assertPackageEntries(packageName, dryFiles, failures);

    const packed = packageEntries(packageName, cwd, ["--pack-destination", staging]);
    const tarball = packed?.filename;
    if (typeof tarball !== "string") {
      failures.push(`${packageName}: npm pack did not return a tarball filename`);
      continue;
    }
    const tarPath = resolve(staging, tarball);
    const entries = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/\/$/u, ""));
    assertPackageEntries(packageName, new Set(entries), failures);
    const extract = mkdtempSync(join(tmpdir(), "noxscope-pack-extract-")).replace(/\\/gu, "/");
    try {
      execFileSync("tar", ["-xzf", tarPath, "-C", extract]);
      const packageRoot = join(extract, "package");
      const files = collectRegularFiles(packageRoot, failures);
      for (const { absolute, relativePath } of files) {
        let size;
        try {
          size = lstatSync(absolute).size;
        } catch (error) {
          failures.push(
            `${packageName} tarball ${relativePath}: cannot inspect file size (${error.message})`,
          );
          continue;
        }
        if (size > 16 * 1024 * 1024) {
          failures.push(
            `${packageName} tarball ${relativePath}: file exceeds bounded scanner input`,
          );
          continue;
        }
        let bytes;
        try {
          bytes = readFileSync(absolute);
        } catch (error) {
          failures.push(
            `${packageName} tarball ${relativePath}: unreadable file (${error.message})`,
          );
          continue;
        }
        const findings = scanBytes(bytes);
        for (const finding of findings)
          failures.push(`${packageName} tarball ${relativePath}: ${finding}`);
      }
    } finally {
      rmSync(extract, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

function assertPackageEntries(packageName, entries, errors) {
  const required = [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/NOTICE",
    "package/THIRD_PARTY_NOTICES.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ];
  for (const path of required)
    if (!entries.has(path)) errors.push(`${packageName}: missing ${path}`);
  for (const path of entries) {
    if (path === "package") continue;
    const legal =
      /^(?:package\/(?:package\.json|README\.md|LICENSE|NOTICE|THIRD_PARTY_NOTICES\.md))$/u.test(
        path,
      );
    const runtime = /^package\/dist\/[A-Za-z0-9._/-]+\.(?:js|d\.ts)$/u.test(path);
    if (!legal && !runtime) errors.push(`${packageName}: forbidden tarball path ${path}`);
    if (/(?:\.test\.|\/fixtures?\/|\.map$)/iu.test(path))
      errors.push(`${packageName}: test/fixture/map leaked into tarball at ${path}`);
  }
}

function normalizeEntry(path) {
  return path.startsWith("package/") ? path : `package/${path}`;
}

function collectRegularFiles(directory, errors) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    errors.push(`package extraction ${directory}: unreadable directory (${error.message})`);
    return files;
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relativePath = relative(join(directory, ".."), absolute).replaceAll("\\", "/");
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      errors.push(`${relativePath}: cannot inspect extracted entry (${error.message})`);
      continue;
    }
    if (stats.isSymbolicLink()) {
      errors.push(`${relativePath}: symlink is forbidden in a publishable tarball`);
    } else if (stats.isDirectory()) {
      files.push(...collectRegularFiles(absolute, errors));
    } else if (stats.isFile()) {
      files.push({ absolute, relativePath });
    } else {
      errors.push(`${relativePath}: non-regular extracted entry is forbidden`);
    }
  }
  return files;
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `package-content: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `package-content: dry-run and extracted tarball checks passed for ${packages.length} packages`,
  );
}
