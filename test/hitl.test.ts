import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentServer } from "../src/index.js";
import type {
  AgentHandler,
  AgentServerConfig,
  PendingAction,
  ProcessMessageResult,
  ResolveActionParams,
  StorageProvider,
} from "../src/index.js";
import { fakeSdkAgent, parseSse, spyStorage } from "./helpers.js";
import { withCall } from "./sdk-stubs.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider } from "./storage/providers.js";

// The suite below runs once per storage provider (memory, SQLite, MongoDB, PostgreSQL), and then
// again across a simulated restart: pause with one server, resolve with a new server on a reopened store.
let active: { current: OpenedProvider } | undefined;
const currentStorage = (): StorageProvider => active!.current.storage;

// ----------------------------------------------------------------------------
// A stub agent-sdk agent. It pauses on the first call, and resumes after
// `resolveToolApproval` / `resolveUserQuestion` the way the real one does:
// the paused state carries pendingApprovals / pendingUserQuestions.
// ----------------------------------------------------------------------------

type Mode = "approval" | "question";

function stubSdkAgent(mode: Mode = "approval", opts: { pausesEveryTime?: boolean } = {}) {
  const calls: any[] = [];
  const pendingApproval = (n: number) => ({
    id: `ap${n}`,
    toolCallId: `call${n}`,
    toolName: "deploy",
    args: { version: "1.0" },
    status: "pending",
    requestedAt: new Date().toISOString(),
    metadata: { prompt: "Deploy 1.0?" },
  });
  const pendingQuestion = (n: number) => ({
    id: `q${n}`,
    toolCallId: `qcall${n}`,
    toolName: "ask_user_question",
    status: "pending",
    requestedAt: new Date().toISOString(),
    allowFreeText: true,
    questions: [
      {
        question: "Which env?",
        header: "Env",
        required: true,
        options: [{ label: "Staging", value: "stg" }, { label: "Production", value: "prod" }],
      },
    ],
  });
  let pauses = 0;

  const agent = {
    calls,
    invoke: async (input: any, config?: any) => {
      calls.push(input);
      const resolved = (input.pendingApprovals ?? []).find((a: any) => a.status === "approved" || a.status === "rejected")
        ?? (input.pendingUserQuestions ?? []).find((q: any) => q.status === "answered" || q.status === "cancelled");
      const fresh = !resolved;
      if (fresh || (opts.pausesEveryTime && pauses < 2)) {
        pauses += 1;
        config?.onEvent?.({ type: "tool_approval", status: "pending" });
        const state = {
          messages: [...(input.messages ?? []), { role: "assistant", content: "" }],
          pendingApprovals: mode === "approval" ? [pendingApproval(pauses)] : [],
          pendingUserQuestions: mode === "question" ? [pendingQuestion(pauses)] : [],
          ctx: mode === "approval" ? { __awaitingApproval: { approvalId: `ap${pauses}` } } : { __awaitingUserQuestion: {} },
        };
        return { content: "", messages: state.messages, metadata: {}, state };
      }
      // resumed: execute
      config?.onEvent?.({ type: "tool_call", phase: "start", name: "deploy", id: "call1", args: { version: "1.0" } });
      config?.onEvent?.({ type: "tool_call", phase: "success", name: "deploy", id: "call1", result: "ok" });
      const verdict =
        resolved?.status === "rejected" ? "denied"
        : resolved?.status === "cancelled" ? "skipped"
        : resolved?.answers ? `answers:${JSON.stringify(resolved.answers)}`
        : resolved?.approvedArgs ? `deployed:${JSON.stringify(resolved.approvedArgs)}`
        : "deployed";
      config?.onStream?.({ text: verdict });
      // (usage the way agent-sdk reports it: a ledger of model calls with totals per model)
      return {
        content: verdict,
        messages: [],
        metadata: { usage: withCall(input.usage, "stub-model", 1, 2) },
        state: { messages: [], pendingApprovals: [], pendingUserQuestions: [] },
      };
    },
    resolveToolApproval: (state: any, r: any) => {
      const approvals = (state.pendingApprovals ?? []).map((a: any) => ({ ...a }));
      const entry = approvals.find((a: any) => a.id === r.id);
      if (!entry) throw new Error(`Pending approval not found for id: ${r.id}`);
      entry.status = r.approved ? "approved" : "rejected";
      entry.approvedArgs = r.approved ? r.approvedArgs : undefined;
      entry.decidedBy = r.decidedBy;
      entry.comment = r.comment;
      const ctx = { ...(state.ctx ?? {}) };
      delete ctx.__awaitingApproval;
      return { ...state, pendingApprovals: approvals, ctx };
    },
    resolveUserQuestion: (state: any, r: any) => {
      const list = (state.pendingUserQuestions ?? []).map((q: any) => ({ ...q }));
      const entry = list.find((q: any) => q.id === r.id);
      if (!entry) throw new Error(`Pending user question not found for id: ${r.id}`);
      if (!r.cancelled && !r.answers?.["Which env?"]) throw new Error('Missing answer for required question: "Which env?".');
      entry.status = r.cancelled ? "cancelled" : "answered";
      entry.answers = r.answers;
      const ctx = { ...(state.ctx ?? {}) };
      delete ctx.__awaitingUserQuestion;
      return { ...state, pendingUserQuestions: list, ctx };
    },
  };
  return agent;
}

