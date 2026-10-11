/**
 * Host-backed agents (`registerHostAgent`): an agent whose work runs in the host's own backend. It reports progress with typed
 * events, returns a typed result, and the server stores the messages, the pending actions, the events and the runtime status
 * itself - over every storage provider (memory, SQLite, MongoDB, PostgreSQL).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentServer, createInMemoryProvider, hostAgentRegistration } from "../src/index.js";
import type {
  AgentServerConfig,
  HostAgent,
  HostCancelInput,
  HostInvokeInput,
  HostResolveInput,
  HostRunIo,
  HostTurnResult,
  PendingAction,
  StorageProvider,
} from "../src/index.js";
import { Follower, eventually, gate, parseSse } from "./helpers.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider } from "./storage/providers.js";

let active: { current: OpenedProvider } | undefined;
const currentStorage = (): StorageProvider => active!.current.storage;

const allow = { type: "tool_approval", decision: "allow" } as const;
const deny = { type: "tool_approval", decision: "deny", comment: "no" } as const;

const approval = (id: string, extra: Partial<Extract<PendingAction, { type: "tool_approval" }>> = {}): PendingAction => ({
  id,
  type: "tool_approval",
  toolName: "deploy",
  args: { version: "1.0" },
  ...extra,
});

const question = (id: string): PendingAction => ({
  id,
  type: "user_question",
  questions: [{ question: "Which region?", options: [{ label: "eu" }, { label: "us" }] }],
});

type Behaviour = Partial<HostAgent> & {
  invoke?: HostAgent["invoke"];
};

/** A host agent that records what it is given. */
function recorder(behaviour: Behaviour = {}) {
  const invokes: HostInvokeInput[] = [];
  const resolves: HostResolveInput[] = [];
  const cancels: HostCancelInput[] = [];
  const ios: HostRunIo[] = [];
  const agent: HostAgent = {
    invoke: async (input, io) => {
      invokes.push(input);
      ios.push(io);
      return behaviour.invoke ? behaviour.invoke(input, io) : { content: "ok" };
    },
    ...(behaviour.resolveAction && {
      resolveAction: async (input, io) => {
        resolves.push(input);
        ios.push(io);
        return behaviour.resolveAction!(input, io);
      },
    }),
    cancel: async (input) => {
      cancels.push(input);
      await behaviour.cancel?.(input);
    },
  };
  return { agent, invokes, resolves, cancels, ios };
}

const quiet = (extra: Partial<AgentServerConfig> = {}): Partial<AgentServerConfig> => ({
  allowAnonymousList: true,
  ...extra,
  runs: { sweepIntervalMs: 0, recoverOnStart: false, ...(extra.runs ?? {}) },
});

async function boot(behaviour: Behaviour, config: Partial<AgentServerConfig> = {}, settings: Record<string, unknown> = {}) {
  const storage = currentStorage();
  const host = recorder(behaviour);
  const server = createAgentServer({ basePath: "/api", storage, ...quiet(config) });
  server.registerHostAgent({ info: { id: "h", name: "Host" }, ...host.agent, ...settings });
  const call = (method: string, path: string, extra: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}) =>
    server.handleRoute(method, path, { query: extra.query ?? {}, body: extra.body, headers: extra.headers });
  const id = ((await call("POST", "/conversations", { body: { agentId: "h" } })).body as any).conversation.id as string;
  const send = (message = "go", extra: Record<string, unknown> = {}) =>
    call("POST", `/conversations/${id}/messages`, { body: { message, ...extra } });
  const resolve = (actionId: string, resolution: Record<string, unknown> = allow, extra: Record<string, unknown> = {}) =>
    call("POST", `/conversations/${id}/actions/${actionId}`, { body: { resolution, ...extra } });
  const cancel = () => call("POST", `/conversations/${id}/cancel`);
  const get = async () => (await call("GET", `/conversations/${id}`)).body as any;
  const events = async () => ((await call("GET", `/conversations/${id}/events`)).body as any).events as any[];
  const types = async () => (await events()).map((e) => e.type as string);
  const drain = async (res: Awaited<ReturnType<typeof send>>) => {
    let text = "";
    for await (const chunk of res.stream!) text += chunk;
    return parseSse(text);
  };
  return { server, storage, host, id, call, send, resolve, cancel, get, events, types, drain };
}

