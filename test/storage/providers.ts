/**
 * The storage providers the suites run over, and how to open a fresh, isolated store of each.
 *
 *   memory    always
 *   sqlite    better-sqlite3 (a file database, so a restart can reopen it)
 *   mongodb   mongodb-memory-server, or MONGODB_URL
 *   postgres  PG_URL, or a throwaway docker container (see global-setup.ts)
 *
 * A provider that cannot run here is a visible skip. With REQUIRE_ALL_PROVIDERS=1 (CI) it is a
 * failing test instead, so a pipeline cannot go green on memory alone.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, inject, it } from "vitest";
import {
  createInMemoryProvider,
  createMongoDBProvider,
  createPostgresProvider,
  createSQLiteProvider,
} from "../../src/index.js";
import type { StorageProvider } from "../../src/index.js";

export type ProviderName = "memory" | "sqlite" | "mongodb" | "postgres";
export const PROVIDER_NAMES: ProviderName[] = ["memory", "sqlite", "mongodb", "postgres"];

/** One isolated store (its own database / schema / file) and the means to look behind the API. */
export interface OpenedProvider {
  storage: StorageProvider;
  /**
   * A restart: closes the current provider and opens a new one on the same data. In-memory data
   * cannot outlive its provider, so `memory` keeps the instance. Also updates `storage`.
   */
  reopen(): Promise<StorageProvider>;
  /** Number of stored file contents, counted behind the API (orphan check). */
  blobCount(): Promise<number>;
  /** Where the data lives, for tests that look behind the API: `url` + `database` (MongoDB) or `url` + `schema` (PostgreSQL). */
  where: Record<string, string>;
  close(): Promise<void>;
}

export type Availability = { ok: true } | { ok: false; reason: string };

export interface ProviderHarness {
  name: ProviderName;
  available: Availability;
  open(options?: { maxFileStorage?: number }): Promise<OpenedProvider>;
}

export const requireAll = (): boolean => process.env.REQUIRE_ALL_PROVIDERS === "1";

const unique = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

function memoryHarness(): ProviderHarness {
  return {
    name: "memory",
    available: { ok: true },
    async open(options) {
      const handle: OpenedProvider = {
        where: {},
        storage: createInMemoryProvider(options?.maxFileStorage ? { maxFileStorage: options.maxFileStorage } : {}),
        async reopen() {
          return handle.storage;
        },
        async blobCount() {
          return (handle.storage as unknown as { fileContents: Map<string, Buffer> }).fileContents.size;
        },
        async close() {
          await handle.storage.disconnect();
        },
      };
      await handle.storage.connect();
      return handle;
    },
  };
}

/** better-sqlite3 is a native module: it may be missing or built for another Node. */
const sqliteAvailability: Availability = await (async (): Promise<Availability> => {
  try {
    const { default: Database } = await import("better-sqlite3");
    new Database(":memory:").close();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `better-sqlite3 cannot be loaded (${(error as Error).message.split("\n")[0]})` };
  }
})();

function sqliteHarness(): ProviderHarness {
  return {
    name: "sqlite",
    available: sqliteAvailability,
    async open() {
      const dir = await mkdtemp(path.join(tmpdir(), "agent-server-sqlite-"));
      const file = path.join(dir, "test.db");
      const make = () => createSQLiteProvider({ filename: file });
      const handle: OpenedProvider = {
        where: { file },
        storage: make(),
        async reopen() {
          await handle.storage.disconnect();
          handle.storage = make();
          await handle.storage.connect();
          return handle.storage;
        },
        async blobCount() {
          const { default: Database } = await import("better-sqlite3");
          const db = new Database(file, { readonly: true });
          try {
            return (db.prepare("SELECT COUNT(*) AS n FROM agent_server_file_contents").get() as { n: number }).n;
          } finally {
            db.close();
          }
        },
        async close() {
          await handle.storage.disconnect();
          await rm(dir, { recursive: true, force: true });
        },
      };
      await handle.storage.connect();
      return handle;
    },
  };
}

