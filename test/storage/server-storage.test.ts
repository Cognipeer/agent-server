/**
 * The server on top of each storage provider: the parts of the storage work that show up in the API
 * (history longer than a page, paged conversation reads, upload and delete rules, the size guard for
 * a pause, limits checked against the provider's capabilities).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentServer, createInMemoryProvider } from "../../src/index.js";
import type { AgentServerConfig, StorageProvider } from "../../src/index.js";
import { fakeSdkAgent, parseSse } from "../helpers.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./providers.js";
import type { OpenedProvider } from "./providers.js";

let active: { current: OpenedProvider } | undefined;
const storage = (): StorageProvider => active!.current.storage;

type Seen = Array<Array<{ role: string; content: string }>>;

async function boot(agent: unknown, config: Partial<AgentServerConfig> = {}, over?: StorageProvider) {
  const server = createAgentServer({
    basePath: "/api",
    storage: over ?? storage(),
    agents: [{ info: { id: "a", name: "A" }, sdkAgent: agent }],
    ...config,
  });
  const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } });
  const id = (created.body as { conversation: { id: string } }).conversation.id;
  const get = async (query: Record<string, string> = {}) => {
    const res = await server.handleRoute("GET", `/conversations/${id}`, { query });
    return { res, body: res.body as any };
  };
  const send = (message: string, stream = false) =>
    server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message, stream } });
  const drain = async (res: Awaited<ReturnType<typeof send>>) => {
    let text = "";
    for await (const chunk of res.stream!) text += chunk;
    return parseSse(text);
  };
  return { server, id, get, send, drain };
}

/** A conversation with `count` messages written straight into the store. */
async function seed(conversationId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const m = await storage().createMessage({
      conversationId,
      role: i % 2 ? "assistant" : "user",
      content: `m${i}`,
    });
    ids.push(m.id);
  }
  return ids;
}

