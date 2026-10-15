/**
 * Message actions, history management, feedback, export and generated titles - the pieces a chat portal needs around a conversation -
 * over every storage provider (memory, SQLite, MongoDB, PostgreSQL).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentServer, hostAgentRegistration } from "../src/index.js";
import type {
  AgentServerConfig,
  AuditEntry,
  ConversationEvent,
  EventStore,
  FeedbackEvent,
  HostAgent,
  HostAgentDefinition,
  HostInvokeInput,
  HostTurnResult,
  RateLimitRequest,
  StorageProvider,
} from "../src/index.js";
import { eventually, fakeSdkAgent, gate, parseSse } from "./helpers.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider } from "./storage/providers.js";

let active: { current: OpenedProvider } | undefined;
const currentStorage = (): StorageProvider => active!.current.storage;

const quiet = (extra: Partial<AgentServerConfig> = {}): Partial<AgentServerConfig> => ({
  ...extra,
  runs: { sweepIntervalMs: 0, recoverOnStart: false, ...(extra.runs ?? {}) },
});

let nextUser = 0;
const freshUser = () => `user-${Date.now().toString(36)}-${++nextUser}`;

type Behaviour = Partial<HostAgent> & { invoke?: HostAgent["invoke"] };

/** A storage provider with some of its members replaced (a getter such as `events` included); everything else is the real one. */
function overriding(storage: StorageProvider, replace: Record<string, unknown>): StorageProvider {
  return new Proxy(storage, {
    get(target, prop) {
      if (typeof prop === "string" && prop in replace) return replace[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * How a host that keeps its own log (a portal) writes it, whatever this server wrote: no run on any event, and
 * - `ids`: otherwise as this server writes it (snake_case, the answer's `message_id`)
 * - `console`: camelCase, the answer's position in the transcript (`messageIndex`) and its text, but no message id
 * - `content`: camelCase and the answer's text only
 * - `order`: camelCase and nothing that names an answer
 */
type HostLog = "ids" | "console" | "content" | "order";
function hostShaped(storage: StorageProvider, shape: HostLog): StorageProvider {
  const events = storage.events!;
  const camelKeys = (data: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(data).map(([key, value]) => [key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), value]));
  const wrapped: EventStore = {
    append: (conversationId, batch, ctx) => events.append(conversationId, batch, ctx),
    summary: events.summary?.bind(events),
    prune: events.prune?.bind(events),
    list: async (conversationId, params, ctx) => {
      const page = await events.list(conversationId, params, ctx);
      const stored = (await storage.getMessages(conversationId, { order: "asc", limit: 1000 }, ctx)).data;
      return {
        ...page,
        events: page.events.map(({ runId: _run, ...event }): ConversationEvent => {
          if (shape === "ids") return event as ConversationEvent;
          const data = camelKeys(event.data);
          if (event.type === "agent.message" || event.type === "user.message") {
            const answerId = data.messageId as string | undefined;
            delete data.messageId;
            if (event.type === "agent.message") {
              if (shape === "console") data.messageIndex = stored.findIndex((m) => m.id === answerId);
              if (shape !== "console" && shape !== "content") delete data.content;
            }
          }
          return { ...event, data } as ConversationEvent;
        }),
      };
    },
  };
  return overriding(storage, { events: wrapped });
}

/**
 * A host's storage that answers an update with a record of its own making: `remembers` still carries what the update took away
 * (the pin of an unpin) and adds a key of its own; `forgets` leaves out what the update put there.
 */
function answeringStale(storage: StorageProvider, mode: "remembers" | "forgets"): StorageProvider {
  const SERVER_KEYS = ["pinned", "pinnedAt", "titleGenerated"];
  const staleOf = (before: { metadata?: Record<string, unknown> } | null, after: any) => {
    if (!after) return after;
    const metadata = { ...(after.metadata ?? {}) };
    if (mode === "forgets") for (const key of SERVER_KEYS) delete metadata[key];
    else {
      for (const key of SERVER_KEYS) if (before?.metadata?.[key] !== undefined) metadata[key] = before.metadata[key];
      metadata.hostKey = "kept";
    }
    return { ...after, metadata };
  };
  return overriding(storage, {
    updateConversation: async (id: string, params: any, ctx: any) => {
      const before = await storage.getConversation(id, ctx);
      return staleOf(before, await storage.updateConversation(id, params, ctx));
    },
    updateConversationIf: async (id: string, version: number, params: any, ctx: any) => {
      const before = await storage.getConversation(id, ctx);
      return staleOf(before, await storage.updateConversationIf!(id, version, params, ctx));
    },
  });
}

/** A host agent that numbers its answers and records what it is given. */
function numbering(behaviour: Behaviour = {}) {
  const invokes: HostInvokeInput[] = [];
  let n = 0;
  const agent: HostAgent = {
    invoke: async (input, io) => {
      invokes.push(input);
      if (behaviour.invoke) return behaviour.invoke(input, io);
      n += 1;
      return { content: `answer ${n}` };
    },
    ...(behaviour.resolveAction && { resolveAction: behaviour.resolveAction }),
    ...(behaviour.cancel && { cancel: behaviour.cancel }),
    ...(behaviour.feedback && { feedback: behaviour.feedback }),
  };
  return { agent, invokes };
}

async function boot(
  options: {
    behaviour?: Behaviour;
    config?: Partial<AgentServerConfig>;
    settings?: Partial<HostAgentDefinition>;
    user?: string;
    /** Puts something between the server and the provider (see {@link hostShaped}, {@link answeringStale}). */
    through?: (storage: StorageProvider) => StorageProvider;
  } = {}
) {
  const storage = options.through ? options.through(currentStorage()) : currentStorage();
  const host = numbering(options.behaviour);
  const user = options.user ?? freshUser();
  const server = createAgentServer({
    basePath: "/api",
    storage,
    resolveContext: (req) => ({ user: { id: String(req.headers["x-user"] ?? user) }, data: {} }),
    ...quiet(options.config),
  });
  server.registerHostAgent({ info: { id: "h", name: "Host" }, ...host.agent, ...options.settings });
  const call = (method: string, path: string, extra: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}) =>
    server.handleRoute(method, path, { query: extra.query ?? {}, body: extra.body, headers: extra.headers });
  const create = async (extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    ((await call("POST", "/conversations", { body: { agentId: "h", ...extra }, headers })).body as any).conversation.id as string;
  const id = await create();
  const send = (message = "hello", extra: Record<string, unknown> = {}, conversationId = id) =>
    call("POST", `/conversations/${conversationId}/messages`, { body: { message, ...extra } });
  const get = async (conversationId = id, query: Record<string, string> = {}) =>
    (await call("GET", `/conversations/${conversationId}`, { query })).body as any;
  const messages = async (conversationId = id) => ((await get(conversationId)).messages as any[]);
  const events = async (conversationId = id) => ((await call("GET", `/conversations/${conversationId}/events`)).body as any).events as any[];
  const drain = async (res: Awaited<ReturnType<typeof send>>) => {
    let text = "";
    for await (const chunk of res.stream!) text += chunk;
    return parseSse(text);
  };
  return { server, storage, host, user, id, call, create, send, get, messages, events, drain };
}

const errorOf = (res: { body?: unknown }) => (res.body as any)?.error as { code: string; message: string; details?: any };

function suite() {
  // ==========================================================================
  describe("regenerate", () => {
    it("runs the newest answer again from the message it answered, and keeps what it said before", async () => {
      const t = await boot();
      const first = await t.send("what is 2+2?");
      const userId = (first.body as any).message.id as string;
      const oldAnswer = (first.body as any).response.id as string;

      const res = await t.call("POST", `/conversations/${t.id}/messages/${oldAnswer}/regenerate`);
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.message.id).toBe(userId);
      expect(body.response.content).toBe("answer 2");
      expect(body.response.id).not.toBe(oldAnswer);

      const stored = await t.messages();
      expect(stored.map((m) => [m.role, m.content])).toEqual([["user", "what is 2+2?"], ["assistant", "answer 2"]]);
      expect(stored[1].metadata.regeneratedFrom).toBe(oldAnswer);
      expect(stored[1].metadata.previousContent).toEqual([expect.objectContaining({ content: "answer 1" })]);

      // the host agent is told it is a regeneration, with the transcript already cut back to the message
      const input = t.host.invokes[1]!;
      expect(input).toMatchObject({ mode: "regenerate", fromMessageId: oldAnswer, message: "what is 2+2?" });
      expect(input.history.map((m) => m.content)).toEqual(["what is 2+2?"]);
      expect(t.host.invokes[0]!.mode).toBeUndefined();

      // the log says what happened: the answer was dropped, and the run is a regeneration
      const log = await t.events();
      const running = log.filter((e) => e.type === "session.status_running");
      expect(running[1].data).toMatchObject({ trigger: "message", mode: "regenerate" });
      const truncated = log.find((e) => e.type === "session.truncated")!;
      expect(truncated.data).toEqual({ reason: "regenerate", from_message_id: oldAnswer, removed_count: 1, removed_message_ids: [oldAnswer] });
      expect(log.findIndex((e) => e.type === "session.truncated")).toBeLessThan(log.length - 1);
      expect((await t.get()).conversation.runtime.status).toBe("idle");
    });

    it("keeps the five most recent previous answers", async () => {
      const t = await boot();
      let answer = ((await t.send("q")).body as any).response.id as string;
      for (let i = 0; i < 7; i++) {
        answer = ((await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`)).body as any).response.id;
      }
      const last = (await t.messages()).at(-1);
      expect(last.content).toBe("answer 8");
      expect(last.metadata.previousContent.map((p: any) => p.content)).toEqual(["answer 3", "answer 4", "answer 5", "answer 6", "answer 7"]);
    });

    it("streams the new answer like a message does", async () => {
      const t = await boot({ behaviour: { invoke: (_i, { emit }) => (emit({ type: "text", text: "fresh " }), emit({ type: "text", text: "take" }), { content: "fresh take" }) } });
      const answer = ((await t.send("q")).body as any).response.id as string;
      const res = await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`, { body: { stream: true } });
      expect(res.status).toBe(200);
      const frames = await t.drain(res as any);
      expect(frames.map((f) => f.type)).toEqual(["stream.start", "stream.text", "stream.text", "stream.done"]);
      const user = (await t.messages())[0];
      expect(frames[0]).toMatchObject({ messageId: user.id });
      expect(frames.at(-1)).toMatchObject({ content: "fresh take", stopReason: "end_turn" });
    });

    it("only regenerates the newest message of the conversation, and only an answer", async () => {
      const t = await boot();
      const first = ((await t.send("one")).body as any).response.id as string;
      await t.send("two");
      // an older answer
      const older = await t.call("POST", `/conversations/${t.id}/messages/${first}/regenerate`);
      expect(older.status).toBe(409);
      expect(errorOf(older)).toMatchObject({ code: "invalid_message_target", details: { reason: "not_newest" } });
      // a message that is not in this conversation
      const other = await t.create();
      const foreign = ((await t.send("elsewhere", {}, other)).body as any).response.id as string;
      expect((await t.call("POST", `/conversations/${t.id}/messages/${foreign}/regenerate`)).status).toBe(404);
      expect((await t.call("POST", `/conversations/${t.id}/messages/msg_nope/regenerate`)).status).toBe(404);
      // nothing changed
      expect((await t.messages()).map((m) => m.content)).toEqual(["one", "answer 1", "two", "answer 2"]);
    });

    it("answers a user message left without an answer by a failed turn", async () => {
      let calls = 0;
      const t = await boot({
        behaviour: {
          invoke: async () => {
            calls += 1;
            if (calls === 1) throw new Error("model down");
            return { content: "recovered" };
          },
        },
      });
      expect((await t.send("please")).status).toBe(500);
      const [user] = await t.messages();
      expect(user.role).toBe("user");
      const res = await t.call("POST", `/conversations/${t.id}/messages/${user.id}/regenerate`);
      expect(res.status).toBe(200);
      expect((await t.messages()).map((m) => m.content)).toEqual(["please", "recovered"]);
    });

    it("leaves the old answer in place when the new turn fails", async () => {
      let calls = 0;
      const t = await boot({
        behaviour: {
          invoke: async () => {
            calls += 1;
            if (calls === 2) throw new Error("model down");
            return { content: `ok ${calls}` };
          },
        },
      });
      const answer = ((await t.send("q")).body as any).response.id as string;
      expect((await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`)).status).toBe(500);
      expect((await t.messages()).map((m) => [m.id, m.content])).toEqual([[expect.any(String), "q"], [answer, "ok 1"]]);
    });

    it("is one turn at a time, and waits for a person to answer what is open", async () => {
      const hold = gate();
      let calls = 0;
      const t = await boot({
        behaviour: {
          invoke: async () => {
            calls += 1;
            if (calls === 2) await hold.promise;
            return { content: `r${calls}` };
          },
        },
      });
      const answer = ((await t.send("q")).body as any).response.id as string;
      const running = t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`);
      await eventually(() => calls === 2);
      const busy = await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`);
      expect(busy.status).toBe(409);
      expect(errorOf(busy).code).toBe("conversation_busy");
      hold.open();
      expect((await running).status).toBe(200);
    });

    it("is refused while a request is open (409 action_pending)", async () => {
      const t = await boot({
        behaviour: {
          invoke: async () => ({ content: "", pendingActions: [{ id: "a1", type: "tool_approval", toolName: "deploy" }] }),
          resolveAction: async () => ({ content: "done" }),
        },
      });
      await t.send("go");
      const [, paused] = await t.messages();
      const res = await t.call("POST", `/conversations/${t.id}/messages/${paused.id}/regenerate`);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe("action_pending");
    });

    it("hands an agent-sdk agent the transcript without the answer it replaces", async () => {
      const seen: string[][] = [];
      const storage = currentStorage();
      const server = createAgentServer({ basePath: "/api", storage, allowAnonymousList: true, ...quiet() });
      server.registerSDKAgent(
        "sdk",
        fakeSdkAgent(async ({ messages }) => {
          seen.push(messages.map((m) => `${m.role}:${m.content}`));
          return { content: `reply ${seen.length}` };
        })
      );
      const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "sdk" } });
      const id = (created.body as any).conversation.id as string;
      const first = await server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message: "hi" } });
      const answer = (first.body as any).response.id as string;
      const again = await server.handleRoute("POST", `/conversations/${id}/messages/${answer}/regenerate`, { query: {} });
      expect(again.status).toBe(200);
      expect(seen).toEqual([["user:hi"], ["user:hi"]]);
      expect((again.body as any).response.content).toBe("reply 2");
    });

    it("is switched off by the agent's experience", async () => {
      const t = await boot({ settings: { experience: { messageActions: { regenerate: false } } } });
      const answer = ((await t.send("q")).body as any).response.id as string;
      const res = await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`);
      expect(res.status).toBe(403);
      expect(errorOf(res)).toMatchObject({ code: "action_disabled", details: { setting: "experience.messageActions.regenerate" } });
    });

    it("belongs to the conversation's owner", async () => {
      const t = await boot();
      const answer = ((await t.send("q")).body as any).response.id as string;
      const res = await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`, { headers: { "x-user": "someone-else" } });
      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  describe("edit", () => {
    it("replaces a message, drops everything after it and runs the conversation again from it", async () => {
      const t = await boot();
      const first = await t.send("original");
      const userId = (first.body as any).message.id as string;
      await t.send("second");
      await t.send("third");
      expect(await t.messages()).toHaveLength(6);

      const res = await t.call("POST", `/conversations/${t.id}/messages/${userId}/edit`, { body: { content: "rewritten" } });
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.message.content).toBe("rewritten");
      expect(body.message.id).not.toBe(userId);
      expect(body.response.content).toBe("answer 4");

      const stored = await t.messages();
      expect(stored.map((m) => [m.role, m.content])).toEqual([["user", "rewritten"], ["assistant", "answer 4"]]);
      expect(stored[0].metadata).toMatchObject({ edited: true, editedFrom: userId, previousContent: [expect.objectContaining({ content: "original" })] });

      const input = t.host.invokes.at(-1)!;
      expect(input).toMatchObject({ mode: "edit", fromMessageId: userId, message: "rewritten" });
      expect(input.history.map((m) => m.content)).toEqual(["rewritten"]);

      const log = await t.events();
      const truncatedAt = log.findIndex((e) => e.type === "session.truncated");
      expect(log[truncatedAt].data).toMatchObject({ reason: "edit", from_message_id: userId, removed_count: 6 });
      // the order of a new turn: what was removed, the new message, the run
      expect(log.slice(truncatedAt, truncatedAt + 3).map((e) => e.type)).toEqual(["session.truncated", "user.message", "session.status_running"]);
      expect(log[truncatedAt + 1].data).toMatchObject({ content: "rewritten", edited: true, edited_from: userId });
    });

    it("can edit a message in the middle: what came before stays", async () => {
      const t = await boot();
      await t.send("one");
      const second = ((await t.send("two")).body as any).message.id as string;
      await t.send("three");
      await t.call("POST", `/conversations/${t.id}/messages/${second}/edit`, { body: { message: "two, better" } });
      expect((await t.messages()).map((m) => m.content)).toEqual(["one", "answer 1", "two, better", "answer 4"]);
    });

    it("keeps the files of the message unless the edit says otherwise, and deletes the ones it drops", async () => {
      const t = await boot();
      const upload = async (name: string) =>
        ((await t.call("POST", "/files", { body: { conversationId: t.id, file: { name, content: Buffer.from(name).toString("base64"), mimeType: "text/plain" } } })).body as any).file.id as string;
      const a = await upload("a.txt");
      const b = await upload("b.txt");
      const sent = await t.send("with files", { fileIds: [a, b] });
      const userId = (sent.body as any).message.id as string;

      // no file fields: the message keeps both
      const kept = await t.call("POST", `/conversations/${t.id}/messages/${userId}/edit`, { body: { content: "same files" } });
      expect(kept.status).toBe(200);
      const editedId = (kept.body as any).message.id as string;
      expect((kept.body as any).message.files.map((f: any) => f.id)).toEqual([a, b]);

      // fileIds: only a stays; b is deleted
      const trimmed = await t.call("POST", `/conversations/${t.id}/messages/${editedId}/edit`, { body: { content: "one file", fileIds: [a] } });
      expect(trimmed.status).toBe(200);
      expect((trimmed.body as any).message.files.map((f: any) => f.id)).toEqual([a]);
      expect((await t.call("GET", `/files/${b}`)).status).toBe(404);
      expect((await t.call("GET", `/files/${a}`)).status).toBe(200);

      // fileIds: [] drops every file
      const lastId = (trimmed.body as any).message.id as string;
      const none = await t.call("POST", `/conversations/${t.id}/messages/${lastId}/edit`, { body: { content: "no files", fileIds: [] } });
      expect((none.body as any).message.files).toBeUndefined();
      expect((await t.call("GET", `/files/${a}`)).status).toBe(404);
    });

    it("edits only a message of the person, with text", async () => {
      const t = await boot();
      const sent = await t.send("hi");
      const assistant = (sent.body as any).response.id as string;
      const userId = (sent.body as any).message.id as string;
      const onAnswer = await t.call("POST", `/conversations/${t.id}/messages/${assistant}/edit`, { body: { content: "x" } });
      expect(onAnswer.status).toBe(409);
      expect(errorOf(onAnswer)).toMatchObject({ code: "invalid_message_target", details: { reason: "not_a_user_message" } });
      expect((await t.call("POST", `/conversations/${t.id}/messages/${userId}/edit`, { body: { content: "  " } })).status).toBe(400);
      expect((await t.call("POST", `/conversations/${t.id}/messages/${userId}/edit`, { body: {} })).status).toBe(400);
      expect((await t.call("POST", `/conversations/${t.id}/messages/msg_nope/edit`, { body: { content: "x" } })).status).toBe(404);
      // somebody else's conversation is theirs: no edit, no pin, no rename
      const intruder = { "x-user": "intruder" };
      expect((await t.call("POST", `/conversations/${t.id}/messages/${userId}/edit`, { body: { content: "mine now" }, headers: intruder })).status).toBe(403);
      expect((await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: true }, headers: intruder })).status).toBe(403);
      expect((await t.call("PATCH", `/conversations/${t.id}`, { body: { title: "stolen" }, headers: intruder })).status).toBe(403);
      expect((await t.messages()).map((m) => m.content)).toEqual(["hi", "answer 1"]);
    });

    it("streams, and is refused while the conversation runs or the agent switched editing off", async () => {
      const t = await boot();
      const userId = ((await t.send("q")).body as any).message.id as string;
      const res = await t.call("POST", `/conversations/${t.id}/messages/${userId}/edit`, { body: { content: "q2", stream: true } });
      const frames = await t.drain(res as any);
      expect(frames[0]!.type).toBe("stream.start");
      expect(frames.at(-1)).toMatchObject({ type: "stream.done", content: "answer 2" });
      expect(frames[0]!.messageId).toBe((await t.messages())[0].id);

      const off = await boot({ settings: { experience: { messageActions: { edit: false } } } });
      const user = ((await off.send("q")).body as any).message.id as string;
      const refused = await off.call("POST", `/conversations/${off.id}/messages/${user}/edit`, { body: { content: "x" } });
      expect(refused.status).toBe(403);
      expect(errorOf(refused).code).toBe("action_disabled");
    });
  });

  // ==========================================================================
  describe("history", () => {
    it("pins a conversation, lists pinned ones first across pages, and unpins", async () => {
      const t = await boot();
      const ids = [t.id];
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3));
        ids.push(await t.create());
      }
      const list = async (query: Record<string, string> = {}) =>
        ((await t.call("GET", "/conversations", { query: { limit: "50", ...query } })).body as any).conversations.map((c: any) => ids.indexOf(c.id)) as number[];
      expect(await list()).toEqual([4, 3, 2, 1, 0]);

      const pin = await t.call("PATCH", `/conversations/${ids[1]}`, { body: { pinned: true } });
      expect(pin.status).toBe(200);
      expect(pin.body).toMatchObject({ pinned: true, metadata: { pinned: true } });
      await t.call("PATCH", `/conversations/${ids[0]}`, { body: { pinned: true } });
      expect(await list()).toEqual([1, 0, 4, 3, 2]);
      expect(await list({ pinned: "none" })).toEqual([4, 3, 2, 1, 0]);

      // pages hold the groups
      const pages: number[] = [];
      for (let offset = 0; offset < 5; offset += 2) pages.push(...(await list({ limit: "2", offset: String(offset) })));
      expect(pages).toEqual([1, 0, 4, 3, 2]);

      // pinned is shown on the conversation, and left alone by an update of the metadata
      const fetched = await t.get(ids[1]);
      expect(fetched.conversation.pinned).toBe(true);
      const meta = await t.call("PATCH", `/conversations/${ids[1]}`, { body: { metadata: { topic: "x" } } });
      expect(meta.body).toMatchObject({ pinned: true, metadata: { topic: "x", pinned: true } });

      const unpin = await t.call("PATCH", `/conversations/${ids[1]}`, { body: { pinned: false } });
      expect((unpin.body as any).pinned).toBeUndefined();
      expect((unpin.body as any).metadata.pinned).toBeUndefined();
      expect(await list()).toEqual([0, 4, 3, 2, 1]);
    });

    it("does not let a client pin through metadata", async () => {
      const t = await boot();
      const created = await t.call("POST", "/conversations", { body: { agentId: "h", metadata: { pinned: true, pinnedAt: "x", titleGenerated: true, keep: 1 } } });
      expect((created.body as any).conversation.metadata).toEqual({ keep: 1 });
      expect((created.body as any).conversation.pinned).toBeUndefined();
      const patched = await t.call("PATCH", `/conversations/${t.id}`, { body: { metadata: { pinned: true } } });
      expect((patched.body as any).pinned).toBeUndefined();
    });

    it("answers the metadata the update left when the host's store answers with a stale record", async () => {
      const t = await boot({ through: (storage) => answeringStale(storage, "remembers") });
      const patch = async (body: Record<string, unknown>) => (await t.call("PATCH", `/conversations/${t.id}`, { body })).body as any;

      const pinned = await patch({ pinned: true });
      expect(pinned).toMatchObject({ pinned: true, metadata: { pinned: true, hostKey: "kept" } });
      expect(typeof pinned.metadata.pinnedAt).toBe("string");

      // the store still says it is pinned; the answer is what the update left
      const unpinned = await patch({ pinned: false });
      expect(unpinned.pinned).toBeUndefined();
      expect(unpinned.metadata.pinned).toBeUndefined();
      expect(unpinned.metadata.pinnedAt).toBeUndefined();
      // (the store's own keys are not replaced away)
      expect(unpinned.metadata.hostKey).toBe("kept");
      // ... and it is what was stored
      const shown = (await t.get()).conversation;
      expect(shown.metadata?.pinned).toBeUndefined();
      expect(shown.pinned).toBeUndefined();

      // a title a person wrote ends the mark of a generated one, also in the answer
      await t.storage.updateConversation(t.id, { metadata: { titleGenerated: true, keep: 1 } }, undefined);
      const renamed = await patch({ title: "Mine" });
      expect(renamed.title).toBe("Mine");
      expect(renamed.metadata.titleGenerated).toBeUndefined();
      expect(renamed.metadata.keep).toBe(1);
    });

    it("answers the pin and the metadata it wrote when the host's store leaves them out", async () => {
      const t = await boot({ through: (storage) => answeringStale(storage, "forgets") });
      const patch = async (body: Record<string, unknown>) => (await t.call("PATCH", `/conversations/${t.id}`, { body })).body as any;

      const pinned = await patch({ pinned: true });
      expect(pinned).toMatchObject({ pinned: true, metadata: { pinned: true } });
      expect(typeof pinned.metadata.pinnedAt).toBe("string");

      // a metadata update keeps the pin (it is the server's) and adds to what the store returned
      const meta = await patch({ metadata: { topic: "x" } });
      expect(meta).toMatchObject({ pinned: true, metadata: { topic: "x", pinned: true, pinnedAt: pinned.metadata.pinnedAt } });
    });

    it("renames, with the title checked", async () => {
      const t = await boot();
      const renamed = await t.call("PATCH", `/conversations/${t.id}`, { body: { title: "  Quarterly plan  " } });
      expect((renamed.body as any).title).toBe("Quarterly plan");
      expect((await t.call("PATCH", `/conversations/${t.id}`, { body: { title: 7 } })).status).toBe(400);
      expect((await t.call("PATCH", `/conversations/${t.id}`, { body: { title: "x".repeat(201) } })).status).toBe(400);
      expect((await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: "yes" } })).status).toBe(400);
      const cleared = await t.call("PATCH", `/conversations/${t.id}`, { body: { title: "" } });
      expect((cleared.body as any).title).toBeUndefined();
    });

    it("is switched off per action by the agent's experience", async () => {
      const t = await boot({ settings: { experience: { history: { pin: false, rename: false, bulkDelete: false } } } });
      const pin = await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: true } });
      expect(pin.status).toBe(403);
      expect(errorOf(pin)).toMatchObject({ code: "action_disabled", details: { setting: "experience.history.pin" } });
      expect((await t.call("PATCH", `/conversations/${t.id}`, { body: { title: "new" } })).status).toBe(403);
      // a call that changes nothing about the title is not a rename
      expect((await t.call("PATCH", `/conversations/${t.id}`, { body: { metadata: { a: 1 } } })).status).toBe(200);
      const bulk = await t.call("POST", "/conversations/bulk-delete", { body: { ids: [t.id] } });
      expect((bulk.body as any).results[0].status).toBe("error");
      expect((await t.call("GET", `/conversations/${t.id}`)).status).toBe(200);
    });

    it("deletes several conversations at once, judging each id by itself", async () => {
      const audit: AuditEntry[] = [];
      const t = await boot({ config: { audit: (_ctx, entry) => void audit.push(entry) } });
      const mine = [t.id, await t.create(), await t.create()];
      const theirs = await t.create({}, { "x-user": "another" });
      const hold = gate();
      const running = await boot({ behaviour: { invoke: async (_i, io) => (await Promise.race([hold.promise, new Promise((r) => io.signal.addEventListener("abort", r))]), { content: "" }) }, user: t.user });
      const busyId = running.id;
      const turn = running.send("long");
      await eventually(async () => ((await running.get()).conversation.runtime.status === "running"));

      const res = await t.call("POST", "/conversations/bulk-delete", { body: { ids: [...mine, theirs, "conv_unknown", mine[0]!] } });
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.deleted).toBe(3);
      expect(body.results).toEqual([
        { id: mine[0], status: "deleted" },
        { id: mine[1], status: "deleted" },
        { id: mine[2], status: "deleted" },
        { id: theirs, status: "not_found" },
        { id: "conv_unknown", status: "not_found" },
      ]);
      for (const id of mine) expect((await t.call("GET", `/conversations/${id}`)).status).toBe(404);
      // someone else's conversation is untouched
      expect((await t.call("GET", `/conversations/${theirs}`, { headers: { "x-user": "another" } })).status).toBe(200);
      expect(audit.find((a) => a.action === "conversation.bulk_delete")).toMatchObject({ details: { requested: 5, deleted: 3 } });

      // a conversation that is running is stopped and deleted
      const stopped = await running.call("POST", "/conversations/bulk-delete", { body: { ids: [busyId] } });
      expect((stopped.body as any).results[0].status).toBe("deleted");
      hold.open();
      await turn.catch(() => undefined);
    });

    it("checks the list of ids", async () => {
      const t = await boot({ config: { limits: { maxBulkDelete: 3 } } });
      for (const ids of [undefined, [], "conv_1", [1], [""], ["a", "b", "c", "d"]]) {
        const res = await t.call("POST", "/conversations/bulk-delete", { body: { ids } });
        expect(res.status, JSON.stringify(ids)).toBe(400);
        expect(errorOf(res).code).toBe("VALIDATION_ERROR");
      }
    });
  });

  // ==========================================================================
  describe("generated titles", () => {
    it("asks the agent's own generator after the first answer, and reports what it used", async () => {
      const seen: any[] = [];
      const t = await boot({
        settings: {
          titleGeneration: {
            generate: async (input) => {
              seen.push({ user: input.user, assistant: input.assistant, maxWords: input.maxWords, agent: input.agent.id });
              return { title: '"Trip to Lisbon in May for a week."', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }, model: "small" };
            },
            maxWords: 4,
          },
        },
      });
      const res = await t.send("plan a trip to Lisbon");
      expect((res.body as any).conversationTitle).toBe("Trip to Lisbon in");
      expect(seen).toEqual([{ user: "plan a trip to Lisbon", assistant: "answer 1", maxWords: 4, agent: "h" }]);
      const conversation = (await t.get()).conversation;
      expect(conversation.title).toBe("Trip to Lisbon in");
      expect(conversation.metadata.titleGenerated).toBe(true);
      const event = (await t.events()).find((e) => e.type === "session.title")!;
      expect(event.data).toEqual({ title: "Trip to Lisbon in", purpose: "title", model: "small", usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } });
      expect((await t.get()).conversation.runtime.status).toBe("idle");

      // only the first exchange is titled
      await t.send("and then?");
      expect(seen).toHaveLength(1);
    });

    it("with titleFrame, ends the turn first and sends the title as its own frame after the done frame", async () => {
      const titleGate = gate();
      let asked = 0;
      const t = await boot({
        settings: { titleGeneration: { generate: async () => { asked += 1; await titleGate.promise; return "Late title"; } } },
      });
      const res = await t.send("plan a trip", { stream: true, titleFrame: true });
      const reader = res.stream![Symbol.asyncIterator]();
      let text = "";
      while (!parseSse(text).some((f) => f.type === "stream.done")) {
        const next = await reader.next();
        if (next.done) break;
        text += next.value;
      }
      // the done frame is out while the title model is still working, without a title
      const done = parseSse(text).find((f) => f.type === "stream.done") as any;
      expect(done).toMatchObject({ conversationId: t.id, content: "answer 1" });
      expect(done.title).toBeUndefined();
      await eventually(() => asked === 1);
      // ... and the conversation is free: the next message is taken at once
      expect((await t.get()).conversation.runtime.status).toBe("idle");
      const second = await t.send("and then?");
      expect(second.status).toBe(200);
      expect((second.body as any).response.content).toBe("answer 2");

      titleGate.open();
      for (;;) {
        const next = await reader.next();
        if (next.done) break;
        text += next.value;
      }
      const frames = parseSse(text);
      expect(frames.map((f) => f.type).slice(-2)).toEqual(["stream.done", "stream.title"]);
      expect(frames.at(-1)).toMatchObject({ type: "stream.title", conversationId: t.id, title: "Late title" });
      expect((await t.get()).conversation.title).toBe("Late title");
      expect((await t.events()).filter((e) => e.type === "session.title").map((e) => e.data.title)).toEqual(["Late title"]);
      expect(asked).toBe(1);
    });

    it("without titleFrame keeps the title in the done frame, and with it closes right after the done frame when there is no title to make", async () => {
      const t = await boot({ settings: { titleGeneration: { generate: async () => "Early title" } } });
      const first = await t.drain(await t.send("one", { stream: true }));
      expect(first.find((f) => f.type === "stream.done")).toMatchObject({ title: "Early title" });
      expect(first.some((f) => f.type === "stream.title")).toBe(false);

      const second = await t.drain(await t.send("two", { stream: true, titleFrame: true }));
      expect(second.at(-1)!.type).toBe("stream.done");
      expect(second.some((f) => f.type === "stream.title")).toBe(false);
    });

    it("can be switched off for one agent whatever the server says, and costs the conversation nothing when the generator fails", async () => {
      const generate = vi.fn(async () => "Server title");
      const off = await boot({ config: { titleGeneration: { generate } }, settings: { titleGeneration: false } });
      expect(((await off.send("hi")).body as any).conversationTitle).toBeUndefined();
      expect(generate).not.toHaveBeenCalled();
      expect((await off.server.getAgentFor("h"))!.titleGeneration).toBe(false);

      const on = await boot({ config: { titleGeneration: { generate } } });
      expect(((await on.send("hi")).body as any).conversationTitle).toBe("Server title");

      const failing = await boot({ settings: { titleGeneration: { generate: async () => { throw new Error("no model"); } } } });
      const res = await failing.send("hi");
      expect(res.status).toBe(200);
      expect((res.body as any).conversationTitle).toBeUndefined();
    });

    it("keeps a title the person wrote, and makes a new one when the first message is edited", async () => {
      let n = 0;
      const t = await boot({ settings: { titleGeneration: { generate: async () => `Title ${++n}` } } });
      const first = await t.send("one");
      const userId = (first.body as any).message.id as string;
      expect((await t.get()).conversation.title).toBe("Title 1");

      // editing the first message of a conversation whose title the server made: the title is made again
      await t.call("POST", `/conversations/${t.id}/messages/${userId}/edit`, { body: { content: "something else" } });
      expect((await t.get()).conversation.title).toBe("Title 2");

      // a title the person wrote stays
      await t.call("PATCH", `/conversations/${t.id}`, { body: { title: "Mine" } });
      expect((await t.get()).conversation.metadata.titleGenerated).toBeUndefined();
      const [user] = await t.messages();
      await t.call("POST", `/conversations/${t.id}/messages/${user.id}/edit`, { body: { content: "third" } });
      expect((await t.get()).conversation.title).toBe("Mine");
    });

    it("refuses a configuration that cannot make a title when the server is built", () => {
      expect(() => createAgentServer({ basePath: "/api", storage: currentStorage(), titleGeneration: {} })).toThrow(/baseUrl and model|generate/);
      const server = createAgentServer({ basePath: "/api", storage: currentStorage() });
      expect(() => server.registerHostAgent({ info: { id: "x", name: "X" }, invoke: () => ({}), titleGeneration: { model: "m" } })).toThrow(/baseUrl and model|generate/);
    });
  });

  // ==========================================================================
  describe("what a client shows around an agent", () => {
    it("publishes the switches with their defaults on every agent", async () => {
      const t = await boot();
      const agent = ((await t.call("GET", "/agents/h")).body as any);
      expect(agent.metadata.experience).toEqual({
        messageActions: { copy: true, regenerate: true, edit: true },
        history: { rename: true, pin: true, bulkDelete: true },
        feedback: { enabled: true, comments: true, reasons: ["inaccurate", "incomplete", "off_topic", "too_long", "unsafe", "other"], maxCommentLength: 1000 },
        export: { enabled: true, includeTools: false, formats: ["md", "json", "html"] },
        titles: false,
      });
      expect(agent.metadata.welcome).toBeUndefined();
      expect(agent.metadata.starters).toBeUndefined();
    });

    it("publishes welcome text and starters, cleaned", async () => {
      const t = await boot({
        settings: {
          experience: {
            welcome: "  Hello **there**\n\n- ask me things  ",
            starters: [
              { text: "  Summarise my week  ", label: "Week", autoSend: true },
              { text: "Draft an email" },
              { text: "" },
              { text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" },
            ],
          },
        },
      });
      const agents = (await t.call("GET", "/agents")).body as any;
      const meta = agents.agents.find((a: any) => a.id === "h").metadata;
      expect(meta.welcome).toBe("Hello **there**\n\n- ask me things");
      expect(meta.starters).toHaveLength(6);
      expect(meta.starters.slice(0, 2)).toEqual([{ text: "Summarise my week", label: "Week", autoSend: true }, { text: "Draft an email" }]);
    });

    it("layers the server's settings, the agent's and what the host wrote in the agent's metadata", async () => {
      const t = await boot({
        config: {
          experience: { messageActions: { edit: false }, feedback: { comments: false }, export: { includeTools: true } },
          feedback: { reasons: ["wrong", "slow"] },
          export: { renderPdf: async () => Buffer.from("%PDF") },
          titleGeneration: { generate: async () => "t" },
        },
        settings: {
          experience: { messageActions: { regenerate: false }, history: { pin: false } },
          info: { id: "h", name: "Host", metadata: { welcome: "From the host", experience: { messageActions: { edit: true }, feedback: { reasons: ["meh"] } } } },
        },
      });
      const meta = ((await t.call("GET", "/agents/h")).body as any).metadata;
      expect(meta.welcome).toBe("From the host");
      expect(meta.experience.messageActions).toEqual({ copy: true, regenerate: false, edit: true });
      expect(meta.experience.history.pin).toBe(false);
      expect(meta.experience.feedback).toEqual({ enabled: true, comments: false, reasons: ["meh"], maxCommentLength: 0 });
      expect(meta.experience.export).toEqual({ enabled: true, includeTools: true, formats: ["md", "json", "html", "pdf"] });
      expect(meta.experience.titles).toBe(true);
    });

    it("keeps the legacy metadata keys the first chat-ui read", async () => {
      const t = await boot();
      const meta = ((await t.call("GET", "/agents/h")).body as any).metadata;
      expect(meta).toMatchObject({ enableFileUpload: expect.any(Boolean), maxFiles: expect.any(Number) });
    });
  });

  // ==========================================================================
  describe("feedback", () => {
    const rate = (t: Awaited<ReturnType<typeof boot>>, messageId: string, body: unknown, headers?: Record<string, string>, conversationId = t.id) =>
      t.call("POST", `/conversations/${conversationId}/messages/${messageId}/feedback`, { body, headers });

    it("stores a rating on the answer, replaces it, and withdraws it", async () => {
      const heard: FeedbackEvent[] = [];
      const hostHeard: FeedbackEvent[] = [];
      const t = await boot({
        behaviour: { feedback: (event) => void hostHeard.push(event) },
        config: { feedback: { onFeedback: (_ctx, event) => void heard.push(event) } },
      });
      await t.send("first");
      const second = await t.send("second");
      const answer = (second.body as any).response.id as string;
      const question = (second.body as any).message.id as string;

      const up = await rate(t, answer, { rating: "up" });
      expect(up.status).toBe(200);
      expect((up.body as any).feedback).toMatchObject({ rating: "up", userId: t.user });
      const stored = (await t.messages()).find((m) => m.id === answer);
      expect(stored.feedback).toMatchObject({ rating: "up" });
      expect(stored.metadata.feedback.rating).toBe("up");

      const down = await rate(t, answer, { rating: "down", reasons: ["inaccurate", "too_long", "inaccurate"], comment: "  it was wrong  " });
      const feedback = (down.body as any).feedback;
      expect(feedback).toMatchObject({ rating: "down", reasons: ["inaccurate", "too_long"], comment: "it was wrong" });
      expect(feedback.createdAt).toBe((up.body as any).feedback.createdAt);
      expect(Date.parse(feedback.updatedAt)).toBeGreaterThanOrEqual(Date.parse(feedback.createdAt));

      // the hooks: the agent's first, then the server's - one event per change, with where the answer sits
      expect(hostHeard.map((e) => e.rating)).toEqual(["up", "down"]);
      expect(heard.map((e) => e.rating)).toEqual(["up", "down"]);
      expect(heard[1]).toMatchObject({
        conversationId: t.id,
        messageId: answer,
        messageIndex: 3,
        agentId: "h",
        userId: t.user,
        reasons: ["inaccurate", "too_long"],
        comment: "it was wrong",
        previous: { rating: "up" },
      });
      expect(heard[1]!.message.content).toBe("answer 2");
      expect(heard[1]!.question!.id).toBe(question);

      // withdrawing removes it everywhere, and withdrawing again changes nothing
      const withdrawn = await rate(t, answer, { rating: null });
      expect(withdrawn.body).toEqual({ feedback: null, messageId: answer });
      expect((await t.messages()).find((m) => m.id === answer).feedback).toBeUndefined();
      expect(heard.map((e) => e.rating)).toEqual(["up", "down", null]);
      await rate(t, answer, { rating: null });
      expect(heard).toHaveLength(3);
    });

    it("checks the rating, the reasons and the comment", async () => {
      const t = await boot({ config: { feedback: { reasons: ["wrong", "rude"], maxCommentLength: 20 } } });
      const answer = ((await t.send("q")).body as any).response.id as string;
      const bad = async (body: unknown) => {
        const res = await rate(t, answer, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(errorOf(res).code).toBe("invalid_feedback");
      };
      await bad({});
      await bad({ rating: "meh" });
      await bad({ rating: "up", reasons: ["wrong"] });
      await bad({ rating: "down", reasons: ["unsafe"] });
      await bad({ rating: "down", reasons: "wrong" });
      await bad({ rating: "down", comment: "x".repeat(21) });
      await bad({ rating: "down", comment: 5 });
      expect((await rate(t, answer, { rating: "down", reasons: ["wrong"], comment: "x".repeat(20) })).status).toBe(200);

      const noComments = await boot({ settings: { experience: { feedback: { comments: false } } } });
      const a2 = ((await noComments.send("q")).body as any).response.id as string;
      expect((await rate(noComments, a2, { rating: "down", comment: "why" })).status).toBe(400);
      expect((await rate(noComments, a2, { rating: "down" })).status).toBe(200);
    });

    it("rates answers only, for the owner only, and when the agent takes feedback", async () => {
      const t = await boot();
      const sent = await t.send("q");
      const answer = (sent.body as any).response.id as string;
      const question = (sent.body as any).message.id as string;
      const onQuestion = await rate(t, question, { rating: "up" });
      expect(onQuestion.status).toBe(409);
      expect(errorOf(onQuestion).code).toBe("invalid_message_target");
      expect((await rate(t, "msg_nope", { rating: "up" })).status).toBe(404);
      expect((await rate(t, answer, { rating: "up" }, { "x-user": "intruder" })).status).toBe(403);

      const off = await boot({ settings: { experience: { feedback: { enabled: false } } } });
      const a2 = ((await off.send("q")).body as any).response.id as string;
      const refused = await rate(off, a2, { rating: "up" });
      expect(refused.status).toBe(403);
      expect(errorOf(refused).code).toBe("feedback_disabled");
    });

    it("keeps the rating when a hook fails, so repeating the request is safe", async () => {
      let fail = true;
      const t = await boot({ config: { feedback: { onFeedback: () => { if (fail) throw new Error("analytics down"); } } } });
      const answer = ((await t.send("q")).body as any).response.id as string;
      expect((await rate(t, answer, { rating: "up" })).status).toBe(500);
      expect((await t.messages()).find((m) => m.id === answer).feedback.rating).toBe("up");
      fail = false;
      expect((await rate(t, answer, { rating: "up" })).status).toBe(200);
    });

    it("survives the answer being regenerated: the new answer starts unrated", async () => {
      const t = await boot();
      const answer = ((await t.send("q")).body as any).response.id as string;
      await rate(t, answer, { rating: "down", reasons: ["other"] });
      await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`);
      expect((await t.messages()).at(-1).feedback).toBeUndefined();
    });
  });

  // ==========================================================================
  describe("export", () => {
    const exp = (t: Awaited<ReturnType<typeof boot>>, query: Record<string, string> = {}, headers?: Record<string, string>) =>
      t.call("GET", `/conversations/${t.id}/export`, { query, headers });
    const text = (res: { raw?: Buffer }) => res.raw!.toString("utf8");

    it("downloads Markdown by default, with the title, the speakers and the text", async () => {
      const t = await boot();
      await t.call("PATCH", `/conversations/${t.id}`, { body: { title: "Lisbon / trip: plan?" } });
      await t.send("plan a trip");
      const res = await exp(t);
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject({
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      expect(res.headers!["Content-Disposition"]).toMatch(/^attachment; filename="Lisbon trip plan.md"/);
      const md = text(res);
      expect(md).toContain("# Lisbon / trip: plan?");
      expect(md).toMatch(/\*\*You\*\* · \d{4}-/);
      expect(md).toContain("plan a trip");
      expect(md).toContain("**Host**");
      expect(md).toContain("answer 1");
      expect(Number(res.headers!["Content-Length"])).toBe(res.raw!.length);
    });

    it("speaks the person's language and honours the host's labels", async () => {
      const t = await boot({ config: { export: { labels: { de: { user: "Sie" } } } } });
      await t.send("merhaba");
      expect(text(await exp(t, { locale: "tr-TR" }))).toContain("**Siz**");
      expect(text(await exp(t, { locale: "de" }))).toContain("**Sie**");
      expect(text(await exp(t, { locale: "xx" }))).toContain("**You**");
    });

    it("downloads JSON with the messages, their files and ratings", async () => {
      const t = await boot();
      const sent = await t.send("hello");
      await t.call("POST", `/conversations/${t.id}/messages/${(sent.body as any).response.id}/feedback`, { body: { rating: "down", reasons: ["other"], comment: "meh" } });
      const res = await exp(t, { format: "json" });
      expect(res.headers!["Content-Type"]).toBe("application/json; charset=utf-8");
      const body = JSON.parse(text(res));
      expect(body).toMatchObject({ schemaVersion: 1, conversation: { id: t.id, agentId: "h", agentName: "Host", truncated: false } });
      expect(body.messages.map((m: any) => [m.role, m.content])).toEqual([["user", "hello"], ["assistant", "answer 1"]]);
      expect(body.messages[1].feedback).toEqual({ rating: "down", reasons: ["other"], comment: "meh" });
    });

    it("renders a print page that never interprets a message as markup", async () => {
      const t = await boot({ behaviour: { invoke: async () => ({ content: "<img src=x onerror=alert(1)> & done" }) } });
      await t.send("<script>alert('x')</script>");
      const plain = await exp(t, { format: "html" });
      const html = text(plain);
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; done");
      expect(plain.headers!["Content-Security-Policy"]).toContain("default-src 'none'");
      expect(plain.headers!["Content-Security-Policy"]).not.toContain("script-src");
      expect(plain.headers!["Content-Disposition"]).toMatch(/^attachment/);

      // with print=1 exactly one script is allowed: the one that opens the print dialog
      const print = await exp(t, { format: "html", print: "1" });
      const csp = print.headers!["Content-Security-Policy"]!;
      expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
      expect(text(print).match(/<script>/g)).toHaveLength(1);
      expect(text(print)).toContain("print()");
      expect(print.headers!["Content-Disposition"]).toMatch(/^inline/);
    });

    it("includes tool calls only when asked for and allowed", async () => {
      const behaviour: Behaviour = {
        invoke: (_i, { emit }) => {
          emit({ type: "tool_use", id: "c1", name: "search", args: { q: "lisbon" } });
          emit({ type: "tool_result", id: "c1", result: { hits: 3 } });
          return { content: "found it" };
        },
      };
      const denied = await boot({ behaviour });
      await denied.send("find");
      const refused = await exp(denied, { tools: "1" });
      expect(refused.status).toBe(403);
      expect(errorOf(refused).code).toBe("export_disabled");
      expect(text(await exp(denied))).not.toContain("search");

      const allowed = await boot({ behaviour, config: { export: { includeTools: true } } });
      await allowed.send("find");
      const md = text(await exp(allowed, { tools: "1" }));
      expect(md).toContain("Tool calls");
      expect(md).toContain('`search` {"q":"lisbon"} - ok');
      const json = JSON.parse(text(await exp(allowed, { tools: "1", format: "json" })));
      expect(json.messages[1].toolCalls).toEqual([expect.objectContaining({ name: "search", args: { q: "lisbon" }, ok: true })]);
      // without tools=1 the file has none
      expect(text(await exp(allowed))).not.toContain("search");
      expect(((await allowed.call("GET", "/agents/h")).body as any).metadata.experience.export.includeTools).toBe(true);
    });

    describe("tool calls when the log has no run ids", () => {
      /** A turn that searches, a turn that does not, a turn that writes with one tool failing. */
      const toolful: Behaviour = {
        invoke: (input, { emit }) => {
          if (input.message === "find") {
            emit({ type: "tool_use", id: "c1", name: "search", args: { q: "lisbon" } });
            emit({ type: "tool_result", id: "c1", result: { hits: 3 } });
            return { content: "found it" };
          }
          if (input.message === "save") {
            emit({ type: "tool_use", id: "c2", name: "fetch", args: { url: "u" } });
            emit({ type: "tool_use", id: "c3", name: "write", args: { path: "p" } });
            emit({ type: "tool_result", id: "c2", error: "timeout" });
            emit({ type: "tool_result", id: "c3", result: "ok" });
            return { content: "saved it" };
          }
          return { content: "plain answer" };
        },
      };

      for (const shape of ["ids", "console", "content", "order"] as const) {
        it(`includes them for a host whose log is ${shape === "ids" ? "this server's, minus the runs" : `camelCase and says ${shape === "console" ? "the position and the text" : shape === "content" ? "the text" : "nothing about the answer"}`}`, async () => {
          const t = await boot({ behaviour: toolful, config: { export: { includeTools: true } }, through: (storage) => hostShaped(storage, shape) });
          for (const message of ["find", "chat", "save"]) await t.send(message);

          // (the log really has no run to go by)
          const log = ((await t.call("GET", `/conversations/${t.id}/events`)).body as any).events as any[];
          expect(log.some((e) => e.type === "agent.tool_use")).toBe(true);
          expect(log.every((e) => e.run_id === undefined)).toBe(true);

          const json = JSON.parse(text(await exp(t, { tools: "1", format: "json" })));
          expect(json.messages.map((m: any) => [m.content, (m.toolCalls ?? []).map((c: any) => [c.name, c.ok, c.error])])).toEqual([
            ["find", []],
            ["found it", [["search", true, undefined]]],
            ["chat", []],
            ["plain answer", []],
            ["save", []],
            ["saved it", [["fetch", false, "timeout"], ["write", true, undefined]]],
          ]);
          expect(json.messages[1].toolCalls[0].args).toEqual({ q: "lisbon" });
          const md = text(await exp(t, { tools: "1" }));
          expect(md).toContain('`search` {"q":"lisbon"} - ok');
          expect(md).toContain("`fetch` {\"url\":\"u\"} - failed: timeout");
          expect(md).toContain('`write` {"path":"p"} - ok');
          expect(text(await exp(t, { tools: "1", format: "html" }))).toContain("<code>search</code>");
          // without tools=1 there are none
          expect(text(await exp(t))).not.toContain("search");
        });
      }

      it("does not give a regenerated answer the calls of the one it replaced, nor hand them to another answer", async () => {
        let finds = 0;
        const behaviour: Behaviour = {
          invoke: (input, { emit }) => {
            if (input.message !== "find") return { content: "plain answer" };
            const tool = ++finds === 1 ? "search" : "search_again";
            emit({ type: "tool_use", id: `c${finds}`, name: tool, args: {} });
            emit({ type: "tool_result", id: `c${finds}`, result: {} });
            return { content: finds === 1 ? "found it" : "found it again" };
          },
        };
        for (const shape of ["content", "order"] as const) {
          finds = 0;
          const t = await boot({ behaviour, config: { export: { includeTools: true } }, through: (storage) => hostShaped(storage, shape) });
          await t.send("chat");
          const found = await t.send("find");
          await t.call("POST", `/conversations/${t.id}/messages/${(found.body as any).response.id}/regenerate`);
          const json = JSON.parse(text(await exp(t, { tools: "1", format: "json" })));
          const answers = json.messages.filter((m: any) => m.role === "assistant").map((m: any) => [m.content, (m.toolCalls ?? []).map((c: any) => c.name)]);
          // (by what the answers say the new one is told apart; with nothing to tell them apart, none is guessed)
          expect(answers).toEqual([["plain answer", []], ["found it again", shape === "content" ? ["search_again"] : []]]);
        }
      });
    });

    it("renders PDF only when the host has a renderer, and says what to do otherwise", async () => {
      const t = await boot();
      const none = await exp(t, { format: "pdf" });
      expect(none.status).toBe(501);
      expect(errorOf(none)).toMatchObject({ code: "export_format_unsupported" });
      expect(errorOf(none).message).toMatch(/format=html&print=1/);

      const seen: string[] = [];
      const rendering = await boot({
        config: { export: { renderPdf: async ({ html, conversation }) => (seen.push(conversation.id, html.slice(0, 15)), Buffer.from("%PDF-1.7 fake")) } },
      });
      await rendering.send("hi");
      const pdf = await exp(rendering, { format: "pdf" });
      expect(pdf.status).toBe(200);
      expect(pdf.headers!["Content-Type"]).toBe("application/pdf");
      expect(text(pdf)).toBe("%PDF-1.7 fake");
      expect(seen).toEqual([rendering.id, "<!doctype html>"]);
      expect(((await rendering.call("GET", "/agents/h")).body as any).metadata.experience.export.formats).toContain("pdf");
    });

    it("refuses an unknown format, someone else's conversation, and a disabled export", async () => {
      const t = await boot();
      expect((await exp(t, { format: "docx" })).status).toBe(400);
      expect((await exp(t, {}, { "x-user": "intruder" })).status).toBe(403);
      expect((await t.call("GET", "/conversations/conv_nope/export")).status).toBe(404);
      const off = await boot({ settings: { experience: { export: { enabled: false } } } });
      const refused = await exp(off);
      expect(refused.status).toBe(403);
      expect(errorOf(refused).code).toBe("export_disabled");
      expect(((await off.call("GET", "/agents/h")).body as any).metadata.experience.export.formats).toEqual([]);
    });

    it("leaves out the empty husks of stopped turns, cuts a very long conversation, and is audited", async () => {
      const audit: AuditEntry[] = [];
      const t = await boot({ config: { export: { maxMessages: 4 }, audit: (_ctx, entry) => void audit.push(entry) } });
      for (let i = 1; i <= 4; i++) await t.send(`question ${i}`);
      const body = JSON.parse(text(await exp(t, { format: "json" })));
      expect(body.conversation.truncated).toBe(true);
      expect(body.messages.map((m: any) => m.content)).toEqual(["question 3", "answer 3", "question 4", "answer 4"]);
      expect(text(await exp(t))).toContain("Only the newest messages are included.");
      expect(audit.filter((a) => a.action === "conversation.export").map((a) => a.details)).toEqual([
        { format: "json", includeTools: false, messages: 4 },
        { format: "md", includeTools: false, messages: 4 },
      ]);
      expect(audit[0]).toMatchObject({ conversationId: t.id, agentId: "h", userId: t.user });
    });
  });
}

// ============================================================================
// Client tools
// ============================================================================

/**
 * The switches are the agent's policy. When the agent of a conversation cannot be resolved any more (it left the host's catalog, or the
 * host's `agents` function failed) the server must not fall back to its own defaults, which are all on.
 */
function unresolvedAgentSuite() {
  type Catalog = { present: boolean; failing: boolean };

  /** A portal-like host: one agent whose switches are off, offered while `catalog.present`. */
  async function portalLike(switches: Record<string, unknown> | undefined, config: Partial<AgentServerConfig> = {}) {
    const catalog: Catalog = { present: true, failing: false };
    const user = freshUser();
    const server = createAgentServer({
      basePath: "/api",
      storage: currentStorage(),
      resolveContext: () => ({ user: { id: user }, data: {} }),
      agents: () => {
        if (catalog.failing) throw new Error("catalog unavailable");
        return catalog.present
          ? [hostAgentRegistration({ info: { id: "h", name: "Host" }, invoke: async () => ({ content: "answer" }), ...(switches ? { experience: switches } : {}) } as any)]
          : [];
      },
      ...quiet(config),
    } as AgentServerConfig);
    const call = (method: string, path: string, extra: { body?: unknown; query?: Record<string, string> } = {}) =>
      server.handleRoute(method, path, { query: extra.query ?? {}, body: extra.body, headers: {} });
    const id = (((await call("POST", "/conversations", { body: { agentId: "h" } })).body as any).conversation.id) as string;
    const sent = await call("POST", `/conversations/${id}/messages`, { body: { message: "hello" } });
    const answerId = (sent.body as any).response.id as string;
    return { catalog, call, id, answerId };
  }

  const OFF = {
    messageActions: { copy: false, regenerate: false, edit: false },
    history: { rename: false, pin: false, bulkDelete: false },
    feedback: { enabled: false, comments: false },
    export: { enabled: false, includeTools: false },
  };

  it("keeps a policy switched off after the agent has left the catalog", async () => {
    const t = await portalLike(OFF);
    const exportIt = (format: string) => t.call("GET", `/conversations/${t.id}/export`, { query: { format } });
    const rate = () => t.call("POST", `/conversations/${t.id}/messages/${t.answerId}/feedback`, { body: { rating: "up", comment: "x" } });

    // with the agent in the catalog every action is refused
    expect(errorOf(await exportIt("md")).code).toBe("export_disabled");
    expect(errorOf(await rate()).code).toBe("feedback_disabled");
    expect(errorOf(await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: true } })).code).toBe("action_disabled");

    t.catalog.present = false;

    // ... and still is once the agent is gone
    for (const format of ["md", "json", "html"]) {
      const res = await exportIt(format);
      expect(res.status).toBe(403);
      expect(errorOf(res)).toMatchObject({ code: "export_disabled", details: { reason: "agent_unavailable" } });
      expect(res.raw).toBeUndefined();
    }
    const withTools = await t.call("GET", `/conversations/${t.id}/export`, { query: { format: "json", tools: "1" } });
    expect(errorOf(withTools).code).toBe("export_disabled");

    const rated = await rate();
    expect(rated.status).toBe(403);
    expect(errorOf(rated)).toMatchObject({ code: "feedback_disabled", details: { reason: "agent_unavailable" } });

    const pinned = await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: true } });
    expect(errorOf(pinned)).toMatchObject({ code: "action_disabled", details: { setting: "experience.history.pin", reason: "agent_unavailable" } });
    const renamed = await t.call("PATCH", `/conversations/${t.id}`, { body: { title: "renamed" } });
    expect(errorOf(renamed)).toMatchObject({ code: "action_disabled", details: { setting: "experience.history.rename", reason: "agent_unavailable" } });

    const bulk = await t.call("POST", "/conversations/bulk-delete", { body: { ids: [t.id] } });
    expect(bulk.status).toBe(200);
    expect((bulk.body as any).deleted).toBe(0);
    expect((bulk.body as any).results[0]).toMatchObject({ id: t.id, status: "error" });

    // nothing changed: the conversation is still there, unpinned and unrated
    const shown = (await t.call("GET", `/conversations/${t.id}`)).body as any;
    expect(shown.conversation.metadata?.pinned).toBeFalsy();
    expect(shown.conversation.title ?? "").not.toBe("renamed");
    expect(shown.messages.map((m: any) => m.feedback).filter(Boolean)).toEqual([]);
  });

  it("does not let the server's defaults, which are all on, stand in for the agent", async () => {
    // the agent never switched anything off, so while it is offered everything works ...
    const t = await portalLike(undefined);
    expect((await t.call("GET", `/conversations/${t.id}/export`, { query: { format: "md" } })).status).toBe(200);
    expect((await t.call("POST", `/conversations/${t.id}/messages/${t.answerId}/feedback`, { body: { rating: "up" } })).status).toBe(200);

    // ... and once it cannot be resolved nothing is assumed
    t.catalog.present = false;
    expect(errorOf(await t.call("GET", `/conversations/${t.id}/export`, { query: { format: "md" } })).code).toBe("export_disabled");
    expect(errorOf(await t.call("POST", `/conversations/${t.id}/messages/${t.answerId}/feedback`, { body: { rating: "down" } })).code).toBe("feedback_disabled");
    expect(errorOf(await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: true } })).code).toBe("action_disabled");

    // the agent coming back brings its own switches back
    t.catalog.present = true;
    expect((await t.call("GET", `/conversations/${t.id}/export`, { query: { format: "md" } })).status).toBe(200);
    expect((await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: true } })).status).toBe(200);
  });

  it("holds even when the server's own settings switch things on", async () => {
    const t = await portalLike(undefined, { experience: { export: { enabled: true, includeTools: true }, feedback: { enabled: true } } });
    t.catalog.present = false;
    expect(errorOf(await t.call("GET", `/conversations/${t.id}/export`, { query: { format: "json", tools: "1" } })).code).toBe("export_disabled");
    expect(errorOf(await t.call("POST", `/conversations/${t.id}/messages/${t.answerId}/feedback`, { body: { rating: "up" } })).code).toBe("feedback_disabled");
  });

  it("refuses, not fails, when the host cannot say which agents exist", async () => {
    const t = await portalLike(OFF);
    t.catalog.failing = true;
    const res = await t.call("GET", `/conversations/${t.id}/export`, { query: { format: "md" } });
    // the conversation lookup itself needs no agent, so the refusal comes from the closed switches
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe("export_disabled");
    expect(errorOf(await t.call("POST", `/conversations/${t.id}/messages/${t.answerId}/feedback`, { body: { rating: "up" } })).code).toBe("feedback_disabled");
  });

  it("leaves the person able to read and delete their own history", async () => {
    const t = await portalLike(OFF);
    t.catalog.present = false;
    const shown = await t.call("GET", `/conversations/${t.id}`);
    expect(shown.status).toBe(200);
    expect(((shown.body as any).messages as any[]).map((m) => m.content)).toEqual(["hello", "answer"]);
    expect((await t.call("DELETE", `/conversations/${t.id}`)).status).toBe(204);
  });

  it("does not offer regeneration or editing for it", async () => {
    const t = await portalLike(undefined);
    t.catalog.present = false;
    const regenerated = await t.call("POST", `/conversations/${t.id}/messages/${t.answerId}/regenerate`);
    expect(regenerated.status).toBe(404);
    const edited = await t.call("POST", `/conversations/${t.id}/messages/${t.answerId}/edit`, { body: { content: "changed" } });
    expect(edited.status).toBe(404);
  });
}

