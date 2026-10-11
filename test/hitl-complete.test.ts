/**
 * Human-in-the-loop, completely: answers that do not lose each other, requests that lapse, who may answer, the record
 * an answer leaves on the paused message, edited arguments that are checked, remembered tools, previews - and usage,
 * budgets and "continue". Every test runs over memory, SQLite, MongoDB and PostgreSQL.
 */

import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentServer } from "../src/index.js";
import type { AgentHandler, AgentServerConfig, PendingAction, StorageProvider } from "../src/index.js";
import { eventually, gate, parseSse } from "./helpers.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider, ProviderHarness } from "./storage/providers.js";
import { pausingStub, steppingStub, testPricing } from "./sdk-stubs.js";

let active: { current: OpenedProvider } | undefined;
const currentStorage = (): StorageProvider => active!.current.storage;

const allow = { type: "tool_approval", decision: "allow" } as const;
const deny = { type: "tool_approval", decision: "deny" } as const;

/** A server that does its sweeping only when the test says so. */
const quiet = (extra: Partial<AgentServerConfig> = {}): Partial<AgentServerConfig> => ({
  // (single-user tests: the conversations list is theirs)
  allowAnonymousList: true,
  ...extra,
  runs: { sweepIntervalMs: 0, recoverOnStart: false, ...(extra.runs ?? {}) },
});

type AgentLike = unknown | { handler: AgentHandler };

