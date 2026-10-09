import http from "node:http";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, createNodeHandler, type AgentRegistration, type ContextRequest } from "../src/index.js";
import { createNextHandler } from "../src/adapters/next.js";
import { createExpressMiddleware } from "../src/adapters/express.js";
import { createFastifyPlugin, mountOnFastify } from "../src/adapters/fastify.js";
import { fakeSdkAgent, listen, memoryStorage, parseSse } from "./helpers.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const sdkAgent = (reply = "pong"): AgentRegistration => ({
  info: { id: "bot", name: "Bot" },
  sdkAgent: fakeSdkAgent(async () => ({ content: reply })),
});

async function json(res: Response) {
  return (await res.json()) as any;
}

async function converse(base: string, headers: Record<string, string> = {}, message = "ping") {
  const created = await fetch(`${base}/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ agentId: "bot" }),
  });
  const { conversation } = await json(created);
  const res = await fetch(`${base}/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ message, stream: true }),
  });
  return { conversation, res, events: parseSse(await res.text()) };
}

describe("createNodeHandler", () => {
  async function boot(config: Partial<Parameters<typeof createAgentServer>[0]> = {}, options = {}) {
    const server = createAgentServer({ basePath: "/api/agents", storage: await memoryStorage(), agents: [sdkAgent()], ...config });
    const handle = createNodeHandler(server, options);
    const http_ = http.createServer(async (req, res) => {
      if (!(await handle(req, res))) {
        res.statusCode = 418;
        res.end("outside");
      }
    });
    const { url, close } = await listen(http_);
    closers.push(close);
    return { url, server };
  }

  it("serves JSON routes under the server base path", async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/api/agents/agents`);
    expect(res.status).toBe(200);
    expect((await json(res)).agents.map((a: any) => a.id)).toEqual(["bot"]);
  });

  it("returns false (and writes nothing) for paths outside the base path", async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/other`);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("outside");
  });

  it("honours a custom basePath option", async () => {
    const { url } = await boot({}, { basePath: "/x" });
    expect((await fetch(`${url}/x/agents`)).status).toBe(200);
    expect((await fetch(`${url}/api/agents/agents`)).status).toBe(418);
  });

  it("streams SSE, including a final answer from a non-streaming agent", async () => {
    const { url } = await boot();
    const { res, events } = await converse(`${url}/api/agents`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.text", "stream.done"]);
    expect(events[1]).toMatchObject({ text: "pong" });
  });

  it("answers errors with proper statuses", async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/api/agents/conversations/nope`)).status).toBe(404);
    const bad = await fetch(`${url}/api/agents/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("rejects bodies over the limit with 413", async () => {
    const { url } = await boot({}, { maxBodyBytes: 50 });
    const res = await fetch(`${url}/api/agents/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "bot", title: "x".repeat(200) }),
    });
    expect(res.status).toBe(413);
  });

  it("runs resolveContext with cookies and 401s without a session", async () => {
    let seen: ContextRequest | undefined;
    const { url } = await boot({
      resolveContext: (req) => {
        seen = req;
        return req.cookies.sid === "good" ? { user: { id: "u1" }, data: {} } : null;
      },
    });
    expect((await fetch(`${url}/api/agents/agents`)).status).toBe(401);
    const ok = await fetch(`${url}/api/agents/agents?x=1`, { headers: { cookie: "sid=good" } });
    expect(ok.status).toBe(200);
    expect(seen?.query).toEqual({ x: "1" });
    expect(seen?.path).toBe("/agents");
  });

  it("answers CORS preflight when enabled", async () => {
    const { url } = await boot({ cors: { enabled: true, origins: ["https://a.example"] } });
    const res = await fetch(`${url}/api/agents/agents`, { method: "OPTIONS", headers: { origin: "https://a.example" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://a.example");
    const other = await fetch(`${url}/api/agents/agents`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("applies token auth", async () => {
    const { url } = await boot({
      auth: { enabled: true, provider: { validateToken: async (t) => (t === "tok" ? { valid: true, userId: "u" } : { valid: false }) } },
    });
    expect((await fetch(`${url}/api/agents/agents`)).status).toBe(401);
    expect((await fetch(`${url}/api/agents/agents`, { headers: { authorization: "Bearer tok" } })).status).toBe(200);
  });

  it("stops consuming the agent stream when the client disconnects", async () => {
    const slow: AgentRegistration = {
      info: { id: "bot", name: "Bot" },
      sdkAgent: fakeSdkAgent(async (_p, config) => {
        for (let i = 0; i < 50; i++) {
          config?.onStream?.({ text: `t${i} ` });
          await new Promise((r) => setTimeout(r, 20));
        }
        return { content: "done" };
      }),
    };
    const { url } = await boot({ agents: [slow] });
    const created = await json(await fetch(`${url}/api/agents/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "bot" }) }));
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/agents/conversations/${created.conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x", stream: true }),
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 100));
    // the server must still be healthy after an aborted stream
    expect((await fetch(`${url}/api/agents/agents`)).status).toBe(200);
  });
});

