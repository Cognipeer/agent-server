/**
 * Stop: a run the person cancelled is recorded as cancelled on every kind of agent, and the model request is hung up on - over every
 * storage provider (memory, SQLite, MongoDB, PostgreSQL). Also the snapshot a follower is sent first when it joins a run in progress,
 * and the failure the runtime reports for a turn that ended in error.
 */

import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentServer, createInMemoryProvider, withSessionImages } from "../src/index.js";
import type { AgentHandler, AgentServerConfig, StorageProvider } from "../src/index.js";
import { Follower, eventually, fakeSdkAgent, gate, listen } from "./helpers.js";
import { sdk, sdkAbortsRequests } from "./sdk.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider } from "./storage/providers.js";

let active: { current: OpenedProvider } | undefined;
const currentStorage = (): StorageProvider => active!.current.storage;

const allow = { type: "tool_approval", decision: "allow" } as const;
const types = (events: any[]) => events.map((e) => e.type as string);

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** Waits for the abort signal the server passes as the SDK's cancellation token. */
const untilAborted = (config: any) =>
  new Promise<void>((resolve) => {
    const signal: AbortSignal = config.cancellationToken;
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

async function boot(agent: unknown | { handler: AgentHandler }, config: Partial<AgentServerConfig> = {}, over?: StorageProvider) {
  const storage = over ?? currentStorage();
  const registration =
    agent && typeof agent === "object" && "handler" in (agent as object)
      ? { info: { id: "a", name: "A" }, handler: (agent as { handler: AgentHandler }).handler }
      : { info: { id: "a", name: "A" }, sdkAgent: agent };
  const server = createAgentServer({
    basePath: "/api",
    storage,
    agents: [registration as any],
    allowAnonymousList: true,
    ...config,
    runs: { sweepIntervalMs: 0, recoverOnStart: false, ...(config.runs ?? {}) },
  });
  const call = (method: string, path: string, extra: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}) =>
    server.handleRoute(method, path, { query: extra.query ?? {}, body: extra.body, headers: extra.headers });
  const id = ((await call("POST", "/conversations", { body: { agentId: "a" } })).body as any).conversation.id as string;
  const send = (message = "go", stream = false) => call("POST", `/conversations/${id}/messages`, { body: { message, stream } });
  const resolve = (actionId = "ap1", body: Record<string, unknown> = {}) =>
    call("POST", `/conversations/${id}/actions/${actionId}`, { body: { resolution: allow, ...body } });
  const cancel = () => call("POST", `/conversations/${id}/cancel`);
  const get = async () => (await call("GET", `/conversations/${id}`)).body as any;
  const runtime = async () => (await get()).conversation.runtime as any;
  const events = async (query: Record<string, string> = {}) => ((await call("GET", `/conversations/${id}/events`, { query })).body as any).events as any[];
  const follower = async (query: Record<string, string> = {}) =>
    new Follower((await call("GET", `/conversations/${id}/events/stream`, { query })) as any);
  const activeRun = () => (server as any).runs.get(id) as { id: string; streamedText: string; lastSeq: number } | undefined;
  return { server, storage, id, call, send, resolve, cancel, get, runtime, events, follower, activeRun };
}

/** An agent-sdk-shaped agent that pauses on its first call and finishes after the decision. */
function pausingAgent(hooks: { onResume?: (config: any) => Promise<unknown> } = {}) {
  return {
    invoke: async (input: any, config?: any) => {
      const resolved = (input.pendingApprovals ?? []).find((a: any) => a.status === "approved" || a.status === "rejected");
      if (!resolved) {
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
      const override = await hooks.onResume?.(config);
      if (override) return override as any;
      return { content: "deployed", messages: [], metadata: {}, state: { messages: [], pendingApprovals: [], pendingUserQuestions: [] } };
    },
    resolveToolApproval: (state: any, r: any) => {
      const approvals = (state.pendingApprovals ?? []).map((a: any) => ({ ...a }));
      const entry = approvals.find((a: any) => a.id === r.id);
      entry.status = r.approved ? "approved" : "rejected";
      const ctx = { ...(state.ctx ?? {}) };
      delete ctx.__awaitingApproval;
      return { ...state, pendingApprovals: approvals, ctx };
    },
    resolveUserQuestion: (state: any) => state,
  };
}

// ----------------------------------------------------------------------------
// Stop is recorded as a cancellation
// ----------------------------------------------------------------------------

function stopSuite() {
  describe("an agent-sdk agent that finishes anyway", () => {
    // An SDK that does not hang up on the model returns an ordinary answer after the cancel; Stop still wins.
    const stubborn = (text: string, started: ReturnType<typeof gate>, streamed = "") =>
      fakeSdkAgent(async (_p, config: any) => {
        if (streamed) config?.onStream?.({ text: streamed });
        started.open();
        await untilAborted(config);
        // (no `__cancelled` on the state: the SDK did not notice)
        return { content: text, messages: [], metadata: {}, state: { messages: [], ctx: {} } } as any;
      });

    it("records the turn as cancelled: message status, runtime, idle event - and keeps the text streamed so far", async () => {
      const started = gate();
      const t = await boot(stubborn("The whole answer, written to the end.", started, "The whole "));
      const res = await t.send("write something long", true);
      const mine = new Follower(res as any);
      await started.promise;
      await t.cancel();
      await mine.until((f) => f.ended);

      const done = mine.frames.map((f) => f.data).filter(Boolean).find((d: any) => d.type === "stream.done");
      expect(done).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
      const conversation = await t.get();
      const assistant = (conversation.messages as any[]).at(-1);
      expect(assistant).toMatchObject({ role: "assistant", status: "cancelled", metadata: { status: "cancelled", stopReason: "cancelled" } });
      expect(String(assistant.content)).not.toBe("");
      expect(conversation.conversation.runtime).toMatchObject({ status: "idle", stopReason: "cancelled" });
      const log = await t.events();
      expect(log.at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "cancelled" } });
      expect(types(log)).not.toContain("session.work_done");
      expect(types(log)).not.toContain("session.error");
    });

    it("does the same for a request that is not streamed", async () => {
      const started = gate();
      const t = await boot(stubborn("A finished answer.", started));
      const sending = t.send("hello");
      await started.promise;
      const cancelled = await t.cancel();
      expect(cancelled.body).toMatchObject({ cancelled: true, settled: true, stopReason: "cancelled" });
      const sent = (await sending).body as any;
      expect(sent).toMatchObject({ status: "cancelled", stopReason: "cancelled", response: { status: "cancelled" } });
      expect(await t.runtime()).toMatchObject({ status: "idle", stopReason: "cancelled" });
      expect((await t.events()).at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "cancelled" } });
    });

    it("cancels the turn that carries on after an approval", async () => {
      const started = gate();
      const t = await boot(
        pausingAgent({
          onResume: async (config) => {
            config?.onStream?.({ text: "Deploying " });
            started.open();
            await untilAborted(config);
            return { content: "Deployed everything.", messages: [], metadata: {}, state: { messages: [], pendingApprovals: [], pendingUserQuestions: [] } };
          },
        })
      );
      await t.send("deploy");
      const resolving = t.resolve("ap1");
      await started.promise;
      await t.cancel();
      const resolved = (await resolving).body as any;
      expect(resolved).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
      expect(await t.runtime()).toMatchObject({ status: "idle", stopReason: "cancelled" });
      const log = await t.events();
      expect(log.at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "cancelled" } });
      const messages = (await t.get()).messages as any[];
      expect(messages.at(-1)).toMatchObject({ role: "assistant", status: "cancelled" });
      // the conversation works again
      expect((await t.send("again")).status).toBe(200);
    });
  });

  describe("a handler", () => {
    it("is recorded as cancelled with the signal aborted, also when it returns an ordinary answer", async () => {
      let seen: AbortSignal | undefined;
      const started = gate();
      const handler: AgentHandler = {
        async processMessage(params) {
          seen = params.signal;
          started.open();
          await new Promise<void>((resolve) => params.signal!.addEventListener("abort", () => resolve(), { once: true }));
          return { content: "all done after all" };
        },
      };
      const t = await boot({ handler });
      const sending = t.send("go");
      await started.promise;
      await t.cancel();
      const sent = (await sending).body as any;
      expect(seen!.aborted).toBe(true);
      expect(sent).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
      expect(await t.runtime()).toMatchObject({ status: "idle", stopReason: "cancelled" });
      expect((await t.events()).at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "cancelled" } });
    });
  });

  describe("a host agent", () => {
    it("is recorded as cancelled with its signal aborted", async () => {
      const started = gate();
      let signal: AbortSignal | undefined;
      const server = createAgentServer({ basePath: "/api", storage: currentStorage(), allowAnonymousList: true, runs: { sweepIntervalMs: 0, recoverOnStart: false } });
      server.registerHostAgent({
        info: { id: "h", name: "H" },
        invoke: async (_input, io) => {
          signal = io.signal;
          io.emit({ type: "text", text: "partial " });
          started.open();
          await new Promise<void>((resolve) => io.signal.addEventListener("abort", () => resolve(), { once: true }));
          return { content: "a finished answer" };
        },
      });
      const call = (method: string, path: string, body?: unknown) => server.handleRoute(method, path, { query: {}, body });
      const id = ((await call("POST", "/conversations", { agentId: "h" })).body as any).conversation.id as string;
      const sending = call("POST", `/conversations/${id}/messages`, { message: "go" });
      await started.promise;
      await call("POST", `/conversations/${id}/cancel`);
      const sent = (await sending).body as any;
      expect(signal!.aborted).toBe(true);
      expect(sent).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
      const runtime = ((await call("GET", `/conversations/${id}`)).body as any).conversation.runtime;
      expect(runtime).toMatchObject({ status: "idle", stopReason: "cancelled" });
    });
  });
}

