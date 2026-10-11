import { describe, expect, it } from "vitest";
import {
  createAgentServer,
  getRequestContext,
  type AgentRegistration,
  type ContextRequest,
  type RequestContext,
} from "../src/index.js";
import { fakeSdkAgent, memoryStorage, parseSse, spyStorage } from "./helpers.js";

const echoHandler = (id: string): AgentRegistration => ({
  info: { id, name: id },
  handler: {
    async processMessage(params) {
      return { content: `echo:${params.message}:${params.context?.user?.id ?? "anon"}` };
    },
  },
});

async function send(server: ReturnType<typeof createAgentServer>, headers: Record<string, string>, agentId: string, message: string) {
  const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId }, headers });
  const conversationId = (created.body as { conversation: { id: string } }).conversation.id;
  const sent = await server.handleRoute("POST", `/conversations/${conversationId}/messages`, {
    query: {},
    body: { message },
    headers,
  });
  return { created, sent, conversationId };
}

describe("resolveContext", () => {
  it("rejects with 401 when the resolver returns null", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: () => null,
    });
    const res = await server.handleRoute("GET", "/agents", { query: {} });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("AUTHENTICATION_ERROR");
  });

  it("gives the resolver normalized headers, cookies, query and mount params", async () => {
    let seen: ContextRequest | undefined;
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: (req) => {
        seen = req;
        return { user: { id: "u1" }, data: {} };
      },
    });
    await server.handleRoute("GET", "/agents", {
      query: { a: "1" },
      headers: { Cookie: "sid=abc%20d; other=1", "X-Thing": "yes" },
      mountParams: { portalKey: "k1" },
      url: "/api/agents?a=1",
    });
    expect(seen?.method).toBe("GET");
    expect(seen?.path).toBe("/agents");
    expect(seen?.headers["x-thing"]).toBe("yes");
    expect(seen?.cookies).toEqual({ sid: "abc d", other: "1" });
    expect(seen?.query).toEqual({ a: "1" });
    expect(seen?.mountParams).toEqual({ portalKey: "k1" });
  });

  it("accepts a sync resolver and defaults missing data to {}", async () => {
    let ctx: RequestContext | undefined;
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: () => ({ user: { id: "u1" } }) as unknown as RequestContext,
      agents: (c) => {
        ctx = c;
        return [];
      },
    });
    await server.handleRoute("GET", "/agents", { query: {} });
    expect(ctx?.data).toEqual({});
  });

  it("does not require a context for public swagger routes", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      swagger: { enabled: true },
      resolveContext: () => null,
    });
    expect((await server.handleRoute("GET", "/docs", { query: {} })).status).toBe(200);
  });

  it("treats the resolved identity as authoritative", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: (req) => {
        const id = req.headers["x-user"];
        return id ? { user: { id: String(id) }, data: {} } : null;
      },
      agents: [echoHandler("a")],
    });

    const alice = { "x-user": "alice" };
    const bob = { "x-user": "bob" };

    // body.userId is ignored: the conversation belongs to the resolved user
    const created = await server.handleRoute("POST", "/conversations", {
      query: {},
      body: { agentId: "a", userId: "bob" },
      headers: alice,
    });
    const conv = (created.body as { conversation: { id: string; userId: string } }).conversation;
    expect(conv.userId).toBe("alice");

    // another user cannot read, write or delete it
    expect((await server.handleRoute("GET", `/conversations/${conv.id}`, { query: {}, headers: bob })).status).toBe(403);
    expect(
      (await server.handleRoute("POST", `/conversations/${conv.id}/messages`, { query: {}, headers: bob, body: { message: "hi" } })).status
    ).toBe(403);
    expect((await server.handleRoute("DELETE", `/conversations/${conv.id}`, { query: {}, headers: bob })).status).toBe(403);

    // query.userId cannot be used to list someone else's conversations
    const listed = await server.handleRoute("GET", "/conversations", { query: { userId: "alice" }, headers: bob });
    expect((listed.body as { conversations: unknown[] }).conversations).toHaveLength(0);
    const own = await server.handleRoute("GET", "/conversations", { query: {}, headers: alice });
    expect((own.body as { conversations: unknown[] }).conversations).toHaveLength(1);
  });

  it("passes the context to agent handlers", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: () => ({ user: { id: "u9" }, data: { tenant: "t1" } }),
      agents: [echoHandler("a")],
    });
    const { sent } = await send(server, {}, "a", "hello");
    expect(sent.status).toBe(200);
    expect((sent.body as { response: { content: string } }).response.content).toBe("echo:hello:u9");
  });

  it("passes the context to sdk agents (config.context) and exposes getRequestContext()", async () => {
    let configContext: unknown;
    let ambient: RequestContext | undefined;
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: () => ({ user: { id: "u1" }, data: { tenant: "t1" } }),
      agents: [
        {
          info: { id: "sdk", name: "sdk" },
          sdkAgent: fakeSdkAgent(async (_params, config) => {
            configContext = config?.context;
            ambient = getRequestContext();
            return { content: "ok" };
          }),
        },
      ],
    });
    await send(server, {}, "sdk", "x");
    expect(configContext).toMatchObject({ user: { id: "u1" }, data: { tenant: "t1" } });
    expect(ambient).toBe(configContext);
  });

  it("keeps getRequestContext() available inside streamed agent runs", async () => {
    let ambient: RequestContext | undefined;
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: () => ({ user: { id: "u1" }, data: { tenant: "t1" } }),
      agents: [
        {
          info: { id: "sdk", name: "sdk" },
          sdkAgent: fakeSdkAgent(async (_p, config) => {
            await new Promise((r) => setTimeout(r, 5));
            ambient = getRequestContext();
            config?.onStream?.({ text: "hi" });
            return { content: "hi" };
          }),
        },
      ],
    });
    const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "sdk" } });
    const id = (created.body as { conversation: { id: string } }).conversation.id;
    const res = await server.handleRoute("POST", `/conversations/${id}/messages`, {
      query: {},
      body: { message: "x", stream: true },
    });
    for await (const _ of res.stream!) void _;
    expect(ambient?.data).toEqual({ tenant: "t1" });
  });

  it("lets a pre-resolved context skip resolveContext", async () => {
    let calls = 0;
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: () => {
        calls++;
        return null;
      },
    });
    const res = await server.handleRoute("GET", "/agents", { query: {}, context: { user: { id: "pre" }, data: {} } });
    expect(res.status).toBe(200);
    expect(calls).toBe(0);
  });

  it("hands resolveUserId the context", async () => {
    let seen: RequestContext | undefined;
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      auth: {
        enabled: false,
        resolveUserId: (c) => {
          seen = c.context;
          return "from-resolver";
        },
      },
      agents: [echoHandler("a")],
    });
    await server.handleRoute("POST", "/conversations", {
      query: {},
      body: { agentId: "a" },
      context: { data: { k: 1 } },
    });
    expect(seen?.data).toEqual({ k: 1 });
  });
});

