import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const source = (packageName: string) => resolve(root, "packages", packageName, "src", "index.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@noxscope/protocol": source("protocol"),
      "@noxscope/core": source("core"),
      "@noxscope/adapter-mock": source("adapter-mock"),
      "@noxscope/adapter-gsd": source("adapter-gsd"),
      "@noxscope/adapter-moth": source("adapter-moth"),
      "@noxscope/hostbridge": source("hostbridge"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.tsx", "scripts/**/*.test.mjs"],
  },
});
