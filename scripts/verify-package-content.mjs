/* global URL, console, process */

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { scanBytes } from "./secret-scanner.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = [
  "protocol",
  "core",
  "adapter-mock",
  "adapter-gsd",
  "adapter-moth",
  "hostbridge",
  "conformance",
];
const failures = [];
const staging = mkdtempSync(join(tmpdir(), "noxscope-pack-")).replace(/\\/gu, "/");
const workspacePackages = new Map(
  readdirSync(packageRoot(root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [`@noxscope/${entry.name}`, resolve(root, "packages", entry.name)]),
);

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
      assertExtractedLegalFiles(packageName, packageRoot, failures);
      linkWorkspaceDependencies(packageRoot, failures);
      await assertImportable(packageName, packageRoot, failures);
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

function assertExtractedLegalFiles(packageName, packageRoot, errors) {
  const checks = [
    ["LICENSE", "Apache License"],
    ["NOTICE", "Noxscope"],
    ["THIRD_PARTY_NOTICES.md", "Apache-2.0"],
  ];
  for (const [relativePath, marker] of checks) {
    let contents;
    try {
      contents = readFileSync(join(packageRoot, relativePath), "utf8");
    } catch (error) {
      errors.push(`${packageName} tarball ${relativePath}: unreadable (${error.message})`);
      continue;
    }
    if (!contents.includes(marker))
      errors.push(`${packageName} tarball ${relativePath}: missing ${marker} attribution`);
  }
}

function linkWorkspaceDependencies(packageRoot, errors) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    errors.push(`package extraction ${packageRoot}: invalid package manifest (${error.message})`);
    return;
  }
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  });
  for (const dependency of dependencies) {
    const target = workspacePackages.get(dependency);
    if (target === undefined) continue;
    const link = join(packageRoot, "node_modules", dependency);
    try {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      errors.push(
        `${manifest.name ?? "package"}: dependency link ${dependency} failed (${error.message})`,
      );
    }
  }
}

async function assertImportable(packageName, packageRoot, errors) {
  const entry = pathToFileURL(join(packageRoot, "dist", "index.js")).href;
  try {
    await import(`${entry}?noxscopePackage=${encodeURIComponent(packageName)}`);
  } catch (error) {
    errors.push(`${packageName} tarball dist/index.js: cannot import (${error.message})`);
  }
}

function normalizeEntry(path) {
  return path.startsWith("package/") ? path : `package/${path}`;
}

function packageRoot(rootDirectory) {
  return join(rootDirectory, "packages");
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
    `package-content: dry-run, extracted tarball, legal, and import checks passed for ${packages.length} packages`,
  );
}