function mongoHarness(): ProviderHarness {
  const infra = inject("storageInfra").mongodb;
  return {
    name: "mongodb",
    available: "url" in infra ? { ok: true } : { ok: false, reason: infra.skip },
    async open() {
      if (!("url" in infra)) throw new Error(infra.skip);
      const database = unique("as_test");
      const make = () => createMongoDBProvider({ connectionString: infra.url, database });
      const handle: OpenedProvider = {
        where: { url: infra.url, database },
        storage: make(),
        async reopen() {
          await handle.storage.disconnect();
          handle.storage = make();
          await handle.storage.connect();
          return handle.storage;
        },
        async blobCount() {
          const { MongoClient } = await import("mongodb");
          const client = await new MongoClient(infra.url).connect();
          try {
            const db = client.db(database);
            return (
              (await db.collection("agent_server_files.files").countDocuments()) +
              (await db.collection("agent_server_file_contents").countDocuments())
            );
          } finally {
            await client.close();
          }
        },
        async close() {
          await handle.storage.disconnect();
          const { MongoClient } = await import("mongodb");
          const client = await new MongoClient(infra.url).connect();
          try {
            await client.db(database).dropDatabase();
          } finally {
            await client.close();
          }
        },
      };
      await handle.storage.connect();
      return handle;
    },
  };
}

function postgresHarness(): ProviderHarness {
  const infra = inject("storageInfra").postgres;
  return {
    name: "postgres",
    available: "url" in infra ? { ok: true } : { ok: false, reason: infra.skip },
    async open() {
      if (!("url" in infra)) throw new Error(infra.skip);
      const schema = unique("as_test");
      const make = () => createPostgresProvider({ connectionString: infra.url, schema });
      const withClient = async <T>(fn: (client: import("pg").Client) => Promise<T>): Promise<T> => {
        const { default: pg } = await import("pg");
        const client = new pg.Client({ connectionString: infra.url });
        await client.connect();
        try {
          return await fn(client);
        } finally {
          await client.end();
        }
      };
      const handle: OpenedProvider = {
        where: { url: infra.url, schema },
        storage: make(),
        async reopen() {
          await handle.storage.disconnect();
          handle.storage = make();
          await handle.storage.connect();
          return handle.storage;
        },
        blobCount: () =>
          withClient(async (client) => {
            const result = await client.query(`SELECT COUNT(*) AS n FROM "${schema}"."agent_server_file_contents"`);
            return Number(result.rows[0].n);
          }),
        async close() {
          await handle.storage.disconnect();
          await withClient((client) => client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
        },
      };
      await handle.storage.connect();
      return handle;
    },
  };
}

export function harnessFor(name: ProviderName): ProviderHarness {
  switch (name) {
    case "memory":
      return memoryHarness();
    case "sqlite":
      return sqliteHarness();
    case "mongodb":
      return mongoHarness();
    case "postgres":
      return postgresHarness();
  }
}

/**
 * `describe` for one provider. When the provider cannot run here the suite is a visible skip,
 * or - with REQUIRE_ALL_PROVIDERS=1 - a failing test that says why.
 */
export function describeProvider(name: ProviderName, body: (harness: ProviderHarness) => void): void {
  const harness = harnessFor(name);
  if (!harness.available.ok) {
    const reason = harness.available.reason;
    if (requireAll()) {
      describe(`${name} (REQUIRE_ALL_PROVIDERS=1)`, () => {
        it("is available", () => {
          throw new Error(`${name} is required but unavailable: ${reason}`);
        });
      });
    } else {
      console.warn(`[storage tests] ${name} SKIPPED: ${reason}`);
      describe.skip(`${name} (skipped: ${reason})`, () => body(harness));
    }
    return;
  }
  describe(name, () => body(harness));
}

/** Opens one store for a whole `describe` and closes it afterwards. */
export function useProvider(harness: ProviderHarness, options?: { maxFileStorage?: number }) {
  const ref: { current: OpenedProvider } = { current: undefined as unknown as OpenedProvider };
  beforeAll(async () => {
    if (!harness.available.ok) return;
    ref.current = await harness.open(options);
  });
  afterAll(async () => {
    await ref.current?.close();
  });
  return ref;
}