async function boot(
  agent: AgentLike,
  extra: Partial<AgentServerConfig> = {},
  options: { storage?: StorageProvider; headers?: Record<string, string>; registration?: Record<string, unknown> } = {}
) {
  const storage = options.storage ?? currentStorage();
  const registration =
    agent && typeof agent === "object" && "handler" in (agent as object)
      ? { info: { id: "a", name: "A" }, handler: (agent as { handler: AgentHandler }).handler, ...options.registration }
      : { info: { id: "a", name: "A" }, sdkAgent: agent, ...options.registration };
  const server = createAgentServer({ basePath: "/api", storage, agents: [registration as any], ...quiet(extra) });
  const headers = options.headers;

  const call = (method: string, path: string, body?: unknown, query: Record<string, string> = {}, h = headers) =>
    server.handleRoute(method, path, { query, body, ...(h ? { headers: h } : {}) });
  const create = async (body: Record<string, unknown> = {}) => {
    const res = await call("POST", "/conversations", { agentId: "a", ...body });
    return res;
  };
  const created = await create();
  const id = (created.body as any).conversation.id as string;

  const t = {
    server,
    storage,
    id,
    call,
    create,
    send: (message = "deploy it", body: Record<string, unknown> = {}) => call("POST", `/conversations/${id}/messages`, { message, ...body }),
    resolve: (actionId: string, resolution: unknown, body: Record<string, unknown> = {}) =>
      call("POST", `/conversations/${id}/actions/${actionId}`, { resolution, ...body }),
    get: async () => (await call("GET", `/conversations/${id}`)).body as any,
    patch: (body: Record<string, unknown>) => call("PATCH", `/conversations/${id}`, body),
    cont: (body: Record<string, unknown> = {}) => call("POST", `/conversations/${id}/continue`, body),
    cancel: () => call("POST", `/conversations/${id}/cancel`),
    events: async (types?: string) =>
      ((await call("GET", `/conversations/${id}/events`, undefined, { limit: "1000", ...(types ? { types } : {}) })).body as any).events as Array<{
        seq: number;
        type: string;
        data: any;
        run_id?: string;
      }>,
    raw: () => storage.getConversation(id),
    pausedMessage: async () => {
      const messages = (await t.get()).messages as any[];
      return messages.find((m) => m.metadata?.pendingActions);
    },
    drain: async (res: { stream?: AsyncGenerator<string, void, unknown> }) => {
      let text = "";
      for await (const chunk of res.stream!) text += chunk;
      return parseSse(text);
    },
  };
  return t;
}

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function suite(harness: ProviderHarness) {
  // --------------------------------------------------------------------------
  describe("answers to one pause lose none of each other", () => {
    it("two answers sent at the same time are both recorded, and the turn continues once", async () => {
      const agent = pausingStub({ approvals: 2 });
      const t = await boot(agent);
      const paused = (await t.send()).body as any;
      expect(paused.pendingActions.map((a: PendingAction) => a.id)).toEqual(["ap1", "ap2"]);

      const [a, b] = await Promise.all([t.resolve("ap1", allow, { metadata: { n: 1 } }), t.resolve("ap2", deny)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      // exactly one of the two answers ran the agent again, and it saw both decisions
      const resumed = agent.calls.slice(1);
      expect(resumed).toHaveLength(1);
      expect(resumed[0]!.input.pendingApprovals.map((x: any) => `${x.id}:${x.status}`).sort()).toEqual(["ap1:approved", "ap2:rejected"]);
      const finished = [a, b].filter((r) => (r.body as any).stopReason === "end_turn");
      expect(finished).toHaveLength(1);
      expect((finished[0]!.body as any).response.content).toBe("denied");
      expect((await t.get()).pendingActions).toBeUndefined();
    });

    it("answers to the actions of one pause, one after the other, keep the earlier one", async () => {
      const agent = pausingStub({ approvals: 2 });
      const t = await boot(agent);
      await t.send();
      const first = (await t.resolve("ap1", { ...allow, comment: "first" })).body as any;
      expect(first.status).toBe("requires_action");
      expect(first.pendingActions.map((a: PendingAction) => a.id)).toEqual(["ap2"]);
      // the open one is all that is left
      expect((await t.get()).pendingActions.map((a: PendingAction) => a.id)).toEqual(["ap2"]);
      const second = (await t.resolve("ap2", allow)).body as any;
      expect(second.response.content).toBe("deployed");
      expect(agent.calls[1]!.input.pendingApprovals.map((x: any) => `${x.id}:${x.status}`)).toEqual(["ap1:approved", "ap2:approved"]);
      expect(agent.calls[1]!.input.pendingApprovals[0].comment).toBe("first");
    });

    it("of two answers to the same action one wins, the other finds it answered", async () => {
      const t = await boot(pausingStub());
      await t.send();
      const [a, b] = await Promise.all([t.resolve("ap1", allow), t.resolve("ap1", deny)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = [a, b].find((r) => r.status === 409)!;
      expect((loser.body as any).error.code).toBe("action_not_pending");
    });

    it("two server instances over one store do not lose an answer either", async () => {
      const agent = pausingStub({ approvals: 2 });
      const first = await boot(agent);
      await first.send();
      const second = await boot(pausingStub({ approvals: 2 }), {}, { storage: first.storage });
      // (the second server answers the same conversation)
      const other = (id: string, actionId: string, resolution: unknown) =>
        second.server.handleRoute("POST", `/conversations/${id}/actions/${actionId}`, { query: {}, body: { resolution } });
      const [a, b] = await Promise.all([first.resolve("ap1", allow), other(first.id, "ap2", allow)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await first.get()).pendingActions).toBeUndefined();
      const raw = await first.raw();
      expect((raw!.state as any).__agentServerHitl).toBeUndefined();
    });

    it("an answer waits for another answer, not for a turn that runs the model", async () => {
      const release = gate();
      const agent = pausingStub({ approvals: 1 });
      const original = agent.invoke;
      const t = await boot(agent);
      await t.send();
      agent.invoke = async (input: any, config: any) => {
        await release.promise;
        return original(input, config);
      };
      const running = t.resolve("ap1", allow);
      await eventually(async () => ((await t.get()).conversation.runtime?.status === "running"), 4000, "the answer to run the agent");
      // a message meets a running turn: busy at once
      const busy = await t.send("hello");
      expect(busy.status).toBe(409);
      expect((busy.body as any).error.code).toBe("conversation_busy");
      release.open(undefined);
      expect((await running).status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  describe("requests lapse", () => {
    it("stamps expiresAt from hitl.timeoutMinutes (agent over server) and leaves a request that has its own", async () => {
      const t1 = await boot(pausingStub(), { hitl: { timeoutMinutes: 30 } });
      const before = Date.now();
      const body = (await t1.send()).body as any;
      const at = new Date(body.pendingActions[0].expiresAt).getTime();
      expect(at).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);
      expect((await t1.get()).pendingActions[0].expiresAt).toBe(body.pendingActions[0].expiresAt);

      // an agent's own setting wins
      const t2 = await boot(pausingStub(), { hitl: { timeoutMinutes: 30 } }, { registration: { hitl: { timeoutMinutes: 5 } } });
      const own = ((await t2.send()).body as any).pendingActions[0].expiresAt;
      expect(new Date(own).getTime()).toBeLessThan(Date.now() + 6 * 60_000);

      // the default is a day; 0 means never
      const t3 = await boot(pausingStub());
      const day = ((await t3.send()).body as any).pendingActions[0].expiresAt;
      expect(new Date(day).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
      const never = await boot(pausingStub(), { hitl: { timeoutMinutes: 0 } });
      expect(((await never.send()).body as any).pendingActions[0].expiresAt).toBeUndefined();

      // an entry that comes with a deadline keeps it
      const fixed = minutesFromNow(3);
      const t4 = await boot(pausingStub({ expiresAt: () => fixed }), { hitl: { timeoutMinutes: 30 } });
      expect(((await t4.send()).body as any).pendingActions[0].expiresAt).toBe(fixed);
    });

    it("records the earliest deadline on the conversation so the sweep can find it, and clears it when answered", async () => {
      const t = await boot(pausingStub({ approvals: 2 }), { hitl: { timeoutMinutes: 30 } });
      await t.send();
      const raw = (await t.raw())!;
      expect(raw.actionDueAt).toBeInstanceOf(Date);
      expect(JSON.stringify((await t.get()).conversation)).not.toContain("actionDueAt");
      expect(JSON.stringify((await t.get()).conversation)).not.toContain('"version"');
      await t.resolve("ap1", allow);
      expect((await t.raw())!.actionDueAt).toBeInstanceOf(Date);
      await t.resolve("ap2", allow);
      expect((await t.raw())!.actionDueAt).toBeUndefined();
    });

    it("answers 410 action_expired after the deadline and leaves the request where it is", async () => {
      const t = await boot(pausingStub({ approvals: 2, expiresAt: () => new Date(Date.now() + 80).toISOString() }));
      await t.send();
      await sleep(120);
      const res = await t.resolve("ap1", allow);
      expect(res.status).toBe(410);
      expect((res.body as any).error).toMatchObject({ code: "action_expired", details: { actionId: "ap1" } });
      // nothing was recorded: the request is still there for the sweep
      expect((await t.get()).pendingActions).toHaveLength(2);
      expect((await t.events("action.resolved"))).toEqual([]);
    });

    it("onTimeout 'deny' (the default) answers a lapsed approval as a refusal and lets the agent carry on", async () => {
      const agent = pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() });
      const t = await boot(agent);
      await t.send();
      await sleep(100);
      const done = await t.server.expirePendingActions({ conversationId: t.id });
      expect(done).toMatchObject({ conversations: 1, denied: 1, continued: 1, expired: 0 });

      // the agent saw a refusal, as a run of its own
      expect(agent.calls[1]!.input.pendingApprovals[0]).toMatchObject({ status: "rejected", comment: "timed out", decidedBy: "system:timeout" });
      const messages = (await t.get()).messages as any[];
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
      expect(messages[2].content).toBe("denied");
      expect((await t.get()).pendingActions).toBeUndefined();

      const log = await t.events();
      const resolved = log.find((e) => e.type === "action.resolved")!;
      expect(resolved.data).toMatchObject({ action_id: "ap1", decision: "deny", expired: true, status: "rejected", resolved_by: "system:timeout", channel: "timeout" });
      const running = log.filter((e) => e.type === "session.status_running");
      expect(running.map((e) => e.data.trigger)).toEqual(["message", "timeout"]);
      expect(log.at(-1)).toMatchObject({ type: "session.work_done" });

      // the paused message tells the story, and the deadline marker is gone
      expect(messages[1].metadata.pendingActions[0]).toMatchObject({
        id: "ap1",
        status: "resolved",
        resolution: { type: "tool_approval", decision: "deny", comment: "timed out" },
        resolvedBy: "system:timeout",
      });
      expect(messages[1].metadata.requiresAction).toBeUndefined();
      expect((await t.raw())!.actionDueAt).toBeUndefined();
      // and there is nothing left for the next sweep
      expect(await t.server.expirePendingActions({ conversationId: t.id })).toMatchObject({ conversations: 0 });
    });

    it("onTimeout 'deny' skips a lapsed question", async () => {
      const agent = pausingStub({ question: true, expiresAt: () => new Date(Date.now() + 60).toISOString() });
      const t = await boot(agent);
      await t.send();
      await sleep(100);
      await t.server.expirePendingActions({ conversationId: t.id });
      expect(agent.calls[1]!.input.pendingUserQuestions[0].status).toBe("cancelled");
      expect(((await t.get()).messages as any[]).at(-1).content).toBe("skipped");
    });

    it("onTimeout 'cancel' drops the pause: no agent call, the turn ends cancelled", async () => {
      const agent = pausingStub({ approvals: 2, expiresAt: () => new Date(Date.now() + 60).toISOString() });
      const t = await boot(agent, { hitl: { onTimeout: "cancel" } });
      await t.send();
      await sleep(100);
      const done = await t.server.expirePendingActions({ conversationId: t.id });
      expect(done).toMatchObject({ conversations: 1, expired: 2, denied: 0, continued: 0 });
      expect(agent.calls).toHaveLength(1);

      const body = await t.get();
      expect(body.pendingActions).toBeUndefined();
      expect(body.conversation.runtime).toMatchObject({ status: "idle", stopReason: "cancelled", pendingActionIds: [] });
      const log = await t.events();
      expect(log.filter((e) => e.type === "action.resolved").map((e) => e.data)).toEqual([
        expect.objectContaining({ action_id: "ap1", status: "expired", expired: true, cancelled: true, resolved_by: "system:timeout", channel: "timeout" }),
        expect.objectContaining({ action_id: "ap2", status: "expired" }),
      ]);
      expect(log.at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "cancelled", detail: "action_expired" } });
      const snapshot = (body.messages as any[])[1].metadata.pendingActions;
      expect(snapshot.map((a: any) => a.status)).toEqual(["expired", "expired"]);
      expect(snapshot[0].resolvedBy).toBe("system:timeout");
      // the conversation takes a new message
      expect((await t.send("go on")).status).toBe(200);
    });

    it("an agent's own onTimeout wins, and the policy is the one the pause was taken with", async () => {
      const agent = pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() });
      const t = await boot(agent, { hitl: { onTimeout: "deny" } }, { registration: { hitl: { onTimeout: "cancel" } } });
      await t.send();
      await sleep(100);
      expect(await t.server.expirePendingActions({ conversationId: t.id })).toMatchObject({ expired: 1, denied: 0 });
      expect(agent.calls).toHaveLength(1);
    });

    it("lets the ones that have not lapsed be", async () => {
      let n = 0;
      const agent = pausingStub({ approvals: 2, expiresAt: () => new Date(Date.now() + (++n === 1 ? 60 : 3_600_000)).toISOString() });
      const t = await boot(agent);
      await t.send();
      await sleep(100);
      const done = await t.server.expirePendingActions({ conversationId: t.id });
      expect(done).toMatchObject({ conversations: 1, denied: 1, continued: 0 });
      // ap1 is answered (denied), ap2 still waits - and its deadline is what the conversation carries now
      const body = await t.get();
      expect(body.pendingActions.map((a: PendingAction) => a.id)).toEqual(["ap2"]);
      expect(agent.calls).toHaveLength(1);
      const raw = (await t.raw())!;
      expect(raw.actionDueAt!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
      expect(await t.server.expirePendingActions({ conversationId: t.id })).toMatchObject({ conversations: 0 });
    });

    it("hands a handler agent the refusal", async () => {
      const seen: any[] = [];
      const handler: AgentHandler = {
        async processMessage() {
          return {
            content: "needs a check",
            status: "requires_action",
            pendingActions: [{ id: "h1", type: "tool_approval", toolName: "wire", expiresAt: new Date(Date.now() + 60).toISOString() }],
            state: { step: 1 },
          };
        },
        async resolveAction(params) {
          seen.push(params);
          return { content: "refused", state: { step: 2 } };
        },
      };
      const t = await boot({ handler });
      await t.send();
      await sleep(100);
      expect(await t.server.expirePendingActions({ conversationId: t.id })).toMatchObject({ denied: 1, continued: 1 });
      expect(seen[0]).toMatchObject({ actionId: "h1", resolution: { type: "tool_approval", decision: "deny", comment: "timed out" }, state: { step: 1 } });
      expect((await t.get()).conversation.state).toEqual({ step: 2 });
    });

    it("leaves a conversation that is running to the next sweep", async () => {
      const release = gate();
      const agent = pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() });
      const t = await boot(agent);
      await t.send();
      await sleep(100);
      // an answer with the agent busy holds the conversation
      const original = agent.invoke;
      agent.invoke = async (input: any, config: any) => {
        await release.promise;
        return original(input, config);
      };
      const held = t.server.expirePendingActions({ conversationId: t.id });
      await eventually(async () => ((await t.get()).conversation.runtime?.status === "running"), 4000, "the continuation to run");
      // a second sweep finds it busy and does nothing
      expect(await t.server.expirePendingActions({ conversationId: t.id })).toMatchObject({ conversations: 0, denied: 0 });
      release.open(undefined);
      expect(await held).toMatchObject({ denied: 1, continued: 1 });
    });

    it("the periodic sweep does it by itself", async () => {
      const iso = await harness.open();
      try {
        const agent = pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() });
        const t = await boot(agent, { runs: { sweepIntervalMs: 40, recoverOnStart: false } }, { storage: iso.storage });
        await t.send();
        await eventually(
          async () => {
            const body = await t.get();
            return body.pendingActions === undefined && body.conversation.runtime.status === "idle" && body.messages.length === 3;
          },
          5000,
          "the sweep to answer the lapsed request"
        );
        await t.server.close();
        expect(((await t.get()).messages as any[]).at(-1).content).toBe("denied");
      } finally {
        await iso.close();
      }
    });

    it("finds the lapsed requests of every conversation by itself, and only those", async () => {
      const iso = await harness.open();
      try {
        const lapsing = () => pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() });
        const a = await boot(lapsing(), {}, { storage: iso.storage });
        const b = await boot(lapsing(), {}, { storage: iso.storage });
        const later = await boot(pausingStub({ expiresAt: () => new Date(Date.now() + 3_600_000).toISOString() }), {}, { storage: iso.storage });
        const idle = await boot(pausingStub(), {}, { storage: iso.storage });
        await a.send();
        await b.send();
        await later.send();
        await idle.send("nothing pausing here");
        await sleep(100);

        // one server looks at the whole store - its own agent answers for the conversations of "a"
        const sweeper = await boot(pausingStub(), {}, { storage: iso.storage });
        const done = await sweeper.server.expirePendingActions();
        expect(done).toMatchObject({ conversations: 2, denied: 2, continued: 2, expired: 0 });
        expect((await a.get()).pendingActions).toBeUndefined();
        expect((await b.get()).pendingActions).toBeUndefined();
        expect((await later.get()).pendingActions).toHaveLength(1);
        // and a second look finds nothing
        expect(await sweeper.server.expirePendingActions()).toMatchObject({ conversations: 0 });
      } finally {
        await iso.close();
      }
    });

    it("can look at one conversation of a store that cannot search for lapsed requests", async () => {
      const inner = currentStorage();
      const blind = new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "capabilities") return () => ({ ...target.capabilities!(), actionDeadlines: false });
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as StorageProvider;
      const agent = pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() });
      const t = await boot(agent, {}, { storage: blind });
      await t.send();
      await sleep(100);
      // the sweep cannot find it...
      expect(await t.server.expirePendingActions()).toMatchObject({ conversations: 0 });
      // ...but it is still refused, and can be handled by name
      expect((await t.resolve("ap1", allow)).status).toBe(410);
      expect(await t.server.expirePendingActions({ conversationId: t.id })).toMatchObject({ conversations: 1, denied: 1 });
    });

    it("ends a task that waits on a request that lapsed under 'cancel'", async () => {
      const agent = pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() });
      const t = await boot(agent, { hitl: { onTimeout: "cancel" } });
      const created = await t.call("POST", "/tasks", { agentId: "a", input: "deploy" });
      const taskId = (created.body as any).task.id;
      await eventually(async () => ((await t.call("GET", `/tasks/${taskId}`)).body as any).task.status === "waiting_for_input", 5000, "the task to wait");
      await sleep(100);
      const conversationId = ((await t.call("GET", `/tasks/${taskId}`)).body as any).task.conversationId;
      await t.server.expirePendingActions({ conversationId });
      await eventually(async () => ((await t.call("GET", `/tasks/${taskId}`)).body as any).task.status === "cancelled", 5000, "the task to be cancelled");
    });
  });

  // --------------------------------------------------------------------------
  describe("who may answer", () => {
    const as = (user: string) => ({ "x-user": user });
    const resolveContext = (req: { headers: Record<string, unknown> }) => ({ user: { id: String(req.headers["x-user"]) }, data: { role: req.headers["x-role"] } });

    it("the owner, by default; anybody else is 403", async () => {
      const t = await boot(pausingStub(), { resolveContext }, { headers: as("alice") });
      await t.send();
      const evil = await t.call("POST", `/conversations/${t.id}/actions/ap1`, { resolution: allow }, {}, as("mallory"));
      expect(evil.status).toBe(403);
      expect((await t.resolve("ap1", allow)).status).toBe(200);
    });

    it("authorizeResolve decides for everyone: an approver who is not the owner may answer", async () => {
      const seen: any[] = [];
      const t = await boot(pausingStub(), {
        resolveContext: (req: any) => ({ user: { id: String(req.headers["x-user"]) }, data: { role: req.headers["x-role"] } }),
        hitl: {
          authorizeResolve: (ctx, { conversation, action }) => {
            seen.push({ user: ctx.user?.id, role: ctx.data.role, conversation: conversation.id, action: action.id });
            return ctx.data.role === "admin";
          },
        },
      }, { headers: as("alice") });
      await t.send();

      const member = await t.call("POST", `/conversations/${t.id}/actions/ap1`, { resolution: allow }, {}, { ...as("bob"), "x-role": "member" });
      expect(member.status).toBe(403);
      expect((member.body as any).error.code).toBe("action_forbidden");
      // even the owner is only as allowed as the hook says
      const owner = await t.call("POST", `/conversations/${t.id}/actions/ap1`, { resolution: allow }, {}, { ...as("alice"), "x-role": "member" });
      expect(owner.status).toBe(403);
      expect((await t.get()).pendingActions).toHaveLength(1);

      const admin = await t.call("POST", `/conversations/${t.id}/actions/ap1`, { resolution: allow }, {}, { ...as("carol"), "x-role": "admin" });
      expect(admin.status).toBe(200);
      expect(seen[0]).toMatchObject({ user: "bob", role: "member", conversation: t.id, action: "ap1" });
      // who answered is on the record
      const log = await t.events("action.resolved");
      expect(log[0]!.data.resolved_by).toBe("carol");
      expect(((await t.call("GET", `/conversations/${t.id}`, undefined, {}, as("alice"))).body as any).messages[1].metadata.pendingActions[0].resolvedBy).toBe("carol");
    });

    it("an action that is gone (409) or lapsed (410) is said so before the hook is asked", async () => {
      const hook = vi.fn(() => false);
      const t = await boot(pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() }), { hitl: { authorizeResolve: hook } });
      await t.send();
      expect((await t.resolve("nope", allow)).status).toBe(409);
      await sleep(100);
      expect((await t.resolve("ap1", allow)).status).toBe(410);
      expect(hook).not.toHaveBeenCalled();
    });

    it("a sweep needs no approver", async () => {
      const hook = vi.fn(() => false);
      const t = await boot(pausingStub({ expiresAt: () => new Date(Date.now() + 60).toISOString() }), { hitl: { authorizeResolve: hook } });
      await t.send();
      await sleep(100);
      expect(await t.server.expirePendingActions({ conversationId: t.id })).toMatchObject({ denied: 1, continued: 1 });
      expect(hook).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  describe("the record an answer leaves", () => {
    it("settles the action on the paused message: what was asked, what was answered, by whom, when", async () => {
      const server = createAgentServer({
        basePath: "/api",
        storage: currentStorage(),
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: pausingStub() } as any],
        resolveContext: (req) => ({ user: { id: String(req.headers["x-user"]) }, data: {} }),
        ...quiet(),
      });
      const h = { "x-user": "alice" };
      const conv = ((await server.handleRoute("POST", "/conversations", { query: {}, headers: h, body: { agentId: "a" } })).body as any).conversation.id;
      await server.handleRoute("POST", `/conversations/${conv}/messages`, { query: {}, headers: h, body: { message: "go" } });
      const before = Date.now();
      await server.handleRoute("POST", `/conversations/${conv}/actions/ap1`, { query: {}, headers: h, body: { resolution: { ...allow, comment: "ship it" } } });
      const messages = ((await server.handleRoute("GET", `/conversations/${conv}`, { query: {}, headers: h })).body as any).messages as any[];
      const entry = messages[1].metadata.pendingActions[0];
      expect(entry).toMatchObject({
        id: "ap1",
        type: "tool_approval",
        toolName: "deploy",
        title: "Deploy 1.0?",
        args: { version: "1.0" },
        status: "resolved",
        resolution: { type: "tool_approval", decision: "allow", comment: "ship it" },
        resolvedBy: "alice",
      });
      expect(new Date(entry.resolvedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
      // (the message no longer says it waits)
      expect(messages[1].metadata.requiresAction).toBeUndefined();
    });

    it("shows the request as pending while it waits, with the deadline", async () => {
      const t = await boot(pausingStub({ approvals: 2 }));
      await t.send();
      const message = await t.pausedMessage();
      expect(message.metadata.requiresAction).toBe(true);
      expect(message.metadata.pendingActions.map((a: any) => [a.id, a.status])).toEqual([["ap1", "pending"], ["ap2", "pending"]]);
      expect(message.metadata.pendingActions[0].expiresAt).toBeDefined();
    });

    it("keeps a multi-action pause honest: one answered, one waiting", async () => {
      const t = await boot(pausingStub({ approvals: 2 }));
      await t.send();
      await t.resolve("ap2", deny);
      const message = await t.pausedMessage();
      expect(message.metadata.requiresAction).toBe(true);
      expect(message.metadata.pendingActions.map((a: any) => [a.id, a.status])).toEqual([["ap1", "pending"], ["ap2", "resolved"]]);
      expect(message.metadata.pendingActions[1].resolution).toMatchObject({ decision: "deny" });
      await t.resolve("ap1", allow);
      const after = await t.pausedMessage();
      expect(after.metadata.requiresAction).toBeUndefined();
      expect(after.metadata.pendingActions.map((a: any) => a.status)).toEqual(["resolved", "resolved"]);
    });

    it("records an answered question and a skipped one", async () => {
      const t = await boot(pausingStub({ question: true }));
      await t.send();
      await t.resolve("q1", { type: "user_question", answers: { "Which env?": "Production" } });
      const answered = (await t.pausedMessage()).metadata.pendingActions[0];
      expect(answered).toMatchObject({ status: "resolved", resolution: { type: "user_question", answers: { "Which env?": "Production" } } });

      const t2 = await boot(pausingStub({ question: true }));
      await t2.send();
      await t2.resolve("q1", { type: "user_question", answers: {}, cancelled: true });
      expect((await t2.pausedMessage()).metadata.pendingActions[0]).toMatchObject({ status: "resolved", resolution: { cancelled: true } });
    });

    it("records edits and remembering in the answer", async () => {
      const t = await boot(pausingStub());
      await t.send();
      await t.resolve("ap1", { ...allow, approvedArgs: { version: "2.0" }, rememberForSession: true });
      const entry = (await t.pausedMessage()).metadata.pendingActions[0];
      expect(entry.resolution).toMatchObject({ approvedArgs: { version: "2.0" }, rememberForSession: true });
      expect(entry.args).toEqual({ version: "1.0" });
      const resolved = (await t.events("action.resolved"))[0]!.data;
      expect(resolved).toMatchObject({ edited_args: true, remember_for_session: true });
    });

    it("records a cancelled request: by a new message under pendingActionPolicy 'cancel', and by the cancel route", async () => {
      const t = await boot(pausingStub(), { pendingActionPolicy: "cancel" });
      await t.send();
      await t.send("never mind");
      const first = (await t.get()).messages.find((m: any) => m.metadata?.pendingActions);
      expect(first.metadata.pendingActions[0]).toMatchObject({ status: "cancelled", resolvedBy: "system" });
      expect(first.metadata.requiresAction).toBeUndefined();

      const c = await boot(pausingStub(), {}, { headers: { "x-user": "alice" } });
      await c.send();
      const res = await c.cancel();
      expect((res.body as any).cancelledActionIds).toEqual(["ap1"]);
      const snap = (await c.pausedMessage()).metadata.pendingActions[0];
      expect(snap).toMatchObject({ status: "cancelled" });
      expect(snap.resolvedAt).toBeDefined();
    });

    it("a provider that cannot update messages still works; the history keeps the request as it was asked", async () => {
      const inner = currentStorage();
      const noUpdate = new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "updateMessage") return undefined;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as StorageProvider;
      const t = await boot(pausingStub(), {}, { storage: noUpdate });
      await t.send();
      expect((await t.resolve("ap1", allow)).status).toBe(200);
      expect((await t.pausedMessage()).metadata.pendingActions[0].status).toBe("pending");
    });

    it("a store whose message update fails does not fail the answer", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const inner = currentStorage();
      const flaky = new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "updateMessage") return async () => { throw new Error("disk full"); };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as StorageProvider;
      const t = await boot(pausingStub(), {}, { storage: flaky });
      await t.send();
      expect((await t.resolve("ap1", allow)).status).toBe(200);
      vi.restoreAllMocks();
    });
  });

  // --------------------------------------------------------------------------
  describe("edited arguments are checked", () => {
    const zodTool = { name: "deploy", schema: z.object({ version: z.string(), replicas: z.number().int().min(1).optional() }) };

    it("refuses arguments the tool's zod schema does not accept, and leaves the request pending", async () => {
      const t = await boot(pausingStub({ tools: [zodTool] }));
      await t.send();
      const bad = await t.resolve("ap1", { ...allow, approvedArgs: { version: 2 } });
      expect(bad.status).toBe(400);
      expect((bad.body as any).error).toMatchObject({ code: "invalid_approved_args", details: { toolName: "deploy" } });
      expect((bad.body as any).error.message).toContain("version");
      expect((await t.get()).pendingActions).toHaveLength(1);
      expect((await t.events("action.resolved"))).toEqual([]);
      const worse = await t.resolve("ap1", { ...allow, approvedArgs: { version: "2.0", replicas: 0 } });
      expect(worse.status).toBe(400);
      expect((worse.body as any).error.message).toContain("replicas");
      const ok = await t.resolve("ap1", { ...allow, approvedArgs: { version: "2.0", replicas: 3 } });
      expect(ok.status).toBe(200);
      expect((ok.body as any).response.content).toBe('deployed:{"version":"2.0","replicas":3}');
    });

    it("tells the client what the tool takes: argsSchema on the request, in the log and on the paused message", async () => {
      const t = await boot(pausingStub({ tools: [zodTool] }));
      const paused = (await t.send()).body as any;
      const argsSchema = {
        type: "object",
        properties: { version: { type: "string" }, replicas: { type: "integer", minimum: 1 } },
        required: ["version"],
      };
      expect(paused.pendingActions[0]).toMatchObject({ id: "ap1", toolName: "deploy", argsSchema });
      // kept with the pause
      expect((await t.get()).pendingActions[0].argsSchema).toEqual(argsSchema);
      // announced (JSON Schema keys are not re-cased) and recorded for the history
      const [required] = await t.events("action.required");
      expect(required!.data.args_schema).toEqual(argsSchema);
      expect((await t.pausedMessage()).metadata.pendingActions[0].argsSchema).toEqual(argsSchema);
    });

    it("hands a JSON Schema on as it is, and says nothing for a tool whose schema is not known", async () => {
      const parameters = { type: "object", required: ["version"], properties: { version: { type: "string", pattern: "^\\d+\\.\\d+$" } } };
      const known = await boot(pausingStub({ tools: [{ name: "deploy", parameters }] }));
      expect(((await known.send()).body as any).pendingActions[0].argsSchema).toEqual(parameters);

      for (const tools of [[{ name: "other", schema: zodTool.schema }], [{ name: "deploy" }], []]) {
        const unknown = await boot(pausingStub({ tools }));
        const action = ((await unknown.send()).body as any).pendingActions[0];
        expect(action.argsSchema).toBeUndefined();
        expect("argsSchema" in action).toBe(false);
      }
      const [event] = await (await boot(pausingStub())).events("action.required");
      expect(event).toBeUndefined();
    });

    it("understands a JSON Schema too", async () => {
      const tool = {
        name: "deploy",
        parameters: { type: "object", required: ["version"], additionalProperties: false, properties: { version: { type: "string", pattern: "^\\d+\\.\\d+$" }, env: { enum: ["stg", "prod"] } } },
      };
      const t = await boot(pausingStub({ tools: [tool] }));
      await t.send();
      for (const args of [{}, { version: "latest" }, { version: "2.0", env: "dev" }, { version: "2.0", extra: 1 }, { version: 2 }]) {
        const res = await t.resolve("ap1", { ...allow, approvedArgs: args });
        expect(res.status, JSON.stringify(args)).toBe(400);
        expect((res.body as any).error.code).toBe("invalid_approved_args");
      }
      expect((await t.resolve("ap1", { ...allow, approvedArgs: { version: "2.0", env: "prod" } })).status).toBe(200);
    });

    it("lets through the arguments as they were asked, a denial, a tool with no schema, and a server that does not check", async () => {
      const t = await boot(pausingStub({ tools: [zodTool] }));
      await t.send();
      // the very arguments of the request need no check
      expect((await t.resolve("ap1", { ...allow, approvedArgs: { version: "1.0" } })).status).toBe(200);

      const denied = await boot(pausingStub({ tools: [zodTool] }));
      await denied.send();
      expect((await denied.resolve("ap1", { ...deny, approvedArgs: { version: 7 } })).status).toBe(200);

      const unknown = await boot(pausingStub({ tools: [{ name: "other", schema: zodTool.schema }] }));
      await unknown.send();
      expect((await unknown.resolve("ap1", { ...allow, approvedArgs: { whatever: true } })).status).toBe(200);

      const lax = await boot(pausingStub({ tools: [zodTool] }), { hitl: { validateApprovedArgs: false } });
      await lax.send();
      expect((await lax.resolve("ap1", { ...allow, approvedArgs: { version: 2 } })).status).toBe(200);

      const perAgent = await boot(pausingStub({ tools: [zodTool] }), {}, { registration: { hitl: { validateApprovedArgs: false } } });
      await perAgent.send();
      expect((await perAgent.resolve("ap1", { ...allow, approvedArgs: { version: 2 } })).status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  describe("previews and summaries", () => {
    it("passes an option's preview and an approval's summary through, to the response, the log and the stream", async () => {
      const t = await boot(pausingStub({ question: { preview: "staging: 1 node" } }));
      const body = (await t.send()).body as any;
      expect(body.pendingActions[0].questions[0].options[0]).toMatchObject({ label: "Staging", preview: "staging: 1 node" });
      expect(body.pendingActions[0].questions[0].options[1].preview).toBeUndefined();
      const required = (await t.events("action.required"))[0]!;
      expect(required.data.questions[0].options[0].preview).toBe("staging: 1 node");

      const a = await boot(pausingStub({ summary: "Deploys 1.0 to production" }));
      const approval = (await a.send()).body as any;
      expect(approval.pendingActions[0].summary).toBe("Deploys 1.0 to production");
      expect((await a.events("action.required"))[0]!.data.summary).toBe("Deploys 1.0 to production");
      expect(((await a.pausedMessage()).metadata.pendingActions[0]).summary).toBe("Deploys 1.0 to production");
    });
  });

  // --------------------------------------------------------------------------
  describe("tools remembered for the session", () => {
    it("an approval skipped because of a remembered tool is in the log, and the tool can be listed and forgotten", async () => {
      const agent = pausingStub();
      const t = await boot(agent);
      await t.send();
      await t.resolve("ap1", { ...allow, rememberForSession: true });
      expect(((await t.call("GET", `/conversations/${t.id}/remembered-tools`)).body as any).tools).toEqual(["deploy"]);
      expect((await t.get()).conversation.rememberedTools).toEqual(["deploy"]);

      const second = (await t.send("again")).body as any;
      expect(second.status).toBeUndefined();
      const auto = (await t.events("action.resolved")).filter((e) => e.data.resolved_by === "remembered");
      expect(auto).toHaveLength(1);
      expect(auto[0]!.data).toMatchObject({ action_id: "ap2_1", kind: "tool_approval", tool_name: "deploy", decision: "allow", status: "approved", channel: "remembered", remembered: true });

      // forget it: the next call asks again
      const revoked = await t.call("DELETE", `/conversations/${t.id}/remembered-tools/deploy`);
      expect(revoked.status).toBe(200);
      expect((revoked.body as any).tools).toEqual([]);
      expect((await t.get()).conversation.rememberedTools).toBeUndefined();
      expect(((await t.send("third")).body as any).status).toBe("requires_action");
    });

    it("404 for a tool that is not remembered, and the usual access rules", async () => {
      const t = await boot(pausingStub());
      expect((await t.call("DELETE", `/conversations/${t.id}/remembered-tools/nothing`)).status).toBe(404);
      expect((await t.call("GET", "/conversations/missing/remembered-tools")).status).toBe(404);
      expect((await t.call("DELETE", "/conversations/missing/remembered-tools/x")).status).toBe(404);

      const owned = await boot(pausingStub(), { resolveContext: (req: any) => ({ user: { id: String(req.headers["x-user"]) }, data: {} }) }, { headers: { "x-user": "alice" } });
      await owned.send();
      await owned.resolve("ap1", { ...allow, rememberForSession: true });
      const evil = { "x-user": "mallory" };
      expect((await owned.call("GET", `/conversations/${owned.id}/remembered-tools`, undefined, {}, evil)).status).toBe(403);
      expect((await owned.call("DELETE", `/conversations/${owned.id}/remembered-tools/deploy`, undefined, {}, evil)).status).toBe(403);
    });

    it("a tool revoked while a turn runs stays revoked", async () => {
      const release = gate();
      const agent = pausingStub();
      const original = agent.invoke;
      const t = await boot(agent);
      await t.send();
      await t.resolve("ap1", { ...allow, rememberForSession: true });
      agent.invoke = async (input: any, config: any) => {
        await release.promise;
        return original(input, config);
      };
      const running = t.send("again");
      await eventually(async () => ((await t.get()).conversation.runtime?.status === "running"), 4000, "the turn to run");
      expect((await t.call("DELETE", `/conversations/${t.id}/remembered-tools/deploy`)).status).toBe(200);
      release.open(undefined);
      await running;
      expect(((await t.call("GET", `/conversations/${t.id}/remembered-tools`)).body as any).tools).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  describe("usage of a turn", () => {
    it("reports what the turn used from the SDK's ledger, and a resumed turn only what it used after the resume", async () => {
      const agent = pausingStub({
        pauseCall: { input: 100, output: 50 },
        finishCall: { input: 40, output: 10, cached: 20 },
      });
      const t = await boot(agent);
      const paused = (await t.send()).body as any;
      expect(paused.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      const resumed = (await t.resolve("ap1", allow)).body as any;
      // (not 140 / 60: the 100 / 50 before the pause are already reported)
      expect(resumed.usage).toEqual({ inputTokens: 40, outputTokens: 10, totalTokens: 50, cachedInputTokens: 20 });
      const log = await t.events("session.usage");
      expect(log.map((e) => e.data)).toEqual([
        { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        { input_tokens: 40, output_tokens: 10, total_tokens: 50, cached_input_tokens: 20 },
      ]);
    });

    it("prices the usage when the agent has a pricing function, per model, with the cached discount", async () => {
      const agent = pausingStub({
        pauseCall: { model: "m1", input: 100, output: 50 },
        finishCall: { model: "cached-model", input: 1000, output: 100, cached: 500 },
      });
      const t = await boot(agent, { pricing: testPricing });
      const paused = (await t.send()).body as any;
      expect(paused.usage.costUsd).toBeCloseTo(0.2, 8);
      const resumed = (await t.resolve("ap1", allow)).body as any;
      // 500 * 0.001 + 500 * 0.0001 + 100 * 0.002
      expect(resumed.usage.costUsd).toBeCloseTo(0.5 + 0.05 + 0.2, 8);
      const events = await t.events("session.usage");
      expect(events[0]!.data).toMatchObject({ turn_cost_usd: 0.2, spent_usd: 0.2 });
      expect(events[1]!.data.turn_cost_usd).toBeCloseTo(0.75, 8);
      expect(events[1]!.data.spent_usd).toBeCloseTo(0.95, 8);
      expect((await t.get()).conversation.spentUsd).toBeCloseTo(0.95, 8);
    });

    it("does not price a model it has no price for, and leaves spend alone when nothing is priced", async () => {
      const agent = pausingStub({ pauseCall: { model: "unknown", input: 100, output: 50 } });
      const t = await boot(agent, { pricing: testPricing });
      const body = (await t.send()).body as any;
      expect(body.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      expect((await t.get()).conversation.spentUsd).toBeUndefined();
    });

    it("keeps the flat usage a handler or a stub reports, and prices it when it names its model or its cost", async () => {
      const handler: AgentHandler = {
        async processMessage(params) {
          return params.message === "cost"
            ? { content: "ok", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.07 } }
            : params.message === "model"
              ? { content: "ok", usage: { inputTokens: 100, outputTokens: 50, model: "m1" } }
              : { content: "ok", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
        },
      };
      const t = await boot({ handler }, { pricing: testPricing });
      expect(((await t.send("plain")).body as any).usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
      expect(((await t.send("cost")).body as any).usage.costUsd).toBe(0.07);
      expect(((await t.send("model")).body as any).usage.costUsd).toBeCloseTo(0.2, 8);
      expect((await t.get()).conversation.spentUsd).toBeCloseTo(0.27, 8);
    });
  });

  // --------------------------------------------------------------------------
  describe("budgets", () => {
    const budgeted = (extra: Partial<AgentServerConfig> = {}, steps = 5) => ({
      agent: steppingStub({ steps }),
      config: { pricing: testPricing, budget: { maxCostUsd: 0.5, onReach: "pause" as const }, ...extra },
    });

    it("counts what the turns cost, shows it, and starts a conversation with the agent's budget", async () => {
      const { agent, config } = budgeted({ budget: { maxCostUsd: 100, onReach: "pause" } }, 2);
      const t = await boot(agent, config);
      expect((await t.get()).conversation).toMatchObject({ budget: { maxCostUsd: 100, onReach: "pause" } });
      const first = (await t.send("one")).body as any;
      expect(first.budget).toEqual({ maxCostUsd: 100, onReach: "pause" });
      expect(first.spentUsd).toBeCloseTo(0.4, 8);
      await t.send("two");
      const listed = ((await t.call("GET", "/conversations")).body as any).conversations.find((c: any) => c.id === t.id);
      expect(listed.spentUsd).toBeCloseTo(0.8, 8);
      expect(listed.budget).toEqual({ maxCostUsd: 100, onReach: "pause" });
      const raw = await t.raw();
      expect(JSON.stringify(raw!.state)).toContain("__agentServerBudget");
      expect(JSON.stringify((await t.get()).conversation)).not.toContain("__agentServerBudget");
    });

    it("counts spend without a budget when the agent is priced, and writes nothing when it is not", async () => {
      const t = await boot(steppingStub({ steps: 2 }), { pricing: testPricing });
      await t.send();
      const body = await t.get();
      expect(body.conversation.budget).toBeUndefined();
      expect(body.conversation.spentUsd).toBeCloseTo(0.4, 8);

      const plain = await boot(steppingStub({ steps: 2 }));
      await plain.send();
      expect(Object.keys((await plain.raw())!.state ?? {})).toEqual([]);
    });

    it("stops a turn in the middle when the budget runs out, keeps the stopped state, and says so everywhere", async () => {
      const { agent, config } = budgeted();
      const t = await boot(agent, config);
      const res = await t.send("work");
      const body = res.body as any;
      expect(res.status).toBe(200);
      expect(body.stopReason).toBe("budget_reached");
      expect(body.response.status).toBe("incomplete");
      expect(body.response.content).toMatch(/worked for 3 steps/);
      // agent-sdk is given the room that is left as its own cost cap
      expect(agent.calls[0]!.config.limits).toEqual({ maxCostUsd: 0.5 });
      // one model call too many: 3 calls of $0.20
      expect(body.spentUsd).toBeCloseTo(0.6, 8);
      expect(body.usage.costUsd).toBeCloseTo(0.6, 8);

      const conv = (await t.get()).conversation;
      expect(conv.runtime).toMatchObject({ status: "budget_paused", stopReason: "budget_reached" });
      // cut short: there is a stopped turn to carry on once the budget allows
      expect(conv.continuable).toBe(true);
      const log = await t.events();
      const reached = log.find((e) => e.type === "budget.reached")!;
      expect(reached.data).toMatchObject({ max_cost_usd: 0.5, on_reach: "pause" });
      expect(reached.data.spent_usd).toBeCloseTo(0.6, 8);
      const types = log.map((e) => e.type);
      expect(types.indexOf("budget.reached")).toBeLessThan(types.lastIndexOf("session.status_idle"));
      expect(log.at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "budget_reached" } });
      expect(types).not.toContain("session.work_done");
      const usage = log.find((e) => e.type === "session.usage")!;
      expect(usage.data).toMatchObject({ budget: { max_cost_usd: 0.5, on_reach: "pause" } });

      // the budget is used up: no model call, no message stored, a 402 - JSON and streamed
      const callsBefore = agent.calls.length;
      const refused = await t.send("more");
      expect(refused.status).toBe(402);
      expect((refused.body as any).error).toMatchObject({ code: "budget_reached", details: { maxCostUsd: 0.5, onReach: "pause" } });
      const streamed = await t.send("more", { stream: true });
      expect(streamed.status).toBe(402);
      expect(agent.calls).toHaveLength(callsBefore);
      expect(((await t.get()).messages as any[]).map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    it("carries the stopped turn on after the budget is raised: only the host may raise it", async () => {
      const { agent, config } = budgeted();
      const authorize = vi.fn(() => true);
      const t = await boot(agent, { ...config, authorizeBudget: authorize });
      await t.send("work");

      // still used up
      const early = await t.cont();
      expect(early.status).toBe(402);
      expect((early.body as any).error.code).toBe("budget_reached");

      // a budget has to leave room above what is spent
      const low = await t.patch({ budget: { maxCostUsd: 0.6, onReach: "pause" } });
      expect(low.status).toBe(400);
      expect((low.body as any).error).toMatchObject({ code: "invalid_budget" });

      const raised = await t.patch({ budget: { maxCostUsd: 5 } });
      expect(raised.status).toBe(200);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize.mock.calls[0]![1]).toMatchObject({ current: { maxCostUsd: 0.5, onReach: "pause" }, requested: { maxCostUsd: 5, onReach: "pause" } });
      expect(authorize.mock.calls[0]![1].spentUsd).toBeCloseTo(0.6, 8);
      expect((raised.body as any).budget).toEqual({ maxCostUsd: 5, onReach: "pause" });
      // the raise only made room: the cut-short turn is still waiting to be carried on
      expect((raised.body as any).runtime).toMatchObject({ status: "budget_paused", stopReason: "budget_reached" });
      expect((raised.body as any).continuable).toBe(true);
      expect((await t.get()).conversation).toMatchObject({ continuable: true, runtime: { status: "budget_paused" } });

      const resumed = await t.cont();
      expect(resumed.status).toBe(200);
      const body = resumed.body as any;
      expect(body.response.content).toBe("finished after 5 steps");
      expect(body.stopReason).toBe("end_turn");
      // only the two calls the continuation made, not the three before
      expect(body.usage).toMatchObject({ inputTokens: 200, outputTokens: 100 });
      expect(body.usage.costUsd).toBeCloseTo(0.4, 8);
      expect(body.spentUsd).toBeCloseTo(1.0, 8);
      // it went on from where it stopped, with room for the whole turn
      const carried = agent.calls.at(-1)!;
      expect(carried.input.iteration).toBe(3);
      expect(carried.input.ctx?.__limitBreached).toBeUndefined();
      expect(carried.config.limits.maxCostUsd).toBeCloseTo(5 - 0.6 + 0.6, 8);
      expect(((await t.get()).messages as any[]).map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
      expect((await t.get()).conversation).toMatchObject({ continuable: false, runtime: { status: "idle", stopReason: "end_turn" } });

      // done: nothing left to carry on
      const again = await t.cont();
      expect(again.status).toBe(409);
      expect((again.body as any).error.code).toBe("nothing_to_continue");
      expect((await t.raw())!.state && JSON.stringify((await t.raw())!.state)).not.toContain("budgetPause");
    });

    it("a turn the budget cut short stays resumable after a raise: budget_paused and continuable on the read, the list and the PATCH answer", async () => {
      const { agent, config } = budgeted({ authorizeBudget: () => true });
      const original = agent.invoke;
      const hold = gate();
      // (a carried state has an iteration: only the continuation waits)
      agent.invoke = async (input: any, cfg: any) => {
        if (typeof input.iteration === "number") await hold.promise;
        return original(input, cfg);
      };
      const t = await boot(agent, config);
      const listed = async () => ((await t.call("GET", "/conversations")).body as any).conversations.find((c: any) => c.id === t.id);

      // nothing stopped yet
      expect((await t.get()).conversation).toMatchObject({ continuable: false, runtime: { status: "idle" } });

      await t.send("work");
      const stopped = { continuable: true, runtime: { status: "budget_paused", stopReason: "budget_reached" } };
      expect((await t.get()).conversation).toMatchObject(stopped);
      expect(await listed()).toMatchObject(stopped);
      // a PATCH that leaves the budget alone does not compute the runtime, so it says nothing about continuing
      const renamed = (await t.patch({ title: "renamed" })).body as any;
      expect(renamed.runtime).toBeUndefined();
      expect(renamed.continuable).toBeUndefined();

      // a raise that is not enough leaves it as it was; a raise that is enough only makes room
      const raised = (await t.patch({ budget: { maxCostUsd: 5 } })).body as any;
      expect(raised).toMatchObject({ budget: { maxCostUsd: 5, onReach: "pause" }, ...stopped });
      expect((await t.get()).conversation).toMatchObject(stopped);
      expect(await listed()).toMatchObject(stopped);
      // asking for the same budget again is no change and says the same
      expect(((await t.patch({ budget: { maxCostUsd: 5 } })).body as any)).toMatchObject(stopped);

      // while the continuation runs, nothing is left to start
      const running = t.cont();
      await eventually(async () => (await t.get()).conversation.runtime?.status === "running", 4000, "the continuation to run");
      expect((await t.get()).conversation).toMatchObject({ continuable: false, runtime: { status: "running" } });
      hold.open(undefined);
      expect((await running).status).toBe(200);
      expect((await t.get()).conversation).toMatchObject({ continuable: false, runtime: { status: "idle", stopReason: "end_turn" } });
      expect(await listed()).toMatchObject({ continuable: false, runtime: { status: "idle" } });
    });

    it("removing the budget keeps a cut-short turn resumable too", async () => {
      const { agent, config } = budgeted({ authorizeBudget: () => true });
      const t = await boot(agent, config);
      await t.send("work");
      const removed = await t.patch({ budget: null });
      expect(removed.status).toBe(200);
      expect((removed.body as any).budget).toBeUndefined();
      expect(removed.body).toMatchObject({ continuable: true, runtime: { status: "budget_paused", stopReason: "budget_reached" } });
      const resumed = await t.cont();
      expect(resumed.status).toBe(200);
      expect((resumed.body as any).response.content).toBe("finished after 5 steps");
      expect((await t.get()).conversation).toMatchObject({ continuable: false, runtime: { status: "idle", stopReason: "end_turn" } });
    });

    it("a new message gives up the stopped turn", async () => {
      const { agent, config } = budgeted({ authorizeBudget: () => true });
      const t = await boot(agent, config);
      await t.send("work");
      await t.patch({ budget: { maxCostUsd: 5 } });
      expect(JSON.stringify((await t.raw())!.state)).toContain("budgetPause");
      expect((await t.get()).conversation).toMatchObject({ continuable: true, runtime: { status: "budget_paused" } });

      expect((await t.send("something else")).status).toBe(200);
      expect((await t.get()).conversation).toMatchObject({ continuable: false, runtime: { status: "idle", stopReason: "end_turn" } });
      const gone = await t.cont();
      expect(gone.status).toBe(409);
      expect((gone.body as any).error.code).toBe("nothing_to_continue");
      expect(JSON.stringify((await t.raw())!.state)).not.toContain("budgetPause");
    });

    it("a new message gives up the stopped turn even when the turn it starts fails", async () => {
      const { agent, config } = budgeted({ authorizeBudget: () => true });
      const original = agent.invoke;
      let fail = false;
      agent.invoke = async (input: any, cfg: any) => {
        // (a carried state has an iteration; a new turn starts from messages)
        if (fail && typeof input.iteration !== "number") throw new Error("model down");
        return original(input, cfg);
      };
      const t = await boot(agent, config);
      await t.send("work");
      await t.patch({ budget: { maxCostUsd: 5 } });
      expect((await t.get()).conversation).toMatchObject({ continuable: true, runtime: { status: "budget_paused" } });

      fail = true;
      expect((await t.send("and this one fails")).status).toBeGreaterThanOrEqual(500);
      expect((await t.get()).conversation).toMatchObject({ continuable: false, runtime: { status: "idle", stopReason: "error" } });
      // the old turn does not come back behind the newer message
      const none = await t.cont();
      expect(none.status).toBe(409);
      expect((none.body as any).error.code).toBe("nothing_to_continue");
      expect(JSON.stringify((await t.raw())!.state)).not.toContain("budgetPause");
    });

    it("a refused message (budget still used up) does not give the stopped turn up", async () => {
      const { agent, config } = budgeted({ authorizeBudget: () => true });
      const t = await boot(agent, config);
      await t.send("work");
      expect((await t.send("more")).status).toBe(402);
      expect((await t.get()).conversation).toMatchObject({ continuable: true, runtime: { status: "budget_paused" } });
      await t.patch({ budget: { maxCostUsd: 5 } });
      expect((await t.cont()).status).toBe(200);
    });

    it("streams a continuation", async () => {
      const { agent, config } = budgeted({ authorizeBudget: () => true });
      const t = await boot(agent, config);
      await t.send("work");
      await t.patch({ budget: { maxCostUsd: 5 } });
      const res = await t.cont({ stream: true });
      const events = await t.drain(res);
      expect(events[0]).toMatchObject({ type: "stream.start", conversationId: t.id });
      const done = events.at(-1) as any;
      expect(done).toMatchObject({ type: "stream.done", stopReason: "end_turn", budget: { maxCostUsd: 5 } });
      expect(done.spentUsd).toBeCloseTo(1.0, 8);
      expect(events.some((e) => e.type === "stream.text")).toBe(true);
    });

    it("lowering is the owner's, raising or removing needs the host; the default is no", async () => {
      const t = await boot(steppingStub({ steps: 1 }), { pricing: testPricing, budget: { maxCostUsd: 10, onReach: "pause" } });
      expect((await t.patch({ budget: { maxCostUsd: 2, onReach: "pause" } })).status).toBe(200);
      expect((await t.patch({ budget: { maxCostUsd: 2, onReach: "stop" } })).status).toBe(200);
      // stricter in either way: fine
      expect(((await t.get()).conversation.budget)).toEqual({ maxCostUsd: 2, onReach: "stop" });
      for (const body of [{ maxCostUsd: 3, onReach: "stop" }, { maxCostUsd: 2, onReach: "pause" }, null]) {
        const res = await t.patch({ budget: body });
        expect(res.status, JSON.stringify(body)).toBe(403);
        expect((res.body as any).error.code).toBe("budget_forbidden");
      }
      expect(((await t.get()).conversation.budget)).toEqual({ maxCostUsd: 2, onReach: "stop" });
      // the same thing again is not a raise
      expect((await t.patch({ budget: { maxCostUsd: 2, onReach: "stop" } })).status).toBe(200);
    });

    it("the host can remove a budget, and then it is gone for good", async () => {
      const t = await boot(steppingStub({ steps: 1 }), { pricing: testPricing, budget: { maxCostUsd: 10, onReach: "pause" }, authorizeBudget: () => true });
      const res = await t.patch({ budget: null });
      expect(res.status).toBe(200);
      expect((res.body as any).budget).toBeUndefined();
      expect((await t.get()).conversation.budget).toBeUndefined();
      await t.send();
      expect((await t.get()).conversation.budget).toBeUndefined();
      expect((await t.get()).conversation.spentUsd).toBeCloseTo(0.2, 8);
    });

    it("answers 400 for a budget it cannot make sense of, or cannot count against", async () => {
      const t = await boot(steppingStub({ steps: 1 }), { pricing: testPricing });
      for (const budget of [{}, { maxCostUsd: 0 }, { maxCostUsd: -1 }, { maxCostUsd: "5" }, { maxCostUsd: 1, onReach: "explode" }, 5, "5", []]) {
        const res = await t.patch({ budget });
        expect(res.status, JSON.stringify(budget)).toBe(400);
        expect((res.body as any).error.code).toBe("invalid_budget");
      }
      const unpriced = await boot(steppingStub({ steps: 1 }));
      const res = await unpriced.patch({ budget: { maxCostUsd: 1 } });
      expect(res.status).toBe(400);
      expect((res.body as any).error.code).toBe("budget_unavailable");
    });

    it("a conversation can be created with a budget of its own: lower than the default, or by permission", async () => {
      const t = await boot(steppingStub({ steps: 1 }), { pricing: testPricing, budget: { maxCostUsd: 10, onReach: "pause" } });
      const lower = await t.create({ budget: { maxCostUsd: 3, onReach: "stop" } });
      expect(lower.status).toBe(201);
      expect((lower.body as any).conversation.budget).toEqual({ maxCostUsd: 3, onReach: "stop" });
      const own = (lower.body as any).conversation;
      expect(JSON.stringify(own)).not.toContain("__agentServerBudget");
      expect((await t.create({ budget: { maxCostUsd: 30 } })).status).toBe(403);
      expect((await t.create({ budget: null })).status).toBe(403);
      expect((await t.create({ budget: { maxCostUsd: 0 } })).status).toBe(400);

      const open = await boot(steppingStub({ steps: 1 }), { pricing: testPricing });
      const fresh = await open.create({ budget: { maxCostUsd: 1 } });
      expect(fresh.status).toBe(201);
      expect((fresh.body as any).conversation.budget).toEqual({ maxCostUsd: 1, onReach: "pause" });
      const plain = await open.create();
      expect((plain.body as any).conversation.budget).toBeUndefined();
    });

    it("an agent's own budget wins over the server's, null means none, and a budget nothing can price is refused up front", async () => {
      const agent = steppingStub({ steps: 1 });
      const own = await boot(agent, { pricing: testPricing, budget: { maxCostUsd: 10, onReach: "pause" } }, { registration: { budget: { maxCostUsd: 2, onReach: "stop" } } });
      expect((await own.get()).conversation.budget).toEqual({ maxCostUsd: 2, onReach: "stop" });
      const none = await boot(agent, { pricing: testPricing, budget: { maxCostUsd: 10, onReach: "pause" } }, { registration: { budget: null } });
      expect((await none.get()).conversation.budget).toBeUndefined();
      const priced = await boot(agent, {}, { registration: { budget: { maxCostUsd: 2, onReach: "pause" }, pricing: testPricing } });
      expect((await priced.get()).conversation.budget).toEqual({ maxCostUsd: 2, onReach: "pause" });

      expect(() => createAgentServer({ basePath: "/api", storage: currentStorage(), budget: { maxCostUsd: 1, onReach: "pause" } })).toThrow(/pricing/);
      expect(() => createAgentServer({ basePath: "/api", storage: currentStorage(), pricing: testPricing, budget: { maxCostUsd: 0, onReach: "pause" } })).toThrow(/greater than 0/);
      expect(() =>
        createAgentServer({ basePath: "/api", storage: currentStorage(), agents: [{ info: { id: "a", name: "A" }, sdkAgent: agent, budget: { maxCostUsd: 1, onReach: "pause" } }] })
      ).toThrow(/pricing/);
      const server = createAgentServer({ basePath: "/api", storage: currentStorage() });
      expect(() => server.registerSDKAgent("x", agent, {}, { budget: { maxCostUsd: 1, onReach: "pause" } })).toThrow(/pricing/);
      expect(() => server.registerSDKAgent("y", agent, {}, { budget: { maxCostUsd: 1, onReach: "pause" }, pricing: testPricing })).not.toThrow();
    });

    it("onReach 'stop' ends the conversation: idle, nothing to continue, every message refused until the host raises it", async () => {
      const { agent, config } = budgeted({ budget: { maxCostUsd: 0.5, onReach: "stop" }, authorizeBudget: () => true });
      const t = await boot(agent, config);
      const body = (await t.send("work")).body as any;
      expect(body.stopReason).toBe("budget_reached");
      const conv = (await t.get()).conversation;
      expect(conv.runtime).toMatchObject({ status: "idle", stopReason: "budget_reached" });
      expect(conv.continuable).toBe(false);
      expect((await t.send("more")).status).toBe(402);
      const raised = await t.patch({ budget: { maxCostUsd: 5, onReach: "stop" } });
      expect((raised.body as any).continuable).toBe(false);
      // no state was kept to carry on from
      const none = await t.cont();
      expect(none.status).toBe(409);
      expect((none.body as any).error.code).toBe("nothing_to_continue");
      expect((await t.send("fresh start")).status).toBe(200);
    });

    it("a turn that only crosses the budget delivers its answer and stops there", async () => {
      // the agent cannot stop in the middle (it has no cost estimator, the stub ignores the cap): the turn completes
      const agent = steppingStub({ steps: 3 });
      const original = agent.invoke;
      agent.invoke = (input: any, config: any) => original(input, { ...config, limits: undefined });
      const t = await boot(agent, { pricing: testPricing, budget: { maxCostUsd: 0.5, onReach: "pause" }, authorizeBudget: () => true });
      const res = (await t.send("work")).body as any;
      expect(res.response.content).toBe("finished after 3 steps");
      expect(res.response.status).toBe("completed");
      expect(res.stopReason).toBe("budget_reached");
      expect(res.status).toBeUndefined();
      expect((await t.get()).conversation).toMatchObject({ continuable: false, runtime: { status: "budget_paused", stopReason: "budget_reached" } });
      // nothing was cut short, so there is nothing to carry on
      const cont = await t.cont();
      expect([402, 409]).toContain(cont.status);
      expect((await t.send("more")).status).toBe(402);

      // a raise only reopens the conversation: idle, still nothing to continue
      const raised = await t.patch({ budget: { maxCostUsd: 5, onReach: "pause" } });
      expect(raised.status).toBe(200);
      expect((raised.body as any).runtime).toMatchObject({ status: "idle", stopReason: "budget_reached" });
      expect((raised.body as any).continuable).toBe(false);
      const none = await t.cont();
      expect(none.status).toBe(409);
      expect((none.body as any).error.code).toBe("nothing_to_continue");
      expect((await t.send("more")).status).toBe(200);
    });

    it("counts the cost of a cancelled turn", async () => {
      const agent = steppingStub({ steps: 3 });
      const original = agent.invoke;
      const reached = gate();
      const slow = gate();
      agent.invoke = async (input: any, config: any) => {
        const result = await original(input, config);
        reached.open(undefined);
        await slow.promise;
        // what the SDK returns for a run that was told to stop after it had made its calls
        return config.cancellationToken?.aborted
          ? { ...result, state: { ...result.state, ctx: { ...(result.state.ctx ?? {}), __cancelled: { stage: "tools", reason: "aborted" } } } }
          : result;
      };
      const t = await boot(agent, { pricing: testPricing });
      const running = t.send("work");
      await reached.promise;
      const cancel = t.cancel();
      await eventually(async () => agent.calls[0]?.config.cancellationToken.aborted === true, 4000, "the run to be told to stop");
      slow.open(undefined);
      await cancel;
      const body = (await running).body as any;
      expect(body.stopReason).toBe("cancelled");
      expect((await t.get()).conversation.spentUsd).toBeCloseTo(0.6, 8);
    });

    it("two settings at once: a budget change while a turn runs is not undone by the turn", async () => {
      const agent = steppingStub({ steps: 2 });
      const original = agent.invoke;
      const slow = gate();
      agent.invoke = async (input: any, config: any) => {
        const result = await original(input, config);
        await slow.promise;
        return result;
      };
      const t = await boot(agent, { pricing: testPricing, budget: { maxCostUsd: 100, onReach: "pause" } });
      const running = t.send("work");
      await eventually(async () => ((await t.get()).conversation.runtime?.status === "running"), 4000, "the turn to run");
      expect((await t.patch({ budget: { maxCostUsd: 50, onReach: "pause" } })).status).toBe(200);
      slow.open(undefined);
      await running;
      const conv = (await t.get()).conversation;
      expect(conv.budget).toEqual({ maxCostUsd: 50, onReach: "pause" });
      expect(conv.spentUsd).toBeCloseTo(0.4, 8);
    });

    it("an answer that would let the model run needs a budget with something left", async () => {
      const agent = pausingStub({ pauseCall: { input: 100, output: 50 }, finishCall: { input: 10, output: 5 } });
      const t = await boot(agent, { pricing: testPricing, budget: { maxCostUsd: 0.2, onReach: "pause" } });
      const first = (await t.send()).body as any;
      // a pause keeps its own stop, and the budget it used up is not reported as the reason
      expect(first.stopReason).toBe("requires_action");
      expect(first.spentUsd).toBeCloseTo(0.2, 8);
      const refused = await t.resolve("ap1", allow);
      expect(refused.status).toBe(402);
      expect((refused.body as any).error.code).toBe("budget_reached");
      // nothing was recorded: the request is still there
      expect((await t.get()).pendingActions).toHaveLength(1);
      expect(agent.calls).toHaveLength(1);
    });

    it("a task cut short by the budget fails", async () => {
      const { agent, config } = budgeted();
      const t = await boot(agent, config);
      const created = await t.call("POST", "/tasks", { agentId: "a", input: "work" });
      const taskId = (created.body as any).task.id;
      await eventually(async () => ["failed", "completed"].includes(((await t.call("GET", `/tasks/${taskId}`)).body as any).task.status), 5000, "the task to end");
      const task = ((await t.call("GET", `/tasks/${taskId}`)).body as any).task;
      expect(task.status).toBe("failed");
      expect(task.error).toMatch(/budget/);
    });
  });

  // --------------------------------------------------------------------------
  describe("streaming an answer that expired, or was edited", () => {
    it("the stream of a resolve names the edit, and the log has the rest", async () => {
      const t = await boot(pausingStub());
      await t.send();
      const res = await t.resolve("ap1", { ...allow, approvedArgs: { version: "3.0" } }, { stream: true });
      const events = await t.drain(res);
      expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.action_resolved", "stream.tool_call", "stream.tool_result", "stream.text", "stream.done"]);
    });
  });
}

// ----------------------------------------------------------------------------
// The record outlives a restart
// ----------------------------------------------------------------------------

function restartSuite(handle: () => OpenedProvider) {
  describe("a restart in the middle of a pause that lapses", () => {
    it("the deadline, the policy and the snapshot are whatever the store kept", async () => {
      // (ap1 has all the time in the world, ap2 lapses a moment from now)
      let n = 0;
      const first = await boot(
        pausingStub({ approvals: 2, expiresAt: () => new Date(Date.now() + (++n === 1 ? 3_600_000 : 400)).toISOString() }),
        { hitl: { onTimeout: "cancel" } }
      );
      await first.send();
      await first.resolve("ap1", allow);
      const reopened = await handle().reopen();
      const agent = pausingStub({ approvals: 2 });
      // a new server, and a different default: the pause keeps the policy it was taken with
      const server = createAgentServer({ basePath: "/api", storage: reopened, agents: [{ info: { id: "a", name: "A" }, sdkAgent: agent } as any], hitl: { onTimeout: "deny" }, ...quiet() });
      await sleep(500);
      const done = await server.expirePendingActions({ conversationId: first.id });
      expect(done).toMatchObject({ conversations: 1, expired: 1, denied: 0 });
      const body = (await server.handleRoute("GET", `/conversations/${first.id}`, { query: {} })).body as any;
      expect(body.pendingActions).toBeUndefined();
      expect(body.messages[1].metadata.pendingActions.map((a: any) => a.status)).toEqual(["resolved", "expired"]);
      expect(agent.calls).toHaveLength(0);
    });

    it("spend and the carried state of a stopped turn survive a restart", async () => {
      const agent = steppingStub({ steps: 5 });
      const t = await boot(agent, { pricing: testPricing, budget: { maxCostUsd: 0.5, onReach: "pause" }, authorizeBudget: () => true });
      await t.send("work");
      const reopened = await handle().reopen();
      const next = createAgentServer({
        basePath: "/api",
        storage: reopened,
        agents: [{ info: { id: "a", name: "A" }, sdkAgent: steppingStub({ steps: 5 }) } as any],
        pricing: testPricing,
        authorizeBudget: () => true,
        ...quiet(),
      });
      const get = async () => (await next.handleRoute("GET", `/conversations/${t.id}`, { query: {} })).body as any;
      const before = (await get()).conversation;
      expect(before).toMatchObject({ runtime: { status: "budget_paused" }, continuable: true, budget: { maxCostUsd: 0.5 } });
      expect(before.spentUsd).toBeCloseTo(0.6, 8);
      const raised = await next.handleRoute("PATCH", `/conversations/${t.id}`, { query: {}, body: { budget: { maxCostUsd: 5 } } });
      expect(raised.body).toMatchObject({ runtime: { status: "budget_paused" }, continuable: true });
      expect((await get()).conversation).toMatchObject({ runtime: { status: "budget_paused" }, continuable: true });
      const resumed = await next.handleRoute("POST", `/conversations/${t.id}/continue`, { query: {}, body: {} });
      expect(resumed.status).toBe(200);
      expect((resumed.body as any).response.content).toBe("finished after 5 steps");
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
    suite(harness);
    restartSuite(() => provider.current);
  });
}
