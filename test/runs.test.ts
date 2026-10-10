/**
 * Detached runs, cancellation, conversation leases, the event log and the reattach stream - over every
 * storage provider (memory, SQLite, MongoDB, PostgreSQL), and for a provider that has neither events
 * nor leases.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentServer } from "../src/index.js";
import type { AgentHandler, AgentServerConfig, StorageProvider } from "../src/index.js";
import { Follower, eventually, fakeSdkAgent, gate, parseSse } from "./helpers.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider } from "./storage/providers.js";

let active: { current: OpenedProvider } | undefined;
const currentStorage = (): StorageProvider => active!.current.storage;

const allow = { type: "tool_approval", decision: "allow" } as const;

// ----------------------------------------------------------------------------
// Agents
// ----------------------------------------------------------------------------

/** An agent-sdk-shaped agent that pauses on its first call and finishes after the decision. */
function pausingAgent(hooks: { beforePause?: (config: any) => Promise<void>; onResume?: (config: any) => Promise<void> } = {}) {
  const calls: any[] = [];
  return {
    calls,
    invoke: async (input: any, config?: any) => {
      calls.push({ input, config });
      const resolved = (input.pendingApprovals ?? []).find((a: any) => a.status === "approved" || a.status === "rejected");
      if (!resolved) {
        await hooks.beforePause?.(config);
        const state = {
          messages: [...(input.messages ?? []), { role: "assistant", content: "" }],
          pendingApprovals: [
            { id: "ap1", toolCallId: "call1", toolName: "deploy", args: { version: "1.0" }, status: "pending", requestedAt: new Date().toISOString(), metadata: { prompt: "Deploy 1.0?" } },
          ],
          pendingUserQuestions: [],
          ctx: { __awaitingApproval: { approvalId: "ap1" } },
        };
        return { content: "", messages: state.messages, metadata: {}, state };
      }
      await hooks.onResume?.(config);
      config?.onEvent?.({ type: "tool_call", phase: "start", name: "deploy", id: "call1", args: { version: "1.0" } });
      config?.onEvent?.({ type: "tool_call", phase: "success", name: "deploy", id: "call1", result: "ok" });
      return {
        content: "deployed",
        messages: [],
        metadata: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
        state: { messages: [], pendingApprovals: [], pendingUserQuestions: [] },
      };
    },
    resolveToolApproval: (state: any, r: any) => {
      const approvals = (state.pendingApprovals ?? []).map((a: any) => ({ ...a }));
      const entry = approvals.find((a: any) => a.id === r.id);
      if (!entry) throw new Error(`Pending approval not found for id: ${r.id}`);
      entry.status = r.approved ? "approved" : "rejected";
      const ctx = { ...(state.ctx ?? {}) };
      delete ctx.__awaitingApproval;
      return { ...state, pendingApprovals: approvals, ctx };
    },
    resolveUserQuestion: (state: any) => state,
  };
}