/** Waits for the abort signal. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

function hostSuite() {
  describe("a turn", () => {
    it("turns events into the stored log and the legacy stream, and the result into the message", async () => {
      const t = await boot({
        invoke: (input, { emit }) => {
          emit({ type: "text", text: "Looking " });
          emit({ type: "tool_use", id: "c1", name: "search", args: { q: input.message } });
          emit({ type: "tool_result", id: "c1", result: { hits: 2 } });
          emit({ type: "tool_use", id: "c2", name: "fetch" });
          emit({ type: "tool_result", id: "c2", error: "boom" });
          emit({ type: "text", text: "done." });
          emit({ type: "usage", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });
          emit({ type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
          return { content: "Looking done." };
        },
      });
      const res = await t.send("find cats", { stream: true });
      const frames = await t.drain(res);
      expect(frames.map((f) => f.type)).toEqual([
        "stream.start",
        "stream.text",
        "stream.tool_call",
        "stream.tool_result",
        "stream.tool_call",
        "stream.tool_result",
        "stream.text",
        "stream.done",
      ]);
      expect(frames.find((f) => f.type === "stream.tool_call")).toMatchObject({ toolName: "search", toolCallId: "c1", args: { q: "find cats" } });
      expect(frames.filter((f) => f.type === "stream.tool_result")[1]).toMatchObject({ toolName: "fetch", result: { error: "boom" } });
      expect(frames.at(-1)).toMatchObject({
        type: "stream.done",
        content: "Looking done.",
        stopReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      });

      const log = await t.events();
      expect(log.map((e) => e.type)).toEqual([
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
      expect(log.find((e) => e.type === "agent.tool_result" && e.data.tool_call_id === "c2")!.data).toMatchObject({ ok: false, error: "boom", name: "fetch" });
      expect(log.find((e) => e.type === "session.status_idle")!.data).toEqual({ stop_reason: "end_turn" });
      expect(new Set(log.map((e) => e.run_id).filter(Boolean)).size).toBe(1);

      const stored = (await t.get()).messages as any[];
      expect(stored.map((m) => [m.role, m.content])).toEqual([["user", "find cats"], ["assistant", "Looking done."]]);
      expect(stored[1]).toMatchObject({ status: "completed", metadata: { stopReason: "end_turn" } });
      expect((await t.get()).conversation.runtime).toMatchObject({ status: "idle", stopReason: "end_turn" });
    });

    it("hands the agent the message, the history, the run, the files and the context", async () => {
      const t = await boot({ invoke: async () => ({ content: "first" }) });
      await t.send("one");
      const res = await t.send("two", { metadata: { channel: "web" } });
      const input = t.host.invokes[1]!;
      expect(input).toMatchObject({ conversationId: t.id, message: "two", files: [], metadata: { channel: "web" } });
      expect(input.runId).toBe((res.body as any).runId);
      expect(input.history.map((m) => [m.role, m.content])).toEqual([["user", "one"], ["assistant", "first"], ["user", "two"]]);
      expect(input.context.data).toBeDefined();
    });

    it("uses the streamed text as the answer when the result has none", async () => {
      const t = await boot({
        invoke: (_i, { emit }) => {
          emit({ type: "text", text: "all " });
          emit({ type: "text", text: "streamed" });
          return {};
        },
      });
      const res = await t.send("hi");
      expect((res.body as any).response.content).toBe("all streamed");
      expect(((await t.get()).messages as any[]).at(-1).content).toBe("all streamed");
    });

    it("sends the whole answer once to a streaming request when nothing was streamed", async () => {
      const t = await boot({ invoke: async () => ({ content: "whole answer" }) });
      const frames = await t.drain(await t.send("hi", { stream: true }));
      expect(frames.filter((f) => f.type === "stream.text")).toEqual([expect.objectContaining({ text: "whole answer", isFinal: true })]);
    });

    it("reports how the turn stopped: the result wins over the emitted stop", async () => {
      const t = await boot({
        invoke: (_i, { emit }) => {
          emit({ type: "stop", stopReason: "limit", detail: "emitted" });
          return { content: "cut short", stopReason: "max_turns", detail: "ten turns" };
        },
      });
      const res = await t.send("hi");
      expect(res.body as any).toMatchObject({ status: "incomplete", stopReason: "max_turns", response: { status: "incomplete", metadata: { stopReason: "max_turns" } } });
      const idle = (await t.events()).find((e) => e.type === "session.status_idle")!;
      expect(idle.data).toEqual({ stop_reason: "max_turns", detail: "ten turns" });
      expect((await t.get()).conversation.runtime).toMatchObject({ status: "idle", stopReason: "max_turns" });
      // the emitted stop alone is enough
      const t2 = await boot({ invoke: (_i, { emit }) => (emit({ type: "stop", stopReason: "limit" }), { content: "x" }) });
      expect((await t2.send("hi")).body).toMatchObject({ stopReason: "limit" });
    });

    it("lets the result's usage replace the emitted usage, and prices it for budgets", async () => {
      const pricing = (model: string) => (model === "m" ? { inputPerToken: 0.001, outputPerToken: 0.002 } : undefined);
      const t = await boot(
        {
          invoke: (_i, { emit }) => {
            emit({ type: "usage", usage: { inputTokens: 999, outputTokens: 999 } });
            return { content: "ok", usage: { inputTokens: 100, outputTokens: 50, model: "m" } };
          },
        },
        { pricing }
      );
      const res = await t.send("hi");
      expect((res.body as any).usage).toEqual({ inputTokens: 100, outputTokens: 50, costUsd: 0.2 });
      expect((await t.get()).conversation.spentUsd).toBe(0.2);
    });

    it("stops a conversation whose host-reported cost used up the budget", async () => {
      const t = await boot(
        { invoke: async () => ({ content: "pricey", usage: { costUsd: 0.05 } }) },
        { pricing: () => undefined },
        { budget: { maxCostUsd: 0.04, onReach: "stop" } }
      );
      const res = await t.send("hi");
      expect(res.body as any).toMatchObject({ stopReason: "budget_reached", spentUsd: 0.05 });
      const again = await t.send("more");
      expect(again.status).toBe(402);
      expect((again.body as any).error.code).toBe("budget_reached");
      expect(t.host.invokes).toHaveLength(1);
    });

    it("ignores a malformed event with a warning and goes on", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const t = await boot({
          invoke: (_i, { emit }) => {
            emit({ type: "tool_use", id: "", name: "x" } as any);
            emit({ type: "mystery" } as any);
            emit(null as any);
            emit({ type: "text", text: "fine" });
            return { content: "fine" };
          },
        });
        const res = await t.send("hi");
        expect(res.status).toBe(200);
        expect(await t.types()).not.toContain("agent.tool_use");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain("Host");
      } finally {
        warn.mockRestore();
      }
    });

    it("drops events that arrive after the turn ended", async () => {
      let late: HostRunIo["emit"] | undefined;
      const t = await boot({
        invoke: (_i, io) => {
          late = io.emit;
          return { content: "ok" };
        },
      });
      await t.send("hi");
      const before = await t.types();
      late!({ type: "tool_use", id: "z", name: "late" });
      late!({ type: "text", text: "late" });
      await new Promise((r) => setTimeout(r, 20));
      expect(await t.types()).toEqual(before);
    });

    it("fails a turn whose result is not a result: 500, the log says so, the conversation works again", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        let calls = 0;
        const t = await boot({ invoke: async () => (++calls === 1 ? ("nope" as any) : { content: "fine now" }) });
        const res = await t.send("hi");
        expect(res.status).toBe(500);
        expect((res.body as any).error.code).toBe("invalid_host_result");
        expect(await t.types()).toEqual(expect.arrayContaining(["session.error", "session.status_idle"]));
        expect((await t.get()).conversation.runtime).toMatchObject({ status: "idle", stopReason: "error" });
        expect((await t.send("again")).status).toBe(200);
      } finally {
        errors.mockRestore();
      }
    });

    it.each([
      ["a content that is not text", { content: 42 }],
      ["a status it does not know", { content: "x", status: "weird" }],
      ["a stop reason it does not know", { content: "x", stopReason: "weird" }],
      ["a pending action without an id", { content: "x", pendingActions: [{ type: "tool_approval", toolName: "t" }] }],
      ["a pending action of an unknown type", { content: "x", pendingActions: [{ id: "a", type: "poll" }] }],
      ["two actions with one id", { content: "x", pendingActions: [approval("a"), approval("a")] }],
      ["an expiry that is no date", { content: "x", pendingActions: [approval("a", { expiresAt: "someday" })] }],
      ["files without a size", { content: "x", files: [{ id: "f", name: "n", mimeType: "text/plain" }] }],
    ])("refuses %s", async (_what, result) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const t = await boot({ invoke: async () => result as any });
        const res = await t.send("hi");
        expect(res.status).toBe(500);
        expect((res.body as any).error.code).toBe("invalid_host_result");
        // nothing half-made is left behind: no pause, no assistant message
        const body = await t.get();
        expect(body.pendingActions).toBeUndefined();
        expect(body.messages.map((m: any) => m.role)).toEqual(["user"]);
      } finally {
        errors.mockRestore();
      }
    });

    it("works as a task: it completes with the answer, in a conversation of its own", async () => {
      const t = await boot({ invoke: async (input) => ({ content: `did: ${input.message}` }) });
      const created = (await t.call("POST", "/tasks", { body: { agentId: "h", input: "the job" } })).body as any;
      const done = await eventually(async () => {
        const body = (await t.call("GET", `/tasks/${created.task.id}`)).body as any;
        return body.task.status === "completed" ? body : undefined;
      }, 4000, "the task to complete");
      expect(done.result.content).toBe("did: the job");
      expect(done.task.conversationId).toMatch(/^conv_/);
    });

    it("works as a task that waits for a person: the answer comes on the task's conversation", async () => {
      const t = await boot({
        invoke: async () => ({ content: "", pendingActions: [approval("ap1")] }),
        resolveAction: async () => ({ content: "approved and done" }),
      });
      const created = (await t.call("POST", "/tasks", { body: { agentId: "h", input: "deploy it" } })).body as any;
      const waiting = await eventually(async () => {
        const body = (await t.call("GET", `/tasks/${created.task.id}`)).body as any;
        return body.task.status === "waiting_for_input" ? body : undefined;
      }, 4000, "the task to wait");
      expect(waiting.pendingActions).toEqual([expect.objectContaining({ id: "ap1", toolName: "deploy" })]);
      const answered = await t.call("POST", `/conversations/${waiting.task.conversationId}/actions/ap1`, { body: { resolution: allow } });
      expect(answered.status).toBe(200);
      const done = await eventually(async () => {
        const body = (await t.call("GET", `/tasks/${created.task.id}`)).body as any;
        return body.task.status === "completed" ? body : undefined;
      }, 4000, "the task to complete");
      expect(done.result.content).toBe("approved and done");
    });
  });

  describe("pausing and resolving", () => {
    it("stores a pause from the result, announces it afterwards, and continues from the full answer", async () => {
      const t = await boot({
        invoke: (_i, { emit }) => {
          emit({ type: "text", text: "I need your OK." });
          return { content: "I need your OK.", pendingActions: [approval("ap1", { title: "Deploy 1.0?", summary: "ships it" })] };
        },
        resolveAction: async (_i, { emit }) => {
          emit({ type: "tool_use", id: "c1", name: "deploy", args: { version: "2.0" } });
          emit({ type: "tool_result", id: "c1", result: "ok" });
          return { content: "deployed" };
        },
      });
      const sent = await t.send("ship it", { stream: true });
      const frames = await t.drain(sent);
      const required = frames.find((f) => f.type === "stream.action_required") as any;
      expect(required.actions[0]).toMatchObject({ id: "ap1", type: "tool_approval", toolName: "deploy", title: "Deploy 1.0?", summary: "ships it" });
      const done = frames.at(-1) as any;
      expect(done).toMatchObject({ type: "stream.done", status: "requires_action", stopReason: "requires_action" });
      // persisted before it was announced
      const paused = await t.get();
      expect(paused.pendingActions.map((a: any) => a.id)).toEqual(["ap1"]);
      expect(paused.conversation.runtime).toMatchObject({ status: "requires_action", pendingActionIds: ["ap1"] });
      expect((paused.messages as any[]).at(-1)).toMatchObject({
        status: "requires_action",
        metadata: { requiresAction: true, pendingActions: [{ id: "ap1", status: "pending", title: "Deploy 1.0?" }] },
      });
      // no agent state of the host's making is kept by the server
      expect(JSON.stringify(paused.conversation.state ?? {})).not.toContain("sdkState");
      expect(await t.types()).toEqual(expect.arrayContaining(["action.required"]));

      const edited = { type: "tool_approval", decision: "allow", approvedArgs: { version: "2.0" }, rememberForSession: true, comment: "ok" };
      const res = await t.resolve("ap1", edited);
      expect(res.status).toBe(200);
      expect(res.body as any).toMatchObject({ response: { content: "deployed", status: "completed" }, stopReason: "end_turn" });
      expect(t.host.resolves).toHaveLength(1);
      expect(t.host.resolves[0]).toMatchObject({
        conversationId: t.id,
        actionId: "ap1",
        action: { id: "ap1", toolName: "deploy" },
        resolution: edited,
        pendingActions: [],
        channel: "api",
        actor: "anonymous",
      });
      expect(t.host.resolves[0]!.runId).toBe((res.body as any).runId);
      const settled = ((await t.get()).messages as any[]).find((m) => m.metadata?.pendingActions);
      expect(settled.metadata.pendingActions[0]).toMatchObject({ id: "ap1", status: "resolved", resolution: { decision: "allow" } });
      expect(settled.metadata.requiresAction).toBeUndefined();
      expect((await t.get()).conversation.runtime).toMatchObject({ status: "idle", stopReason: "end_turn", pendingActionIds: [] });
      expect(await t.types()).toEqual(expect.arrayContaining(["action.resolved", "agent.tool_use", "agent.tool_result", "session.work_done"]));
    });

    it("takes a pause the agent only emitted", async () => {
      const t = await boot({
        invoke: (_i, { emit }) => {
          emit({ type: "action_required", actions: [question("q1")] });
          emit({ type: "action_required", actions: [question("q1")] }); // (the same action again is the same action)
          return { content: "" };
        },
        resolveAction: async () => ({ content: "eu it is" }),
      });
      const res = await t.send("where?");
      expect(res.body as any).toMatchObject({ status: "requires_action", stopReason: "requires_action", pendingActions: [{ id: "q1", type: "user_question" }] });
      expect((res.body as any).pendingActions).toHaveLength(1);
      const answered = await t.resolve("q1", { type: "user_question", answers: { "Which region?": "eu" } });
      expect(answered.status).toBe(200);
      expect(t.host.resolves[0]!.resolution).toEqual({ type: "user_question", answers: { "Which region?": "eu" } });
    });

    it("lets the result's pending actions replace the emitted ones", async () => {
      const t = await boot({
        invoke: (_i, { emit }) => {
          emit({ type: "action_required", actions: [approval("old")] });
          return { content: "", pendingActions: [approval("new")] };
        },
      });
      expect(((await t.send("go")).body as any).pendingActions.map((a: any) => a.id)).toEqual(["new"]);
    });

    it("calls the agent once per answered action, and the result replaces what is still open", async () => {
      const t = await boot({
        invoke: async () => ({ content: "two things", pendingActions: [approval("a"), approval("b", { toolName: "migrate" })] }),
        resolveAction: async (input) =>
          input.pendingActions.length > 0
            ? { content: "", pendingActions: input.pendingActions }
            : { content: "both done" },
      });
      await t.send("go");
      const first = await t.resolve("a", allow);
      expect(first.status).toBe(200);
      expect(first.body as any).toMatchObject({ status: "requires_action", pendingActions: [{ id: "b" }] });
      expect(t.host.resolves[0]!.pendingActions.map((a) => a.id)).toEqual(["b"]);
      expect((await t.get()).conversation.runtime).toMatchObject({ status: "requires_action", pendingActionIds: ["b"] });

      const second = await t.resolve("b", deny);
      expect(second.body as any).toMatchObject({ response: { content: "both done" }, stopReason: "end_turn" });
      expect(t.host.resolves[1]).toMatchObject({ actionId: "b", resolution: { decision: "deny", comment: "no" }, pendingActions: [] });
      expect((await t.get()).conversation.runtime.status).toBe("idle");
    });

    it("only records an answer when the agent says it still waits on the rest: no new message", async () => {
      const t = await boot({
        invoke: async () => ({ content: "two things", pendingActions: [approval("a"), approval("b", { toolName: "migrate" })] }),
        resolveAction: async (input) => (input.pendingActions.length > 0 ? { pendingActions: input.pendingActions } : { content: "both done" }),
      });
      await t.send("go");
      const before = ((await t.get()).messages as any[]).map((m) => m.id);
      const first = await t.resolve("a", allow);
      expect(first.body as any).toMatchObject({ status: "requires_action", stopReason: "requires_action", pendingActions: [{ id: "b" }] });
      expect(first.body.response.id).toBe(before.at(-1)); // the message that asked

      const after = await t.get();
      expect((after.messages as any[]).map((m) => m.id)).toEqual(before);
      const asked = (after.messages as any[]).at(-1);
      expect(asked.metadata.requiresAction).toBe(true);
      expect(asked.metadata.pendingActions.map((a: any) => [a.id, a.status])).toEqual([["a", "resolved"], ["b", "pending"]]);
      expect(after.pendingActions.map((a: any) => a.id)).toEqual(["b"]);
      expect(after.conversation.runtime).toMatchObject({ status: "requires_action", pendingActionIds: ["b"] });
      const log = await t.types();
      expect(log.at(-1)).toBe("session.status_idle");

      const last = await t.resolve("b", allow);
      expect(last.body as any).toMatchObject({ response: { content: "both done" }, stopReason: "end_turn" });
      const done = ((await t.get()).messages as any[]).find((m) => m.id === before.at(-1));
      expect(done.metadata.pendingActions.map((a: any) => a.status)).toEqual(["resolved", "resolved"]);
      expect(done.metadata.requiresAction).toBeUndefined();
    });

    it("withdraws, on the message that asked, the open requests the agent no longer reports", async () => {
      const t = await boot({
        invoke: async () => ({ content: "", pendingActions: [approval("a"), approval("b", { toolName: "migrate" })] }),
        resolveAction: async () => ({ content: "decided without b" }),
      });
      await t.send("go");
      const res = await t.resolve("a", allow);
      expect(res.body as any).toMatchObject({ response: { content: "decided without b" }, stopReason: "end_turn" });
      const asked = ((await t.get()).messages as any[]).find((m) => m.metadata?.pendingActions);
      expect(asked.metadata.pendingActions.map((a: any) => [a.id, a.status, a.resolvedBy])).toEqual([["a", "resolved", "anonymous"], ["b", "cancelled", "system"]]);
      expect(asked.metadata.requiresAction).toBeUndefined();
      expect((await t.get()).pendingActions).toBeUndefined();
      const withdrawn = (await t.events()).filter((e) => e.type === "action.resolved" && e.data.action_id === "b");
      expect(withdrawn).toHaveLength(1);
      expect(withdrawn[0]!.data).toMatchObject({ status: "cancelled", resolved_by: "system" });
      expect((await t.send("next")).status).toBe(200);
    });

    it("asks a request again, changed, on its reply, and withdraws the old one", async () => {
      const t = await boot({
        invoke: async () => ({ content: "", pendingActions: [approval("a"), approval("b", { args: { target: "staging" } })] }),
        resolveAction: async () => ({ content: "b changed", pendingActions: [approval("b", { args: { target: "production" } })] }),
      });
      await t.send("go");
      const res = await t.resolve("a", allow);
      expect(res.body as any).toMatchObject({ status: "requires_action", pendingActions: [{ id: "b", args: { target: "production" } }] });
      const messages = (await t.get()).messages as any[];
      expect(messages.at(-1)).toMatchObject({ content: "b changed", metadata: { requiresAction: true } });
      const old = messages.find((m) => m.metadata?.pendingActions?.some((a: any) => a.id === "a"));
      expect(old.metadata.pendingActions.map((a: any) => [a.id, a.status])).toEqual([["a", "resolved"], ["b", "cancelled"]]);
      expect((await t.get()).pendingActions[0].args).toEqual({ target: "production" });
    });

    it("lets a resolved turn pause again", async () => {
      const t = await boot({
        invoke: async () => ({ content: "", pendingActions: [approval("a")] }),
        resolveAction: async (input) =>
          input.actionId === "a" ? { content: "one more", pendingActions: [question("b")] } : { content: "finished" },
      });
      await t.send("go");
      const again = await t.resolve("a");
      expect(again.body as any).toMatchObject({ status: "requires_action", pendingActions: [{ id: "b", type: "user_question" }] });
      const last = await t.resolve("b", { type: "user_question", answers: { "Which region?": "us" } });
      expect(last.body as any).toMatchObject({ response: { content: "finished" }, stopReason: "end_turn" });
    });

    it("answers 409 to an action that is not pending, and 400 to an answer of the wrong kind", async () => {
      const t = await boot({
        invoke: async () => ({ content: "", pendingActions: [approval("a")] }),
        resolveAction: async () => ({ content: "ok" }),
      });
      await t.send("go");
      const wrong = await t.resolve("a", { type: "user_question", answers: {} });
      expect(wrong.status).toBe(400);
      expect((await t.resolve("nope")).status).toBe(409);
      expect((await t.resolve("a")).status).toBe(200);
      const twice = await t.resolve("a");
      expect(twice.status).toBe(409);
      expect((twice.body as any).error.code).toBe("action_not_pending");
      expect(t.host.resolves).toHaveLength(1);
    });

    it("has no way to continue an agent that cannot resolve: its actions answer 404", async () => {
      const t = await boot({ invoke: async () => ({ content: "", pendingActions: [approval("a")] }) });
      await t.send("go");
      expect((await t.resolve("a")).status).toBe(404);
    });

    it("streams the continuation of a resolved action", async () => {
      const t = await boot({
        invoke: async () => ({ content: "", pendingActions: [approval("a")] }),
        resolveAction: async (_i, { emit }) => {
          emit({ type: "text", text: "continued" });
          return {};
        },
      });
      await t.send("go");
      const frames = await t.drain(await t.call("POST", `/conversations/${t.id}/actions/a`, { body: { resolution: allow, stream: true } }));
      expect(frames.map((f) => f.type)).toEqual(["stream.start", "stream.action_resolved", "stream.text", "stream.done"]);
      expect(frames.at(-1)).toMatchObject({ content: "continued", stopReason: "end_turn" });
    });

    it("answers a request that lapsed: the agent hears it as a refusal from the system, or a cancel", async () => {
      const t = await boot(
        {
          invoke: async () => ({ content: "", pendingActions: [approval("a", { expiresAt: new Date(Date.now() + 60_000).toISOString() })] }),
          resolveAction: async () => ({ content: "carrying on without you" }),
        },
        { hitl: { onTimeout: "deny" } }
      );
      await t.send("go");
      await t.server.expirePendingActions({ now: new Date(Date.now() + 120_000), conversationId: t.id });
      expect(t.host.resolves).toHaveLength(1);
      expect(t.host.resolves[0]).toMatchObject({ actionId: "a", channel: "timeout", expired: true, actor: "system:timeout", resolution: { decision: "deny" } });
      expect(((await t.get()).messages as any[]).at(-1)).toMatchObject({ content: "carrying on without you" });

      const c = await boot(
        {
          invoke: async () => ({ content: "", pendingActions: [approval("a", { expiresAt: new Date(Date.now() + 60_000).toISOString() })] }),
          resolveAction: async () => ({ content: "never" }),
        },
        { hitl: { onTimeout: "cancel" } }
      );
      await c.send("go");
      await c.server.expirePendingActions({ now: new Date(Date.now() + 120_000), conversationId: c.id });
      expect(c.host.resolves).toHaveLength(0);
      expect(c.host.cancels).toEqual([expect.objectContaining({ conversationId: c.id, reason: "expired", actions: [expect.objectContaining({ id: "a" })] })]);
    });
  });

  describe("cancelling", () => {
    it("aborts the signal, tells the agent, and keeps what it said", async () => {
      const started = gate();
      let signal: AbortSignal | undefined;
      let calls = 0;
      const t = await boot({
        invoke: async (_i, io) => {
          if (++calls > 1) return { content: "fine now" };
          signal = io.signal;
          io.emit({ type: "text", text: "I was saying " });
          started.open();
          await untilAborted(io.signal);
          return { content: "" };
        },
      });
      const res = await t.send("talk", { stream: true });
      const mine = new Follower(res as any);
      await started.promise;
      const cancelled = await t.cancel();
      expect(cancelled.body).toMatchObject({ cancelled: true, settled: true, stopReason: "cancelled" });
      expect(signal!.aborted).toBe(true);
      await mine.until((f) => f.ended);
      const done = mine.frames.map((f) => f.data).filter(Boolean).find((d: any) => d.type === "stream.done");
      expect(done).toMatchObject({ status: "cancelled", stopReason: "cancelled", content: "I was saying " });
      await eventually(() => t.host.cancels.length === 1);
      expect(t.host.cancels[0]).toMatchObject({ conversationId: t.id, reason: "user", runId: expect.stringMatching(/^run_/) });
      expect((await t.get()).conversation.runtime).toMatchObject({ status: "idle", stopReason: "cancelled" });
      expect((await t.send("again")).status).toBe(200);
    });

    it("abandons an agent that ignores the signal after the grace period", async () => {
      let calls = 0;
      const t = await boot(
        { invoke: () => (++calls > 1 ? Promise.resolve({ content: "fine now" }) : new Promise<HostTurnResult>(() => undefined)) },
        { runs: { cancelGraceMs: 30 } }
      );
      const sending = t.send("hang");
      await eventually(() => t.host.invokes.length === 1);
      await t.cancel();
      const sent = await sending;
      expect(sent.body as any).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
      expect((await t.send("again")).status).toBe(200);
    });

    it("tells the agent when the requests it holds are withdrawn or the conversation is deleted", async () => {
      const t = await boot({
        invoke: async () => ({ content: "", pendingActions: [approval("a")] }),
        resolveAction: async () => ({ content: "never" }),
      });
      await t.send("go");
      const cancelled = await t.cancel();
      expect(cancelled.body as any).toMatchObject({ cancelled: true, cancelledActionIds: ["a"] });
      expect(t.host.cancels).toEqual([expect.objectContaining({ conversationId: t.id, reason: "withdrawn", actions: [expect.objectContaining({ id: "a" })] })]);
      expect(t.host.cancels[0]!.runId).toBeUndefined();

      const d = await boot({ invoke: async () => ({ content: "", pendingActions: [approval("a")] }), resolveAction: async () => ({ content: "x" }) });
      await d.send("go");
      expect((await d.call("DELETE", `/conversations/${d.id}`)).status).toBe(204);
      expect(d.host.cancels).toEqual([expect.objectContaining({ reason: "deleted", actions: [expect.objectContaining({ id: "a" })] })]);
    });

    it("tells the agent when a new message withdraws the open requests (pendingActionPolicy cancel)", async () => {
      let calls = 0;
      const t = await boot(
        {
          invoke: async () => (++calls === 1 ? { content: "", pendingActions: [approval("a")] } : { content: "moved on" }),
          resolveAction: async () => ({ content: "never" }),
        },
        { pendingActionPolicy: "cancel" }
      );
      await t.send("go");
      expect((await t.send("never mind")).status).toBe(200);
      expect(t.host.cancels).toEqual([expect.objectContaining({ reason: "withdrawn", actions: [expect.objectContaining({ id: "a" })] })]);
    });

    it("does not let a failing cancel hook fail the request", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const t = await boot({
          invoke: async () => ({ content: "", pendingActions: [approval("a")] }),
          resolveAction: async () => ({ content: "x" }),
          cancel: async () => {
            throw new Error("backend is down");
          },
        });
        await t.send("go");
        expect((await t.cancel()).status).toBe(200);
        expect(errors).toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it("does not hold the conversation for a cancel hook that never answers", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const t = await boot(
          {
            invoke: async () => ({ content: "", pendingActions: [approval("a")] }),
            resolveAction: async () => ({ content: "x" }),
            cancel: () => new Promise<void>(() => undefined),
          },
          { runs: { cancelGraceMs: 40 } }
        );
        await t.send("go");
        const started = Date.now();
        expect((await t.cancel()).status).toBe(200);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(String(errors.mock.calls.at(-1)?.[0])).toContain("cancel hook");
        expect((await t.get()).conversation.runtime.status).toBe("idle");
      } finally {
        errors.mockRestore();
      }
    });

    it("refuses a second message while a turn is running", async () => {
      const inside = gate();
      const release = gate();
      const t = await boot({
        invoke: async () => {
          inside.open();
          await release.promise;
          return { content: "done" };
        },
      });
      const first = t.send("one");
      await inside.promise;
      const second = await t.send("two");
      expect(second.status).toBe(409);
      expect((second.body as any).error.code).toBe("conversation_busy");
      expect((await t.get()).conversation.runtime.status).toBe("running");
      release.open();
      expect((await first).status).toBe(200);
    });
  });

  describe("files", () => {
    it("reads the conversation's files and no others", async () => {
      const t = await boot({
        invoke: async (input, io) => {
          const listed = await io.files.list();
          const text = await io.files.text(input.files[0]!.id);
          const bytes = await io.files.read(input.files[0]!.id);
          const stranger = await io.files.read("file_not_mine");
          return { content: JSON.stringify({ listed: listed.map((f) => f.name), text, size: bytes?.length, stranger, attached: input.files.map((f) => f.name) }) };
        },
      });
      const upload = (await t.call("POST", "/files", {
        body: { file: { name: "notes.txt", content: Buffer.from("remember the milk").toString("base64"), mimeType: "text/plain" }, conversationId: t.id },
      })).body as any;
      const other = await t.call("POST", "/conversations", { body: { agentId: "h" } });
      const otherId = (other.body as any).conversation.id as string;
      const stray = (await t.call("POST", "/files", {
        body: { file: { name: "stray.txt", content: Buffer.from("not yours").toString("base64"), mimeType: "text/plain" }, conversationId: otherId },
      })).body as any;

      const res = await t.send("read it", { fileIds: [upload.file.id] });
      expect(res.status).toBe(200);
      expect(JSON.parse((res.body as any).response.content)).toEqual({
        listed: ["notes.txt"],
        text: "remember the milk",
        size: 17,
        stranger: null,
        attached: ["notes.txt"],
      });
      // a file of another conversation is not reachable by its id either
      let reached: unknown = "untouched";
      const peek = recorder({ invoke: async (_i, io) => ((reached = await io.files.read(stray.file.id)), { content: "x" }) });
      t.server.registerHostAgent({ info: { id: "peek", name: "Peek" }, ...peek.agent });
      const peeking = ((await t.call("POST", "/conversations", { body: { agentId: "peek" } })).body as any).conversation.id as string;
      await t.call("POST", `/conversations/${peeking}/messages`, { body: { message: "peek" } });
      expect(reached).toBeNull();
    });

    it("also hands the readers to resolveAction", async () => {
      let text: string | null = "untouched";
      const t = await boot({
        invoke: async () => ({ content: "", pendingActions: [approval("a")] }),
        resolveAction: async (_i, io) => {
          const [file] = await io.files.list();
          text = file ? await io.files.text(file.id) : null;
          return { content: "read" };
        },
      });
      await t.call("POST", "/files", {
        body: { file: { name: "n.txt", content: Buffer.from("hello").toString("base64"), mimeType: "text/plain" }, conversationId: t.id },
      });
      await t.send("go");
      await t.resolve("a");
      expect(text).toBe("hello");
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
    hostSuite();
  });
}

// ----------------------------------------------------------------------------
// Registration (no storage needed)
// ----------------------------------------------------------------------------

describe("host agent registration", () => {
  const server = () => createAgentServer({ basePath: "/api", storage: createInMemoryProvider() });

  it("refuses a definition that cannot work, at registration", () => {
    expect(() => server().registerHostAgent(undefined as any)).toThrow(/definition/);
    expect(() => server().registerHostAgent({ info: { id: "", name: "x" }, invoke: async () => ({}) } as any)).toThrow(/info\.id/);
    expect(() => server().registerHostAgent({ info: { id: "h", name: "x" } } as any)).toThrow(/invoke/);
    expect(() => server().registerHostAgent({ info: { id: "h", name: "x" }, invoke: async () => ({}), resolveAction: "no" } as any)).toThrow(/resolveAction/);
    expect(() => server().registerHostAgent({ info: { id: "h", name: "x" }, invoke: async () => ({}), cancel: 1 } as any)).toThrow(/cancel/);
  });

  it("lists the agent like any other, with the settings it came with", () => {
    const s = server();
    s.registerHostAgent({
      info: { id: "h", name: "Host", description: "d", capabilities: { toolApproval: true } },
      invoke: async () => ({}),
      files: { enabled: false },
    });
    expect(s.getAgents()).toEqual([
      expect.objectContaining({ id: "h", name: "Host", description: "d", capabilities: expect.objectContaining({ toolApproval: true, attachments: expect.objectContaining({ enabled: false }) }) }),
    ]);
    expect(s.getAgent("h")!.host).toBeDefined();
  });

  it("keeps the `this` of a class instance", async () => {
    class Backend implements HostAgent {
      info = { id: "cls", name: "Class" };
      answer = "from the instance";
      async invoke() {
        return { content: this.answer };
      }
    }
    const instance = new Backend();
    const registration = hostAgentRegistration({ info: instance.info, invoke: instance.invoke.bind(instance) });
    expect(await registration.host!.invoke({} as any, {} as any)).toEqual({ content: "from the instance" });
    const viaMethod = hostAgentRegistration(instance);
    expect(await viaMethod.host!.invoke({} as any, {} as any)).toEqual({ content: "from the instance" });
  });

  it("can be served per request: `config.agents` returns the registration", async () => {
    const { memoryStorage } = await import("./helpers.js");
    const host = recorder({ invoke: async (input) => ({ content: `hello ${(input.context.data as any).tenant}` }) });
    const s = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      allowAnonymousList: true,
      resolveContext: (req) => ({ user: { id: "u" }, data: { tenant: String(req.headers["x-tenant"] ?? "none") } }),
      agents: (ctx) => [hostAgentRegistration({ info: { id: `dyn-${(ctx.data as any).tenant}`, name: "Dyn" }, ...host.agent })],
    });
    const headers = { "x-tenant": "acme" };
    const created = await s.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "dyn-acme" }, headers });
    const id = (created.body as any).conversation.id as string;
    const sent = await s.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message: "hi" }, headers });
    expect((sent.body as any).response.content).toBe("hello acme");
    // the agent only exists for the tenant that has it
    expect((await s.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "dyn-acme" }, headers: { "x-tenant": "other" } })).status).toBe(404);
  });
});
