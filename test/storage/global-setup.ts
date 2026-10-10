/**
 * Brings up the databases the storage tests run against, once per `vitest` run.
 *
 *  - MongoDB: `MONGODB_URL` when set (CI service container), else mongodb-memory-server with
 *    the binary pinned by `MONGOMS_VERSION` (default 7.0.14, cached in ~/.cache/mongodb-binaries).
 *  - PostgreSQL: `PG_URL` when set (CI service container), else ONE throwaway docker container
 *    (`agent-server-pgtest-<random>`, random host port, `--rm`) that is removed again at the end.
 *    Nothing else on the docker host is touched. `AGENT_SERVER_TEST_PG=off` skips it.
 *
 * A backend that cannot be brought up is reported as a skip reason; `REQUIRE_ALL_PROVIDERS=1`
 * (CI) turns every skip into a failure.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { GlobalSetupContext } from "vitest/node";

export type Backend = { url: string } | { skip: string };
export interface StorageInfra {
  mongodb: Backend;
  postgres: Backend;
}

declare module "vitest" {
  export interface ProvidedContext {
    storageInfra: StorageInfra;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (args: string[], timeout = 30_000) =>
  execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();

async function startMongo(): Promise<{ backend: Backend; stop?: () => Promise<void> }> {
  if (process.env.MONGODB_URL) return { backend: { url: process.env.MONGODB_URL } };
  try {
    process.env.MONGOMS_VERSION ??= "7.0.14";
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const server = await MongoMemoryServer.create();
    return { backend: { url: server.getUri() }, stop: () => server.stop().then(() => undefined) };
  } catch (error) {
    return { backend: { skip: `MongoDB is not available (${(error as Error).message.split("\n")[0]})` } };
  }
}

async function startPostgres(): Promise<{ backend: Backend; stop?: () => Promise<void> }> {
  if (process.env.PG_URL) return { backend: { url: process.env.PG_URL } };
  if (process.env.AGENT_SERVER_TEST_PG === "off") {
    return { backend: { skip: "PostgreSQL disabled (AGENT_SERVER_TEST_PG=off)" } };
  }
  try {
    docker(["version", "--format", "{{.Server.Version}}"], 10_000);
  } catch {
    return { backend: { skip: "PostgreSQL needs PG_URL or docker; neither is available" } };
  }

  const name = `agent-server-pgtest-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  const remove = () => {
    try {
      docker(["rm", "-f", name], 60_000);
    } catch {
      /* already gone */
    }
  };
  try {
    docker(
      ["run", "-d", "--rm", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432", "postgres:16-alpine"],
      300_000
    );
    process.once("exit", remove);
    const port = docker(["port", name, "5432/tcp"]).split("\n")[0]!.split(":").pop()!;
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;

    // Ready = a real client can run a query (the init phase listens on the socket only)
    const { default: pg } = await import("pg");
    const deadline = Date.now() + 90_000;
    for (;;) {
      const client = new pg.Client({ connectionString: url });
      try {
        await client.connect();
        await client.query("SELECT 1");
        await client.end();
        break;
      } catch (error) {
        await client.end().catch(() => undefined);
        if (Date.now() > deadline) throw error;
        await sleep(500);
      }
    }
    return { backend: { url }, stop: async () => remove() };
  } catch (error) {
    remove();
    return { backend: { skip: `PostgreSQL container did not start (${(error as Error).message.split("\n")[0]})` } };
  }
}

export default async function setup({ config, provide }: GlobalSetupContext) {
  // A run filtered to unrelated files does not pay for databases it will not use
  const filters = config.filters ?? [];
  const wanted = filters.length === 0 || filters.some((f) => /storage|provider|hitl|contract|mongo|postgres|sqlite/i.test(f));

  const stops: Array<() => Promise<void>> = [];
  let mongodb: Backend = { skip: "not needed by the selected tests" };
  let postgres: Backend = { skip: "not needed by the selected tests" };
  if (wanted) {
    const [m, p] = await Promise.all([startMongo(), startPostgres()]);
    mongodb = m.backend;
    postgres = p.backend;
    if (m.stop) stops.push(m.stop);
    if (p.stop) stops.push(p.stop);
  }
  provide("storageInfra", { mongodb, postgres });

  return async () => {
    await Promise.all(stops.map((stop) => stop().catch(() => undefined)));
  };
}