async function setup(
  agent: unknown | { handler: AgentHandler },
  extra: Partial<AgentServerConfig> = {},
  /** Continue an existing conversation on another (re-opened) storage, as after a restart. */
  resume?: { id: string; storage: StorageProvider }
) {
  const storage = resume?.storage ?? currentStorage();
  const registration =
    agent && typeof agent === "object" && "handler" in (agent as object)
      ? { info: { id: "a", name: "A" }, handler: (agent as { handler: AgentHandler }).handler }
      : { info: { id: "a", name: "A" }, sdkAgent: agent };
  const server = createAgentServer({ basePath: "/api", storage, agents: [registration as any], ...extra });
  const id =
    resume?.id ??
    ((await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } })).body as {
      conversation: { id: string };
    }).conversation.id;

  const send = (message = "deploy it") =>
    server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message } });
  const sendStream = async (message = "deploy it") => {
    const res = await server.handleRoute("POST", `/conversations/${id}/messages`, {
      query: {},
      body: { message, stream: true },
    });
    if (!res.stream) return { res, events: [] as ReturnType<typeof parseSse> };
    let text = "";
    for await (const chunk of res.stream) text += chunk;
    return { res, events: parseSse(text) };
  };
  const resolve = (actionId: string, resolution: unknown, body: Record<string, unknown> = {}) =>
    server.handleRoute("POST", `/conversations/${id}/actions/${actionId}`, {
      query: {},
      body: { resolution, ...body },
    });
  const resolveStream = async (actionId: string, resolution: unknown) => {
    const res = await resolve(actionId, resolution, { stream: true });
    if (!res.stream) return { res, events: [] as ReturnType<typeof parseSse> };
    let text = "";
    for await (const chunk of res.stream) text += chunk;
    return { res, events: parseSse(text) };
  };
  const get = async () => (await server.handleRoute("GET", `/conversations/${id}`, { query: {} })).body as any;
  return { server, storage, id, send, sendStream, resolve, resolveStream, get };
}

const allow = { type: "tool_approval", decision: "allow" } as const;