describe("storage receives the request context", () => {
  it("passes ctx as the last argument of every storage call", async () => {
    const { storage, calls } = spyStorage(await memoryStorage());
    const context: RequestContext = { user: { id: "u1" }, data: { tenant: "t1" } };
    const server = createAgentServer({
      basePath: "/api",
      storage,
      resolveContext: () => context,
      agents: [echoHandler("a")],
    });
    const { conversationId } = await send(server, {}, "a", "hello");
    await server.handleRoute("GET", `/conversations/${conversationId}`, { query: {} });
    await server.handleRoute("GET", `/conversations/${conversationId}/messages`, { query: {} });
    await server.handleRoute("GET", "/conversations", { query: {} });
    await server.handleRoute("DELETE", `/conversations/${conversationId}`, { query: {} });

    // Work that belongs to no request (the recovery sweep) runs with a system context of its own
    const dataCalls = calls.filter(
      (c) => !["connect", "disconnect", "isConnected"].includes(c.method) && !(c.ctx as RequestContext | undefined)?.data?.system
    );
    expect(dataCalls.length).toBeGreaterThan(6);
    for (const call of dataCalls) {
      expect(call.ctx, call.method).toMatchObject({ user: { id: "u1" }, data: { tenant: "t1" } });
    }
    expect(new Set(dataCalls.map((c) => c.method))).toContain("getMessages");
  });

  it("passes ctx for getMessages with and without params", async () => {
    const { storage, calls } = spyStorage(await memoryStorage());
    const server = createAgentServer({ basePath: "/api", storage, resolveContext: () => ({ user: { id: "u1" }, data: {} }), agents: [echoHandler("a")] });
    const { conversationId } = await send(server, {}, "a", "hi");
    calls.length = 0;
    await server.handleRoute("GET", `/conversations/${conversationId}`, { query: {} }); // getMessages(id, undefined, ctx)
    await server.handleRoute("GET", `/conversations/${conversationId}/messages`, { query: {} }); // getMessages(id, {...}, ctx)
    const getMessages = calls.filter((c) => c.method === "getMessages");
    expect(getMessages).toHaveLength(2);
    for (const c of getMessages) expect(c.ctx).toMatchObject({ user: { id: "u1" } });
  });
});

