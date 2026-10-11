import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
// The example (examples/standalone) imports the packages by name, as an application does. In the tests that is this source and, when
// there is a checkout next to this repository (or AGENT_SDK_SRC), the real agent-sdk; without one the example's test is skipped.
const sdkSource = path.resolve(process.env.AGENT_SDK_SRC ?? path.join(root, "../agent-sdk/src/index.ts"));

export default defineConfig({
  resolve: {
    alias: {
      "@cognipeer/agent-server": path.join(root, "src/index.ts"),
      ...(existsSync(sdkSource) ? { "@cognipeer/agent-sdk": sdkSource } : {}),
    },
  },
  test: {
    // Starts MongoDB (mongodb-memory-server, or MONGODB_URL) and PostgreSQL (PG_URL, or a throwaway
    // docker container) for the storage tests; see test/storage/global-setup.ts.
    globalSetup: ["./test/storage/global-setup.ts"],
    // The storage contract moves 17 MiB files and a few hundred rows through real databases.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
