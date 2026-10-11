/**
 * The example server, built from its settings. `server.ts` runs it; the end-to-end tests build it the same way.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createAgentServer,
  createInMemoryProvider,
  createMongoDBProvider,
  createNodeHandler,
  createSQLiteProvider,
} from "@cognipeer/agent-server";
import type { AgentServer, StorageProvider } from "@cognipeer/agent-server";
import { createExampleAgent, createHostEchoAgent, createModel, pricing } from "./agent.js";

export type StorageKind = "sqlite" | "mongodb" | "memory";

export interface ExampleOptions {
  /** Where conversations live. Default `sqlite`. */
  storage?: StorageKind;
  /** SQLite file (`:memory:` for a throwaway one). Default `./data/example.db`. */
  sqliteFile?: string;
  /** MongoDB connection string. Without one, `storage: "mongodb"` starts an in-memory MongoDB (mongodb-memory-server). */
  mongodbUrl?: string;
  mongodbDatabase?: string;
  /** Where the API is served from. Default `/api/agents`. */
  basePath?: string;
  /** Origins that may call the API from a browser (`*`: any). */
  corsOrigins?: string[];
  /** A spend limit for every new conversation, in USD (counted with `pricing`). */
  budgetUsd?: number;
  /** The model the SDK agent uses (default: from the environment, see `createModel`). */
  model?: unknown;
  /** Let the recovery sweep run on a timer (default on). Tests switch it off. */
  sweep?: boolean;
}

export interface ExampleServer {
  server: AgentServer;
  storage: StorageProvider;
  /** Starts listening. `port: 0` takes a free one. */
  listen(port: number, host?: string): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

/** Settings from the environment: STORAGE, SQLITE_FILE, MONGODB_URL, MONGODB_DB, BASE_PATH, CORS_ORIGINS, BUDGET_USD. */
export function optionsFromEnv(env: Record<string, string | undefined> = process.env): ExampleOptions {
  const storage = (env.STORAGE ?? "sqlite") as StorageKind;
  if (!["sqlite", "mongodb", "memory"].includes(storage)) {
    throw new Error(`STORAGE has to be sqlite, mongodb or memory (got "${env.STORAGE}")`);
  }
  return {
    storage,
    sqliteFile: env.SQLITE_FILE,
    mongodbUrl: env.MONGODB_URL,
    mongodbDatabase: env.MONGODB_DB,
    basePath: env.BASE_PATH,
    corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",").map((origin) => origin.trim()) : undefined,
    budgetUsd: env.BUDGET_USD ? Number(env.BUDGET_USD) : undefined,
  };
}

async function openStorage(options: ExampleOptions): Promise<{ storage: StorageProvider; stop: () => Promise<void> }> {
  const kind = options.storage ?? "sqlite";
  if (kind === "memory") return { storage: createInMemoryProvider(), stop: async () => undefined };

  if (kind === "sqlite") {
    const filename = options.sqliteFile ?? "./data/example.db";
    if (filename !== ":memory:") {
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(filename), { recursive: true });
    }
    return { storage: createSQLiteProvider({ filename }), stop: async () => undefined };
  }

  // MongoDB: yours (MONGODB_URL), or - for a try-out - one that lives and dies with this process
  let url = options.mongodbUrl;
  let stopMemoryServer = async () => undefined as unknown;
  if (!url) {
    const { MongoMemoryServer } = (await import("mongodb-memory-server")) as typeof import("mongodb-memory-server");
    const memory = await MongoMemoryServer.create();
    url = memory.getUri();
    stopMemoryServer = () => memory.stop();
  }
  return {
    storage: createMongoDBProvider({ connectionString: url, database: options.mongodbDatabase ?? "agent_server_example" }),
    stop: async () => void (await stopMemoryServer()),
  };
}

export async function createExampleServer(options: ExampleOptions = {}): Promise<ExampleServer> {
  const { storage, stop } = await openStorage(options);
  await storage.connect();
  const basePath = options.basePath ?? "/api/agents";

  const server = createAgentServer({
    basePath,
    storage,
    swagger: { enabled: true, path: "/docs", title: "Agent Server example", version: "0.3.0" },
    cors: {
      enabled: true,
      origins: options.corsOrigins ?? ["*"],
      headers: ["Content-Type", "Authorization", "Last-Event-ID", "X-User-Id"],
    },
    // Who is asking. Replace this with your own sign-in (a session cookie, a verified token). The example trusts a header and
    // otherwise treats everybody as one demo user - which is also what lets `GET /conversations` answer: listing needs a user.
    resolveContext: (req) => {
      const header = req.headers["x-user-id"];
      const id = (Array.isArray(header) ? header[0] : header) || "demo-user";
      return { user: { id: String(id) }, data: {} };
    },
    pricing,
    ...(options.budgetUsd ? { budget: { maxCostUsd: options.budgetUsd, onReach: "pause" as const }, authorizeBudget: () => true } : {}),
    runs: options.sweep === false ? { sweepIntervalMs: 0, recoverOnStart: false } : undefined,
    // Approvals lapse after a day by default; a short fuse is easier to try
    hitl: { timeoutMinutes: 60 },
  });

  server.registerSDKAgent(
    "assistant",
    createExampleAgent(options.model ?? createModel()),
    {
      name: "Assistant",
      description: "An agent-sdk agent: approvals (try: deploy web), questions (ask me), files (read my files), cancel (slow answer).",
    },
    // (pictures are only shown to a model that can look at them: the scripted one cannot)
    { files: { vision: Boolean(process.env.LLM_BASE_URL) } }
  );
  server.registerHostAgent(createHostEchoAgent());

  const handle = createNodeHandler(server);
  const http_ = http.createServer((req, res) => {
    handle(req, res)
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `The API lives under ${basePath}` } }));
        }
      })
      .catch((error) => {
        console.error(error);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
  });

  return {
    server,
    storage,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        http_.once("error", reject);
        http_.listen(port, host, () => {
          const bound = (http_.address() as AddressInfo).port;
          resolve({ url: `http://${host}:${bound}${basePath}`, port: bound });
        });
      }),
    async close() {
      await server.close({ abort: true });
      http_.closeAllConnections?.();
      await new Promise<void>((resolve) => http_.close(() => resolve()));
      await storage.disconnect();
      await stop();
    },
  };
}