function clientToolSuite() {
  const tool = (extra: Record<string, unknown> = {}) => ({
    id: "ct1",
    type: "client_tool" as const,
    toolName: "read_page_title",
    toolCallId: "call-1",
    args: { selector: "h1" },
    timeoutSeconds: 20,
    ...extra,
  });

  /** An agent that asks the page for a tool, then answers with what the page said. */
  const asking = (extra: Record<string, unknown> = {}) =>
    boot({
      behaviour: {
        invoke: async () => ({ content: "", pendingActions: [tool(extra)] }),
        resolveAction: async (input) => {
          const resolution = input.resolution as any;
          return { content: resolution.error ? `page failed: ${resolution.error}` : `title is ${JSON.stringify(resolution.output)}` };
        },
      },
    });

  it("pauses the turn on a request for the host page and passes it to the client unchanged", async () => {
    const t = await asking();
    const res = await t.send("what is the page about?", { stream: true });
    const frames = await t.drain(res as any);
    const required = frames.find((f) => f.type === "stream.action_required") as any;
    expect(required.actions).toEqual([
      expect.objectContaining({ id: "ct1", type: "client_tool", toolName: "read_page_title", toolCallId: "call-1", args: { selector: "h1" }, timeoutSeconds: 20 }),
    ]);
    const action = required.actions[0];
    // the server stamps when it was asked and when it gives up on the page: the tool's timeout plus a grace period
    expect(Date.parse(action.requestedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(action.expiresAt) - Date.parse(action.requestedAt)).toBe(50_000);
    expect(frames.at(-1)).toMatchObject({ type: "stream.done", status: "requires_action", stopReason: "requires_action" });

    const log = await t.events();
    const event = log.find((e) => e.type === "action.required")!;
    expect(event.data).toMatchObject({ action_id: "ct1", kind: "client_tool", tool_name: "read_page_title", tool_call_id: "call-1", args: { selector: "h1" }, timeout_seconds: 20 });
    const detail = await t.get();
    expect(detail.pendingActions).toHaveLength(1);
    expect(detail.conversation.runtime).toMatchObject({ status: "requires_action", pendingActionIds: ["ct1"] });
    expect(detail.messages.at(-1).metadata.pendingActions[0]).toMatchObject({ type: "client_tool", status: "pending", toolName: "read_page_title" });
    expect(detail.messages.at(-1).status).toBe("requires_action");
  });

  it("continues the turn with the page's result, and records its size - not the result - in the history", async () => {
    const t = await asking();
    await t.send("go");
    const output = { title: "Quarterly report", rows: Array.from({ length: 50 }, (_, i) => i) };
    const res = await t.call("POST", `/conversations/${t.id}/actions/ct1`, { body: { resolution: { type: "client_tool", output } } });
    expect(res.status).toBe(200);
    expect((res.body as any).response.content).toBe(`title is ${JSON.stringify(output)}`);
    expect((res.body as any).stopReason).toBe("end_turn");

    const resolved = (await t.events()).find((e) => e.type === "action.resolved")!;
    expect(resolved.data).toMatchObject({ action_id: "ct1", kind: "client_tool", tool_name: "read_page_title", status: "answered", ok: true });
    expect(typeof resolved.data.duration_ms).toBe("number");
    expect(JSON.stringify(resolved.data)).not.toContain("Quarterly");

    const paused = (await t.messages()).find((m) => m.metadata.pendingActions);
    const snapshot = paused.metadata.pendingActions[0];
    expect(snapshot.status).toBe("resolved");
    expect(snapshot.resolution).toEqual({ type: "client_tool", outputBytes: JSON.stringify(output).length });
    expect(JSON.stringify(paused)).not.toContain("Quarterly");
  });

  it("gives the model an error when the page failed or has no such tool", async () => {
    const t = await asking();
    await t.send("go");
    const res = await t.call("POST", `/conversations/${t.id}/actions/ct1`, { body: { resolution: { type: "client_tool", error: "  no handler for read_page_title  " } } });
    expect((res.body as any).response.content).toBe("page failed: no handler for read_page_title");
    const resolved = (await t.events()).find((e) => e.type === "action.resolved")!;
    expect(resolved.data).toMatchObject({ status: "failed", ok: false, error: "no handler for read_page_title" });
    const paused = (await t.messages()).find((m) => m.metadata.pendingActions);
    expect(paused.metadata.pendingActions[0].resolution).toEqual({ type: "client_tool", error: "no handler for read_page_title" });
  });

  it("takes any JSON as the result, including null, and checks the answer", async () => {
    const t = await asking();
    await t.send("go");
    const bad = async (resolution: unknown, code = "VALIDATION_ERROR") => {
      const res = await t.call("POST", `/conversations/${t.id}/actions/ct1`, { body: { resolution } });
      expect(res.status, JSON.stringify(resolution)).toBe(400);
      expect(errorOf(res).code).toBe(code);
    };
    await bad({ type: "client_tool" });
    await bad({ type: "client_tool", error: 5 });
    await bad({ type: "tool_approval", decision: "allow" });
    await bad({ type: "client_tool", output: "x".repeat(70_000) }, "invalid_client_tool_result");
    // still open after the refusals; null is a result
    const res = await t.call("POST", `/conversations/${t.id}/actions/ct1`, { body: { resolution: { type: "client_tool", output: null } } });
    expect(res.status).toBe(200);
    expect((res.body as any).response.content).toBe("title is null");
  });

  it("limits the result by `hitl.clientToolMaxOutputBytes`", async () => {
    const t = await boot({
      config: { hitl: { clientToolMaxOutputBytes: 100 } },
      behaviour: { invoke: async () => ({ content: "", pendingActions: [tool()] }), resolveAction: async () => ({ content: "ok" }) },
    });
    await t.send("go");
    const big = await t.call("POST", `/conversations/${t.id}/actions/ct1`, { body: { resolution: { type: "client_tool", output: "y".repeat(120) } } });
    expect(errorOf(big)).toMatchObject({ code: "invalid_client_tool_result", details: { maxBytes: 100 } });
    expect((await t.call("POST", `/conversations/${t.id}/actions/ct1`, { body: { resolution: { type: "client_tool", output: "fine" } } })).status).toBe(200);
  });

  it("answers a page that never did with an error the model reads, even where approvals are cancelled on timeout", async () => {
    const t = await boot({
      config: { hitl: { onTimeout: "cancel" } },
      behaviour: {
        invoke: async () => ({ content: "", pendingActions: [tool({ timeoutSeconds: 5 })] }),
        resolveAction: async (input) => ({ content: `model saw: ${(input.resolution as any).error}`, ...(input.expired ? {} : {}) }),
      },
    });
    await t.send("go");
    const result = await t.server.expirePendingActions({ conversationId: t.id, now: new Date(Date.now() + 10 * 60_000) });
    expect(result).toMatchObject({ denied: 1, continued: 1 });
    const stored = await t.messages();
    expect(stored.at(-1).content).toBe("model saw: The host page did not answer.");
    const resolved = (await t.events()).find((e) => e.type === "action.resolved")!;
    expect(resolved.data).toMatchObject({ kind: "client_tool", ok: false, status: "failed" });
  });

  it("falls back to the server-wide timeout for a request without a timeoutSeconds of its own", async () => {
    const t = await boot({
      config: { hitl: { timeoutMinutes: 3 } },
      behaviour: { invoke: async () => ({ content: "", pendingActions: [tool({ timeoutSeconds: undefined })] }) },
    });
    const res = await t.send("go");
    const action = (res.body as any).pendingActions[0];
    expect(Date.parse(action.expiresAt) - Date.parse(action.requestedAt)).toBe(180_000);
    expect(action.timeoutSeconds).toBeUndefined();
  });

  it("refuses a malformed request from the host agent at the boundary", async () => {
    const t = await boot({ behaviour: { invoke: async () => ({ content: "", pendingActions: [{ id: "x", type: "client_tool" } as any] }) } });
    const res = await t.send("go");
    expect(res.status).toBe(500);
    expect(errorOf(res).code).toBe("invalid_host_result");
    const badTimeout = await boot({ behaviour: { invoke: async () => ({ content: "", pendingActions: [tool({ timeoutSeconds: -1 }) as any] }) } });
    expect((await badTimeout.send("go")).status).toBe(500);
  });

  it("is a request a custom handler can make too", async () => {
    const storage = currentStorage();
    const server = createAgentServer({ basePath: "/api", storage, allowAnonymousList: true, ...quiet() });
    server.registerCustomAgent(
      "h2",
      {
        processMessage: async () => ({ content: "", status: "requires_action", pendingActions: [tool()] }),
        resolveAction: async ({ resolution }) => ({ content: `got ${JSON.stringify((resolution as any).output)}` }),
      },
      { name: "Handler" }
    );
    const id = ((await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "h2" } })).body as any).conversation.id as string;
    const sent = await server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message: "go" } });
    expect((sent.body as any).pendingActions[0].type).toBe("client_tool");
    const done = await server.handleRoute("POST", `/conversations/${id}/actions/ct1`, { query: {}, body: { resolution: { type: "client_tool", output: [1, 2] } } });
    expect((done.body as any).response.content).toBe("got [1,2]");
  });
}