/** Waits for the abort signal the server passes as the SDK's cancellation token. */
const untilAborted = (config: any) =>
  new Promise<void>((resolve) => {
    const signal: AbortSignal = config.cancellationToken;
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** What the real SDK returns when it was cancelled. */
const cancelledResult = (content = "") => ({
  content,
  messages: [],
  metadata: {},
  state: { messages: [], ctx: { __cancelled: { stage: "tools", reason: "aborted" } } },
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------

async function boot(agent: unknown | { handler: AgentHandler }, config: Partial<AgentServerConfig> = {}, over?: StorageProvider) {
  const storage = over ?? currentStorage();
  const registration =
    agent && typeof agent === "object" && "handler" in (agent as object)
      ? { info: { id: "a", name: "A" }, handler: (agent as { handler: AgentHandler }).handler }
      : { info: { id: "a", name: "A" }, sdkAgent: agent };
  const server = createAgentServer({ basePath: "/api", storage, agents: [registration as any], ...config });
  const call = (method: string, path: string, extra: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}) =>
    server.handleRoute(method, path, { query: extra.query ?? {}, body: extra.body, headers: extra.headers });
  const id = ((await call("POST", "/conversations", { body: { agentId: "a" } })).body as any).conversation.id as string;

  const send = (message = "go", stream = false) => call("POST", `/conversations/${id}/messages`, { body: { message, stream } });
  const resolve = (actionId = "ap1", body: Record<string, unknown> = {}) =>
    call("POST", `/conversations/${id}/actions/${actionId}`, { body: { resolution: allow, ...body } });
  const cancel = () => call("POST", `/conversations/${id}/cancel`);
  const get = async () => (await call("GET", `/conversations/${id}`)).body as any;
  const runtime = async () => (await get()).conversation.runtime as any;
  const events = async (query: Record<string, string> = {}) => (await call("GET", `/conversations/${id}/events`, { query })).body as any;
  const follow = (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    new Follower(call("GET", `/conversations/${id}/events/stream`, { query, headers }) as any);
  /** Opens the follower once the route has answered. */
  const follower = async (query: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const res = await call("GET", `/conversations/${id}/events/stream`, { query, headers });
    return new Follower(res as any);
  };
  const types = async () => ((await events()).events as any[]).map((e) => e.type as string);
  const drain = async (res: Awaited<ReturnType<typeof send>>) => {
    let text = "";
    for await (const chunk of res.stream!) text += chunk;
    return parseSse(text);
  };
  return { server, storage, id, call, send, resolve, cancel, get, runtime, events, types, follow, follower, drain };
}

const types = (events: any[]) => events.map((e) => e.type as string);

// ----------------------------------------------------------------------------
// The suite
// ----------------------------------------------------------------------------

function runsSuite() {
  describe("the event log of a turn", () => {
    it("records a turn in the Console vocabulary, tied to its run", async () => {
      const agent = fakeSdkAgent(async (_p, config: any) => {
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "search", id: "c1", args: { q: "cats" } });
        await new Promise((r) => setTimeout(r, 5));
        config?.onEvent?.({ type: "tool_call", phase: "success", name: "search", id: "c1", result: "found" });
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "fetch", id: "c2", args: {} });
        config?.onEvent?.({ type: "tool_call", phase: "error", name: "fetch", id: "c2", error: { message: "boom" } });
        return { content: "all done", metadata: { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } } as any;
      });
      const t = await boot(agent);
      const res = await t.send("find cats");
      const body = res.body as any;
      expect(res.status).toBe(200);
      expect(body.runId).toMatch(/^run_/);
      expect(body.stopReason).toBe("end_turn");

      const log = (await t.events()).events as any[];
      expect(types(log)).toEqual([
        "user.message",
        "session.status_running",
        "agent.tool_use",
        "agent.tool_result",
        "agent.tool_use",
        "agent.tool_result",
        "agent.message",
        "session.usage",
        "session.status_idle",
        "session.work_done",
      ]);
      expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(log[0].data).toMatchObject({ content: "find cats", message_id: body.message.id });
      expect(log[1].data).toEqual({ trigger: "message" });
      expect(log[2].data).toEqual({ tool_call_id: "c1", name: "search", args: { q: "cats" } });
      expect(log[3].data).toMatchObject({ tool_call_id: "c1", name: "search", ok: true });
      expect(typeof log[3].data.duration_ms).toBe("number");
      expect(log[5].data).toMatchObject({ tool_call_id: "c2", ok: false, error: "boom" });
      expect(log[6].data).toMatchObject({ content: "all done", message_id: body.response.id, stop_reason: "end_turn" });
      expect(log[7].data).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
      expect(log[8].data).toEqual({ stop_reason: "end_turn" });
      for (const e of log) {
        expect(e.run_id).toBe(body.runId);
        expect(new Date(e.created_at).toString()).not.toBe("Invalid Date");
      }
    });

    it("pages with after / limit / types, and refuses a bad cursor", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "hi" })));
      await t.send("one");
      await t.send("two");
      const all = (await t.events()).events as any[];
      expect(all).toHaveLength(10);

      const first = await t.events({ limit: "4" });
      expect(first).toMatchObject({ hasMore: true, lastSeq: 4 });
      const second = await t.events({ after: String(first.lastSeq), limit: "4" });
      expect(second.events.map((e: any) => e.seq)).toEqual([5, 6, 7, 8]);
      const rest = await t.events({ after: "8", limit: "100" });
      expect(rest).toMatchObject({ hasMore: false, lastSeq: 10 });
      expect((await t.events({ after: "10" }))).toMatchObject({ events: [], hasMore: false, lastSeq: 10 });

      const messages = await t.events({ types: "agent.message,user.message" });
      expect(types(messages.events)).toEqual(["user.message", "agent.message", "user.message", "agent.message"]);
      expect((await t.call("GET", `/conversations/${t.id}/events`, { query: { after: "x" } })).status).toBe(400);
      expect((await t.call("GET", `/conversations/${t.id}/events`, { query: { after: "-1" } })).status).toBe(400);
      expect((await t.call("GET", "/conversations/nope/events")).status).toBe(404);
      expect((await t.call("GET", "/conversations/nope/events/stream")).status).toBe(404);
    });

    it("caps the page size at the configured maximum", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "hi" })), { runs: { eventPageSize: 3, maxEventPageSize: 4 } });
      await t.send("one");
      expect((await t.events()).events).toHaveLength(3);
      expect((await t.events({ limit: "100" })).events).toHaveLength(4);
    });

    it("cuts an event larger than the cap and says so", async () => {
      const big = "x".repeat(5000);
      const t = await boot(fakeSdkAgent(async () => ({ content: big })), { runs: { maxEventDataBytes: 600 } });
      await t.send("hi");
      const message = ((await t.events({ types: "agent.message" })).events as any[])[0];
      expect(message.data._truncated).toBe(true);
      expect(JSON.stringify(message.data).length).toBeLessThan(700);
      expect(message.data.message_id).toBeDefined();
      // the stored message is whole
      const stored = (await t.get()).messages.at(-1);
      expect(stored.content).toBe(big);
    });

    it("records a pause, its resolution and the continuation", async () => {
      const t = await boot(pausingAgent());
      await t.send("deploy");
      let log = (await t.events()).events as any[];
      expect(types(log)).toEqual([
        "user.message",
        "session.status_running",
        "action.required",
        "session.status_idle",
      ]);
      expect(log[2].data).toMatchObject({ action_id: "ap1", kind: "tool_approval", tool_name: "deploy", args: { version: "1.0" }, tool_call_id: "call1" });
      expect(log[3].data).toEqual({ stop_reason: "requires_action", pending_action_ids: ["ap1"] });

      const res = await t.resolve("ap1", { resolution: { ...allow, comment: "ok" } });
      expect(res.status).toBe(200);
      log = ((await t.events({ after: "4" })).events as any[]);
      expect(types(log)).toEqual([
        "action.resolved",
        "session.status_running",
        "agent.tool_use",
        "agent.tool_result",
        "agent.message",
        "session.usage",
        "session.status_idle",
        "session.work_done",
      ]);
      expect(log[0].data).toEqual({ action_id: "ap1", kind: "tool_approval", decision: "allow", status: "approved", resolved_by: "anonymous", channel: "api" });
      expect(log[1].data).toEqual({ trigger: "resume" });
      expect(log.at(-2)!.data).toEqual({ stop_reason: "end_turn" });
    });

    it("records who resolved an action", async () => {
      const t = await boot(pausingAgent(), { resolveContext: (req: any) => ({ user: { id: String(req.headers["x-user"]) }, data: {} }) });
      const as = { "x-user": "alice" };
      const created = (await t.call("POST", "/conversations", { body: { agentId: "a" }, headers: as })).body as any;
      const id = created.conversation.id;
      await t.call("POST", `/conversations/${id}/messages`, { body: { message: "go" }, headers: as });
      await t.call("POST", `/conversations/${id}/actions/ap1`, { body: { resolution: { type: "tool_approval", decision: "deny" } }, headers: as });
      const log = ((await t.call("GET", `/conversations/${id}/events`, { headers: as })).body as any).events as any[];
      expect(log.find((e) => e.type === "action.resolved").data).toMatchObject({ decision: "deny", status: "rejected", resolved_by: "alice" });
    });

    it("records a failed turn as session.error and an idle with stop reason error", async () => {
      const t = await boot(fakeSdkAgent(async () => {
        throw new Error("model exploded");
      }));
      const res = await t.send("hi");
      expect(res.status).toBe(500);
      const log = (await t.events()).events as any[];
      expect(types(log)).toEqual(["user.message", "session.status_running", "session.error", "session.status_idle"]);
      expect(log[2].data).toMatchObject({ message: "model exploded" });
      expect(log[3].data).toMatchObject({ stop_reason: "error" });
      const runtime = await t.runtime();
      expect(runtime).toMatchObject({ status: "idle", stopReason: "error" });
      // the conversation is usable again
      expect((await t.send("again")).status).toBe(500);
    });

    it("does not break a turn when the log cannot be written", async () => {
      const inner = currentStorage();
      const broken = new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "events") {
            const events = target.events!;
            return { ...events, append: async () => { throw new Error("log is down"); }, list: events.list.bind(events), summary: events.summary?.bind(events) };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as StorageProvider;
      const errors: unknown[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args);
      try {
        const t = await boot(fakeSdkAgent(async () => ({ content: "still answered" })), {}, broken);
        const res = await t.send("hi");
        expect(res.status).toBe(200);
        expect((res.body as any).response.content).toBe("still answered");
        expect(errors.length).toBeGreaterThan(0);
      } finally {
        console.error = original;
      }
    });
  });

  describe("what the legacy stream carries", () => {
    it("gives every stream.* frame the event-log cursor as seq", async () => {
      const agent = fakeSdkAgent(async (_p, config: any) => {
        config?.onStream?.({ text: "Hel" });
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "t", id: "c1", args: {} });
        config?.onEvent?.({ type: "tool_call", phase: "success", name: "t", id: "c1", result: 1 });
        config?.onStream?.({ text: "lo" });
        return { content: "Hello" };
      });
      const t = await boot(agent);
      const events = await t.drain(await t.send("hi", true));
      expect(events.map((e) => e.type)).toEqual([
        "stream.start",
        "stream.text",
        "stream.tool_call",
        "stream.tool_result",
        "stream.text",
        "stream.done",
      ]);
      const seqs = events.map((e) => e.seq as number);
      expect(seqs.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
      // never goes backwards, and the final frame is the end of the log
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      const log = (await t.events()).events as any[];
      expect(events.at(-1)!.seq).toBe(log.at(-1).seq);
      expect(events.find((e) => e.type === "stream.tool_call")!.seq).toBe(log.find((e) => e.type === "agent.tool_use").seq);
      expect(events.at(-1)).toMatchObject({ stopReason: "end_turn", runId: log[0].run_id });
    });

    it("tells followers about the model's text as deltas that are not stored", async () => {
      const connected = gate();
      const proceed = gate();
      const agent = fakeSdkAgent(async (_p, config: any) => {
        await connected.promise; // chunks are not replayed: speak once somebody listens
        config?.onStream?.({ text: "one " });
        await proceed.promise;
        config?.onStream?.({ text: "two" });
        return { content: "one two" };
      });
      const t = await boot(agent);
      const res = await t.send("hi", true);
      const mine = new Follower(res as any);
      const watcher = await t.follower();
      connected.open();
      await watcher.until((f) => f.frames.some((x) => x.event === "agent.message.delta"));
      proceed.open();
      await watcher.until((f) => f.types.includes("session.work_done"));
      const deltas = watcher.frames.filter((f) => f.event === "agent.message.delta");
      expect(deltas.map((d) => d.data.text)).toEqual(["one ", "two"]);
      expect(deltas.every((d) => d.id === undefined)).toBe(true);
      expect(types((await t.events()).events)).not.toContain("agent.message.delta");
      await mine.until((f) => f.ended);
      watcher.close();
    });
  });

  describe("what a streamed request that cannot start answers (unchanged)", () => {
    it("is a stream carrying stream.error for a conversation or agent that is not there, or not yours", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "x" })), {
        resolveContext: (req: any) => ({ user: { id: String(req.headers["x-user"]) }, data: {} }),
      });
      const as = (u: string) => ({ "x-user": u });
      const id = ((await t.call("POST", "/conversations", { body: { agentId: "a" }, headers: as("alice") })).body as any).conversation.id;
      const read = async (path: string, user: string) => {
        const res = await t.call("POST", path, { body: { message: "hi", stream: true }, headers: as(user) });
        expect(res.status).toBe(200);
        let text = "";
        for await (const chunk of res.stream!) text += chunk;
        return parseSse(text);
      };
      expect(await read("/conversations/nope/messages", "alice")).toEqual([expect.objectContaining({ type: "stream.error", code: "NOT_FOUND" })]);
      expect(await read(`/conversations/${id}/messages`, "mallory")).toEqual([expect.objectContaining({ type: "stream.error", code: "FORBIDDEN" })]);
    });
  });

  describe("runtime and message status", () => {
    it("reports idle, running, requires_action and the last stop reason on GET and in the list", async () => {
      const proceed = gate();
      const started = gate();
      let calls = 0;
      const agent = fakeSdkAgent(async () => {
        if (++calls === 2) {
          started.open();
          await proceed.promise;
        }
        return { content: "ok" };
      });
      const t = await boot(agent);
      expect(await t.runtime()).toEqual({ status: "idle", lastEventSeq: 0, pendingActionIds: [] });

      await t.send("one");
      expect(await t.runtime()).toEqual({ status: "idle", stopReason: "end_turn", lastEventSeq: 5, pendingActionIds: [] });

      const second = t.send("two");
      await started.promise;
      const running = await t.runtime();
      expect(running).toMatchObject({ status: "running" });
      expect(running.activeRunId).toMatch(/^run_/);
      expect(running.stopReason).toBeUndefined();
      const listed = ((await t.call("GET", "/conversations", { query: { limit: "200" } })).body as any).conversations.find((c: any) => c.id === t.id);
      expect(listed.runtime).toMatchObject({ status: "running", activeRunId: running.activeRunId });
      proceed.open();
      expect(((await second).body as any).runId).toBe(running.activeRunId);
      expect(await t.runtime()).toMatchObject({ status: "idle", stopReason: "end_turn" });

      const paused = await boot(pausingAgent());
      await paused.send("deploy");
      expect(await paused.runtime()).toEqual({ status: "requires_action", stopReason: "requires_action", lastEventSeq: 4, pendingActionIds: ["ap1"] });
      const pausedListed = ((await paused.call("GET", "/conversations", { query: { limit: "200" } })).body as any).conversations.find((c: any) => c.id === paused.id);
      expect(pausedListed.runtime).toMatchObject({ status: "requires_action", pendingActionIds: ["ap1"] });
    });

    it("marks assistant messages with their status and stop reason", async () => {
      const t = await boot(pausingAgent());
      const paused = (await t.send("deploy")).body as any;
      expect(paused.response).toMatchObject({ status: "requires_action", metadata: { status: "requires_action", stopReason: "requires_action", requiresAction: true } });
      const done = (await t.resolve()).body as any;
      expect(done.response).toMatchObject({ status: "completed", metadata: { status: "completed", stopReason: "end_turn" } });

      const messages = (await t.get()).messages as any[];
      expect(messages.map((m) => m.status)).toEqual([undefined, "requires_action", "completed"]);
      const listed = ((await t.call("GET", `/conversations/${t.id}/messages`)).body as any).messages as any[];
      expect(listed.map((m) => m.status)).toEqual([undefined, "requires_action", "completed"]);
    });
  });

  describe("a turn runs detached from the connection that started it", () => {
    it("goes on after the client of a streamed message disconnects, and stores the answer", async () => {
      const proceed = gate();
      const agent = fakeSdkAgent(async (_p, config: any) => {
        config?.onStream?.({ text: "thinking " });
        await proceed.promise;
        config?.onStream?.({ text: "done" });
        return { content: "thinking done" };
      });
      const t = await boot(agent);
      const res = await t.send("hi", true);
      const first = await res.stream!.next();
      expect(first.value).toContain("stream.start");
      // the connection goes away mid-turn
      res.close!();
      await res.stream!.return(undefined);

      expect((await t.runtime()).status).toBe("running");
      proceed.open();
      await eventually(async () => (await t.runtime()).status === "idle", 4000, "the turn to finish");

      const messages = (await t.get()).messages as any[];
      expect(messages.map((m) => [m.role, m.content])).toEqual([["user", "hi"], ["assistant", "thinking done"]]);
      expect(types((await t.events()).events).at(-1)).toBe("session.work_done");
    });

    it("stores the pause (message and pending action) when the client disconnects before the agent pauses", async () => {
      const proceed = gate();
      const agent = pausingAgent({
        beforePause: async (config) => {
          config?.onStream?.({ text: "checking... " });
          await proceed.promise;
        },
      });
      const t = await boot(agent);
      const res = await t.send("deploy", true);
      await res.stream!.next(); // stream.start
      res.close!();
      await res.stream!.return(undefined);

      proceed.open();
      await eventually(async () => (await t.runtime()).status === "requires_action", 4000, "the pause");
      const conv = await t.get();
      expect(conv.pendingActions).toEqual([expect.objectContaining({ id: "ap1", toolName: "deploy" })]);
      expect(conv.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
      expect(conv.messages[1].metadata).toMatchObject({ requiresAction: true });
      expect(types((await t.events()).events)).toContain("action.required");
      // ...and a new connection can answer it
      expect((await t.resolve()).status).toBe(200);
    });

    it("finishes a resolve whose client disconnected", async () => {
      const proceed = gate();
      const t = await boot(pausingAgent({ onResume: () => proceed.promise }));
      await t.send("deploy");
      const res = await t.resolve("ap1", { stream: true });
      await res.stream!.next();
      res.close!();
      await res.stream!.return(undefined);
      proceed.open();
      await eventually(async () => (await t.runtime()).status === "idle", 4000, "the continuation");
      const messages = (await t.get()).messages as any[];
      expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "deployed" });
      expect((await t.get()).pendingActions).toBeUndefined();
    });

    it("keeps the request context available inside a detached agent", async () => {
      const { getRequestContext } = await import("../src/index.js");
      let ambient: unknown;
      const agent = fakeSdkAgent(async () => {
        await new Promise((r) => setTimeout(r, 5));
        ambient = getRequestContext()?.data;
        return { content: "x" };
      });
      const t = await boot(agent, { resolveContext: () => ({ user: { id: "u" }, data: { tenant: "t9" } }) });
      await t.send("hi");
      expect(ambient).toEqual({ tenant: "t9" });
    });
  });

  describe("one turn at a time per conversation", () => {
    it("answers 409 conversation_busy to a second message, streamed or not, naming the running run", async () => {
      const proceed = gate();
      const started = gate();
      const t = await boot(fakeSdkAgent(async () => {
        started.open();
        await proceed.promise;
        return { content: "ok" };
      }));
      const first = t.send("one");
      await started.promise;
      const runId = (await t.runtime()).activeRunId;

      const second = await t.send("two");
      expect(second.status).toBe(409);
      expect((second.body as any).error).toMatchObject({ code: "conversation_busy", details: { activeRunId: runId } });
      const streamed = await t.send("three", true);
      expect(streamed.status).toBe(409);
      expect(streamed.stream).toBeUndefined();

      proceed.open();
      expect((await first).status).toBe(200);
      // nothing was stored for the refused ones, and the conversation is free again
      expect(((await t.get()).messages as any[]).map((m) => m.content)).toEqual(["one", "ok"]);
      expect((await t.send("four")).status).toBe(200);
    });

    it("lets exactly one of several simultaneous messages through", async () => {
      const t = await boot(fakeSdkAgent(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { content: "ok" };
      }));
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => t.send(`m${i}`)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(((await t.get()).messages as any[]).filter((m) => m.role === "user")).toHaveLength(1);
    });

    it("refuses a second answer to the same pause while the first runs, and a message during a resolve", async () => {
      const proceed = gate();
      const t = await boot(pausingAgent({ onResume: () => proceed.promise }));
      await t.send("deploy");
      const first = t.resolve();
      await eventually(async () => (await t.runtime()).status === "running", 4000, "the resolve to run");
      const again = await t.resolve();
      expect(again.status).toBe(409);
      expect((again.body as any).error.code).toBe("conversation_busy");
      expect((await t.send("hello")).status).toBe(409);
      proceed.open();
      expect((await first).status).toBe(200);
      // now the action is gone
      expect((await t.resolve()).status).toBe(409);
      expect(((await t.resolve()).body as any).error.code).toBe("action_not_pending");
    });

    it("holds across servers sharing a store: the second node is refused until the first is done", async () => {
      const proceed = gate();
      const started = gate();
      const a = await boot(fakeSdkAgent(async () => {
        started.open();
        await proceed.promise;
        return { content: "from a" };
      }), { runs: { nodeId: "node-a" } });
      const bServer = createAgentServer({
        basePath: "/api",
        storage: a.storage,
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "from b" })) }],
        runs: { nodeId: "node-b" },
      });
      const sendOnB = () => bServer.handleRoute("POST", `/conversations/${a.id}/messages`, { query: {}, body: { message: "hi from b" } });

      const first = a.send("hi from a");
      await started.promise;
      const refused = await sendOnB();
      expect(refused.status).toBe(409);
      expect((refused.body as any).error.code).toBe("conversation_busy");
      // node B sees the conversation as running too
      const seen = ((await bServer.handleRoute("GET", `/conversations/${a.id}`, { query: {} })).body as any).conversation.runtime;
      expect(seen).toMatchObject({ status: "running", activeRunId: (await a.runtime()).activeRunId });

      proceed.open();
      await first;
      expect((await sendOnB()).status).toBe(200);
    });
  });

  describe("cancelling", () => {
    it("stops a turn in the middle of a tool: the agent sees the signal, the message is stored as cancelled", async () => {
      let sawSignal: AbortSignal | undefined;
      const inTool = gate();
      let calls = 0;
      const agent = fakeSdkAgent(async (_p, config: any) => {
        if (++calls > 1) return { content: "fine now" };
        sawSignal = config.cancellationToken;
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "slow_tool", id: "c1", args: {} });
        inTool.open();
        await untilAborted(config);
        return cancelledResult() as any;
      });
      const t = await boot(agent);
      const sending = t.send("do the slow thing");
      await inTool.promise;

      const cancelled = await t.cancel();
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ cancelled: true, settled: true, stopReason: "cancelled", runtime: { status: "idle", stopReason: "cancelled" } });
      expect(sawSignal!.aborted).toBe(true);

      const sent = await sending;
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({ status: "cancelled", stopReason: "cancelled", response: { status: "cancelled", metadata: { status: "cancelled", stopReason: "cancelled" } } });

      const log = (await t.events()).events as any[];
      expect(types(log)).toEqual(["user.message", "session.status_running", "agent.tool_use", "session.status_idle"]);
      expect(log.at(-1).data).toEqual({ stop_reason: "cancelled" });
      expect(types(log)).not.toContain("session.work_done");

      // the conversation works again
      expect((await t.send("again")).status).toBe(200);
    });

    it("keeps the text streamed before the cancellation", async () => {
      const streamed = gate();
      const agent = fakeSdkAgent(async (_p, config: any) => {
        config?.onStream?.({ text: "I was saying " });
        streamed.open();
        await untilAborted(config);
        return cancelledResult("") as any;
      });
      const t = await boot(agent);
      const res = await t.send("talk", true);
      const mine = new Follower(res as any);
      await streamed.promise;
      await mine.until((f) => f.frames.some((x) => x.data?.type === "stream.text"));
      await t.cancel();
      await mine.until((f) => f.ended);
      const done = mine.frames.map((f) => f.data).filter(Boolean).find((d: any) => d.type === "stream.done");
      expect(done).toMatchObject({ status: "cancelled", stopReason: "cancelled", content: "I was saying " });
      expect(((await t.get()).messages as any[]).at(-1)).toMatchObject({ role: "assistant", content: "I was saying ", status: "cancelled" });
      expect(types((await t.events()).events)).toContain("agent.message");
    });

    it("does not hand the empty cancelled message to the model on the next turn", async () => {
      const seen: any[] = [];
      let calls = 0;
      const first = gate();
      const agent = fakeSdkAgent(async (p, config: any) => {
        seen.push(p.messages);
        if (++calls === 1) {
          first.open();
          await untilAborted(config);
          return cancelledResult() as any;
        }
        return { content: "fine" };
      });
      const t = await boot(agent);
      const sending = t.send("first");
      await first.promise;
      await t.cancel();
      await sending;
      await t.send("second");
      expect(seen[1].map((m: any) => `${m.role}:${m.content}`)).toEqual(["user:first", "user:second"]);
    });

    it("abandons an agent that ignores the signal once the grace period is over", async () => {
      const never = gate();
      const started = gate();
      const t = await boot(fakeSdkAgent(async () => {
        started.open();
        await never.promise; // never settles
        return { content: "too late" };
      }), { runs: { cancelGraceMs: 40 } });
      const sending = t.send("hi");
      await started.promise;
      const cancelled = await t.cancel();
      expect(cancelled.body).toMatchObject({ cancelled: true, settled: true });
      expect(((await sending).body as any).status).toBe("cancelled");
      expect((await t.runtime()).status).toBe("idle");
      // whatever the abandoned agent does later changes nothing
      never.open();
      await new Promise((r) => setTimeout(r, 30));
      expect(((await t.get()).messages as any[]).map((m) => m.content)).toEqual(["hi", ""]);
    });

    it("hands a custom handler the signal, and stops waiting for one that ignores it", async () => {
      let seen: AbortSignal | undefined;
      const started = gate();
      const handler: AgentHandler = {
        async processMessage(params) {
          seen = params.signal;
          started.open();
          await new Promise<void>((resolve) => params.signal!.addEventListener("abort", () => resolve(), { once: true }));
          return { content: "stopped by hand" };
        },
      };
      const t = await boot({ handler });
      const sending = t.send("go");
      await started.promise;
      await t.cancel();
      const sent = (await sending).body as any;
      expect(seen!.aborted).toBe(true);
      // the handler returned what it had: kept as the (cancelled) answer
      expect(sent).toMatchObject({ stopReason: "cancelled", response: { content: "stopped by hand" } });

      const stubborn = await boot({
        handler: {
          processMessage: () => new Promise(() => undefined),
        } as AgentHandler,
      }, { runs: { cancelGraceMs: 30 } });
      const stuck = stubborn.send("go");
      await eventually(async () => (await stubborn.runtime()).status === "running", 4000, "the run");
      await stubborn.cancel();
      expect(((await stuck).body as any).stopReason).toBe("cancelled");
    });

    it("reports an agent that stopped at one of its limits as stopReason limit (status incomplete)", async () => {
      const agent = fakeSdkAgent(async () => ({
        content: "got as far as I could",
        messages: [],
        metadata: {},
        state: { messages: [], ctx: { __limitBreached: "maxTotalOutputTokens (100) exceeded" } },
      }) as any);
      const t = await boot(agent);
      const res = (await t.send("go")).body as any;
      expect(res).toMatchObject({ status: "incomplete", stopReason: "limit", response: { status: "incomplete", metadata: { stopReason: "limit" } } });
      const idle = ((await t.events({ types: "session.status_idle" })).events as any[])[0];
      expect(idle.data).toEqual({ stop_reason: "limit", detail: "maxTotalOutputTokens (100) exceeded" });
      expect(types((await t.events()).events)).not.toContain("session.work_done");
      expect(await t.runtime()).toMatchObject({ status: "idle", stopReason: "limit" });
    });

    it("lets a handler report max_turns itself", async () => {
      const handler: AgentHandler = { processMessage: async () => ({ content: "ran out of turns", stopReason: "max_turns", status: "incomplete" }) };
      const t = await boot({ handler });
      const res = (await t.send("go")).body as any;
      expect(res).toMatchObject({ status: "incomplete", stopReason: "max_turns" });
      expect(await t.runtime()).toMatchObject({ stopReason: "max_turns" });
    });

    it("ends a streamed turn with stream.done status cancelled", async () => {
      const started = gate();
      const t = await boot(fakeSdkAgent(async (_p, config: any) => {
        started.open();
        await untilAborted(config);
        return cancelledResult() as any;
      }));
      const res = await t.send("hi", true);
      const mine = new Follower(res as any);
      await started.promise;
      await t.cancel();
      await mine.until((f) => f.ended);
      const frames = mine.frames.map((f) => f.data).filter(Boolean);
      expect(frames.map((f: any) => f.type)).toEqual(["stream.start", "stream.done"]);
      expect(frames.at(-1)).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
    });

    it("cancels the actions of a paused turn: they are resolved as cancelled and the turn is over", async () => {
      const t = await boot(pausingAgent());
      await t.send("deploy");
      expect((await t.get()).pendingActions).toHaveLength(1);

      const cancelled = await t.cancel();
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({
        cancelled: true,
        settled: true,
        cancelledActionIds: ["ap1"],
        stopReason: "cancelled",
        runtime: { status: "idle", stopReason: "cancelled", pendingActionIds: [] },
      });
      const log = ((await t.events({ after: "4" })).events as any[]);
      expect(types(log)).toEqual(["action.resolved", "session.status_idle"]);
      expect(log[0].data).toMatchObject({ action_id: "ap1", kind: "tool_approval", cancelled: true, status: "cancelled" });
      expect(log[1].data).toEqual({ stop_reason: "cancelled" });

      expect((await t.get()).pendingActions).toBeUndefined();
      expect((await t.resolve()).status).toBe(409);
      expect((await t.send("moving on")).status).toBe(200);
    });

    it("has nothing to do for an idle conversation, and 404s for an unknown one", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
      await t.send("hi");
      const idle = await t.cancel();
      expect(idle.status).toBe(200);
      expect(idle.body).toMatchObject({ cancelled: false, settled: true, runtime: { status: "idle", stopReason: "end_turn" } });
      expect((await t.call("POST", "/conversations/nope/cancel")).status).toBe(404);
    });

    it("answers 403 to somebody else's conversation", async () => {
      const started = gate();
      const t = await boot(fakeSdkAgent(async (_p, config: any) => {
        started.open();
        await untilAborted(config);
        return cancelledResult() as any;
      }), { resolveContext: (req: any) => ({ user: { id: String(req.headers["x-user"]) }, data: {} }) });
      const as = (u: string) => ({ "x-user": u });
      const id = ((await t.call("POST", "/conversations", { body: { agentId: "a" }, headers: as("alice") })).body as any).conversation.id;
      const sending = t.call("POST", `/conversations/${id}/messages`, { body: { message: "hi" }, headers: as("alice") });
      await started.promise;
      expect((await t.call("POST", `/conversations/${id}/cancel`, { headers: as("mallory") })).status).toBe(403);
      expect((await t.call("GET", `/conversations/${id}/events`, { headers: as("mallory") })).status).toBe(403);
      expect((await t.call("GET", `/conversations/${id}/events/stream`, { headers: as("mallory") })).status).toBe(403);
      expect((await t.call("POST", `/conversations/${id}/cancel`, { headers: as("alice") })).status).toBe(200);
      await sending;
    });

    it("stops a running turn when its conversation is deleted", async () => {
      const started = gate();
      const t = await boot(fakeSdkAgent(async (_p, config: any) => {
        started.open();
        await untilAborted(config);
        return cancelledResult() as any;
      }));
      const sending = t.send("hi");
      await started.promise;
      const deleted = await t.call("DELETE", `/conversations/${t.id}`);
      expect(deleted.status).toBe(204);
      await sending;
      expect((await t.call("GET", `/conversations/${t.id}`)).status).toBe(404);
      // its log went with it
      expect((await t.storage.events?.list(t.id))?.events ?? []).toEqual([]);
    });

    it("reaches a turn that runs on another node through its lease", async () => {
      const started = gate();
      const a = await boot(fakeSdkAgent(async (_p, config: any) => {
        started.open();
        await untilAborted(config);
        return cancelledResult() as any;
      }), { runs: { nodeId: "node-a", leaseTtlMs: 600 } });
      const bServer = createAgentServer({
        basePath: "/api",
        storage: a.storage,
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "b" })) }],
        runs: { nodeId: "node-b", leaseTtlMs: 600 },
      });
      const sending = a.send("hi");
      await started.promise;

      const cancelled = await bServer.handleRoute("POST", `/conversations/${a.id}/cancel`, { query: {} });
      // not settled: the run is on the other node and stops at its next lease renewal
      expect(cancelled.status).toBe(202);
      expect(cancelled.body).toMatchObject({ cancelled: true, settled: false });
      expect(((await sending).body as any).stopReason).toBe("cancelled");
      expect((await a.runtime()).status).toBe("idle");
    });
  });

  describe("following a conversation", () => {
    it("replays the stored events, then follows a running turn: ids ascend one by one, nothing twice", async () => {
      const proceed = gate();
      const midway = gate();
      const t = await boot(fakeSdkAgent(async (_p, config: any) => {
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "t", id: "c1", args: {} });
        config?.onEvent?.({ type: "tool_call", phase: "success", name: "t", id: "c1", result: 1 });
        midway.open();
        await proceed.promise;
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "t", id: "c2", args: {} });
        config?.onEvent?.({ type: "tool_call", phase: "success", name: "t", id: "c2", result: 2 });
        return { content: "finished" };
      }));
      const sending = t.send("go");
      await midway.promise;
      // connect in the middle of the turn
      const watcher = await t.follower();
      await watcher.until((f) => f.types.includes("agent.tool_result"));
      expect(watcher.frames[0]).toEqual({ comment: "open" });
      proceed.open();
      await watcher.until((f) => f.types.includes("session.work_done"));
      await sending;

      const ids = watcher.frames.filter((f) => f.id !== undefined).map((f) => f.id!);
      expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
      expect(watcher.types).toEqual([
        "user.message",
        "session.status_running",
        "agent.tool_use",
        "agent.tool_result",
        "agent.tool_use",
        "agent.tool_result",
        "agent.message",
        "session.status_idle",
        "session.work_done",
      ]);
      // every frame is `id`, `event` and the same JSON the event list returns
      const stored = (await t.events()).events as any[];
      expect(watcher.events).toEqual(stored);
      for (const frame of watcher.frames.filter((f) => f.id !== undefined)) {
        expect(frame.event).toBe(frame.data.type);
        expect(frame.id).toBe(frame.data.seq);
      }
      watcher.close();
      await watcher.until((f) => f.ended);
    });

    it("starts after ?after= and after the Last-Event-ID header, which wins", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "hi" })));
      await t.send("one");
      const byQuery = await t.follower({ after: "3" });
      await byQuery.until((f) => f.types.length === 2);
      expect(byQuery.events.map((e) => e.seq)).toEqual([4, 5]);
      byQuery.close();

      const byHeader = await t.follower({ after: "4" }, { "Last-Event-ID": "2" });
      await byHeader.until((f) => f.types.length === 3);
      expect(byHeader.events.map((e) => e.seq)).toEqual([3, 4, 5]);
      byHeader.close();

      // a header that is not a number is ignored
      const bad = await t.follower({ after: "3" }, { "last-event-id": "abc" });
      await bad.until((f) => f.types.length === 2);
      expect(bad.events.map((e) => e.seq)).toEqual([4, 5]);
      bad.close();
      expect((await t.call("GET", `/conversations/${t.id}/events/stream`, { query: { after: "nope" } })).status).toBe(400);
    });

    it("resumes a dropped connection without losing or repeating anything", async () => {
      const gates = [gate(), gate()];
      let call = 0;
      const t = await boot(fakeSdkAgent(async (_p, config: any) => {
        const turn = call++;
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "t", id: `a${turn}`, args: {} });
        config?.onEvent?.({ type: "tool_call", phase: "success", name: "t", id: `a${turn}`, result: 1 });
        await gates[turn]!.promise;
        return { content: `answer ${turn}` };
      }));
      const sending = t.send("go");
      const first = await t.follower();
      await first.until((f) => f.types.includes("agent.tool_result"));
      const lastSeen = first.frames.filter((f) => f.id !== undefined).at(-1)!.id!;
      first.close();
      await first.until((f) => f.ended);

      gates[0]!.open();
      await sending;
      // reconnect from the last id it saw
      const second = await t.follower({}, { "Last-Event-ID": String(lastSeen) });
      await second.until((f) => f.types.includes("session.work_done"));
      const all = [...first.events, ...second.events];
      expect(all.map((e) => e.seq)).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
      expect(types(all)).toEqual(types((await t.events()).events));
      second.close();
    });

    it("pings when nothing happens, and stays open for the next turn", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "hi" })), { runs: { pingIntervalMs: 30, followPollMs: 20 } });
      const watcher = await t.follower();
      await watcher.until((f) => f.frames.filter((x) => x.comment === "ping").length >= 2);
      await t.send("first turn, after it connected");
      await watcher.until((f) => f.types.includes("session.work_done"));
      await t.send("second turn");
      await watcher.until((f) => f.types.filter((x) => x === "session.work_done").length === 2);
      watcher.close();
    });

    it("filters by type, and sends deltas only if they were asked for", async () => {
      const t = await boot(fakeSdkAgent(async (_p, config: any) => {
        config?.onStream?.({ text: "x" });
        return { content: "x" };
      }));
      const watcher = await t.follower({ types: "agent.message" });
      await t.send("hi", true).then((res) => new Follower(res as any).until((f) => f.ended));
      await watcher.until((f) => f.types.length === 1);
      await new Promise((r) => setTimeout(r, 30));
      expect(watcher.types).toEqual(["agent.message"]);
      expect(watcher.frames.some((f) => f.event === "agent.message.delta")).toBe(false);
      watcher.close();

      const withDeltas = await t.follower({ types: "agent.message.delta,agent.message", after: "0" });
      await withDeltas.until((f) => f.types.length === 1);
      withDeltas.close();
    });

    it("sends what is stored while it replays, exactly once", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "hi" })));
      await t.send("one");
      // the replay reads the log; an event lands in it while that read is in flight
      const inner = t.storage.events!;
      let delayed = false;
      const racing = new Proxy(t.storage, {
        get(target, prop, receiver) {
          if (prop === "events") {
            return {
              ...inner,
              append: inner.append.bind(inner),
              summary: inner.summary?.bind(inner),
              list: async (...args: Parameters<typeof inner.list>) => {
                const page = await inner.list(...args);
                if (!delayed) {
                  delayed = true;
                  // after the first replay read, but before the follower looks again
                  await racingServer.handleRoute("POST", `/conversations/${t.id}/messages`, { query: {}, body: { message: "two" } });
                }
                return page;
              },
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as StorageProvider;
      const racingServer = createAgentServer({
        basePath: "/api",
        storage: racing,
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "again" })) }],
      });
      const res = await racingServer.handleRoute("GET", `/conversations/${t.id}/events/stream`, { query: {} });
      const watcher = new Follower(res as any);
      await watcher.until((f) => f.types.filter((x) => x === "session.work_done").length === 2);
      expect(watcher.events.map((e) => e.seq)).toEqual(Array.from({ length: watcher.events.length }, (_, i) => i + 1));
      expect(watcher.types.filter((x) => x === "user.message")).toHaveLength(2);
      watcher.close();
    });

    it("follows a turn that runs on another node by reading the log", async () => {
      const proceed = gate();
      const started = gate();
      const a = await boot(fakeSdkAgent(async (_p, config: any) => {
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "t", id: "c1", args: {} });
        started.open();
        await proceed.promise;
        return { content: "from a" };
      }), { runs: { nodeId: "node-a" } });
      const bServer = createAgentServer({
        basePath: "/api",
        storage: a.storage,
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "b" })) }],
        runs: { nodeId: "node-b", followPollMs: 20 },
      });
      const sending = a.send("hi");
      await started.promise;
      const res = await bServer.handleRoute("GET", `/conversations/${a.id}/events/stream`, { query: {} });
      const watcher = new Follower(res as any);
      await watcher.until((f) => f.types.includes("agent.tool_use"));
      proceed.open();
      await sending;
      await watcher.until((f) => f.types.includes("session.work_done"));
      expect(watcher.events.map((e) => e.seq)).toEqual(Array.from({ length: watcher.events.length }, (_, i) => i + 1));
      watcher.close();
    });

    it("ends when the client closes and when the conversation is deleted", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "hi" })));
      const one = await t.follower();
      const two = await t.follower();
      await one.until((f) => f.frames.length > 0);
      one.close();
      await one.until((f) => f.ended);
      expect(two.ended).toBe(false);
      await t.call("DELETE", `/conversations/${t.id}`);
      await two.until((f) => f.ended);
      expect((t.server as any).bus.hasListeners(t.id)).toBe(false);
    });

    it("closes a connection that has been open for the maximum time", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "hi" })), { runs: { maxStreamMs: 60, pingIntervalMs: 20 } });
      const watcher = await t.follower();
      await watcher.until((f) => f.ended, 2000, "the stream to close");
    });
  });

  describe("recovery", () => {
    /** What a process that died mid-turn leaves behind: a running event, no idle, and a lease nobody renews. */
    async function dieMidTurn(storage: StorageProvider, conversationId: string, ttlMs = 40) {
      const runId = `run_dead${Math.random().toString(36).slice(2, 8)}`;
      await storage.events!.append(conversationId, [
        { type: "user.message", data: { content: "hi" }, runId },
        { type: "session.status_running", data: { trigger: "message" }, runId },
      ]);
      await storage.acquireLease!({ key: `conv:${conversationId}`, owner: "dead-node", ttlMs, data: { conversationId, runId, kind: "message" } });
      await new Promise((r) => setTimeout(r, ttlMs + 60));
      return runId;
    }

    it("closes the run of a node that died: session.error, idle with stop reason error, runtime idle", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "x" })), { runs: { recoverOnStart: false } });
      const runId = await dieMidTurn(t.storage, t.id);
      // while the lease has not been recovered the conversation is not running (the lease expired) ...
      expect((await t.runtime()).status).toBe("idle");

      const result = await t.server.recoverStaleRuns();
      expect(result.conversations).toBeGreaterThanOrEqual(1);
      const log = (await t.events()).events as any[];
      expect(types(log)).toEqual(["user.message", "session.status_running", "session.error", "session.status_idle"]);
      expect(log[2]).toMatchObject({ run_id: runId, data: { code: "run_interrupted" } });
      expect(log[3]).toMatchObject({ run_id: runId, data: { stop_reason: "error", detail: "run_interrupted" } });
      expect(await t.runtime()).toMatchObject({ status: "idle", stopReason: "error", lastEventSeq: 4 });

      // done once: a second pass finds nothing to close for it
      await t.server.recoverStaleRuns();
      expect(types((await t.events()).events)).toHaveLength(4);
      expect((await t.storage.getLeases!([`conv:${t.id}`]))).toEqual([]);
    });

    it("recovers by itself at the first request", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "x" })), { runs: { recoverOnStart: false } });
      const runId = await dieMidTurn(t.storage, t.id);
      const fresh = createAgentServer({
        basePath: "/api",
        storage: t.storage,
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "x" })) }],
      });
      await fresh.handleRoute("GET", "/agents", { query: {} }); // any request starts it
      await eventually(async () => {
        const log = ((await fresh.handleRoute("GET", `/conversations/${t.id}/events`, { query: {} })).body as any).events as any[];
        return log.some((e) => e.type === "session.status_idle" && e.run_id === runId);
      }, 4000, "the recovery to close the dead run");
    });

    it("closes the dead run before a new message takes the conversation over", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "alive" })), { runs: { recoverOnStart: false } });
      await dieMidTurn(t.storage, t.id);
      const res = await t.send("anyone there?");
      expect(res.status).toBe(200);
      expect(types((await t.events()).events)).toEqual([
        "user.message",
        "session.status_running",
        "session.error",
        "session.status_idle",
        "user.message",
        "session.status_running",
        "agent.message",
        "session.status_idle",
        "session.work_done",
      ]);
    });

    it("leaves a run alone that finished and only failed to give the lease back", async () => {
      const t = await boot(fakeSdkAgent(async () => ({ content: "x" })), { runs: { recoverOnStart: false } });
      await t.send("done properly");
      const before = (await t.events()).events as any[];
      await t.storage.acquireLease!({ key: `conv:${t.id}`, owner: "dead-node", ttlMs: 30, data: { conversationId: t.id, runId: "run_x" } });
      await new Promise((r) => setTimeout(r, 90));
      await t.server.recoverStaleRuns();
      expect(types((await t.events()).events)).toEqual(types(before));
      expect(await t.storage.getLeases!([`conv:${t.id}`])).toEqual([]);
    });

    it("does not touch a run that is alive", async () => {
      const proceed = gate();
      const started = gate();
      const t = await boot(fakeSdkAgent(async () => {
        started.open();
        await proceed.promise;
        return { content: "ok" };
      }), { runs: { leaseTtlMs: 300 } });
      const sending = t.send("hi");
      await started.promise;
      // longer than a lease lives without renewal: it is renewed
      await new Promise((r) => setTimeout(r, 700));
      await t.server.recoverStaleRuns();
      expect((await t.runtime()).status).toBe("running");
      proceed.open();
      expect((await sending).status).toBe(200);
      expect(types((await t.events()).events)).not.toContain("session.error");
    });
  });

  describe("tasks", () => {
    const post = (t: Awaited<ReturnType<typeof boot>>, body: Record<string, unknown>) =>
      t.call("POST", "/tasks", { body: { agentId: "a", ...body } });
    const task = async (t: Awaited<ReturnType<typeof boot>>, id: string) => ((await t.call("GET", `/tasks/${id}`)).body as any);

    it("runs in a conversation of its own and completes with the result", async () => {
      const t = await boot(fakeSdkAgent(async (p) => ({ content: `did: ${p.messages.at(-1)!.content}`, metadata: { usage: { totalTokens: 5 } } as any })));
      const created = (await post(t, { input: "the job" })).body as any;
      expect(created.task.status).toBe("pending");
      const done = await eventually(async () => {
        const body = await task(t, created.task.id);
        return body.task.status === "completed" ? body : undefined;
      }, 4000, "the task to complete");
      expect(done.result.content).toBe("did: the job");
      expect(done.task.conversationId).toMatch(/^conv_/);

      // it is a conversation like any other: history, events, runtime
      const conv = (await t.call("GET", `/conversations/${done.task.conversationId}`)).body as any;
      expect(conv.messages.map((m: any) => [m.role, m.content])).toEqual([["user", "the job"], ["assistant", "did: the job"]]);
      expect(conv.conversation.runtime).toMatchObject({ status: "idle", stopReason: "end_turn" });
      const log = ((await t.call("GET", `/conversations/${done.task.conversationId}/events`)).body as any).events as any[];
      expect(types(log)).toContain("session.work_done");
      const status = (await t.call("GET", `/tasks/${created.task.id}/status`)).body as any;
      expect(status.conversationId).toBe(done.task.conversationId);
      const byConversation = (await t.call("GET", "/tasks", { query: { conversationId: done.task.conversationId } })).body as any;
      expect(byConversation.tasks.map((x: any) => x.id)).toEqual([created.task.id]);
    });

    it("waits for input when the agent pauses, and finishes when the action is answered on the conversation", async () => {
      const t = await boot(pausingAgent());
      const created = (await post(t, { input: "deploy it" })).body as any;
      const waiting = await eventually(async () => {
        const body = await task(t, created.task.id);
        return body.task.status === "waiting_for_input" ? body : undefined;
      }, 4000, "the task to wait");
      expect(waiting.pendingActions).toEqual([expect.objectContaining({ id: "ap1", type: "tool_approval", toolName: "deploy" })]);
      expect(waiting.result.metadata).toMatchObject({ waitingForInput: true, pendingActionIds: ["ap1"] });

      const conversationId = waiting.task.conversationId as string;
      const res = await t.call("POST", `/conversations/${conversationId}/actions/ap1`, { body: { resolution: allow } });
      expect(res.status).toBe(200);
      const done = await eventually(async () => {
        const body = await task(t, created.task.id);
        return body.task.status === "completed" ? body : undefined;
      }, 4000, "the task to complete");
      expect(done.result.content).toBe("deployed");
      expect(done.pendingActions).toBeUndefined();
    });

    it("refuses a comment while the task is running or waiting on an action", async () => {
      const proceed = gate();
      const started = gate();
      const t = await boot(fakeSdkAgent(async () => {
        started.open();
        await proceed.promise;
        return { content: "ok" };
      }));
      const created = (await post(t, { input: "slow" })).body as any;
      await started.promise;
      const busy = await t.call("POST", `/tasks/${created.task.id}/comments`, { body: { content: "hey" } });
      expect(busy.status).toBe(409);
      expect((busy.body as any).error.code).toBe("task_busy");
      proceed.open();
      await eventually(async () => (await task(t, created.task.id)).task.status === "completed", 4000);

      const paused = await boot(pausingAgent());
      const p = (await post(paused, { input: "deploy" })).body as any;
      await eventually(async () => (await task(paused, p.task.id)).task.status === "waiting_for_input", 4000);
      const refused = await paused.call("POST", `/tasks/${p.task.id}/comments`, { body: { content: "hey" } });
      expect(refused.status).toBe(409);
      expect((refused.body as any).error.code).toBe("action_pending");
    });

    it("continues a finished task in the same conversation when somebody comments", async () => {
      const t = await boot(fakeSdkAgent(async (p) => ({ content: `saw ${p.messages.length} messages, last: ${p.messages.at(-1)!.content}` })));
      const created = (await post(t, { input: "first" })).body as any;
      await eventually(async () => (await task(t, created.task.id)).task.status === "completed", 4000);
      const commented = await t.call("POST", `/tasks/${created.task.id}/comments`, { body: { content: "and one more thing" } });
      expect(commented.status).toBe(201);
      const done = await eventually(async () => {
        const body = await task(t, created.task.id);
        return body.task.status === "completed" && body.result.content.includes("one more") ? body : undefined;
      }, 4000, "the follow-up");
      expect(done.result.content).toBe("saw 3 messages, last: and one more thing");
    });

    it("cancels a running task: the run is aborted and the task is cancelled", async () => {
      const started = gate();
      const t = await boot(fakeSdkAgent(async (_p, config: any) => {
        started.open();
        await untilAborted(config);
        return cancelledResult() as any;
      }));
      const created = (await post(t, { input: "long" })).body as any;
      await started.promise;
      const cancelled = await t.call("POST", `/tasks/${created.task.id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect((cancelled.body as any).task.status).toBe("cancelled");
      expect((await task(t, created.task.id)).task.status).toBe("cancelled");
      const conversationId = (await task(t, created.task.id)).task.conversationId;
      expect(((await t.call("GET", `/conversations/${conversationId}`)).body as any).conversation.runtime).toMatchObject({ status: "idle", stopReason: "cancelled" });
      // cancelling again is fine; a finished task cannot be cancelled
      expect((await t.call("POST", `/tasks/${created.task.id}/cancel`)).status).toBe(200);
      const finished = (await post(t, { input: "quick" })).body as any;
      await eventually(async () => (await task(t, finished.task.id)).task.status !== "pending", 4000);
      expect((await t.call("POST", "/tasks/nope/cancel")).status).toBe(404);
    });

    it("cancels a task that waits for input", async () => {
      const t = await boot(pausingAgent());
      const created = (await post(t, { input: "deploy" })).body as any;
      await eventually(async () => (await task(t, created.task.id)).task.status === "waiting_for_input", 4000);
      const cancelled = await t.call("POST", `/tasks/${created.task.id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect((cancelled.body as any).task.status).toBe("cancelled");
      const conversationId = (await task(t, created.task.id)).task.conversationId;
      expect(((await t.call("GET", `/conversations/${conversationId}`)).body as any).pendingActions).toBeUndefined();
      expect((await t.call("POST", `/tasks/${created.task.id}/cancel`)).status).toBe(200);
      const finished = await boot(fakeSdkAgent(async () => ({ content: "ok" })));
      const quick = (await post(finished, { input: "x" })).body as any;
      await eventually(async () => (await task(finished, quick.task.id)).task.status === "completed", 4000);
      expect((await finished.call("POST", `/tasks/${quick.task.id}/cancel`)).status).toBe(409);
    });

    it("fails a task that cannot run, and one whose agent throws", async () => {
      const t = await boot(fakeSdkAgent(async () => {
        throw new Error("agent exploded");
      }));
      const original = console.error;
      console.error = () => undefined;
      try {
        const created = (await post(t, { input: "doomed" })).body as any;
        const failed = await eventually(async () => {
          const body = await task(t, created.task.id);
          return body.task.status === "failed" ? body : undefined;
        }, 4000, "the task to fail");
        expect(failed.task.error).toContain("agent exploded");
      } finally {
        console.error = original;
      }
    });

    it("keeps the handler contract: waitingForInput metadata still asks a question through a comment", async () => {
      const handler: AgentHandler = {
        async processMessage(params) {
          const comments = ((params.metadata as any)?.comments ?? []) as any[];
          return comments.length === 0
            ? { content: "which environment?", metadata: { waitingForInput: true } }
            : { content: `deploying to ${comments.at(-1).content}` };
        },
      };
      const t = await boot({ handler });
      const created = (await post(t, { input: "deploy" })).body as any;
      const waiting = await eventually(async () => {
        const body = await task(t, created.task.id);
        return body.task.status === "waiting_for_input" ? body : undefined;
      }, 4000, "the question");
      expect(waiting.task.comments.at(-1)).toMatchObject({ role: "agent", content: "which environment?" });
      expect(waiting.pendingActions).toBeUndefined();
      await t.call("POST", `/tasks/${created.task.id}/comments`, { body: { content: "staging" } });
      const done = await eventually(async () => {
        const body = await task(t, created.task.id);
        return body.task.status === "completed" ? body : undefined;
      }, 4000, "the answer");
      expect(done.result.content).toBe("deploying to staging");
    });

    it("fails the tasks a dead process left running, and spares the ones that are alive", async () => {
      const proceed = gate();
      const started = gate();
      const t = await boot(fakeSdkAgent(async () => {
        started.open();
        await proceed.promise;
        return { content: "ok" };
      }), { runs: { leaseTtlMs: 150, recoverOnStart: false } });
      const alive = (await post(t, { input: "alive" })).body as any;
      await started.promise;
      // a task whose process died: running, nothing behind it
      const orphan = await t.storage.createTask({ agentId: "a", input: "orphan" });
      await t.storage.updateTask(orphan.id, { status: "running", startedAt: new Date() });
      await new Promise((r) => setTimeout(r, 400));

      const result = await t.server.recoverStaleRuns();
      expect(result.tasks).toBeGreaterThanOrEqual(1);
      const failed = (await t.storage.getTask(orphan.id))!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("stopped");
      expect((await task(t, alive.task.id)).task.status).toBe("running");
      proceed.open();
      await eventually(async () => (await task(t, alive.task.id)).task.status === "completed", 4000);
    });
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
    runsSuite();
  });
}

// ----------------------------------------------------------------------------
// A storage provider that has neither an event log nor leases
// ----------------------------------------------------------------------------

describe("a storage provider without events and leases", () => {
  async function bare() {
    const { createInMemoryProvider } = await import("../src/index.js");
    const inner = createInMemoryProvider();
    await inner.connect();
    const hidden = new Set(["events", "acquireLease", "renewLease", "releaseLease", "getLeases", "markLeaseCancel", "listExpiredLeases"]);
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && hidden.has(prop)) return undefined;
        if (prop === "capabilities") return () => ({ ...target.capabilities(), events: false, leases: false });
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorageProvider;
  }

  it("keeps the log in memory (bounded), serialises runs in the process, and still cancels", async () => {
    const started = gate();
    const t = await boot(
      fakeSdkAgent(async (_p, config: any) => {
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "t", id: "c1", args: {} });
        started.open();
        await untilAborted(config);
        return cancelledResult() as any;
      }),
      { runs: { memoryEventLimit: 3 } },
      await bare()
    );
    const sending = t.send("go");
    await started.promise;
    expect((await t.send("second")).status).toBe(409);
    expect(await t.runtime()).toMatchObject({ status: "running" });
    await t.cancel();
    await sending;

    // the bounded log keeps the newest events, and the sequence keeps counting
    const log = (await t.events()).events as any[];
    expect(log.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(log.at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "cancelled" } });
    expect(await t.runtime()).toMatchObject({ status: "idle", stopReason: "cancelled", lastEventSeq: log.at(-1).seq });
  });

  it("follows a turn and recovers (a no-op) without leases", async () => {
    const proceed = gate();
    const t = await boot(fakeSdkAgent(async () => {
      await proceed.promise;
      return { content: "hi" };
    }), {}, await bare());
    const sending = t.send("go");
    const watcher = await t.follower();
    await watcher.until((f) => f.types.includes("session.status_running"));
    proceed.open();
    await sending;
    await watcher.until((f) => f.types.includes("session.work_done"));
    watcher.close();
    expect(await t.server.recoverStaleRuns()).toMatchObject({ conversations: 0 });
  });

  it("fails the tasks an earlier process left running, as the only node", async () => {
    const storage = await bare();
    // left behind by a process that is gone: older than the server that starts now
    const orphan = await storage.createTask({ agentId: "a", input: "orphan" });
    await storage.updateTask(orphan.id, { status: "running" });
    const other = await storage.createTask({ agentId: "a", input: "other node's" });
    await storage.updateTask(other.id, { status: "running" });
    await new Promise((r) => setTimeout(r, 10));

    // when it may be one of several nodes, nothing proves the task is dead
    const shared = createAgentServer({ basePath: "/api", storage, runs: { assumeSingleNode: false, recoverOnStart: false } });
    expect((await shared.recoverStaleRuns()).tasks).toBe(0);
    expect((await storage.getTask(other.id))!.status).toBe("running");

    const t = await boot(fakeSdkAgent(async () => ({ content: "ok" })), { runs: { recoverOnStart: false } }, storage);
    // a task this process starts is its own
    const mine = (await t.call("POST", "/tasks", { body: { agentId: "a", input: "mine" } })).body as any;
    const result = await t.server.recoverStaleRuns();
    expect(result.tasks).toBe(2);
    expect((await storage.getTask(orphan.id))!.status).toBe("failed");
    expect((await storage.getTask(orphan.id))!.error).toContain("stopped");
    await eventually(async () => (await storage.getTask(mine.task.id))?.status === "completed", 4000, "my task");
  });
});