describe("dynamic agents", () => {
  it("resolves the agent list per request", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: (req) => ({ user: { id: "u" }, data: { portal: req.headers["x-portal"] } }),
      agents: async (ctx) => (ctx.data.portal === "p1" ? [echoHandler("a"), echoHandler("b")] : [echoHandler("c")]),
    });
    const list = async (portal: string) =>
      ((await server.handleRoute("GET", "/agents", { query: {}, headers: { "x-portal": portal } })).body as { agents: Array<{ id: string }> }).agents.map((a) => a.id);
    expect(await list("p1")).toEqual(["a", "b"]);
    expect(await list("p2")).toEqual(["c"]);
  });

  it("returns 404 for agents outside the request's registry (get, create, send)", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      resolveContext: (req) => ({ user: { id: "u" }, data: { portal: req.headers["x-portal"] } }),
      agents: (ctx) => (ctx.data.portal === "p1" ? [echoHandler("a")] : []),
    });
    const p1 = { "x-portal": "p1" };
    const p2 = { "x-portal": "p2" };

    const { conversationId } = await send(server, p1, "a", "hi");
    expect((await server.handleRoute("GET", "/agents/a", { query: {}, headers: p2 })).status).toBe(404);
    expect((await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" }, headers: p2 })).status).toBe(404);
    // the conversation exists, but its agent is not served to this request
    expect(
      (await server.handleRoute("POST", `/conversations/${conversationId}/messages`, { query: {}, body: { message: "x" }, headers: p2 })).status
    ).toBe(404);
    expect((await server.handleRoute("GET", "/agents/a", { query: {}, headers: p1 })).status).toBe(200);
  });

  it("merges static registrations; dynamic ids win", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      agents: () => [{ ...echoHandler("shared"), info: { id: "shared", name: "dynamic" } }, echoHandler("dyn")],
    });
    server.registerCustomAgent("shared", echoHandler("shared").handler, { name: "static" });
    server.registerCustomAgent("only-static", echoHandler("x").handler, { name: "s" });
    const agents = ((await server.handleRoute("GET", "/agents", { query: {} })).body as { agents: Array<{ id: string; name: string }> }).agents;
    expect(Object.fromEntries(agents.map((a) => [a.id, a.name]))).toEqual({ shared: "dynamic", dyn: "dyn", "only-static": "s" });
  });

  it("resolves the function once per request", async () => {
    let calls = 0;
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      allowAnonymousList: true,
      agents: () => {
        calls++;
        return [echoHandler("a")];
      },
    });
    await server.handleRoute("GET", "/conversations", { query: {} });
    expect(calls).toBe(1); // list resolves registry for agent names
    await send(server, {}, "a", "hi"); // create + send: two requests
    expect(calls).toBe(3);
  });

  it("surfaces a failing resolver as a 500 and recovers on the next request", async () => {
    let fail = true;
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      agents: () => {
        if (fail) throw new Error("boom");
        return [echoHandler("a")];
      },
    });
    const errorSpy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await server.handleRoute("GET", "/agents", { query: {} })).status).toBe(500);
    fail = false;
    expect((await server.handleRoute("GET", "/agents", { query: {} })).status).toBe(200);
    errorSpy.mockRestore();
  });

  it("registers an array passed as config.agents", async () => {
    const server = createAgentServer({ basePath: "/api", storage: await memoryStorage(), agents: [echoHandler("a")] });
    const res = await server.handleRoute("GET", "/agents/a", { query: {} });
    expect(res.status).toBe(200);
  });

  it("exposes getAgentsFor / getAgentFor", async () => {
    const server = createAgentServer({ basePath: "/api", storage: await memoryStorage(), agents: () => [echoHandler("dyn")] });
    expect((await server.getAgentsFor()).map((a) => a.id)).toEqual(["dyn"]);
    expect(await server.getAgentFor("nope")).toBeUndefined();
    expect(server.getAgents()).toEqual([]); // sync accessor stays static-only
  });
});

describe("legacy behaviour is preserved", () => {
  it("works with the old config shape and no context", async () => {
    const server = createAgentServer({ basePath: "/api/agents", storage: await memoryStorage() });
    server.registerCustomAgent("a", echoHandler("a").handler, { name: "A" });
    const { sent } = await send(server, {}, "a", "hello");
    expect(sent.status).toBe(200);
    expect((sent.body as { response: { content: string } }).response.content).toBe("echo:hello:anon");
    // legacy handleRequest still strips the base path
    const list = await server.handleRequest("GET", "/api/agents/agents", { query: {} });
    expect(list.status).toBe(200);
  });

  it("still honours body/query userId when resolveContext is not configured", async () => {
    const server = createAgentServer({ basePath: "/api", storage: await memoryStorage(), agents: [echoHandler("a")] });
    const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a", userId: "legacy" } });
    expect((created.body as { conversation: { userId: string } }).conversation.userId).toBe("legacy");
  });

  it("answers thrown HTTP errors with their status instead of 500", async () => {
    const server = createAgentServer({ basePath: "/api", storage: await memoryStorage() });
    expect((await server.handleRoute("GET", "/conversations/missing", { query: {} })).status).toBe(404);
    expect((await server.handleRoute("POST", "/conversations", { query: {}, body: {} })).status).toBe(400);
    expect((await server.handleRoute("GET", "/nope", { query: {} })).status).toBe(404);
  });
});
