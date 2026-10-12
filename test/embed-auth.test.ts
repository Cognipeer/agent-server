/**
 * A chat embedded in another site authenticates every request with a bearer token the host application obtained for the person - no
 * cookies, which a page in a third-party frame cannot rely on. These tests run the real HTTP stacks (the Node handler and Fastify under
 * a parameterised prefix) to show what `resolveContext` gets to see, and what a page on another origin may read back.
 */

import http from "node:http";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, createNodeHandler } from "../src/index.js";
import type { AgentServerConfig, ContextRequest } from "../src/index.js";
import { mountOnFastify } from "../src/adapters/fastify.js";
import { listen, memoryStorage } from "./helpers.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** The sessions the host's own backend would know: token -> person, with an expiry. */
function sessions() {
  const table = new Map<string, { userId: string; portal: string; expiresAt: number }>();
  return {
    table,
    issue: (token: string, userId: string, portal = "support", ttlMs = 60_000) => table.set(token, { userId, portal, expiresAt: Date.now() + ttlMs }),
    lookup(req: ContextRequest, portal?: string) {
      const header = req.headers.authorization;
      const raw = Array.isArray(header) ? header[0] : header;
      const token = raw?.startsWith("Bearer ") ? raw.slice(7) : undefined;
      const session = token ? table.get(token) : undefined;
      if (!session || session.expiresAt < Date.now() || (portal !== undefined && session.portal !== portal)) return null;
      return session;
    },
  };
}

const quiet = { runs: { sweepIntervalMs: 0, recoverOnStart: false } };

async function node(config: Partial<AgentServerConfig>) {
  const server = createAgentServer({ basePath: "/api", storage: await memoryStorage(), ...quiet, ...config });
  server.registerCustomAgent("a", { processMessage: async ({ message }) => ({ content: `echo: ${message}` }) }, { name: "A" });
  const handle = createNodeHandler(server);
  const app = http.createServer(async (req, res) => {
    if (!(await handle(req, res))) {
      res.statusCode = 418;
      res.end();
    }
  });
  const { url, close } = await listen(app);
  closers.push(close);
  return { url: `${url}/api`, server };
}