// ----------------------------------------------------------------------------
// Snapshot of a run in progress
// ----------------------------------------------------------------------------

function snapshotSuite() {
  /** A streaming agent: says "Hello ", waits, then says "world". */
  function talkingAgent() {
    const midway = gate();
    const proceed = gate();
    const agent = fakeSdkAgent(async (_p, config: any) => {
      config?.onStream?.({ text: "Hello " });
      midway.open();
      await proceed.promise;
      config?.onStream?.({ text: "world" });
      return { content: "Hello world" };
    });
    return { agent, midway, proceed };
  }

  it("sends one snapshot first - no id, not stored - then the deltas that follow it", async () => {
    const { agent, midway, proceed } = talkingAgent();
    const t = await boot(agent);
    const turn = new Follower((await t.send("hi there", true)) as any);
    await midway.promise;
    await eventually(() => t.activeRun()?.streamedText === "Hello ", 4000, "the first chunk to be delivered");

    const watcher = await t.follower({ after: String((await t.runtime()).lastEventSeq) });
    await watcher.until((f) => f.frames.some((x) => x.event === "agent.message.snapshot"));
    expect(watcher.frames[0]).toEqual({ comment: "open" });
    const snapshot = watcher.frames[1]!;
    expect(snapshot.id).toBeUndefined();
    expect(snapshot.event).toBe("agent.message.snapshot");
    const runId = (await t.runtime()).activeRunId as string;
    expect(runId).toMatch(/^run_/);
    expect(snapshot.data).toEqual({
      type: "agent.message.snapshot",
      data: { run_id: runId, text: "Hello ", user_message: { id: expect.any(String), content: "hi there", files: [] } },
    });
    // the snapshot's message is the stored one
    const stored = ((await t.get()).messages as any[]).find((m) => m.role === "user");
    expect(snapshot.data.data.user_message.id).toBe(stored.id);

    proceed.open();
    await watcher.until((f) => f.types.includes("session.work_done"));
    await turn.until((f) => f.ended);
    const snapshots = watcher.frames.filter((f) => f.event === "agent.message.snapshot");
    expect(snapshots).toHaveLength(1);
    const deltas = watcher.frames.filter((f) => f.event === "agent.message.delta").map((f) => f.data.text as string);
    // what the person sees: the snapshot, then every delta appended - the stored answer
    expect(snapshot.data.data.text + deltas.join("")).toBe("Hello world");
    expect(((await t.get()).messages as any[]).at(-1).content).toBe("Hello world");
    // it is not in the log, and no stored event carries it
    expect(types(await t.events())).not.toContain("agent.message.snapshot");
    expect(watcher.frames.filter((f) => f.id !== undefined).every((f) => f.event !== "agent.message.snapshot")).toBe(true);
    watcher.close();
  });

  it("says what the run has so far even before the first token, and names no user message for a run that answers an action", async () => {
    const started = gate();
    const t = await boot(
      pausingAgent({
        onResume: async () => {
          started.open();
          await new Promise(() => undefined);
          return undefined;
        },
      }),
      { runs: { cancelGraceMs: 30 } }
    );
    await t.send("deploy");
    const resolving = t.resolve("ap1");
    await started.promise;
    const watcher = await t.follower({ after: "999" });
    await watcher.until((f) => f.frames.some((x) => x.event === "agent.message.snapshot"));
    expect(watcher.frames[1]!.data.data).toEqual({ run_id: (await t.runtime()).activeRunId, text: "", user_message: null });
    watcher.close();
    await t.cancel();
    await resolving;
  });

  it("sends none when nothing is running, and none to a follower whose types name neither the snapshot nor the deltas", async () => {
    const t = await boot(fakeSdkAgent(async () => ({ content: "hi" })));
    await t.send("one");
    const idle = await t.follower({ after: "0" });
    await idle.until((f) => f.types.includes("session.work_done"));
    expect(idle.frames.some((f) => f.event === "agent.message.snapshot")).toBe(false);
    idle.close();

    const { agent, midway, proceed } = talkingAgent();
    const busy = await boot(agent);
    const turn = new Follower((await busy.send("hi", true)) as any);
    await midway.promise;
    const filtered = await busy.follower({ types: "agent.message,session.status_idle", after: "99" });
    await new Promise((r) => setTimeout(r, 30));
    expect(filtered.frames.some((f) => f.event === "agent.message.snapshot")).toBe(false);
    filtered.close();
    // naming the snapshot is enough to get it
    const asked = await busy.follower({ types: "agent.message.snapshot", after: "99" });
    await asked.until((f) => f.frames.some((x) => x.event === "agent.message.snapshot"));
    asked.close();
    proceed.open();
    await turn.until((f) => f.ended);
  });

  it("does not drop text that is queued when events of the same run are stored in between", async () => {
    // The follower reads the log after the run has said "B " and called a tool: the read returns the tool's events, which are newer than
    // the text. That text is in no stored event yet, so it must still reach the follower.
    const inner = createInMemoryProvider();
    await inner.connect();
    const hold = gate();
    let armed = false;
    let blocked = false;
    const proxy = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "events") {
          const events = target.events!;
          return {
            ...events,
            append: events.append.bind(events),
            summary: events.summary?.bind(events),
            list: async (...args: Parameters<typeof events.list>) => {
              if (armed && !blocked) {
                blocked = true;
                await hold.promise;
              }
              return events.list(...args);
            },
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorageProvider;

    const midway = gate();
    const proceed = gate();
    const finish = gate();
    const t = await boot(
      fakeSdkAgent(async (_p, config: any) => {
        config?.onStream?.({ text: "A " });
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "t", id: "c1", args: {} });
        config?.onEvent?.({ type: "tool_call", phase: "success", name: "t", id: "c1", result: 1 });
        midway.open();
        await proceed.promise;
        config?.onStream?.({ text: "B " });
        config?.onEvent?.({ type: "tool_call", phase: "start", name: "t", id: "c2", args: {} });
        config?.onEvent?.({ type: "tool_call", phase: "success", name: "t", id: "c2", result: 2 });
        await finish.promise;
        return { content: "A B " };
      }),
      {},
      proxy
    );
    const turn = new Follower((await t.send("go", true)) as any);
    await midway.promise;
    await eventually(() => t.activeRun()?.streamedText === "A " && t.activeRun()!.lastSeq >= 4, 4000, "the first chunk and tool call to be stored");

    armed = true;
    const watcher = await t.follower();
    await watcher.until((f) => f.frames.some((x) => x.event === "agent.message.snapshot"));
    await eventually(() => blocked, 4000, "the follower to start reading the log");
    proceed.open();
    await eventually(() => t.activeRun()!.streamedText === "A B " && t.activeRun()!.lastSeq >= 6, 4000, "the second chunk and tool call to be stored");
    hold.open();
    await watcher.until((f) => f.frames.some((x) => x.event === "agent.message.delta"), 4000, "the queued text to reach the follower");
    finish.open();
    await watcher.until((f) => f.types.includes("session.work_done"));
    await turn.until((f) => f.ended);

    const snapshot = watcher.frames.find((f) => f.event === "agent.message.snapshot")!;
    const deltas = watcher.frames.filter((f) => f.event === "agent.message.delta").map((f) => f.data.text as string);
    expect(snapshot.data.data.text).toBe("A ");
    expect(snapshot.data.data.text + deltas.join("")).toBe("A B ");
    watcher.close();
  });
}

