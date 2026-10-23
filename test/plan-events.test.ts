/**
 * The plan and the compaction marker: what a host agent may report (`readHostEvent`), how the agent-sdk's `plan` and
 * `summarization` events become the same thing, and what the server stores and streams for them - in order with the tool events.
 */

import { describe, expect, it, vi } from "vitest";
import { createAgentServer } from "../src/index.js";
import type { HostEvent } from "../src/index.js";
import { compactionFromSdkEvent, planFromSdkEvent, readHostEvent } from "../src/host.js";
import { memoryStorage, parseSse } from "./helpers.js";

const ok = (raw: unknown): HostEvent => {
  const read = readHostEvent(raw);
  if (!read.ok) throw new Error(`expected an event, got: ${read.message}`);
  return read.value;
};

const refused = (raw: unknown): string => {
  const read = readHostEvent(raw);
  if (read.ok) throw new Error("expected the event to be refused");
  return read.message;
};

describe("readHostEvent: plan", () => {
  it("accepts a plan and keeps only titles, statuses, ids and the version", () => {
    expect(
      ok({
        type: "plan",
        plan: {
          version: 3,
          steps: [
            { id: 1, title: "Read the brief", status: "completed", owner: "agent", exitCriteria: "done", evidence: "secret" },
            { id: "b", title: "Write", status: "in-progress" },
            { title: "Ship", status: "not-started" },
            { id: 4, title: "Wait for review", status: "blocked" },
          ],
          source: "manage_plan",
        },
        extra: true,
      })
    ).toEqual({
      type: "plan",
      plan: {
        version: 3,
        steps: [
          { id: 1, title: "Read the brief", status: "completed" },
          { id: "b", title: "Write", status: "in-progress" },
          { title: "Ship", status: "not-started" },
          { id: 4, title: "Wait for review", status: "blocked" },
        ],
      },
    });
  });

  it("drops a step with an unknown status or a title that is not text, and the ids that are not usable", () => {
    const event = ok({
      type: "plan",
      plan: {
        steps: [
          { title: "fine", status: "completed" },
          { title: "odd", status: "done" },
          { title: 5, status: "completed" },
          { status: "completed" },
          "not a step",
          null,
          { id: {}, title: "no id", status: "blocked" },
          { id: Number.NaN, title: "nan id", status: "blocked" },
        ],
      },
    });
    expect(event).toEqual({
      type: "plan",
      plan: {
        steps: [
          { title: "fine", status: "completed" },
          { title: "no id", status: "blocked" },
          { title: "nan id", status: "blocked" },
        ],
      },
    });
  });

  it("clips a title to 500 characters and the plan to 100 steps, and leaves out a version that is not a number", () => {
    const event = ok({
      type: "plan",
      plan: {
        version: "2",
        steps: Array.from({ length: 130 }, (_, i) => ({ id: i, title: "x".repeat(600), status: "not-started" })),
      },
    });
    if (event.type !== "plan") throw new Error("not a plan");
    expect(event.plan.version).toBeUndefined();
    expect("version" in event.plan).toBe(false);
    expect(event.plan.steps).toHaveLength(100);
    expect(event.plan.steps[0]!.title).toHaveLength(500);
    expect(event.plan.steps[99]!.id).toBe(99);
  });

  it("accepts an empty plan (the agent cleared it)", () => {
    expect(ok({ type: "plan", plan: { steps: [] } })).toEqual({ type: "plan", plan: { steps: [] } });
  });

  it("keeps an operation of `write` or `update`, and invents none", () => {
    const steps = [{ id: 1, title: "Read the brief", status: "in-progress" }];
    expect(ok({ type: "plan", plan: { version: 1, operation: "write", steps } })).toEqual({
      type: "plan",
      plan: { version: 1, operation: "write", steps },
    });
    expect(ok({ type: "plan", plan: { version: 2, operation: "update", steps } })).toEqual({
      type: "plan",
      plan: { version: 2, operation: "update", steps },
    });
    const plain = ok({ type: "plan", plan: { version: 3, steps } });
    if (plain.type !== "plan") throw new Error("not a plan");
    expect("operation" in plain.plan).toBe(false);
  });

  it("drops an operation that is not one of ours, and keeps the plan", () => {
    for (const operation of ["read", "delete", "WRITE", " write", "", 1, true, null, {}, ["write"]]) {
      const event = ok({ type: "plan", plan: { version: 4, operation, steps: [{ title: "kept", status: "completed" }] } });
      if (event.type !== "plan") throw new Error("not a plan");
      expect("operation" in event.plan).toBe(false);
      expect(event.plan).toEqual({ version: 4, steps: [{ title: "kept", status: "completed" }] });
    }
  });

  it("refuses a plan without a list of steps", () => {
    expect(refused({ type: "plan" })).toContain("plan");
    expect(refused({ type: "plan", plan: null })).toContain("plan");
    expect(refused({ type: "plan", plan: { steps: "no" } })).toContain("plan");
    expect(refused({ type: "plan", plan: [] })).toContain("plan");
  });
});