// ----------------------------------------------------------------------------
// Chat Completions / Responses API agents: the request itself is cut
// ----------------------------------------------------------------------------

describe("cancelling an agent that calls an OpenAI-compatible API", () => {
  async function upstream(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, state: { closed: boolean }) => void) {
    const http = await import("node:http");
    const { listen } = await import("./helpers.js");
    const state = { closed: false, requests: 0 };
    const server = http.createServer((req, res) => {
      state.requests++;
      res.on("close", () => {
        state.closed = true;
      });
      handler(req, res, state);
    });
    const { url, close } = await listen(server);
    return { url, close, state };
  }

  async function bootApi(kind: "chat" | "responses", url: string, streaming: boolean) {
    const { createInMemoryProvider } = await import("../src/index.js");
    const storage = createInMemoryProvider();
    await storage.connect();
    const server = createAgentServer({ basePath: "/api", storage, runs: { sweepIntervalMs: 0 } });
    if (kind === "chat") server.registerChatCompletionsAgent("a", { baseUrl: url, apiKey: "k", model: "m" }, { name: "A" });
    else server.registerResponsesAgent("a", { baseUrl: url, apiKey: "k", model: "m" }, { name: "A" });
    const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } });
    const id = (created.body as any).conversation.id as string;
    const send = () => server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message: "hi", stream: streaming } });
    const cancel = () => server.handleRoute("POST", `/conversations/${id}/cancel`, { query: {} });
    const messages = async () => ((await server.handleRoute("GET", `/conversations/${id}`, { query: {} })).body as any).messages as any[];
    return { send, cancel, messages };
  }

  for (const kind of ["chat", "responses"] as const) {
    it(`aborts a ${kind} request that is still waiting for the model`, async () => {
      const up = await upstream(() => {
        /* never answers */
      });
      try {
        const t = await bootApi(kind, up.url, false);
        const sending = t.send();
        await eventually(() => up.state.requests > 0, 3000, "the request to reach the model");
        const cancelled = await t.cancel();
        expect(cancelled.body).toMatchObject({ cancelled: true, settled: true });
        expect(((await sending).body as any).stopReason).toBe("cancelled");
        await eventually(() => up.state.closed, 3000, "the upstream connection to be cut");
      } finally {
        await up.close();
      }
    });
  }

  it("keeps the text streamed before the cancel and cuts the upstream stream", async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Half an " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n`);
      // ... and then nothing
    });
    try {
      const t = await bootApi("chat", up.url, true);
      const res = await t.send();
      const follower = new Follower(res as any);
      await follower.until((f) => f.frames.filter((x) => x.data?.type === "stream.text").length === 2, 3000, "the first chunks");
      await t.cancel();
      await follower.until((f) => f.ended);
      const done = follower.frames.map((f) => f.data).find((d: any) => d?.type === "stream.done");
      expect(done).toMatchObject({ status: "cancelled", content: "Half an answer" });
      expect((await t.messages()).at(-1)).toMatchObject({ role: "assistant", content: "Half an answer", status: "cancelled" });
      await eventually(() => up.state.closed, 3000, "the upstream connection to be cut");
    } finally {
      await up.close();
    }
  });
});

describe("pendingActionPolicy: 'cancel'", () => {
  it("logs the actions it cancels as resolved by the system", async () => {
    const { createInMemoryProvider } = await import("../src/index.js");
    const storage = createInMemoryProvider();
    await storage.connect();
    const t = await boot(pausingAgent(), { pendingActionPolicy: "cancel" }, storage);
    await t.send("deploy");
    const res = await t.send("never mind");
    expect(res.status).toBe(200);
    const log = (await t.events()).events as any[];
    const resolved = log.find((e) => e.type === "action.resolved");
    expect(resolved.data).toEqual({ action_id: "ap1", kind: "tool_approval", cancelled: true, status: "cancelled", resolved_by: "system", channel: "system" });
    // before the new turn's user message
    expect(log.findIndex((e) => e.type === "action.resolved")).toBeLessThan(log.map((e) => e.type).lastIndexOf("user.message"));
  });
});