// ----------------------------------------------------------------------------
// The failure the runtime reports
// ----------------------------------------------------------------------------

function runtimeErrorSuite() {
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

  it("says a run was interrupted, in the conversation and in the list, until the next turn", async () => {
    const t = await boot(fakeSdkAgent(async () => ({ content: "back again" })));
    await dieMidTurn(t.storage, t.id);
    await t.server.recoverStaleRuns();

    const runtime = await t.runtime();
    expect(runtime).toMatchObject({
      status: "idle",
      stopReason: "error",
      error: { code: "run_interrupted", message: expect.stringContaining("interrupted") },
    });
    const listed = ((await t.call("GET", "/conversations")).body as any).conversations.find((c: any) => c.id === t.id);
    expect(listed.runtime.error).toEqual(runtime.error);

    // the next turn is a new start: nothing of the old failure is left on it
    expect((await t.send("hello again")).status).toBe(200);
    const after = await t.runtime();
    expect(after.stopReason).toBe("end_turn");
    expect(after.error).toBeUndefined();
  });

  it("carries the failure of a turn that threw, and nothing for a turn that ended some other way", async () => {
    const failing = await boot(
      fakeSdkAgent(async () => {
        throw Object.assign(new Error("the model is down"), { statusCode: 502, code: "MODEL_DOWN", expose: true });
      })
    );
    expect((await failing.send("hi")).status).toBeGreaterThanOrEqual(500);
    const runtime = await failing.runtime();
    expect(runtime).toMatchObject({ status: "idle", stopReason: "error", error: { code: expect.any(String), message: expect.any(String) } });
    const logged = (await failing.events({ types: "session.error" }))[0];
    expect(runtime.error).toEqual({ code: logged.data.code, message: logged.data.message });

    // a handler that only says stopReason "error" left no failure in the log: there is nothing to report
    const quiet = await boot({ handler: { processMessage: async () => ({ content: "gave up", stopReason: "error", status: "incomplete" }) } });
    await quiet.send("hi");
    const calm = await quiet.runtime();
    expect(calm).toMatchObject({ status: "idle", stopReason: "error" });
    expect(calm.error).toBeUndefined();

    // cancelled is not an error
    const stopped = await boot(fakeSdkAgent(async (_p, config: any) => {
      await untilAborted(config);
      return { content: "", state: { ctx: { __cancelled: { stage: "tools" } } } } as any;
    }));
    const sending = stopped.send("hi");
    await eventually(async () => (await stopped.runtime()).status === "running", 4000, "the run");
    await stopped.cancel();
    await sending;
    expect((await stopped.runtime()).error).toBeUndefined();
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
    describe("Stop", stopSuite);
    describe("reattaching to a run", snapshotSuite);
    describe("the failure of the last turn", runtimeErrorSuite);
  });
}

