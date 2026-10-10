import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Starts MongoDB (mongodb-memory-server, or MONGODB_URL) and PostgreSQL (PG_URL, or a throwaway
    // docker container) for the storage tests; see test/storage/global-setup.ts.
    globalSetup: ["./test/storage/global-setup.ts"],
    // The storage contract moves 17 MiB files and a few hundred rows through real databases.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
