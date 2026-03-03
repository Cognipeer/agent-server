import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/express": "src/adapters/express.ts",
    "adapters/next": "src/adapters/next.ts",
    "providers/storage/postgres": "src/providers/storage/postgres.ts",
    "providers/storage/mongodb": "src/providers/storage/mongodb.ts",
    "providers/storage/sqlite": "src/providers/storage/sqlite.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: "es2022",
  outDir: "dist",
  external: [
    "express",
    "next",
    "pg",
    "mongodb",
    "better-sqlite3",
    "swagger-ui-express",
    "@cognipeer/agent-sdk",
  ],
});
