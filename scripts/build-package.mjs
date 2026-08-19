/* global console, process */

import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const dist = join(process.cwd(), "dist");
rmSync(dist, { recursive: true, force: true });
rmSync(join(process.cwd(), "tsconfig.tsbuildinfo"), { force: true });
execFileSync("tsc", ["-p", "tsconfig.json"], { stdio: "inherit" });
console.log(`built ${process.cwd()}`);