// ----------------------------------------------------------------------------
// The model request is hung up on
// ----------------------------------------------------------------------------

/**
 * A stand-in for the model API that records what the server does to it: how much of the answer it managed to write before the caller
 * hung up, and whether it was hung up on at all. `drip`: streams `words` chunks, `intervalMs` apart. `hold`: takes the request and never
 * answers.
 */
async function recordingModel(mode: "drip" | "hold", options: { words?: number; intervalMs?: number } = {}) {
  const words = options.words ?? 60;
  const intervalMs = options.intervalMs ?? 25;
  const state = { requests: 0, written: 0, total: words, hungUp: false, finished: false, streamed: [] as boolean[] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      state.requests++;
      const body = JSON.parse(raw || "{}");
      state.streamed.push(!!body.stream);
      res.on("close", () => {
        if (!res.writableFinished) state.hungUp = true;
      });
      if (mode === "hold") return; // never answers
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        setTimeout(() => {
          if (res.destroyed) return;
          state.finished = true;
          res.end(JSON.stringify({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "full answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }, words * intervalMs);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "" }));
      let i = 0;
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        if (i >= words) {
          clearInterval(timer);
          res.write(chunk({}, "stop"));
          res.end("data: [DONE]\n\n");
          state.finished = true;
          return;
        }
        res.write(chunk({ content: `w${i} ` }));
        i++;
        state.written = i;
      }, intervalMs);
      res.on("close", () => clearInterval(timer));
    });
  });
  const { url, close } = await listen(server);
  closers.push(close);
  return { url, state };
}