describe("readHostEvent: compaction", () => {
  it("accepts a marker with or without an id and a phase", () => {
    expect(ok({ type: "compaction" })).toEqual({ type: "compaction" });
    expect(ok({ type: "compaction", id: "pass-1", phase: "start" })).toEqual({ type: "compaction", id: "pass-1", phase: "start" });
    expect(ok({ type: "compaction", phase: "done" })).toEqual({ type: "compaction", phase: "done" });
    expect(ok({ type: "compaction", id: "p", phase: "skipped" })).toEqual({ type: "compaction", id: "p", phase: "skipped" });
  });

  it("strips what is not part of the marker and an id that is not text", () => {
    expect(ok({ type: "compaction", id: "", summary: "the whole conversation so far", tokensBefore: 90000 })).toEqual({ type: "compaction" });
    expect(ok({ type: "compaction", id: 7, phase: "done", directives: ["x"] })).toEqual({ type: "compaction", phase: "done" });
  });

  it("refuses a phase that is not one of ours", () => {
    expect(refused({ type: "compaction", phase: "finished" })).toContain("compaction.phase");
    expect(refused({ type: "compaction", phase: 1 })).toContain("compaction.phase");
  });
});

describe("readHostEvent: the other types are unchanged", () => {
  it("still reads the events it knew, and refuses an unknown one", () => {
    expect(ok({ type: "text", text: "a" })).toEqual({ type: "text", text: "a" });
    expect(ok({ type: "thinking", text: "b" })).toEqual({ type: "thinking", text: "b" });
    expect(ok({ type: "tool_use", id: "c1", name: "search", args: { q: 1 }, plan: {} })).toEqual({
      type: "tool_use",
      id: "c1",
      name: "search",
      args: { q: 1 },
    });
    expect(ok({ type: "stop", stopReason: "max_turns" })).toEqual({ type: "stop", stopReason: "max_turns" });
    expect(refused({ type: "mystery" })).toContain('unknown event type "mystery"');
  });
});

