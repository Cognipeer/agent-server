/**
 * Listing is fail-closed: a request that cannot name its user would list the conversations and tasks of everyone,
 * so it is refused (401 `identity_required`) unless the host says the server is single-user (`allowAnonymousList`).
 */

import { describe, expect, it } from "vitest";
import { createAgentServer } from "../src/index.js";
import type { AgentHandler, AgentRegistration, AgentServerConfig, RequestContext } from "../src/index.js";
import { memoryStorage } from "./helpers.js";

const echo: AgentRegistration = {
  info: { id: "a", name: "A" },
  handler: { processMessage: async ({ message }) => ({ content: `echo ${message}` }) } satisfies AgentHandler,
};

async function boot(config: Partial<AgentServerConfig> = {}) {
  const server = createAgentServer({
    basePath: "/api",
    storage: await memoryStorage(),
    agents: [echo],
    runs: { sweepIntervalMs: 0, recoverOnStart: false },
    ...config,
  });
  const call = (method: string, path: string, extra: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; user?: { id: string } } = {}) =>
    server.handleRoute(method, path, { query: extra.query ?? {}, body: extra.body, headers: extra.headers, ...(extra.user ? { user: extra.user } : {}) });
  return { server, call };
}

const byHeader = (req: { headers: Record<string, string | string[] | undefined> }): RequestContext | null => {
  const user = req.headers["x-user"];
  const tenant = String(req.headers["x-tenant"] ?? "t");
  return { ...(user ? { user: { id: String(user) } } : {}), data: { tenant } };
};

describe("listing needs an identity", () => {
  it("refuses a request that names nobody: 401 identity_required, for conversations and tasks", async () => {
    const t = await boot();
    for (const path of ["/conversations", "/tasks"]) {
      const res = await t.call("GET", path);
      expect(res.status, path).toBe(401);
      expect((res.body as any).error.code).toBe("identity_required");
      expect((res.body as any).error.message).toMatch(/allowAnonymousList/);
    }
  });

  it("lists everything on a server that says it is single-user", async () => {
    const t = await boot({ allowAnonymousList: true });
    await t.call("POST", "/conversations", { body: { agentId: "a" } });
    await t.call("POST", "/conversations", { body: { agentId: "a" } });
    const res = await t.call("GET", "/conversations");
    expect(res.status).toBe(200);
    expect((res.body as any).conversations).toHaveLength(2);
    expect((await t.call("GET", "/tasks")).status).toBe(200);
  });

  it("takes a user the server trusts: a token user, a userId in the query, or resolveUserId", async () => {
    const t = await boot();
    await t.call("POST", "/conversations", { body: { agentId: "a", userId: "alice" } });
    await t.call("POST", "/conversations", { body: { agentId: "a", userId: "bob" } });

    const named = await t.call("GET", "/conversations", { query: { userId: "alice" } });
    expect(named.status).toBe(200);
    expect((named.body as any).conversations.map((c: any) => c.userId)).toEqual(["alice"]);

    const token = await t.call("GET", "/conversations", { user: { id: "bob" } });
    expect((token.body as any).conversations.map((c: any) => c.userId)).toEqual(["bob"]);
    expect((await t.call("GET", "/tasks", { user: { id: "bob" } })).status).toBe(200);

    const resolver = await boot({ auth: { enabled: false, resolveUserId: (c) => (c.headers?.["x-who"] as string | undefined) } });
    expect((await resolver.call("GET", "/conversations")).status).toBe(401);
    expect((await resolver.call("GET", "/conversations", { headers: { "x-who": "carol" } })).status).toBe(200);
  });

  it("treats an empty user id as nobody", async () => {
    const t = await boot();
    expect((await t.call("GET", "/conversations", { query: { userId: "" } })).status).toBe(401);
    expect((await t.call("GET", "/conversations", { user: { id: "" } })).status).toBe(401);
  });

  describe("with resolveContext (the resolved identity is authoritative)", () => {
    it("lists a person's own, never another's", async () => {
      const t = await boot({ resolveContext: byHeader });
      await t.call("POST", "/conversations", { body: { agentId: "a" }, headers: { "x-user": "alice" } });
      await t.call("POST", "/conversations", { body: { agentId: "a" }, headers: { "x-user": "bob" } });
      const own = await t.call("GET", "/conversations", { headers: { "x-user": "alice" } });
      expect((own.body as any).conversations.map((c: any) => c.userId)).toEqual(["alice"]);
      // a userId in the query is ignored: it cannot be used to read somebody else's list
      const spoof = await t.call("GET", "/conversations", { headers: { "x-user": "alice" }, query: { userId: "bob" } });
      expect((spoof.body as any).conversations.map((c: any) => c.userId)).toEqual(["alice"]);
    });

    it("refuses a context that carries a tenant but no user, unless anonymous listing is allowed", async () => {
      const t = await boot({ resolveContext: byHeader });
      const res = await t.call("GET", "/conversations", { headers: { "x-tenant": "acme" } });
      expect(res.status).toBe(401);
      expect((res.body as any).error.code).toBe("identity_required");
      expect((await t.call("GET", "/tasks", { headers: { "x-tenant": "acme" } })).status).toBe(401);

      const open = await boot({ resolveContext: byHeader, allowAnonymousList: true });
      expect((await open.call("GET", "/conversations", { headers: { "x-tenant": "acme" } })).status).toBe(200);
    });

    it("keeps refusing a request resolveContext turned away", async () => {
      const t = await boot({ resolveContext: () => null });
      expect((await t.call("GET", "/conversations")).status).toBe(401);
    });
  });

  it("does not change what a single read or write needs", async () => {
    const t = await boot();
    const created = await t.call("POST", "/conversations", { body: { agentId: "a" } });
    expect(created.status).toBe(201);
    const id = (created.body as any).conversation.id as string;
    expect((await t.call("GET", `/conversations/${id}`)).status).toBe(200);
    expect((await t.call("POST", `/conversations/${id}/messages`, { body: { message: "hi" } })).status).toBe(200);
  });
});