describe.skipIf(!sdkAbortsRequests)("Stop hangs up on the model (the real agent-sdk, a recording model API)", () => {
  async function bootReal(url: string) {
    const provider = sdk.createProvider({ provider: "openai-compatible", apiKey: "k", baseURL: url });
    // (as the example builds its agent: the session-image wrapper sits between the SDK and the model)
    const model = withSessionImages(sdk.fromNativeProvider(provider, { model: "m" }) as object);
    const agent = sdk.createSmartAgent({ name: "real", model, tools: [] });
    const storage = createInMemoryProvider();
    await storage.connect();
    closers.push(() => storage.disconnect());
    return boot(agent, { runs: { cancelGraceMs: 5000 } }, storage);
  }

  it("cuts a streamed answer off: the connection is closed before the model is done, and the words so far are kept", async () => {
    const model = await recordingModel("drip", { words: 80, intervalMs: 25 });
    const t = await bootReal(model.url);
    const res = await t.send("count for me", true);
    const mine = new Follower(res as any);
    await mine.until((f) => f.frames.filter((x) => x.data?.type === "stream.text").length >= 3, 6000, "a few words");

    const cancelled = await t.cancel();
    expect(cancelled.body).toMatchObject({ cancelled: true, settled: true, stopReason: "cancelled" });
    await mine.until((f) => f.ended);

    // the request was hung up on, long before the 80 words were written
    await eventually(() => model.state.hungUp, 3000, "the model request to be hung up");
    const writtenAtHangup = model.state.written;
    expect(writtenAtHangup).toBeLessThan(80);
    await new Promise((r) => setTimeout(r, 150));
    expect(model.state.written).toBe(writtenAtHangup); // and nothing more was asked of it
    expect(model.state.requests).toBe(1);
    expect(model.state.finished).toBe(false);

    const done = mine.frames.map((f) => f.data).filter(Boolean).find((d: any) => d.type === "stream.done");
    expect(done).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
    const conversation = await t.get();
    const assistant = (conversation.messages as any[]).at(-1);
    expect(assistant).toMatchObject({ role: "assistant", status: "cancelled", metadata: { stopReason: "cancelled" } });
    expect(String(assistant.content)).toMatch(/^w0 w1 /);
    expect(String(assistant.content).split(" ").length).toBeLessThan(80);
    expect(conversation.conversation.runtime).toMatchObject({ status: "idle", stopReason: "cancelled" });
    const log = await t.events();
    expect(log.at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "cancelled" } });
    expect(types(log)).not.toContain("session.error");
    expect(types(log)).not.toContain("session.work_done");
  });

  it("cuts a request that has not been answered at all", async () => {
    const model = await recordingModel("hold");
    const t = await bootReal(model.url);
    const sending = t.send("hello");
    await eventually(() => model.state.requests === 1, 6000, "the request to reach the model");

    const cancelled = await t.cancel();
    expect(cancelled.body).toMatchObject({ cancelled: true, settled: true, stopReason: "cancelled" });
    await eventually(() => model.state.hungUp, 3000, "the model request to be hung up");
    const sent = (await sending).body as any;
    expect(sent).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
    expect(await t.runtime()).toMatchObject({ status: "idle", stopReason: "cancelled" });
    expect(types(await t.events())).not.toContain("session.error");
    // the conversation takes the next message
    expect(model.state.requests).toBe(1);
  });

  it("cuts a request that is not streamed", async () => {
    const model = await recordingModel("drip", { words: 100, intervalMs: 30 });
    const t = await bootReal(model.url);
    const sending = t.send("hello");
    await eventually(() => model.state.requests === 1, 6000, "the request to reach the model");
    expect(model.state.streamed).toEqual([false]);
    await t.cancel();
    await eventually(() => model.state.hungUp, 3000, "the model request to be hung up");
    expect(model.state.finished).toBe(false);
    expect(((await sending).body as any).stopReason).toBe("cancelled");
  });
});