describe("agent-sdk events", () => {
  const todo = (extra: Record<string, unknown> = {}) => ({
    id: 1,
    step: "Collect sources",
    owner: "agent",
    exitCriteria: "three sources",
    evidence: "internal",
    status: "in-progress",
    ...extra,
  });

  it("turns a written or updated plan into a snapshot: the title, else the step text, and nothing else", () => {
    const written = planFromSdkEvent({
      type: "plan",
      source: "manage_plan",
      operation: "write",
      version: 1,
      adherenceScore: 0.5,
      todoList: [todo(), todo({ id: 2, title: "Summarise", step: "ignored", status: "not-started" })],
    });
    expect(written).toEqual({
      version: 1,
      operation: "write",
      steps: [
        { id: 1, title: "Collect sources", status: "in-progress" },
        { id: 2, title: "Summarise", status: "not-started" },
      ],
    });
    expect(planFromSdkEvent({ type: "plan", operation: "update", version: 2, todoList: [todo({ status: "completed" })] })).toEqual({
      version: 2,
      operation: "update",
      steps: [{ id: 1, title: "Collect sources", status: "completed" }],
    });
  });

  it("carries the event's operation, so a created plan can be told from an updated one", () => {
    const list = [todo()];
    expect(planFromSdkEvent({ type: "plan", operation: "write", todoList: list })?.operation).toBe("write");
    expect(planFromSdkEvent({ type: "plan", operation: "update", todoList: list })?.operation).toBe("update");
  });

  it("skips a read, a plan without a list, and anything a delegated child stamped", () => {
    const base = { type: "plan", version: 1, todoList: [todo()] };
    expect(planFromSdkEvent({ ...base, operation: "read" })).toBeUndefined();
    expect(planFromSdkEvent({ ...base })).toBeUndefined();
    expect(planFromSdkEvent({ type: "plan", operation: "write", version: 1 })).toBeUndefined();
    expect(planFromSdkEvent({ ...base, operation: "write", subagentId: "s1" })).toBeUndefined();
    expect(planFromSdkEvent({ ...base, operation: "write", subagentName: "researcher" })).toBeUndefined();
    expect(planFromSdkEvent({ ...base, operation: "write", delegatedTo: "helper" })).toBeUndefined();
    expect(planFromSdkEvent({ type: "tool_call", operation: "write", todoList: [] })).toBeUndefined();
  });

  it("turns a summarization event into a marker: the phase it has, `done` when it has none, no content", () => {
    expect(compactionFromSdkEvent({ type: "summarization", id: "call_summary_1", phase: "start", summary: "" })).toEqual({ id: "call_summary_1", phase: "start" });
    expect(compactionFromSdkEvent({ type: "summarization", id: "call_summary_1", phase: "done", summary: "long text", inputTokens: 5 })).toEqual({
      id: "call_summary_1",
      phase: "done",
    });
    expect(compactionFromSdkEvent({ type: "summarization", id: "p", phase: "skipped", summary: "" })).toEqual({ id: "p", phase: "skipped" });
    // (from an SDK that had no phases)
    expect(compactionFromSdkEvent({ type: "summarization", summary: "text" })).toEqual({ phase: "done" });
  });

  it("skips a summarization a delegated child stamped, or with a phase it does not know", () => {
    expect(compactionFromSdkEvent({ type: "summarization", id: "p", subagentId: "s1", summary: "" })).toBeUndefined();
    expect(compactionFromSdkEvent({ type: "summarization", id: "p", delegatedTo: "h", summary: "" })).toBeUndefined();
    expect(compactionFromSdkEvent({ type: "summarization", id: "p", phase: "weird", summary: "" })).toBeUndefined();
    expect(compactionFromSdkEvent({ type: "plan" })).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// The server
// ----------------------------------------------------------------------------

const runs = { sweepIntervalMs: 0, recoverOnStart: false };

type Frame = { type: string; [key: string]: any };

/** A server with one host agent that reports `behave`'s events, and a way to send it a message (streamed or not). */
async function bootHost(behave: (emit: (event: unknown) => void) => void, info: Record<string, unknown> = {}) {
  const server = createAgentServer({ basePath: "/api", storage: await memoryStorage(), allowAnonymousList: true, runs });
  server.registerHostAgent({
    info: { id: "h", name: "Host", ...info },
    invoke: (_input, { emit }) => {
      behave(emit as (event: unknown) => void);
      return { content: "done" };
    },
  });
  return harness(server, "h");
}

/** A server with one agent-sdk look-alike that calls `onEvent` the way the SDK does. */
async function bootSdk(behave: (onEvent: (event: Record<string, unknown>) => void) => void) {
  const server = createAgentServer({
    basePath: "/api",
    storage: await memoryStorage(),
    allowAnonymousList: true,
    runs,
    agents: [
      {
        info: { id: "s", name: "Sdk" },
        sdkAgent: {
          invoke: async (_params: unknown, config?: { onEvent?: (event: Record<string, unknown>) => void }) => {
            behave((event) => config?.onEvent?.(event));
            return { content: "done" };
          },
        } as never,
      },
    ],
  });
  return harness(server, "s");
}

async function harness(server: ReturnType<typeof createAgentServer>, agentId: string) {
  const call = (method: string, path: string, extra: { body?: unknown; query?: Record<string, string> } = {}) =>
    server.handleRoute(method, path, { query: extra.query ?? {}, body: extra.body, headers: {} });
  const id = ((await call("POST", "/conversations", { body: { agentId } })).body as any).conversation.id as string;
  const stream = async (): Promise<Frame[]> => {
    const res = await call("POST", `/conversations/${id}/messages`, { body: { message: "go", stream: true } });
    let text = "";
    for await (const chunk of res.stream!) text += chunk;
    return parseSse(text) as Frame[];
  };
  const events = async (types?: string): Promise<Array<{ seq: number; type: string; data: any }>> =>
    ((await call("GET", `/conversations/${id}/events`, { query: types ? { types } : {} })).body as any).events;
  return { call, id, stream, events };
}

const PLAN_V1 = {
  version: 1,
  steps: [
    { id: 1, title: "Read the brief", status: "in-progress" },
    { id: 2, title: "Write the answer", status: "not-started" },
  ],
};
const PLAN_V2 = {
  version: 2,
  steps: [
    { id: 1, title: "Read the brief", status: "completed" },
    { id: 2, title: "Write the answer", status: "in-progress" },
  ],
};

describe("host agent: plan and compaction", () => {
  const behave = (emit: (event: unknown) => void) => {
    emit({ type: "plan", plan: { ...PLAN_V1, steps: PLAN_V1.steps.map((s) => ({ ...s, owner: "agent", evidence: "private" })) } });
    emit({ type: "tool_use", id: "c1", name: "search", args: { q: "cats" } });
    emit({ type: "tool_result", id: "c1", result: { hits: 2 } });
    emit({ type: "compaction", id: "pass-1", phase: "start" });
    emit({ type: "compaction", id: "pass-1", phase: "done" });
    emit({ type: "compaction", id: "pass-2", phase: "start" });
    emit({ type: "compaction", id: "pass-2", phase: "skipped" });
    emit({ type: "plan", plan: PLAN_V2 });
  };

  it("sends the frames in the order the agent reported them", async () => {
    const t = await bootHost(behave);
    const frames = await t.stream();
    expect(frames.map((f) => f.type)).toEqual([
      "stream.start",
      "stream.plan",
      "stream.tool_call",
      "stream.tool_result",
      "stream.compaction",
      "stream.compaction",
      "stream.compaction",
      "stream.compaction",
      "stream.plan",
      "stream.text",
      "stream.done",
    ]);
    const plans = frames.filter((f) => f.type === "stream.plan");
    expect(plans.map((f) => f.plan)).toEqual([PLAN_V1, PLAN_V2]);
    expect(frames.filter((f) => f.type === "stream.compaction").map((f) => [f.id, f.phase])).toEqual([
      ["pass-1", "start"],
      ["pass-1", "done"],
      ["pass-2", "start"],
      ["pass-2", "skipped"],
    ]);
  });

  it("stores the plan and a finished pass, in order with the tool events - and not a start or a skipped pass", async () => {
    const t = await bootHost(behave);
    await t.stream();
    const log = await t.events();
    const flow = log.filter((e) => ["agent.plan", "agent.tool_use", "agent.tool_result", "agent.compaction"].includes(e.type));
    expect(flow.map((e) => e.type)).toEqual(["agent.plan", "agent.tool_use", "agent.tool_result", "agent.compaction", "agent.plan"]);
    expect(flow[0]!.data).toEqual(PLAN_V1);
    expect(flow[4]!.data).toEqual(PLAN_V2);
    expect(flow[3]!.data).toMatchObject({ id: "pass-1" });
    expect(Number.isNaN(Date.parse(flow[3]!.data.at))).toBe(false);
    expect(new Date(flow[3]!.data.at).toISOString()).toBe(flow[3]!.data.at);
    expect(log.filter((e) => e.type === "agent.compaction")).toHaveLength(1);
  });

  it("keeps the plan frame's cursor equal to its stored event", async () => {
    const t = await bootHost(behave);
    const frames = await t.stream();
    const stored = (await t.events()).filter((e) => e.type === "agent.plan");
    expect(frames.filter((f) => f.type === "stream.plan").map((f) => f.seq)).toEqual(stored.map((e) => e.seq));
  });

  it("stores them for a request that is not streamed, and filters by type", async () => {
    const t = await bootHost(behave);
    const res = await t.call("POST", `/conversations/${t.id}/messages`, { body: { message: "go" } });
    expect(res.status).toBe(200);
    const only = await t.events("agent.plan,agent.compaction");
    expect(only.map((e) => e.type)).toEqual(["agent.plan", "agent.compaction", "agent.plan"]);
  });

  it("treats a compaction without a phase as a finished pass", async () => {
    const t = await bootHost((emit) => emit({ type: "compaction" }));
    const frames = await t.stream();
    expect(frames.find((f) => f.type === "stream.compaction")).toMatchObject({ phase: "done" });
    expect("id" in frames.find((f) => f.type === "stream.compaction")!).toBe(false);
    const stored = (await t.events()).filter((e) => e.type === "agent.compaction");
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]!.data)).toEqual(["at"]);
  });

  it("ignores a malformed plan with one warning, and goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const t = await bootHost((emit) => {
        emit({ type: "plan", plan: { steps: "nope" } });
        emit({ type: "compaction", phase: "later" });
        emit({ type: "plan", plan: PLAN_V1 });
      });
      const frames = await t.stream();
      expect(frames.filter((f) => f.type === "stream.plan")).toHaveLength(1);
      expect(frames.some((f) => f.type === "stream.compaction")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("carries the operation in the frame and in the stored event, and leaves it out when the agent did not say", async () => {
    const t = await bootHost((emit) => {
      emit({ type: "plan", plan: { ...PLAN_V1, operation: "write" } });
      emit({ type: "plan", plan: { ...PLAN_V2, operation: "update" } });
      // not an operation of ours: the plan is published without it
      emit({ type: "plan", plan: { version: 3, operation: "read", steps: PLAN_V2.steps } });
      emit({ type: "plan", plan: { version: 4, steps: PLAN_V2.steps } });
    });
    const frames = await t.stream();
    const plans = frames.filter((f) => f.type === "stream.plan").map((f) => f.plan);
    expect(plans.map((p) => p.version)).toEqual([1, 2, 3, 4]);
    expect(plans.map((p) => p.operation)).toEqual(["write", "update", undefined, undefined]);
    expect(plans.map((p) => "operation" in p)).toEqual([true, true, false, false]);

    const stored = (await t.events()).filter((e) => e.type === "agent.plan");
    expect(stored.map((e) => e.data.version)).toEqual([1, 2, 3, 4]);
    expect(stored.map((e) => e.data.operation)).toEqual(["write", "update", undefined, undefined]);
    expect(stored.map((e) => "operation" in e.data)).toEqual([true, true, false, false]);
    expect(stored[0]!.data).toEqual({ ...PLAN_V1, operation: "write" });
  });

  it("publishes capabilities.plan on the agent", async () => {
    const t = await bootHost(() => undefined, { capabilities: { plan: true } });
    expect(((await t.call("GET", "/agents/h")).body as any).capabilities.plan).toBe(true);
  });
});

describe("agent-sdk agent: plan and summarization", () => {
  it("publishes the plan and the passes the SDK reports, in order with its tool calls", async () => {
    const t = await bootSdk((onEvent) => {
      onEvent({
        type: "plan",
        source: "manage_plan",
        operation: "write",
        version: 1,
        toolCallId: "p1",
        todoList: [
          { id: 1, step: "Read the brief", owner: "agent", exitCriteria: "read", status: "in-progress" },
          { id: 2, title: "Write the answer", step: "write", owner: "agent", exitCriteria: "written", evidence: "n/a", status: "not-started" },
        ],
      });
      onEvent({ type: "plan", source: "manage_plan", operation: "read", version: 1, todoList: [{ id: 1, step: "Read the brief", status: "in-progress" }] });
      onEvent({ type: "tool_call", phase: "start", name: "search", id: "c1", args: {} });
      onEvent({ type: "tool_call", phase: "success", name: "search", id: "c1", result: "ok" });
      onEvent({ type: "summarization", id: "call_summary_1", phase: "start", pass: 1, trigger: "mid_leg", summary: "" });
      onEvent({ type: "summarization", id: "call_summary_1", phase: "done", pass: 1, trigger: "mid_leg", summary: "private text", inputTokens: 90 });
      onEvent({ type: "summarization", id: "call_summary_2", phase: "start", pass: 2, summary: "" });
      onEvent({ type: "summarization", id: "call_summary_2", phase: "skipped", pass: 2, summary: "" });
      // a child's own plan and pass are not the turn's
      onEvent({ type: "plan", source: "manage_plan", operation: "write", version: 1, subagentId: "s1", subagentName: "researcher", todoList: [{ id: 1, step: "Child step", status: "not-started" }] });
      onEvent({ type: "summarization", id: "child", phase: "done", subagentId: "s1", summary: "x" });
      onEvent({
        type: "plan",
        source: "manage_plan",
        operation: "update",
        version: 2,
        todoList: [{ id: 1, step: "Read the brief", owner: "agent", exitCriteria: "read", status: "completed" }],
      });
      // from an SDK that had no phases
      onEvent({ type: "summarization", summary: "old style" });
    });
    const frames = await t.stream();
    expect(frames.map((f) => f.type)).toEqual([
      "stream.start",
      "stream.plan",
      "stream.tool_call",
      "stream.tool_result",
      "stream.compaction",
      "stream.compaction",
      "stream.compaction",
      "stream.compaction",
      "stream.plan",
      "stream.compaction",
      "stream.text",
      "stream.done",
    ]);
    expect(frames.filter((f) => f.type === "stream.plan").map((f) => f.plan)).toEqual([
      {
        version: 1,
        operation: "write",
        steps: [
          { id: 1, title: "Read the brief", status: "in-progress" },
          { id: 2, title: "Write the answer", status: "not-started" },
        ],
      },
      { version: 2, operation: "update", steps: [{ id: 1, title: "Read the brief", status: "completed" }] },
    ]);
    expect(frames.filter((f) => f.type === "stream.compaction").map((f) => [f.id, f.phase])).toEqual([
      ["call_summary_1", "start"],
      ["call_summary_1", "done"],
      ["call_summary_2", "start"],
      ["call_summary_2", "skipped"],
      [undefined, "done"],
    ]);
    // nothing of the summary, the tokens or the plan's owner, criteria and evidence is on the wire
    expect(JSON.stringify(frames)).not.toMatch(/private text|exitCriteria|evidence|owner|Child step/);

    const log = await t.events();
    expect(log.filter((e) => e.type === "agent.plan").map((e) => e.data.version)).toEqual([1, 2]);
    // what the frame said about the plan, a reload says too: the first was written, the second updated
    expect(log.filter((e) => e.type === "agent.plan").map((e) => e.data.operation)).toEqual(["write", "update"]);
    expect(log.filter((e) => e.type === "agent.compaction").map((e) => e.data.id)).toEqual(["call_summary_1", undefined]);
    expect(JSON.stringify(log)).not.toMatch(/private text|exitCriteria|evidence|owner|Child step/);
  });
});
