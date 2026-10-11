/**
 * Regression tests of the second review round: who a request acts as, which task a conversation may drive, uploads that race,
 * a conversation read under its lease, bounded waits, form uploads, and the Next adapter's body handling. The parts that depend on
 * storage run over every provider (memory, SQLite, MongoDB, PostgreSQL).
 */

import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAgentServer,
  createInMemoryProvider,
  createNodeHandler,
  hostAgentRegistration,
  withSessionImages,
} from "../src/index.js";
import type { AgentHandler, AgentRegistration, AgentServerConfig, StorageProvider } from "../src/index.js";
import { createNextHandler } from "../src/adapters/next.js";
import { boot as bootFiles, errorOf } from "./files-helpers.js";
import { eventually, gate, listen } from "./helpers.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider } from "./storage/providers.js";

let active: { current: OpenedProvider } | undefined;
const store = (): StorageProvider => active!.current.storage;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${counter++}`;

const echo: AgentRegistration = {
  info: { id: "a", name: "A" },
  handler: { processMessage: async ({ message }) => ({ content: `echo ${message}` }) } satisfies AgentHandler,
};

type CallExtra = { body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; user?: { id: string } };
function caller(server: ReturnType<typeof createAgentServer>) {
  return (method: string, path: string, extra: CallExtra = {}) =>
    server.handleRoute(method, path, {
      query: extra.query ?? {},
      body: extra.body,
      headers: extra.headers,
      ...(extra.user ? { user: extra.user } : {}),
    });
}

for (const name of PROVIDER_NAMES) {
  describeProvider(name, (harness) => {
    const provider = useProvider(harness);
    beforeAll(() => {
      active = provider;
    });
    afterAll(() => {
      active = undefined;
    });

    const make = (config: Partial<AgentServerConfig> = {}) => {
      const server = createAgentServer({
        basePath: "/api",
        storage: store(),
        agents: [echo],
        runs: { sweepIntervalMs: 0, recoverOnStart: false },
        ...config,
      });
      return { server, call: caller(server) };
    };

    // ------------------------------------------------------------------------
    describe("whose conversations a token user lists and creates", () => {
      it("lists their own, whatever ?userId= says", async () => {
        const { call } = make();
        const alice = { id: uniq("alice") };
        const bob = { id: uniq("bob") };
        await call("POST", "/conversations", { user: alice, body: { agentId: "a", title: "alice secret plan" } });
        await call("POST", "/conversations", { user: bob, body: { agentId: "a", title: "bob note" } });

        const spoof = await call("GET", "/conversations", { user: bob, query: { userId: alice.id } });
        expect(spoof.status).toBe(200);
        const titles = (spoof.body as any).conversations.map((c: any) => c.title);
        expect(titles).toEqual(["bob note"]);
        expect((spoof.body as any).conversations.every((c: any) => c.userId === bob.id)).toBe(true);
        // the same user named explicitly is the same list
        const same = await call("GET", "/conversations", { user: bob, query: { userId: bob.id } });
        expect((same.body as any).conversations.map((c: any) => c.title)).toEqual(["bob note"]);
      });

      it("creates conversations as themselves, whatever the body says", async () => {
        const { call } = make();
        const alice = { id: uniq("alice") };
        const bob = { id: uniq("bob") };
        const created = await call("POST", "/conversations", { user: bob, body: { agentId: "a", userId: alice.id } });
        expect(created.status).toBe(201);
        expect((created.body as any).conversation.userId).toBe(bob.id);
        // so alice has nothing planted in her list
        const hers = await call("GET", "/conversations", { user: alice });
        expect((hers.body as any).conversations).toEqual([]);
      });

      it("lets a resolveUserId identity win over ?userId= too", async () => {
        const { call } = make({ auth: { enabled: false, resolveUserId: (c) => c.headers?.["x-who"] as string | undefined } });
        const carol = uniq("carol");
        await call("POST", "/conversations", { headers: { "x-who": carol }, body: { agentId: "a", title: "carol's" } });
        await call("POST", "/conversations", { headers: { "x-who": "someone-else" }, body: { agentId: "a", title: "not carol's" } });
        const res = await call("GET", "/conversations", { headers: { "x-who": carol }, query: { userId: "someone-else" } });
        expect((res.body as any).conversations.map((c: any) => c.title)).toEqual(["carol's"]);
      });

      it("still takes the id a client names when nothing established who it is (a demo server)", async () => {
        const { call } = make();
        const demo = uniq("demo");
        const created = await call("POST", "/conversations", { body: { agentId: "a", userId: demo } });
        expect((created.body as any).conversation.userId).toBe(demo);
        const list = await call("GET", "/conversations", { query: { userId: demo } });
        expect((list.body as any).conversations).toHaveLength(1);
        // a body userId that is not a string is not an id
        const odd = await call("POST", "/conversations", { body: { agentId: "a", userId: { $ne: null } } });
        expect((odd.body as any).conversation.userId).toBeUndefined();
      });
    });

    // ------------------------------------------------------------------------
    describe("the task a conversation drives", () => {
      function workers() {
        const release = gate();
        const handler: AgentHandler = {
          processMessage: async ({ message }) => {
            if (message === "victim job") await release.promise;
            return { content: `result for: ${message}` };
          },
        };
        const worker: AgentRegistration = { info: { id: "worker", name: "Worker" }, handler };
        return { worker, release };
      }

      it("is the task that points back at the conversation: a task id in client metadata drives nothing", async () => {
        const { worker, release } = workers();
        const { call } = make({ agents: [worker] });
        const victim = { id: uniq("victim") };
        const mallory = { id: uniq("mallory") };

        const created = await call("POST", "/tasks", { user: victim, body: { agentId: "worker", input: "victim job" } });
        expect(created.status).toBe(201);
        const taskId = (created.body as any).task.id as string;
        await eventually(async () => (await store().getTask(taskId))?.status === "running", 4000, "the task to run");

        // Mallory's own conversation names the victim's task in its metadata
        const conv = await call("POST", "/conversations", { user: mallory, body: { agentId: "worker", metadata: { taskId, note: "x" } } });
        const convId = (conv.body as any).conversation.id as string;
        expect((conv.body as any).conversation.metadata).toEqual({ note: "x" });
        // (and the same through an update; a client cannot set it)
        const patched = await call("PATCH", `/conversations/${convId}`, { user: mallory, body: { metadata: { taskId, source: "task", other: 1 } } });
        expect((patched.body as any).metadata).toEqual({ other: 1 });
        // planted straight in the store, as an older record or a host's own write could have it
        await store().updateConversation(convId, { metadata: { taskId } });

        const sent = await call("POST", `/conversations/${convId}/messages`, { user: mallory, body: { message: "MALLORY WAS HERE" } });
        expect(sent.status).toBe(200);

        // the victim's task is not hers to complete, fail or cancel
        expect((await store().getTask(taskId))!.status).toBe("running");
        expect(await store().getTaskResult(taskId)).toBeNull();

        release.open();
        await eventually(async () => (await store().getTask(taskId))?.status === "completed", 4000, "the task to complete");
        expect((await store().getTaskResult(taskId))!.content).toBe("result for: victim job");
      });

      it("keeps the link of a task's own conversation through a metadata update", async () => {
        const { worker, release } = workers();
        const { call } = make({ agents: [worker] });
        const victim = { id: uniq("victim") };
        const created = await call("POST", "/tasks", { user: victim, body: { agentId: "worker", input: "victim job" } });
        const taskId = (created.body as any).task.id as string;
        const task = await eventually(async () => {
          const found = await store().getTask(taskId);
          return found?.conversationId ? found : undefined;
        }, 4000, "the task to get its conversation");

        const patched = await call("PATCH", `/conversations/${task.conversationId}`, { user: victim, body: { metadata: { label: "mine" } } });
        expect((patched.body as any).metadata).toEqual({ label: "mine", taskId, source: "task" });

        release.open();
        await eventually(async () => (await store().getTask(taskId))?.status === "completed", 4000, "the task to complete");
      });
    });

    // ------------------------------------------------------------------------
    describe("uploads that arrive together", () => {
      const sizes = (n: number) => Array.from({ length: n }, (_, i) => i);

      it("never put more files in a conversation than files.maxFiles allows", async () => {
        const t = await bootFiles({ storage: store(), handler: echo.handler, files: { maxFiles: 3 } });
        const id = await t.conversation();
        const results = await Promise.all(sizes(12).map((i) => t.uploadJson(id, `f${i}.txt`, `file ${i}`)));
        const created = results.filter((r) => r.status === 201);
        const refused = results.filter((r) => r.status === 409);
        expect(created).toHaveLength(3);
        expect(refused).toHaveLength(9);
        expect(errorOf(refused[0]!).code).toBe("too_many_files");
        const held = await t.call("GET", `/conversations/${id}/files`);
        expect((held.body as any).total).toBe(3);
        // a refused upload leaves no file behind: the next one is refused too, until one is deleted
        expect((await t.uploadJson(id, "late.txt", "late")).status).toBe(409);
        const first = (created[0]!.body as any).file.id as string;
        expect((await t.call("DELETE", `/files/${first}`)).status).toBe(204);
        expect((await t.uploadJson(id, "late.txt", "late")).status).toBe(201);
      });

      it("keeps the files that were there first when the pre-check could not see a rival (another node)", async () => {
        const t = await bootFiles({ storage: store(), handler: echo.handler, files: { maxFiles: 3 } });
        const id = await t.conversation();
        // four files land with no pre-check at all: the way a second node's upload looks to this one
        const saved: Awaited<ReturnType<StorageProvider["saveFile"]>>[] = [];
        for (let i = 0; i < 4; i++) saved.push(await store().saveFile({ name: `n${i}.txt`, mimeType: "text/plain", content: Buffer.from(`n${i}`), conversationId: id }));
        const ctx = { params: {}, query: {}, context: undefined } as never;
        const confirm = (record: (typeof saved)[number]) => (t.server as any).confirmRoomForFile({ maxFiles: 3 }, record, ctx);
        // the first three keep their place ...
        for (const record of saved.slice(0, 3)) await expect(confirm(record)).resolves.toBeUndefined();
        // ... the fourth does not, and is taken back out
        await expect(confirm(saved[3]!)).rejects.toMatchObject({ statusCode: 409, code: "too_many_files" });
        expect(await store().getFile(saved[3]!.id)).toBeNull();
        expect((await store().listFiles!({ conversationId: id, limit: 10 })).total).toBe(3);
      });
    });

    // ------------------------------------------------------------------------
    describe("a message sent while the previous turn finishes", () => {
      it("sees the approval that turn stored, and is told to answer it first (409 action_pending)", async () => {
        const secondEntered = gate();
        const secondMayGo = gate();
        const invokes: string[] = [];
        const host = hostAgentRegistration({
          info: { id: "portal-agent", name: "portal" },
          async invoke({ message }) {
            invokes.push(message);
            if (message === "first") {
              return { content: "", status: "requires_action", pendingActions: [{ id: "a1", type: "tool_approval", toolName: "wire", args: {} }] } as never;
            }
            return { content: `answered: ${message}` } as never;
          },
          async resolveAction() {
            return { content: "done" } as never;
          },
        });
        // A per-request registry: the slow lookup of the second request is held by the test
        const { call } = make({
          agents: async (ctx) => {
            if (ctx.data?.req === "second") {
              secondEntered.open();
              await secondMayGo.promise;
            }
            return [host];
          },
          resolveContext: (req) => ({ user: { id: "u" }, data: { req: String(req.headers["x-req"] ?? "") } }),
        });
        const created = await call("POST", "/conversations", { body: { agentId: "portal-agent" } });
        const id = (created.body as any).conversation.id as string;

        // The second message reads the conversation (nothing pending yet), then waits for its agent ...
        const second = call("POST", `/conversations/${id}/messages`, { headers: { "x-req": "second" }, body: { message: "second" } });
        await secondEntered.promise;
        // ... while the first runs to its pause and gives the conversation back
        const first = await call("POST", `/conversations/${id}/messages`, { body: { message: "first" } });
        expect(first.status).toBe(200);
        expect((first.body as any).pendingActions).toHaveLength(1);

        secondMayGo.open();
        const res = await second;
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe("action_pending");
        expect(invokes).toEqual(["first"]);
        const got = await call("GET", `/conversations/${id}`);
        expect((got.body as any).messages.filter((m: any) => m.role === "user")).toHaveLength(1);
      });
    });
  });
}

// ----------------------------------------------------------------------------
// Not about storage
// ----------------------------------------------------------------------------

describe("a run that never started", () => {
  it("still gives the conversation back: `released` resolves when beginRun fails", async () => {
    const inner = createInMemoryProvider();
    await inner.connect();
    const storage = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "acquireLease") {
          return async () => {
            throw new Error("the lease store is down");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const server = createAgentServer({ basePath: "/api", storage, agents: [echo], allowAnonymousList: true, runs: { sweepIntervalMs: 0, recoverOnStart: false } });
    const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } });
    const conversation = (created.body as any).conversation;

    const internals = server as unknown as {
      beginRun(ctx: unknown, conversation: unknown, kind: string, trigger: string, streaming: boolean): Promise<unknown>;
      runs: Map<string, { released: Promise<void> }>;
    };
    const attempt = internals.beginRun({ params: {}, query: {}, context: undefined }, conversation, "resolve", "resume", false);
    const run = internals.runs.get(conversation.id)!; // (registered before anything is awaited)
    expect(run).toBeDefined();
    await expect(attempt).rejects.toThrow(/lease store is down/);
    // somebody waiting for the run to release the conversation is not left waiting for the full resolve wait
    const outcome = await Promise.race([run.released.then(() => "released"), sleep(1000).then(() => "still waiting")]);
    expect(outcome).toBe("released");
    expect(internals.runs.has(conversation.id)).toBe(false);
  });
});

describe("the timeout sweep without the agent", () => {
  it("says so when a per-request registry cannot resolve the agent for the sweep's own context", async () => {
    const storage = createInMemoryProvider();
    await storage.connect();
    let resolved = 0;
    const registration = hostAgentRegistration({
      info: { id: "portal-agent", name: "portal" },
      async invoke() {
        return { content: "need approval", status: "requires_action", pendingActions: [{ id: "a1", type: "tool_approval", toolName: "wire", args: {} }] } as never;
      },
      async resolveAction() {
        resolved++;
        return { content: "continued after timeout" } as never;
      },
    });
    const server = createAgentServer({
      basePath: "/api",
      storage,
      allowAnonymousList: true,
      runs: { sweepIntervalMs: 0, recoverOnStart: false },
      hitl: { timeoutMinutes: 1, onTimeout: "deny" },
      // a multi-tenant host: the agent exists only for a request that carries its tenant (the sweep's own context does not)
      agents: (ctx) => (ctx.data?.tenant === "acme" ? [registration] : []),
      resolveContext: async () => ({ user: { id: "alice" }, data: { tenant: "acme" } }),
    });
    const call = caller(server);
    const conv = (await call("POST", "/conversations", { body: { agentId: "portal-agent" } })).body as any;
    const sent = await call("POST", `/conversations/${conv.conversation.id}/messages`, { body: { message: "go" } });
    expect((sent.body as any).pendingActions).toHaveLength(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await server.expirePendingActions({ now: new Date(Date.now() + 3_600_000), conversationId: conv.conversation.id });
      // (documented: the lapsed request is cancelled, not denied, and the host agent is not told)
      expect(result).toMatchObject({ conversations: 1, expired: 1, denied: 0 });
      expect(resolved).toBe(0);
      const message = warn.mock.calls.map((args) => args.join(" ")).find((text) => /timeout sweep/.test(text));
      expect(message).toMatch(/portal-agent/);
      expect(message).toMatch(/could not be resolved/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("title generation", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("gives up on an endpoint that never answers, so the turn does not hold its conversation for minutes", async () => {
    // a title provider that accepts the request and says nothing
    const hung = http.createServer(() => undefined);
    servers.push(hung);
    const { url } = await listen(hung);

    const t = await bootFiles({
      storage: await (async () => {
        const s = createInMemoryProvider();
        await s.connect();
        return s;
      })(),
      handler: echo.handler,
      config: { titleGeneration: { baseUrl: url, apiKey: "k", model: "m", timeoutMs: 200 }, allowAnonymousList: true },
    });
    const id = await t.conversation();
    const started = Date.now();
    const res = await t.send(id, "hello there");
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((res.body as any).conversationTitle).toBeUndefined();
    expect(((await t.call("GET", `/conversations/${id}`)).body as any).conversation.title).toBeUndefined();
    // the conversation is free again
    expect((await t.send(id, "and again")).status).toBe(200);
  });

  it("still titles a conversation when the endpoint answers", async () => {
    const answering = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: '"Greeting"' } }] }));
      });
    });
    servers.push(answering);
    const { url } = await listen(answering);
    const storage = createInMemoryProvider();
    await storage.connect();
    const t = await bootFiles({ storage, handler: echo.handler, config: { titleGeneration: { baseUrl: url, apiKey: "k", model: "m" } } });
    const id = await t.conversation();
    const res = await t.send(id, "hello there");
    expect((res.body as any).conversationTitle).toBe("Greeting");
  });
});

describe("form uploads", () => {
  it("answers multipart and urlencoded bodies with 415 unsupported_media_type instead of storing the envelope", async () => {
    const storage = createInMemoryProvider();
    await storage.connect();
    const t = await bootFiles({ storage, handler: echo.handler });
    const id = await t.conversation();
    const envelope = Buffer.from('--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello\r\n--x--\r\n');
    for (const type of ["multipart/form-data; boundary=x", "Multipart/Form-Data; boundary=x", "application/x-www-form-urlencoded", "multipart/mixed; boundary=x"]) {
      const res = await t.uploadRaw(id, "a.txt", envelope, type);
      expect(res.status, type).toBe(415);
      expect(errorOf(res).code).toBe("unsupported_media_type");
      expect(errorOf(res).message).toMatch(/raw|bytes/i);
    }
    // nothing was stored
    expect(((await t.call("GET", `/conversations/${id}/files`)).body as any).total).toBe(0);
    // raw bytes of any other type, and the JSON form, still work
    expect((await t.uploadRaw(id, "a.pdf", "%PDF-1.4", "application/pdf")).status).toBe(201);
    expect((await t.uploadRaw(id, "b.txt", "plain", "text/plain; charset=utf-8")).status).toBe(201);
    expect((await t.uploadJson(id, "c.txt", "json")).status).toBe(201);
  });

  it("is turned away by the Node handler before the body is read", async () => {
    const storage = createInMemoryProvider();
    await storage.connect();
    const server = createAgentServer({ basePath: "/api", storage, agents: [echo], allowAnonymousList: true });
    const handle = createNodeHandler(server);
    const http1 = http.createServer(async (req, res) => {
      if (!(await handle(req, res))) {
        res.statusCode = 404;
        res.end();
      }
    });
    const { url, close } = await listen(http1);
    try {
      const created = await (await fetch(`${url}/api/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "a" }) })).json();
      const id = (created as any).conversation.id as string;
      const form = new FormData();
      form.append("file", new Blob(["hello"], { type: "text/plain" }), "a.txt");
      const res = await fetch(`${url}/api/files?name=a.txt&conversationId=${id}`, { method: "POST", body: form });
      expect(res.status).toBe(415);
      expect(((await res.json()) as any).error.code).toBe("unsupported_media_type");
      const ok = await fetch(`${url}/api/files?name=a.txt&conversationId=${id}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
      expect(ok.status).toBe(201);
    } finally {
      await close();
    }
  });
});

describe("withSessionImages keeps the wrapped model's own members", () => {
  class FakeChatModel {
    private readonly label = "fake";
    _llmType() {
      return `llm:${this.label}`;
    }
    toString() {
      return `FakeChatModel(${this.label})`;
    }
    async invoke() {
      return { content: "ok" };
    }
  }

  it("so a class-based model keeps its constructor name, toString and the like", () => {
    const model = new FakeChatModel();
    const wrapped = withSessionImages(model);
    expect(wrapped.constructor).toBe(FakeChatModel);
    expect(wrapped.constructor.name).toBe("FakeChatModel");
    expect(String(wrapped)).toBe("FakeChatModel(fake)");
    expect(wrapped._llmType()).toBe("llm:fake");
    expect(Object.prototype.hasOwnProperty.call(wrapped, "label")).toBe(true);
    expect(wrapped.hasOwnProperty("invoke")).toBe(false); // (a method of the prototype, as on the model itself)
    expect(wrapped.valueOf()).toBe(model);
  });

  it("while invoke, stream and bindTools are still the wrapper's", async () => {
    const model = {
      bound: false,
      bindTools(_tools: unknown) {
        return { invoke: async () => "bound" };
      },
      invoke: async () => "plain",
    };
    const wrapped = withSessionImages(model);
    expect(await wrapped.invoke()).toBe("plain");
    // (bindTools hands back a wrapped model of its own, which also answers invoke)
    expect(await (wrapped.bindTools([]) as { invoke(): Promise<string> }).invoke()).toBe("bound");
  });
});

describe("the Next adapter's body handling", () => {
  interface FakeBody {
    chunks: Uint8Array[];
    pulled: number;
    cancelled: boolean;
  }

  /** A request whose body is read in `chunks`, recording how much of it was pulled. */
  function fakeRequest(options: { method?: string; path: string; headers?: Record<string, string>; chunkSize?: number; total?: number; json?: unknown }) {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const record: FakeBody = { chunks: [], pulled: 0, cancelled: false };
    const body =
      options.total !== undefined
        ? (() => {
            let sent = 0;
            const size = options.chunkSize ?? 1000;
            return {
              getReader() {
                return {
                  async read() {
                    if (sent >= options.total!) return { done: true as const };
                    const n = Math.min(size, options.total! - sent);
                    sent += n;
                    record.pulled += n;
                    return { done: false as const, value: new Uint8Array(n).fill(0x41) };
                  },
                  async cancel() {
                    record.cancelled = true;
                  },
                };
              },
            };
          })()
        : null;
    const jsonSpy = vi.fn(async () => options.json);
    const request = {
      method: options.method ?? "POST",
      url: `http://x${options.path}`,
      headers: {
        get: (key: string) => headers[key.toLowerCase()] ?? null,
        forEach: (callback: (value: string, key: string) => void) => Object.entries(headers).forEach(([key, value]) => callback(value, key)),
      },
      json: jsonSpy,
      body,
      nextUrl: { pathname: options.path, searchParams: new URLSearchParams() },
    };
    return { request: request as never, record, jsonSpy };
  }

  const tokenAuth = { validateToken: async (token: string) => (token === "good" ? { valid: true, userId: "u" } : { valid: false, error: "bad token" }) };

  it("does not read the body of a request that is not let in", async () => {
    const server = createAgentServer({ basePath: "/api", storage: createInMemoryProvider(), agents: [echo], auth: { enabled: true, provider: tokenAuth } });
    const handler = createNextHandler(server);
    const noToken = fakeRequest({ path: "/api/conversations", total: 50_000_000, json: { agentId: "a" } });
    const res = await handler(noToken.request);
    expect(res.status).toBe(401);
    expect(noToken.record.pulled).toBe(0);
    expect(noToken.jsonSpy).not.toHaveBeenCalled();

    const badToken = fakeRequest({ path: "/api/files?name=a.bin", headers: { authorization: "Bearer nope", "content-type": "application/octet-stream" }, total: 50_000_000 });
    expect((await handler(badToken.request)).status).toBe(401);
    expect(badToken.record.pulled).toBe(0);
  });

  it("refuses a body over limits.maxBodySize with 413 and stops reading", async () => {
    const storage = createInMemoryProvider();
    await storage.connect();
    const server = createAgentServer({ basePath: "/api", storage, agents: [echo], allowAnonymousList: true, limits: { maxBodySize: 4000 } });
    const handler = createNextHandler(server);

    const streamed = fakeRequest({ path: "/api/conversations", headers: { "content-type": "application/json" }, total: 50_000_000, chunkSize: 1000 });
    const res = await handler(streamed.request);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(streamed.record.cancelled).toBe(true);
    expect(streamed.record.pulled).toBeLessThanOrEqual(5000);

    // the declared length alone is enough
    const declared = fakeRequest({ path: "/api/files?name=a.bin", headers: { "content-type": "application/octet-stream", "content-length": "9999999" }, total: 50_000_000 });
    expect((await handler(declared.request)).status).toBe(413);
    expect(declared.record.pulled).toBe(0);
  });

  it("derives a limit from the largest upload when none is set, and still takes a file and a JSON body within it", async () => {
    const storage = createInMemoryProvider();
    await storage.connect();
    const server = createAgentServer({ basePath: "/api", storage, agents: [echo], allowAnonymousList: true, limits: { maxFileSize: 1000 } });
    const handler = createNextHandler(server);

    const created = await handler(
      new Request("http://x/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "a" }) }) as never
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as any).conversation.id as string;
    const upload = await handler(
      new Request(`http://x/api/files?name=a.txt&conversationId=${id}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" }) as never
    );
    expect(upload.status).toBe(201);
    // far over what any file here may be (1000 bytes * 1.4 + 64 KiB)
    const huge = await handler(
      new Request(`http://x/api/files?name=a.bin&conversationId=${id}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(200_000) }) as never
    );
    expect(huge.status).toBe(413);
  });

  it("turns a multipart upload away without reading it", async () => {
    const storage = createInMemoryProvider();
    await storage.connect();
    const server = createAgentServer({ basePath: "/api", storage, agents: [echo], allowAnonymousList: true });
    const handler = createNextHandler(server);
    const form = fakeRequest({ path: "/api/files?name=a.txt", headers: { "content-type": "multipart/form-data; boundary=x" }, total: 10_000_000 });
    const res = await handler(form.request);
    expect(res.status).toBe(415);
    expect(((await res.json()) as any).error.code).toBe("unsupported_media_type");
    expect(form.record.pulled).toBe(0);
  });
});