/** An agent-sdk-shaped agent that pauses on its first call with `bytes` of state to keep. */
function pausingAgent(bytes: number) {
  return {
    invoke: async (input: any): Promise<any> => {
      const resolved = (input.pendingApprovals ?? []).some((a: any) => a.status === "approved" || a.status === "rejected");
      if (resolved) return { content: "deployed", metadata: {}, state: { messages: [], pendingApprovals: [], pendingUserQuestions: [] } };
      const state = {
        messages: [...(input.messages ?? []), { role: "assistant", content: "x".repeat(bytes) }],
        pendingApprovals: [{ id: "ap1", toolCallId: "c1", toolName: "deploy", args: { v: 1 }, status: "pending" }],
        pendingUserQuestions: [],
        ctx: { __awaitingApproval: { approvalId: "ap1" } },
      };
      return { content: "", metadata: {}, state };
    },
    resolveToolApproval: (state: any, r: any) => ({
      ...state,
      pendingApprovals: state.pendingApprovals.map((a: any) => (a.id === r.id ? { ...a, status: r.approved ? "approved" : "rejected" } : a)),
    }),
    resolveUserQuestion: (state: any) => state,
  };
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

    describe("history", () => {
      it("gives the agent the whole conversation, not the first page", async () => {
        const seen: Seen = [];
        const t = await boot(fakeSdkAgent(async (p) => { seen.push(p.messages); return { content: "ok" }; }));
        await seed(t.id, 250);

        expect((await t.send("the newest question")).status).toBe(200);
        expect(seen[0]).toHaveLength(251);
        expect(seen[0]![0]!.content).toBe("m0");
        expect(seen[0]!.at(-1)).toMatchObject({ role: "user", content: "the newest question" });

        // streamed turns read it the same way
        const events = await t.drain(await t.send("and again", true));
        expect(events.at(-1)!.type).toBe("stream.done");
        expect(seen[1]).toHaveLength(253);
        expect(seen[1]!.at(-1)!.content).toBe("and again");
      });
    });

    describe("GET /conversations/:id messages", () => {
      it("returns a short conversation whole, in order, with nothing more to load", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
        const ids = await seed(t.id, 5);
        const { body } = await t.get();
        expect(body.messages.map((m: any) => m.id)).toEqual(ids);
        expect(body.messagesPage).toEqual({ limit: 100, order: "asc", hasMoreBefore: false, hasMoreAfter: false });
      });

      it("returns the newest page of a long one, and pages back with before", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
        const ids = await seed(t.id, 250);

        const newest = (await t.get()).body;
        expect(newest.messages.map((m: any) => m.id)).toEqual(ids.slice(150));
        expect(newest.messagesPage).toMatchObject({ limit: 100, hasMoreBefore: true, hasMoreAfter: false });

        const middle = (await t.get({ before: newest.messages[0].id })).body;
        expect(middle.messages.map((m: any) => m.id)).toEqual(ids.slice(50, 150));
        expect(middle.messagesPage).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

        const oldest = (await t.get({ before: middle.messages[0].id })).body;
        expect(oldest.messages.map((m: any) => m.id)).toEqual(ids.slice(0, 50));
        expect(oldest.messagesPage).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true });
      });

      it("pages forward with after, honours limit and order", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
        const ids = await seed(t.id, 30);

        const forward = (await t.get({ after: ids[9]!, limit: "5" })).body;
        expect(forward.messages.map((m: any) => m.id)).toEqual(ids.slice(10, 15));
        expect(forward.messagesPage).toMatchObject({ limit: 5, hasMoreBefore: true, hasMoreAfter: true });

        const tail = (await t.get({ after: ids[27]! })).body;
        expect(tail.messages.map((m: any) => m.id)).toEqual(ids.slice(28));
        expect(tail.messagesPage.hasMoreAfter).toBe(false);

        const newestFirst = (await t.get({ limit: "3", order: "desc" })).body;
        expect(newestFirst.messages.map((m: any) => m.id)).toEqual([ids[29], ids[28], ids[27]]);
        expect(newestFirst.messagesPage).toMatchObject({ order: "desc", hasMoreBefore: true });
      });

      it("caps limit at the page maximum, and refuses a cursor from another conversation or both cursors", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })), { limits: { maxPageSize: 10 } });
        const other = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
        const ids = await seed(t.id, 25);
        const foreign = (await seed(other.id, 1))[0]!;

        expect((await t.get({ limit: "500" })).body.messages).toHaveLength(10);
        expect((await t.get({ before: foreign })).res.status).toBe(404);
        expect((await t.get({ after: "msg_missing" })).res.status).toBe(404);
        expect((await t.get({ before: ids[3]!, after: ids[4]! })).res.status).toBe(400);
      });

      it("uses limits.messagePageSize as the default page", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })), { limits: { messagePageSize: 7 } });
        await seed(t.id, 20);
        const { body } = await t.get();
        expect(body.messages).toHaveLength(7);
        expect(body.messagesPage.limit).toBe(7);
      });
    });

    describe("GET /conversations", () => {
      it("lists newest created first, or by last activity with orderBy=updatedAt", async () => {
        const agentId = `a-${Math.random().toString(36).slice(2)}`;
        const server = createAgentServer({
          basePath: "/api",
          storage: storage(),
          agents: [{ info: { id: agentId, name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "ok" })) }],
        });
        const make = async () =>
          ((await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId } })).body as any).conversation.id as string;
        const first = await make();
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await make();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await server.handleRoute("POST", `/conversations/${first}/messages`, { query: {}, body: { message: "bump" } });

        const list = async (query: Record<string, string>) =>
          ((await server.handleRoute("GET", "/conversations", { query: { agentId, ...query } })).body as any).conversations.map((c: any) => c.id);
        expect(await list({})).toEqual([second, first]);
        expect(await list({ orderBy: "updatedAt" })).toEqual([first, second]);
        expect(await list({ orderBy: "updatedAt", order: "asc" })).toEqual([second, first]);
        expect(await list({ orderBy: "bogus", order: "sideways" })).toEqual([second, first]);
      });
    });

    describe("files and conversations", () => {
      const upload = (server: Awaited<ReturnType<typeof boot>>["server"], conversationId: string | undefined, text = "hello") =>
        server.handleRoute("POST", "/files", {
          query: {},
          body: { file: { name: "a.txt", content: Buffer.from(text).toString("base64"), mimeType: "text/plain" }, conversationId },
        });

      it("answers 404, not 500, for a file uploaded to a conversation that does not exist", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
        const before = await provider.current.blobCount();
        const res = await upload(t.server, "conv_missing");
        expect(res.status).toBe(404);
        expect(await provider.current.blobCount()).toBe(before);
      });

      it("deleting a conversation removes its uploaded files", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
        const res = await upload(t.server, t.id);
        expect(res.status).toBe(201);
        const fileId = (res.body as any).file.id;
        expect((await t.server.handleRoute("GET", `/files/${fileId}/content`, { query: {} })).status).toBe(200);

        expect((await t.server.handleRoute("DELETE", `/conversations/${t.id}`, { query: {} })).status).toBe(204);
        expect((await t.server.handleRoute("GET", `/files/${fileId}`, { query: {} })).status).toBe(404);
        expect((await t.server.handleRoute("GET", `/files/${fileId}/content`, { query: {} })).status).toBe(404);
      });

      it("serves a download as a Buffer with the right length", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
        const body = "d".repeat(70_000);
        const fileId = ((await upload(t.server, t.id, body)).body as any).file.id;
        const res = await t.server.handleRoute("GET", `/files/${fileId}/content`, { query: {} });
        expect(Buffer.isBuffer(res.raw)).toBe(true);
        expect(res.raw!.length).toBe(70_000);
        expect(res.headers!["Content-Length"]).toBe("70000");
      });

      it("answers 400 for a title longer than the store allows, or stores it", async () => {
        const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
        const res = await t.server.handleRoute("POST", "/conversations", {
          query: {},
          body: { agentId: "a", title: "t".repeat(501) },
        });
        expect([201, 400]).toContain(res.status);
        if (name === "postgres") expect(res.status).toBe(400);
        else expect(res.status).toBe(201);
      });
    });

    describe("a pause that does not fit the store", () => {
      it("pauses as usual when the state fits", async () => {
        const t = await boot(pausingAgent(100), { limits: { maxStateBytes: 20_000 } });
        const body = (await t.send("deploy")).body as any;
        expect(body.status).toBe("requires_action");
        expect(body.warnings).toBeUndefined();
      });

      it("does not pause: the turn finishes with a warning on the message (JSON)", async () => {
        const t = await boot(pausingAgent(30_000), { limits: { maxStateBytes: 20_000 } });
        const body = (await t.send("deploy")).body as any;
        expect(body.status).toBeUndefined();
        expect(body.pendingActions).toBeUndefined();
        expect(body.warnings).toEqual([expect.objectContaining({ code: "pause_state_too_large", maxStateBytes: 20_000 })]);
        expect(body.response.metadata.warnings[0].code).toBe("pause_state_too_large");
        expect(body.response.metadata.requiresAction).toBeUndefined();
        expect(body.response.content).toMatch(/not carried out/);

        const conv = (await t.get()).body;
        expect(conv.pendingActions).toBeUndefined();
        const raw = await storage().getConversation(t.id);
        expect(Object.keys(raw!.state ?? {})).toEqual([]);
        // ...so the conversation is not stuck waiting: the next message goes through
        expect((await t.send("anything else?")).status).toBe(200);
      });

      it("does not pause when streaming either, and says why in the stream", async () => {
        const t = await boot(pausingAgent(30_000), { limits: { maxStateBytes: 20_000 } });
        const events = await t.drain(await t.send("deploy", true));
        expect(events.map((e) => e.type)).not.toContain("stream.action_required");
        const done = events.at(-1) as any;
        expect(done.type).toBe("stream.done");
        expect(done.status).toBeUndefined();
        expect(done.warnings[0].code).toBe("pause_state_too_large");
        expect(events.some((e) => e.type === "stream.text" && /not carried out/.test(String(e.text)))).toBe(true);
      });

      it("a pause that fits the server limit but not the store's write is dropped the same way, leaving no stranded message", async () => {
        const inner = storage();
        let refused = 0;
        const refusing = new Proxy(inner, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            // (a state write is a plain update or a compare-and-set one: the store refuses both)
            if (prop === "updateConversation" || prop === "updateConversationIf") {
              const conditional = prop === "updateConversationIf";
              return async (id: string, ...rest: any[]) => {
                const params = (conditional ? rest[1] : rest[0]) as { state?: Record<string, unknown> };
                if (params.state && (params.state as any).__agentServerHitl?.pending) {
                  refused++;
                  throw Object.assign(new Error("too large for this store"), { statusCode: 413, code: "STORAGE_LIMIT_EXCEEDED" });
                }
                return (target as any)[prop](id, ...rest);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as StorageProvider;
        const t = await boot(pausingAgent(100), {}, refusing);
        const body = (await t.send("deploy")).body as any;
        expect(refused).toBe(1);
        expect(body.status).toBeUndefined();
        expect(body.warnings[0].code).toBe("pause_state_too_large");
        const messages = (await t.get()).body.messages;
        expect(messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
        expect(messages.some((m: any) => m.metadata?.requiresAction)).toBe(false);
      });

      it("a store that fails for another reason fails the request and leaves no assistant message behind", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const inner = storage();
        const broken = new Proxy(inner, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop === "updateConversation" || prop === "updateConversationIf") {
              const conditional = prop === "updateConversationIf";
              return async (id: string, ...rest: any[]) => {
                const params = (conditional ? rest[1] : rest[0]) as { state?: Record<string, unknown> };
                if ((params.state as any)?.__agentServerHitl?.pending) throw new Error("connection lost");
                return (target as any)[prop](id, ...rest);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as StorageProvider;
        const t = await boot(pausingAgent(100), {}, broken);
        const res = await t.send("deploy");
        expect(res.status).toBe(500);
        expect((await t.get()).body.messages.map((m: any) => m.role)).toEqual(["user"]);
      });

      it("a continuation that cannot pause again is finished the same way", async () => {
        // First call pauses with a small state; the continuation pauses again with a big one
        let calls = 0;
        const agent = pausingAgent(100);
        const invoke = agent.invoke;
        agent.invoke = async (input: any) => {
          calls++;
          if (calls === 2) {
            const small = await invoke({ messages: input.messages });
            const big = pausingAgent(30_000);
            const r = await big.invoke({ messages: input.messages });
            return { ...r, state: { ...r.state, pendingApprovals: [{ ...small.state.pendingApprovals[0], id: "ap2" }] } };
          }
          return invoke(input);
        };
        const t = await boot(agent, { limits: { maxStateBytes: 20_000 } });
        expect(((await t.send("deploy")).body as any).status).toBe("requires_action");
        const res = await t.server.handleRoute("POST", `/conversations/${t.id}/actions/ap1`, {
          query: {},
          body: { resolution: { type: "tool_approval", decision: "allow" } },
        });
        const body = res.body as any;
        expect(res.status).toBe(200);
        expect(body.status).toBeUndefined();
        expect(body.warnings[0].code).toBe("pause_state_too_large");
        expect((await t.get()).body.pendingActions).toBeUndefined();
      });
    });
  });
}

describe("limits are checked against what the storage provider can hold", () => {
  const memory = (maxFileStorage: number) => createInMemoryProvider({ maxFileStorage });

  it("refuses a configured file size the provider cannot hold, at startup", () => {
    expect(() => createAgentServer({ basePath: "/x", storage: memory(1000), limits: { maxFileSize: 5000 } })).toThrow(
      /limits\.maxFileSize.*1000/
    );
  });

  it("refuses a configured state size the provider cannot hold, at startup", () => {
    const provider = memory(1000);
    provider.capabilities = () => ({
      maxFileBytes: 1000,
      maxStateBytes: 4096,
      atomicUpdate: false,
      events: false,
      leases: false,
    });
    expect(() => createAgentServer({ basePath: "/x", storage: provider, limits: { maxStateBytes: 10_000 } })).toThrow(
      /limits\.maxStateBytes.*4096/
    );
  });

  it("caps the default upload limit at the provider's, instead of refusing to start", async () => {
    const provider = memory(1000);
    await provider.connect();
    const server = createAgentServer({ basePath: "/x", storage: provider });
    const upload = (size: number) =>
      server.handleRoute("POST", "/files", {
        query: {},
        body: { file: { name: "a", content: Buffer.alloc(size, 1).toString("base64"), mimeType: "text/plain" } },
      });
    expect((await upload(900)).status).toBe(201);
    const refused = await upload(1500);
    expect(refused.status).toBe(400);
    expect((refused.body as any).error.message).toContain("1000 bytes");
  });

  it("does not check a store that does not report capabilities", () => {
    const custom = { ...createInMemoryProvider(), capabilities: undefined } as unknown as StorageProvider;
    Object.setPrototypeOf(custom, Object.getPrototypeOf(createInMemoryProvider()));
    (custom as any).capabilities = undefined;
    expect(() => createAgentServer({ basePath: "/x", storage: custom, limits: { maxFileSize: 10 ** 12 } })).not.toThrow();
  });
});