function hitlSuite() {

  describe("SDK agent: pause -> resolve -> continue", () => {
    it("pauses on a tool approval (JSON), exposes the pending action, and hides internals", async () => {
      const t = await setup(stubSdkAgent());
      const res = await t.send();
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.status).toBe("requires_action");
      expect(body.pendingActions).toEqual([
        expect.objectContaining({
          id: "ap1",
          type: "tool_approval",
          toolName: "deploy",
          toolCallId: "call1",
          title: "Deploy 1.0?",
          args: { version: "1.0" },
        }),
      ]);
      expect(body.response.metadata).toMatchObject({ requiresAction: true });

      const conv = await t.get();
      expect(conv.pendingActions).toHaveLength(1);
      expect(JSON.stringify(conv.conversation)).not.toContain("__agentServerHitl");
      // ...but the store is persisted so a reload (or another process) can resume
      const raw = await t.storage.getConversation(t.id);
      expect(raw?.state?.__agentServerHitl).toBeTruthy();
    });

    it("resolves allow (JSON) by restoring the state and invoking, as a NEW assistant message", async () => {
      const agent = stubSdkAgent();
      const t = await setup(agent);
      await t.send();
      const res = await t.resolve("ap1", { ...allow, comment: "go" });
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.response.content).toBe("deployed");
      expect(body.status).toBeUndefined();
      expect(body.pendingActions).toBeUndefined();
      expect(body.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });

      // the second invoke received the restored state with the decision applied
      const resumeInput = agent.calls[1];
      expect(resumeInput.pendingApprovals[0]).toMatchObject({ status: "approved", comment: "go" });

      const conv = await t.get();
      expect(conv.pendingActions).toBeUndefined();
      const raw = await t.storage.getConversation(t.id);
      expect(raw?.state?.__agentServerHitl).toBeUndefined();
      // user, paused assistant, continuation assistant
      expect(conv.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "assistant"]);
    });

    it("deny reaches the agent, and approvedArgs are forwarded", async () => {
      const denied = await setup(stubSdkAgent());
      await denied.send();
      expect(((await denied.resolve("ap1", { type: "tool_approval", decision: "deny", comment: "no" })).body as any).response.content).toBe("denied");

      const edited = await setup(stubSdkAgent());
      await edited.send();
      const res = await edited.resolve("ap1", { ...allow, approvedArgs: { version: "2.0" } });
      expect((res.body as any).response.content).toBe('deployed:{"version":"2.0"}');
    });

    it("streams the pause: start, action_required, done(requires_action)", async () => {
      const t = await setup(stubSdkAgent());
      const { events } = await t.sendStream();
      expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.action_required", "stream.done"]);
      const required = events[1] as any;
      const done = events[2] as any;
      expect(required.actions[0]).toMatchObject({ id: "ap1", type: "tool_approval", toolName: "deploy" });
      expect(required.messageId).toBe(done.messageId);
      expect(done).toMatchObject({ status: "requires_action", content: "" });
      expect(done.pendingActions).toHaveLength(1);
    });

    it("streams the continuation: start, action_resolved, tool events, text, done", async () => {
      const t = await setup(stubSdkAgent());
      const first = await t.sendStream();
      const pausedMessageId = (first.events[0] as any).messageId;
      const { res, events } = await t.resolveStream("ap1", allow);
      expect(res.headers?.["Content-Type"]).toBe("text/event-stream");
      expect(events.map((e) => e.type)).toEqual([
        "stream.start",
        "stream.action_resolved",
        "stream.tool_call",
        "stream.tool_result",
        "stream.text",
        "stream.done",
      ]);
      expect(events[0]).toMatchObject({ conversationId: t.id });
      expect(events[1]).toMatchObject({ actionId: "ap1", resolution: { type: "tool_approval", decision: "allow" } });
      expect(events.at(-1)).toMatchObject({ content: "deployed" });
      expect((events.at(-1) as any).status).toBeUndefined();
      expect((events.at(-1) as any).messageId).not.toBe(pausedMessageId);
    });

    it("asks questions: maps answers to the SDK shape and continues", async () => {
      const agent = stubSdkAgent("question");
      const t = await setup(agent);
      const paused = (await t.send()).body as any;
      expect(paused.pendingActions[0]).toMatchObject({
        id: "q1",
        type: "user_question",
        allowFreeText: true,
        questions: [{ question: "Which env?", header: "Env", options: [{ label: "Staging", value: "stg" }, { label: "Production", value: "prod" }] }],
      });

      // a label resolves to its value
      const res = await t.resolve("q1", { type: "user_question", answers: { "Which env?": "Production" } });
      expect(res.status).toBe(200);
      expect(agent.calls[1].pendingUserQuestions[0].answers).toEqual({ "Which env?": { values: ["prod"] } });
    });

    it("treats a non-option answer as free text, and cancelled skips the answers", async () => {
      const agent = stubSdkAgent("question");
      const t = await setup(agent);
      await t.send();
      await t.resolve("q1", { type: "user_question", answers: { "Which env?": "qa-3" } });
      expect(agent.calls[1].pendingUserQuestions[0].answers).toEqual({ "Which env?": { values: [], freeText: "qa-3" } });

      const t2 = await setup(stubSdkAgent("question"));
      await t2.send();
      const res = await t2.resolve("q1", { type: "user_question", answers: {}, cancelled: true });
      expect((res.body as any).response.content).toBe("skipped");
    });

    it("an invalid answer is a 400 and leaves the action pending", async () => {
      const t = await setup(stubSdkAgent("question"));
      await t.send();
      const bad = await t.resolve("q1", { type: "user_question", answers: {} });
      expect(bad.status).toBe(400);
      expect((bad.body as any).error.message).toContain("Missing answer");
      expect((await t.get()).pendingActions).toHaveLength(1);
      const ok = await t.resolve("q1", { type: "user_question", answers: { "Which env?": "stg" } });
      expect(ok.status).toBe(200);
    });

    it("can pause again while continuing", async () => {
      const t = await setup(stubSdkAgent("approval", { pausesEveryTime: true }));
      await t.send();
      const res = (await t.resolve("ap1", allow)).body as any;
      expect(res.status).toBe("requires_action");
      expect(res.pendingActions[0].id).toBe("ap2");
      expect((await t.get()).pendingActions[0].id).toBe("ap2");
      // the first action is no longer pending
      expect((await t.resolve("ap1", allow)).status).toBe(409);
    });

    it("rememberForSession auto-approves the same tool later in the conversation", async () => {
      const agent = stubSdkAgent("approval");
      const t = await setup(agent);
      await t.send();
      await t.resolve("ap1", { ...allow, rememberForSession: true });
      // a new turn pauses again on the same tool -> approved without asking
      const second = (await t.send("again")).body as any;
      expect(second.status).toBeUndefined();
      expect(second.pendingActions).toBeUndefined();
      expect(second.response.content).toBe("deployed");
    });
  });

  describe("pending action guards", () => {
    it("409 action_pending for a new message while waiting (JSON and stream), with the ids", async () => {
      const t = await setup(stubSdkAgent());
      await t.send();
      const res = await t.send("hello?");
      expect(res.status).toBe(409);
      expect((res.body as any).error.code).toBe("action_pending");
      expect((res.body as any).error.details.pendingActionIds).toEqual(["ap1"]);

      const streamed = await t.sendStream("hello?");
      expect(streamed.res.status).toBe(409);
      expect(streamed.res.stream).toBeUndefined();
      // nothing was saved for the rejected messages
      expect((await t.get()).messages).toHaveLength(2);
    });

    it("pendingActionPolicy 'cancel' cancels the pending action and processes the message", async () => {
      const agent = stubSdkAgent();
      const t = await setup(agent, { pendingActionPolicy: "cancel" });
      await t.send();
      const res = await t.send("never mind, new question");
      expect(res.status).toBe(200);
      // a fresh turn: the agent got plain messages, not the paused state
      expect(agent.calls[1].pendingApprovals).toBeUndefined();
      expect(agent.calls[1].messages.at(-1).content).toBe("never mind, new question");
      // the old action is gone
      expect((await t.resolve("ap1", allow)).status).toBe(409);
    });

    it("409 action_not_pending for unknown ids and for double resolves", async () => {
      const t = await setup(stubSdkAgent());
      await t.send();
      const unknown = await t.resolve("nope", allow);
      expect(unknown.status).toBe(409);
      expect((unknown.body as any).error.code).toBe("action_not_pending");

      expect((await t.resolve("ap1", allow)).status).toBe(200);
      const again = await t.resolve("ap1", allow);
      expect(again.status).toBe(409);
      expect((again.body as any).error.code).toBe("action_not_pending");
    });

    it("a concurrent second resolve of the same action is rejected", async () => {
      const t = await setup(stubSdkAgent());
      await t.send();
      const [a, b] = await Promise.all([t.resolve("ap1", allow), t.resolve("ap1", allow)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it("400 for a malformed resolution or one that does not match the action", async () => {
      const t = await setup(stubSdkAgent());
      await t.send();
      expect((await t.resolve("ap1", { type: "tool_approval" })).status).toBe(400);
      expect((await t.resolve("ap1", { type: "tool_approval", decision: "allow", approvedArgs: [1] })).status).toBe(400);
      expect((await t.resolve("ap1", { type: "user_question", answers: {} })).status).toBe(400);
      expect((await t.resolve("ap1", { type: "bogus" })).status).toBe(400);
      expect((await t.server.handleRoute("POST", `/conversations/${t.id}/actions/ap1`, { query: {}, body: {} })).status).toBe(400);
    });

    it("404 when the agent cannot resolve actions, or the conversation is unknown", async () => {
      const plain = await setup(fakeSdkAgent(async () => ({ content: "x" })));
      expect((await plain.resolve("ap1", allow)).status).toBe(404);

      const t = await setup(stubSdkAgent());
      const res = await t.server.handleRoute("POST", "/conversations/missing/actions/ap1", {
        query: {},
        body: { resolution: allow },
      });
      expect(res.status).toBe(404);
    });

    it("enforces conversation ownership on resolve", async () => {
      const storage = currentStorage();
      const server = createAgentServer({
        basePath: "/api",
        storage,
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: stubSdkAgent() }],
        resolveContext: (req) => ({ user: { id: String(req.headers["x-user"]) }, data: {} }),
      });
      const hdr = (u: string) => ({ "x-user": u });
      const created = await server.handleRoute("POST", "/conversations", { query: {}, headers: hdr("alice"), body: { agentId: "a" } });
      const id = (created.body as any).conversation.id;
      await server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, headers: hdr("alice"), body: { message: "go" } });
      const evil = await server.handleRoute("POST", `/conversations/${id}/actions/ap1`, {
        query: {}, headers: hdr("mallory"), body: { resolution: allow },
      });
      expect(evil.status).toBe(403);
      const good = await server.handleRoute("POST", `/conversations/${id}/actions/ap1`, {
        query: {}, headers: hdr("alice"), body: { resolution: allow },
      });
      expect(good.status).toBe(200);
    });
  });

  describe("custom handlers", () => {
    function pausingHandler() {
      const seen: ResolveActionParams[] = [];
      const handler: AgentHandler = {
        async processMessage(): Promise<ProcessMessageResult> {
          const action: PendingAction = { id: "h1", type: "tool_approval", toolName: "wire", args: { amount: 5 }, title: "Wire $5?" };
          return { content: "needs a check", status: "requires_action", pendingActions: [action], state: { step: 1 } };
        },
        async resolveAction(params) {
          seen.push(params);
          return params.resolution.type === "tool_approval" && params.resolution.decision === "allow"
            ? { content: "sent", state: { step: 2 }, usage: { totalTokens: 7 } }
            : { content: "cancelled the wire" };
        },
      };
      return { handler, seen };
    }

    it("passes status/pendingActions through (JSON and stream) and keeps its own state", async () => {
      const { handler } = pausingHandler();
      const t = await setup({ handler });
      const res = (await t.send()).body as any;
      expect(res.status).toBe("requires_action");
      expect(res.pendingActions[0]).toMatchObject({ id: "h1", toolName: "wire" });
      expect(res.response.content).toBe("needs a check");

      const conv = await t.get();
      expect(conv.pendingActions).toHaveLength(1);
      expect(conv.conversation.state).toEqual({ step: 1 });

      const t2 = await setup({ handler });
      const { events } = await t2.sendStream();
      expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.progress", "stream.text", "stream.action_required", "stream.done"]);
      expect(events.at(-1)).toMatchObject({ status: "requires_action" });
    });

    it("routes resolve to handler.resolveAction with the full params", async () => {
      const { handler, seen } = pausingHandler();
      const t = await setup({ handler });
      await t.send();
      const res = await t.resolve("h1", { ...allow, rememberForSession: true }, { metadata: { via: "test" } });
      expect(res.status).toBe(200);
      expect((res.body as any).response.content).toBe("sent");
      expect((res.body as any).usage).toEqual({ totalTokens: 7 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        conversationId: t.id,
        actionId: "h1",
        resolution: { type: "tool_approval", decision: "allow", rememberForSession: true },
        state: { step: 1 },
        metadata: { via: "test" },
      });
      expect(JSON.stringify(seen[0].state)).not.toContain("__agentServerHitl");

      const conv = await t.get();
      expect(conv.pendingActions).toBeUndefined();
      expect(conv.conversation.state).toEqual({ step: 2 });
      expect((await t.resolve("h1", allow)).status).toBe(409);
    });

    it("streams a handler resolve", async () => {
      const { handler } = pausingHandler();
      const t = await setup({ handler });
      await t.send();
      const { events } = await t.resolveStream("h1", { type: "tool_approval", decision: "deny" });
      expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.action_resolved", "stream.text", "stream.done"]);
      expect(events.at(-1)).toMatchObject({ content: "cancelled the wire" });
    });

    it("a handler can pause again from resolveAction", async () => {
      const handler: AgentHandler = {
        async processMessage() {
          return { content: "first", status: "requires_action", pendingActions: [{ id: "h1", type: "tool_approval", toolName: "t" }] };
        },
        async resolveAction() {
          return { content: "second", status: "requires_action", pendingActions: [{ id: "h2", type: "tool_approval", toolName: "t" }] };
        },
      };
      const t = await setup({ handler });
      await t.send();
      const res = (await t.resolve("h1", allow)).body as any;
      expect(res.pendingActions[0].id).toBe("h2");
      expect((await t.get()).pendingActions[0].id).toBe("h2");
    });

    it("404 when the handler has no resolveAction", async () => {
      const handler: AgentHandler = {
        async processMessage() {
          return { content: "hi", status: "requires_action", pendingActions: [{ id: "h1", type: "tool_approval", toolName: "t" }] };
        },
      };
      const t = await setup({ handler });
      await t.send();
      expect((await t.resolve("h1", allow)).status).toBe(404);
    });
  });

  describe("agents that never pause are unchanged", () => {
    it("emits the same events and no status/pendingActions fields", async () => {
      const t = await setup(fakeSdkAgent(async () => ({ content: "final answer" })));
      const { events } = await t.sendStream();
      expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.text", "stream.done"]);
      const done = events.at(-1) as any;
      expect("status" in done).toBe(false);
      expect("pendingActions" in done).toBe(false);

      const res = (await t.send("again")).body as any;
      expect("status" in res).toBe(false);
      expect("pendingActions" in res).toBe(false);
      expect(res.response.metadata?.requiresAction).toBeUndefined();

      const conv = await t.get();
      expect("pendingActions" in conv).toBe(false);
      const raw = await t.storage.getConversation(t.id);
      expect(Object.keys(raw?.state ?? {})).toEqual([]);
    });

    it("does not touch conversation state for a never-pausing SDK agent", async () => {
      const { storage, calls } = spyStorage(currentStorage());
      const server = createAgentServer({
        basePath: "/api",
        storage,
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "hi" })) }],
      });
      const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } });
      const id = (created.body as any).conversation.id;
      await server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message: "x" } });
      const res = await server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message: "y", stream: true } });
      for await (const _ of res.stream!) { /* drain */ }
      expect(calls.filter((c) => c.method === "updateConversation")).toHaveLength(0);
    });

    it("a plain handler is unchanged, and keeps writing only the state it returns", async () => {
      const handler: AgentHandler = { processMessage: async () => ({ content: "ok", state: { n: 1 } }) };
      const t = await setup({ handler });
      const res = (await t.send()).body as any;
      expect("status" in res).toBe(false);
      expect((await t.get()).conversation.state).toEqual({ n: 1 });
    });
  });

  describe("capabilities", () => {
    it("derives toolApproval / askUser from an SDK agent instance", async () => {
      const storage = currentStorage();
      const server = createAgentServer({ basePath: "/api", storage });
      const agent = Object.assign(stubSdkAgent(), {
        __runtime: { tools: [{ name: "x" }, { name: "deploy", needsApproval: true }], humanInTheLoop: { askUser: { allowFreeText: true } } },
      });
      server.registerSDKAgent("hitl", agent);
      server.registerSDKAgent("plain", fakeSdkAgent(async () => ({ content: "x" })));
      server.registerSDKAgent("explicit", stubSdkAgent(), { capabilities: { askUser: true } });
      expect(server.getAgent("hitl")?.info.capabilities).toEqual({ toolApproval: true, askUser: true });
      expect(server.getAgent("plain")?.info.capabilities).toBeUndefined();
      expect(server.getAgent("explicit")?.info.capabilities).toEqual({ askUser: true });
      const list = await server.handleRoute("GET", "/agents", { query: {} });
      expect(JSON.stringify(list.body)).toContain('"toolApproval":true');
    });
  });

  describe("review fixes", () => {
    it("normalises handler status: pending actions imply requires_action, a bare requires_action is dropped", async () => {
      const a: AgentHandler = {
        processMessage: async () => ({ content: "x", pendingActions: [{ id: "h1", type: "tool_approval", toolName: "t" }] }),
      };
      const ta = await setup({ handler: a });
      const ra = (await ta.send()).body as any;
      expect(ra.status).toBe("requires_action");
      const sa = await setup({ handler: a });
      expect((await sa.sendStream()).events.map((e) => e.type)).toContain("stream.action_required");

      const b: AgentHandler = { processMessage: async () => ({ content: "x", status: "requires_action" }) };
      const tb = await setup({ handler: b });
      expect("status" in ((await tb.send()).body as any)).toBe(false);
    });

    it("a second resolve of an already-resolved action is a 409 even when streaming", async () => {
      const t = await setup(stubSdkAgent("approval"));
      await t.send();
      expect((await t.resolve("ap1", allow, { stream: true })).stream).toBeDefined();
      // consume the first stream fully, then try again
      const t2 = await setup(stubSdkAgent("approval"));
      await t2.send();
      await t2.resolveStream("ap1", allow);
      expect((await t2.resolve("ap1", allow, { stream: true })).status).toBe(409);
    });

    it("allowRememberApproval: false ignores rememberForSession", async () => {
      const t = await setup(stubSdkAgent("approval"), { allowRememberApproval: false });
      await t.send();
      await t.resolve("ap1", { ...allow, rememberForSession: true });
      const second = (await t.send("again")).body as any;
      expect(second.status).toBe("requires_action");
    });

    it("does not remember tools whose needsApproval is a predicate", async () => {
      const agent = Object.assign(stubSdkAgent("approval"), {
        __runtime: { tools: [{ name: "deploy", needsApproval: () => true }] },
      });
      const t = await setup(agent);
      await t.send();
      await t.resolve("ap1", { ...allow, rememberForSession: true });
      const second = (await t.send("again")).body as any;
      expect(second.status).toBe("requires_action");
    });
  });
}