describe("Fastify adapter", () => {
  async function boot(config: Partial<Parameters<typeof createAgentServer>[0]> = {}, prefix = "/api/portal/:portalKey") {
    const server = createAgentServer({ basePath: "/ignored", storage: await memoryStorage(), agents: [sdkAgent()], ...config });
    const app = Fastify();
    mountOnFastify(app, server, { prefix });
    app.get("/health", async () => ({ ok: true }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const { port } = app.server.address() as { port: number };
    return { app, url: `http://127.0.0.1:${port}`, server };
  }

  it("serves under a parameterised prefix and passes the params to resolveContext", async () => {
    const seen: ContextRequest[] = [];
    const { url } = await boot({
      resolveContext: (req) => {
        seen.push(req);
        return { user: { id: "u1" }, data: { portalKey: req.mountParams.portalKey } };
      },
    });
    const res = await fetch(`${url}/api/portal/abc123/agents`);
    expect(res.status).toBe(200);
    expect(seen[0].mountParams).toEqual({ portalKey: "abc123" });
    expect(seen[0].path).toBe("/agents");
    // the bare prefix maps to "/" (unknown route -> our 404, not Fastify's)
    const root = await fetch(`${url}/api/portal/abc123`);
    expect(root.status).toBe(404);
    expect((await json(root)).error.code).toBe("NOT_FOUND");
  });

  it("uses Fastify's parsed JSON body and streams SSE", async () => {
    const { url } = await boot();
    const { res, events, conversation } = await converse(`${url}/api/portal/k1`);
    expect(conversation.agentId).toBe("bot");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.text", "stream.done"]);
  });

  it("reads a body the app's own JSON parser left as a raw string or Buffer", async () => {
    for (const parseAs of ["string", "buffer"] as const) {
      const server = createAgentServer({ basePath: "/x", storage: await memoryStorage(), agents: [sdkAgent()] });
      const app = Fastify();
      // e.g. an app that keeps bodies raw for a framework that re-parses them
      app.addContentTypeParser("application/json", { parseAs }, (_req, body, done) => done(null, body));
      mountOnFastify(app, server, { prefix: "/p/:k" });
      await app.listen({ port: 0, host: "127.0.0.1" });
      closers.push(() => app.close());
      const { port } = app.server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/p/k1`;

      const created = await fetch(`${url}/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "bot" }),
      });
      expect(created.status, parseAs).toBe(201);
      const bad = await fetch(`${url}/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(bad.status, parseAs).toBe(400);
    }
  });

  it("returns 401 for unauthenticated requests and leaves other routes alone", async () => {
    const { url } = await boot({ resolveContext: () => null });
    expect((await fetch(`${url}/api/portal/k/agents`)).status).toBe(401);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it("scopes dynamic agents per mount param", async () => {
    const { url } = await boot({
      resolveContext: (req) => ({ user: { id: "u" }, data: { key: req.mountParams.portalKey } }),
      agents: (ctx) => (ctx.data.key === "one" ? [sdkAgent()] : []),
    });
    expect((await json(await fetch(`${url}/api/portal/one/agents`))).agents).toHaveLength(1);
    expect((await json(await fetch(`${url}/api/portal/two/agents`))).agents).toHaveLength(0);
    const create = await fetch(`${url}/api/portal/two/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "bot" }),
    });
    expect(create.status).toBe(404);
  });

  it("carries headers set by earlier hooks over to the hijacked response", async () => {
    const server = createAgentServer({ basePath: "/x", storage: await memoryStorage(), agents: [sdkAgent()] });
    const app = Fastify();
    app.addHook("onRequest", async (_req, reply) => {
      reply.header("x-request-id", "rid-1");
    });
    app.register(createFastifyPlugin(server), { prefix: "/p/:k" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const { port } = app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/p/z/agents`);
    expect(res.headers.get("x-request-id")).toBe("rid-1");
  });

  it("tolerates DELETE and bodyless POST", async () => {
    const { url } = await boot();
    const { conversation } = await converse(`${url}/api/portal/k1`);
    const del = await fetch(`${url}/api/portal/k1/conversations/${conversation.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
  });
});

describe("Express and Next adapters feed resolveContext", () => {
  it("Next: forwards headers, cookies and the native request", async () => {
    let seen: ContextRequest | undefined;
    const server = createAgentServer({
      basePath: "/api/agents",
      storage: await memoryStorage(),
      agents: [sdkAgent()],
      resolveContext: (req) => {
        seen = req;
        return req.cookies.sid ? { user: { id: "u" }, data: {} } : null;
      },
    });
    const handler = createNextHandler(server);
    const anon = await handler(new Request("http://x/api/agents/agents") as never);
    expect(anon.status).toBe(401);
    const ok = await handler(new Request("http://x/api/agents/agents", { headers: { cookie: "sid=1" } }) as never);
    expect(ok.status).toBe(200);
    expect(seen?.headers.cookie).toBe("sid=1");
    expect(seen?.raw).toBeInstanceOf(Request);
  });

  it("Express: forwards headers and mount params", async () => {
    let seen: ContextRequest | undefined;
    const server = createAgentServer({
      basePath: "/api/agents",
      storage: await memoryStorage(),
      agents: [sdkAgent()],
      resolveContext: (req) => {
        seen = req;
        return { user: { id: "u" }, data: {} };
      },
    });
    const mw = createExpressMiddleware(server);
    let status = 0;
    const res: any = {
      status(c: number) { status = c; return res; },
      json() { return res; }, send() { return res; }, set() { return res; }, write() { return true; }, end() {},
    };
    await mw({ method: "GET", path: "/api/agents/agents", originalUrl: "/api/agents/agents", headers: { cookie: "a=b" }, query: {}, params: { portalKey: "k" } } as any, res, () => {});
    expect(status).toBe(200);
    expect(seen?.cookies).toEqual({ a: "b" });
    expect(seen?.mountParams).toEqual({ portalKey: "k" });
  });
});