// ----------------------------------------------------------------------------
// Agents the server calls the model for itself
// ----------------------------------------------------------------------------

describe("Stop on an agent that calls an OpenAI-compatible API", () => {
  async function bootApi(kind: "chat" | "responses", url: string) {
    const storage = createInMemoryProvider();
    await storage.connect();
    const server = createAgentServer({ basePath: "/api", storage, runs: { sweepIntervalMs: 0, recoverOnStart: false } });
    if (kind === "chat") server.registerChatCompletionsAgent("a", { baseUrl: url, apiKey: "k", model: "m" }, { name: "A" });
    else server.registerResponsesAgent("a", { baseUrl: url, apiKey: "k", model: "m" }, { name: "A" });
    const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } });
    const id = (created.body as any).conversation.id as string;
    const call = (method: string, path: string, body?: unknown) => server.handleRoute(method, `/conversations/${id}${path}`, { query: {}, body });
    return { id, call, send: (stream: boolean) => call("POST", "/messages", { message: "hi", stream }) };
  }

  /** A model API that streams the way the kind of agent expects, a word at a time, and records the hang-up. */
  async function dripping(kind: "chat" | "responses") {
    const state = { hungUp: false, finished: false };
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.on("close", () => {
          if (!res.writableFinished) state.hungUp = true;
        });
        res.writeHead(200, { "content-type": "text/event-stream" });
        let i = 0;
        const timer = setInterval(() => {
          if (res.destroyed) return clearInterval(timer);
          if (i >= 60) {
            clearInterval(timer);
            state.finished = true;
            return void res.end();
          }
          const word = `w${i++} `;
          res.write(
            kind === "chat"
              ? `data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`
              : `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: word })}\n\n`
          );
        }, 20);
        res.on("close", () => clearInterval(timer));
      });
    });
    const { url, close } = await listen(server);
    closers.push(close);
    return { url, state };
  }

  for (const kind of ["chat", "responses"] as const) {
    it(`records a stopped ${kind} stream as cancelled, keeps its words and hangs up on the model`, async () => {
      const model = await dripping(kind);
      const t = await bootApi(kind, model.url);
      const mine = new Follower((await t.send(true)) as any);
      await mine.until((f) => f.frames.filter((x) => x.data?.type === "stream.text").length >= 3, 6000, "a few words");
      const cancelled = await t.call("POST", "/cancel");
      expect(cancelled.body).toMatchObject({ cancelled: true, settled: true, stopReason: "cancelled", runtime: { status: "idle", stopReason: "cancelled" } });
      await mine.until((f) => f.ended);
      await eventually(() => model.state.hungUp, 3000, "the model request to be hung up");
      expect(model.state.finished).toBe(false);

      const done = mine.frames.map((f) => f.data).find((d: any) => d?.type === "stream.done");
      expect(done).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
      expect(String(done.content)).toMatch(/^w0 w1 /);
      const messages = ((await t.call("GET", "")).body as any).messages as any[];
      expect(messages.at(-1)).toMatchObject({ role: "assistant", status: "cancelled", metadata: { stopReason: "cancelled" } });
      const log = ((await t.call("GET", "/events")).body as any).events as any[];
      expect(log.at(-1)).toMatchObject({ type: "session.status_idle", data: { stop_reason: "cancelled" } });
      expect(types(log)).not.toContain("session.work_done");
    });
  }
});