// ----------------------------------------------------------------------------
// A restart in the middle of a pause: the pause is whatever the store kept
// ----------------------------------------------------------------------------

function restartSuite(handle: () => OpenedProvider) {
  /** Pauses on one server instance, then continues on a brand new one over the re-opened store. */
  async function restarted(
    first: Awaited<ReturnType<typeof setup>>,
    agent: unknown | { handler: AgentHandler },
    extra: Partial<AgentServerConfig> = {}
  ) {
    const storage = await handle().reopen();
    return setup(agent, extra, { id: first.id, storage });
  }

  describe("a restart in the middle of a pause", () => {
    it("shows the pending action after the restart, with no null where a field was left out", async () => {
      const t = await setup(stubSdkAgent());
      await t.send();
      const after = await restarted(t, stubSdkAgent());
      const conv = await after.get();
      expect(conv.pendingActions).toHaveLength(1);
      expect(conv.pendingActions[0]).toMatchObject({ id: "ap1", type: "tool_approval", toolName: "deploy", args: { version: "1.0" } });
      expect(JSON.stringify(conv.pendingActions)).not.toContain("null");
      expect(conv.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
      expect(conv.messages[1].metadata).toMatchObject({ requiresAction: true });
      expect(JSON.stringify(conv.conversation)).not.toContain("__agentServerHitl");
    });

    it("resolves an approval on a new server and the agent gets the restored state", async () => {
      const t = await setup(stubSdkAgent());
      await t.send();
      const agent = stubSdkAgent();
      const after = await restarted(t, agent);
      const res = await after.resolve("ap1", { ...allow, comment: "go" });
      expect(res.status).toBe(200);
      expect((res.body as any).response.content).toBe("deployed");
      expect(agent.calls[0].pendingApprovals[0]).toMatchObject({ id: "ap1", status: "approved", comment: "go" });
      const conv = await after.get();
      expect(conv.pendingActions).toBeUndefined();
      expect(conv.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "assistant"]);
      expect((await after.resolve("ap1", allow)).status).toBe(409);
    });

    it("streams the continuation on a new server", async () => {
      const t = await setup(stubSdkAgent());
      const paused = await t.sendStream();
      expect(paused.events.map((e) => e.type)).toContain("stream.action_required");
      const after = await restarted(t, stubSdkAgent());
      const { events } = await after.resolveStream("ap1", allow);
      expect(events.map((e) => e.type)).toEqual([
        "stream.start",
        "stream.action_resolved",
        "stream.tool_call",
        "stream.tool_result",
        "stream.text",
        "stream.done",
      ]);
      expect((events.at(-1) as any).content).toBe("deployed");
    });

    it("answers a question on a new server", async () => {
      const t = await setup(stubSdkAgent("question"));
      await t.send();
      const agent = stubSdkAgent("question");
      const after = await restarted(t, agent);
      const res = await after.resolve("q1", { type: "user_question", answers: { "Which env?": "prod" } });
      expect(res.status).toBe(200);
      expect(agent.calls[0].pendingUserQuestions[0]).toMatchObject({ status: "answered" });
      expect(agent.calls[0].pendingUserQuestions[0].answers["Which env?"]).toEqual({ values: ["prod"] });
    });

    it("keeps refusing a new message while the action is pending", async () => {
      const t = await setup(stubSdkAgent());
      await t.send();
      const after = await restarted(t, stubSdkAgent());
      const res = await after.send("hello?");
      expect(res.status).toBe(409);
      expect((res.body as any).error.details.pendingActionIds).toEqual(["ap1"]);
    });

    it("keeps what the user asked to remember for the session", async () => {
      const t = await setup(stubSdkAgent());
      await t.send();
      await t.resolve("ap1", { ...allow, rememberForSession: true });
      const after = await restarted(t, stubSdkAgent());
      const second = (await after.send("again")).body as any;
      expect(second.status).toBeUndefined();
      expect(second.response.content).toBe("deployed");
    });

    it("a second pause survives a restart too", async () => {
      const t = await setup(stubSdkAgent("approval", { pausesEveryTime: true }));
      await t.send();
      // resolving on a new server pauses again (each stub instance numbers its pauses from 1)
      const mid = await restarted(t, stubSdkAgent("approval", { pausesEveryTime: true }));
      const again = (await mid.resolve("ap1", allow)).body as any;
      expect(again.status).toBe("requires_action");
      expect(again.pendingActions).toHaveLength(1);
      const last = await restarted(mid, stubSdkAgent());
      expect((await last.get()).pendingActions).toHaveLength(1);
      const done = (await last.resolve(again.pendingActions[0].id, allow)).body as any;
      expect(done.response.content).toBe("deployed");
      expect((await last.get()).pendingActions).toBeUndefined();
    });

    it("resolves a custom handler's action on a new server", async () => {
      const handler: AgentHandler = {
        async processMessage() {
          return {
            content: "needs a check",
            status: "requires_action",
            pendingActions: [{ id: "h1", type: "tool_approval", toolName: "wire", args: { amount: 5 } }],
            state: { step: 1 },
          };
        },
        async resolveAction(params) {
          return { content: `done at step ${(params.state as any)?.step}`, state: { step: 2 } };
        },
      };
      const t = await setup({ handler });
      await t.send();
      const after = await restarted(t, { handler });
      expect((await after.get()).pendingActions[0]).toMatchObject({ id: "h1", args: { amount: 5 } });
      const res = (await after.resolve("h1", allow)).body as any;
      expect(res.response.content).toBe("done at step 1");
      expect((await after.get()).conversation.state).toEqual({ step: 2 });
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
    hitlSuite();
    restartSuite(() => provider.current);
  });
}