const json = (token: string | undefined, body?: unknown, method = "POST") => ({
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe("bearer auth for an embedded chat", () => {
  it("knows the person from the token alone, on every request, and nobody else's conversations", async () => {
    const host = sessions();
    host.issue("cp_es_alice", "alice");
    host.issue("cp_es_bob", "bob");
    const seen: ContextRequest[] = [];
    const { url } = await node({
      resolveContext: (req) => {
        seen.push(req);
        const session = host.lookup(req);
        return session ? { user: { id: session.userId }, data: { portal: session.portal } } : null;
      },
    });

    const created = await fetch(`${url}/conversations`, json("cp_es_alice", { agentId: "a" }));
    expect(created.status).toBe(201);
    const id = ((await created.json()) as any).conversation.id as string;
    const sent = await fetch(`${url}/conversations/${id}/messages`, json("cp_es_alice", { message: "hi" }));
    expect(((await sent.json()) as any).response.content).toBe("echo: hi");

    // the request carried a token and nothing else: no cookie, and the server never asked for one
    expect(seen.every((req) => req.headers.authorization && !req.headers.cookie && Object.keys(req.cookies).length === 0)).toBe(true);

    // another person with a valid token meets 403 on this conversation; no token, 401
    expect((await fetch(`${url}/conversations/${id}`, json("cp_es_bob", undefined, "GET"))).status).toBe(403);
    expect((await fetch(`${url}/conversations/${id}`, json(undefined, undefined, "GET"))).status).toBe(401);
    expect((await fetch(`${url}/conversations/${id}`, json("cp_es_forged", undefined, "GET"))).status).toBe(401);
    const list = await fetch(`${url}/conversations`, json("cp_es_bob", undefined, "GET"));
    expect(((await list.json()) as any).conversations).toEqual([]);
  });

  it("stops serving a token the moment the host revokes it, in the middle of a conversation", async () => {
    const host = sessions();
    host.issue("cp_es_short", "carol");
    const { url } = await node({
      resolveContext: (req) => {
        const session = host.lookup(req);
        return session ? { user: { id: session.userId }, data: {} } : null;
      },
    });
    const id = (((await (await fetch(`${url}/conversations`, json("cp_es_short", { agentId: "a" }))).json()) as any).conversation.id) as string;
    expect((await fetch(`${url}/conversations/${id}/messages`, json("cp_es_short", { message: "one" }))).status).toBe(200);
    host.table.delete("cp_es_short");
    expect((await fetch(`${url}/conversations/${id}/messages`, json("cp_es_short", { message: "two" }))).status).toBe(401);
    // a refreshed token for the same person picks the conversation up where it was
    host.issue("cp_es_next", "carol");
    const messages = await fetch(`${url}/conversations/${id}/messages`, json("cp_es_next", undefined, "GET"));
    expect(((await messages.json()) as any).messages.map((m: any) => m.content)).toEqual(["one", "echo: one"]);
  });

  it("lets a page on an allowed origin send the token and read what it needs from the answers", async () => {
    const host = sessions();
    host.issue("cp_es_dana", "dana");
    const { url } = await node({
      cors: { enabled: true, origins: ["https://intranet.example.com"] },
      resolveContext: (req) => {
        const session = host.lookup(req);
        return session ? { user: { id: session.userId }, data: {} } : null;
      },
      rateLimit: (_ctx, request) => (request.operation === "message.send" ? { allowed: false, retryAfterSeconds: 7 } : undefined),
    });
    const origin = "https://intranet.example.com";

    const preflight = await fetch(`${url}/conversations`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/Last-Event-ID/);
    // a token in a header needs no credentials mode, so cookies are never part of this
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    // a 429 can be read by the page: Retry-After is exposed
    const id = (((await (await fetch(`${url}/conversations`, { ...json("cp_es_dana", { agentId: "a" }), headers: { ...json("cp_es_dana", {}).headers, origin } })).json()) as any).conversation.id) as string;
    const limited = await fetch(`${url}/conversations/${id}/messages`, { ...json("cp_es_dana", { message: "x" }), headers: { ...json("cp_es_dana", {}).headers, origin } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect(limited.headers.get("access-control-expose-headers")).toMatch(/Retry-After/);
    expect(((await limited.json()) as any).error).toMatchObject({ code: "rate_limited", details: { retryAfterSeconds: 7 } });

    // another origin gets no CORS headers at all
    const stranger = await fetch(`${url}/conversations`, { method: "OPTIONS", headers: { origin: "https://evil.example.org", "access-control-request-method": "POST" } });
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves a downloaded conversation as a file the page can name", async () => {
    const host = sessions();
    host.issue("cp_es_eli", "eli");
    const { url } = await node({
      cors: { enabled: true, origins: ["https://intranet.example.com"] },
      resolveContext: (req) => {
        const session = host.lookup(req);
        return session ? { user: { id: session.userId }, data: {} } : null;
      },
    });
    const id = (((await (await fetch(`${url}/conversations`, json("cp_es_eli", { agentId: "a", title: "Ünïcode başlık" }))).json()) as any).conversation.id) as string;
    await fetch(`${url}/conversations/${id}/messages`, json("cp_es_eli", { message: "merhaba" }));
    const md = await fetch(`${url}/conversations/${id}/export?locale=tr`, json("cp_es_eli", undefined, "GET"));
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("content-disposition")).toMatch(/^attachment; filename="[^"]+\.md"; filename\*=UTF-8''%C3%9Cn%C3%AFcode%20ba%C5%9Fl%C4%B1k\.md$/);
    const text = await md.text();
    expect(text).toContain("**Siz**");
    expect(text).toContain("merhaba");
  });

  it("gives resolveContext the dynamic part of a prefix, so one server can serve many portals with their own sessions", async () => {
    const host = sessions();
    host.issue("cp_es_for_support", "fay", "support");
    const server = createAgentServer({
      basePath: "/ignored",
      storage: await memoryStorage(),
      ...quiet,
      resolveContext: (req) => {
        const session = host.lookup(req, req.mountParams.portalKey);
        return session ? { user: { id: session.userId }, data: { portal: req.mountParams.portalKey } } : null;
      },
    });
    server.registerCustomAgent("a", { processMessage: async ({ message }) => ({ content: `echo: ${message}` }) }, { name: "A" });
    const app = Fastify();
    mountOnFastify(app, server, { prefix: "/api/portal/:portalKey" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const { port } = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/api/portal`;

    const own = await fetch(`${base}/support/conversations`, json("cp_es_for_support", { agentId: "a" }));
    expect(own.status).toBe(201);
    // the same token is not valid for another portal
    expect((await fetch(`${base}/sales/conversations`, json("cp_es_for_support", { agentId: "a" }))).status).toBe(401);
  });
});