// ============================================================================
// Rate limits and the audit trail
// ============================================================================

function hooksSuite() {
  it("refuses with 429 and Retry-After when the hook says so, before any work is done", async () => {
    const asked: RateLimitRequest[] = [];
    const t = await boot({
      config: {
        rateLimit: (_ctx, request) => {
          asked.push(request);
          return request.operation === "message.send" ? { allowed: false, retryAfterSeconds: 12.2, message: "Slow down" } : undefined;
        },
      },
    });
    const res = await t.send("hi");
    expect(res.status).toBe(429);
    expect(errorOf(res)).toEqual({ code: "rate_limited", message: "Slow down", details: { retryAfterSeconds: 13 } });
    expect(res.headers).toEqual({ "Retry-After": "13" });
    expect(await t.messages()).toEqual([]);
    expect(asked.at(-1)).toMatchObject({ operation: "message.send", conversationId: t.id, agentId: "h", userId: t.user, streaming: false });

    const plain = await boot({ config: { rateLimit: (_ctx, request) => (request.operation === "message.send" ? false : undefined) } });
    const refused = await plain.send("hi");
    expect(refused.status).toBe(429);
    expect(refused.headers).toBeUndefined();
    expect(errorOf(refused).code).toBe("rate_limited");
  });

  it("is asked about every operation that costs something", async () => {
    const asked: string[] = [];
    const t = await boot({ config: { rateLimit: (_ctx, request) => void asked.push(request.operation) } });
    const created = await t.create();
    const sent = await t.send("hi");
    const answer = (sent.body as any).response.id as string;
    await t.call("POST", "/files", { body: { conversationId: t.id, file: { name: "a.txt", content: Buffer.from("a").toString("base64"), mimeType: "text/plain" } } });
    await t.call("POST", `/conversations/${t.id}/messages/${answer}/feedback`, { body: { rating: "up" } });
    await t.call("GET", `/conversations/${t.id}/export`);
    await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`);
    const user = (await t.messages())[0];
    await t.call("POST", `/conversations/${t.id}/messages/${user.id}/edit`, { body: { content: "again" } });
    await t.call("POST", "/conversations/bulk-delete", { body: { ids: [created] } });
    expect(asked).toEqual([
      "conversation.create", // (the conversation the test booted with)
      "conversation.create",
      "message.send",
      "file.upload",
      "message.feedback",
      "conversation.export",
      "message.regenerate",
      "message.edit",
      "conversation.bulk_delete",
    ]);
  });

  it("tells the hook when a turn is over - not when the request is answered - so concurrent streams can be capped", async () => {
    const hold = gate();
    let open = 0;
    let peak = 0;
    const t = await boot({
      behaviour: { invoke: async () => (await hold.promise, { content: "done" }) },
      config: {
        rateLimit: (_ctx, request) => {
          if (request.operation !== "message.send") return undefined;
          if (open >= 1) return { allowed: false, retryAfterSeconds: 1 };
          open += 1;
          peak = Math.max(peak, open);
          return { release: () => void (open -= 1) };
        },
      },
    });
    const other = await t.create();
    const first = t.send("one", { stream: true });
    const stream = await first;
    expect(stream.status).toBe(200);
    // the connection can go away: the run, and its slot, go on
    stream.close?.();
    await eventually(() => open === 1);
    const second = await t.send("two", {}, other);
    expect(second.status).toBe(429);
    expect(open).toBe(1);
    hold.open();
    await eventually(() => open === 0);
    expect(peak).toBe(1);
    expect((await t.send("three", {}, other)).status).toBe(200);
  });

  it("releases the slot of a turn that could not start", async () => {
    let open = 0;
    const t = await boot({
      config: { rateLimit: () => (open++, { release: () => void open-- }) },
      behaviour: { invoke: async () => ({ content: "x" }) },
    });
    await t.send("hi");
    expect((await t.call("POST", `/conversations/${t.id}/messages`, { body: {} })).status).toBe(400);
    expect((await t.call("POST", `/conversations/conv_missing/messages`, { body: { message: "x" } })).status).toBe(404);
    expect(open).toBe(0);
  });

  it("tells the audit hook about the actions of a person, and survives a hook that fails", async () => {
    const entries: AuditEntry[] = [];
    const t = await boot({ config: { audit: (_ctx, entry) => void entries.push(entry) } });
    const sent = await t.send("hi");
    const answer = (sent.body as any).response.id as string;
    await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: true } });
    await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: true } });
    await t.call("PATCH", `/conversations/${t.id}`, { body: { pinned: false } });
    await t.call("POST", `/conversations/${t.id}/messages/${answer}/feedback`, { body: { rating: "down", reasons: ["other"] } });
    await t.call("POST", `/conversations/${t.id}/messages/${answer}/regenerate`);
    const user = (await t.messages())[0];
    await t.call("POST", `/conversations/${t.id}/messages/${user.id}/edit`, { body: { content: "changed" } });
    await t.call("DELETE", `/conversations/${t.id}`);
    await eventually(() => entries.some((e) => e.action === "message.edit"));
    expect(entries.map((e) => e.action)).toEqual([
      "conversation.pin",
      "conversation.unpin",
      "message.feedback",
      "message.regenerate",
      "message.edit",
      "conversation.delete",
    ]);
    expect(entries.every((e) => e.userId === t.user && e.conversationId === t.id && e.at instanceof Date)).toBe(true);
    expect(entries.find((e) => e.action === "message.feedback")).toMatchObject({ messageId: answer, details: { rating: "down", reasons: ["other"] } });

    const broken = await boot({ config: { audit: () => { throw new Error("siem down"); } } });
    const quietLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await broken.call("DELETE", `/conversations/${broken.id}`)).status).toBe(204);
    expect(quietLog).toHaveBeenCalled();
    quietLog.mockRestore();
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
    suite();
    describe("an agent that cannot be resolved", unresolvedAgentSuite);
    describe("client tools", clientToolSuite);
    describe("rate limits and audit", hooksSuite);
  });
}
