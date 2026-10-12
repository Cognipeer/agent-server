import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
// The tests that need a real agent-sdk (test/real-sdk, test/stop, the example) use, in this order: AGENT_SDK_SRC=/path/to/agent-sdk/src/index.ts,
// the package installed in node_modules (`npm install --no-save <the agent-sdk tarball>`; the abort-signal tests need 0.10.6 or later), and a
// checkout next to this repository. Without any of them those tests are skipped.
const installed = existsSync(path.join(root, "node_modules/@cognipeer/agent-sdk/package.json"));
const override = process.env.AGENT_SDK_SRC ? path.resolve(process.env.AGENT_SDK_SRC) : undefined;
const sibling = path.resolve(root, "../agent-sdk/src/index.ts");
const sdkSource = override ?? (installed ? undefined : existsSync(sibling) ? sibling : undefined);

export default defineConfig({
  resolve: {
    alias: {
      "@cognipeer/agent-server": path.join(root, "src/index.ts"),
      ...(sdkSource && existsSync(sdkSource) ? { "@cognipeer/agent-sdk": sdkSource } : {}),
    },
  },
  test: {
    env: { AGENT_SDK_AVAILABLE: installed || (!!sdkSource && existsSync(sdkSource)) ? "1" : "" },
    // Starts MongoDB (mongodb-memory-server, or MONGODB_URL) and PostgreSQL (PG_URL, or a throwaway
    // docker container) for the storage tests; see test/storage/global-setup.ts.
    globalSetup: ["./test/storage/global-setup.ts"],
    // The storage contract moves 17 MiB files and a few hundred rows through real databases.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
