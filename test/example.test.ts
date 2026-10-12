/**
 * The standalone example (examples/standalone), run for real: the Node HTTP server, an agent-sdk agent on the scripted model, and a
 * host-backed agent, over SQLite and over MongoDB. This is what the end-to-end run starts, so it must keep working. Skipped when there is
 * no agent-sdk to load (see vitest.config.ts).
 */

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { parseSse } from "./helpers.js";
import { hasSdk } from "./sdk.js";

type Example = { url: string; close: () => Promise<void> };

async function start(kind: "sqlite" | "mongodb" | "memory"): Promise<Example> {
  const { createExampleServer } = (await import("../examples/standalone/app.js")) as typeof import("../examples/standalone/app.js");
  const infra = inject("storageInfra").mongodb;
  const app = await createExampleServer({
    storage: kind,
    sqliteFile: ":memory:",
    ...(kind === "mongodb" && "url" in infra ? { mongodbUrl: infra.url, mongodbDatabase: `example_${randomBytes(4).toString("hex")}` } : {}),
    model: undefined,
    sweep: false,
  });
  const { url } = await app.listen(0);
  return { url, close: () => app.close() };
}

const json = async (res: Response) => (res.headers.get("content-type")?.includes("json") ? res.json() : res.text()) as Promise<any>;

function client(base: string, user?: string) {
  const headers = (extra: Record<string, string> = {}) => ({ ...(user ? { "x-user-id": user } : {}), ...extra });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await json(res), res };
  };
  const create = async (agentId = "assistant") => (await call("POST", "/conversations", { agentId })).body.conversation.id as string;
  const send = (id: string, message: string, extra: Record<string, unknown> = {}) => call("POST", `/conversations/${id}/messages`, { message, ...extra });
  const resolve = (id: string, actionId: string, resolution: unknown) => call("POST", `/conversations/${id}/actions/${actionId}`, { resolution });
  const get = async (id: string) => (await call("GET", `/conversations/${id}`)).body;
  const events = async (id: string) => ((await call("GET", `/conversations/${id}/events`)).body.events as any[]).map((e) => e.type as string);
  const stream = async (id: string, message: string) => {
    const res = await fetch(`${base}/conversations/${id}/messages`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ message, stream: true }),
    });
    return { status: res.status, frames: parseSse(await res.text()), contentType: res.headers.get("content-type") };
  };
  return { call, create, send, resolve, get, events, stream, headers };
}

function exampleSuite(kind: "sqlite" | "mongodb" | "memory") {
  let example: Example | undefined;
  const boot = async () => (example ??= await start(kind));
  afterAll(async () => {
    await example?.close();
  });

  it("serves the agents and lists the demo user's conversations without any sign-in", async () => {
    const c = client((await boot()).url);
    const agents = (await c.call("GET", "/agents")).body.agents as any[];
    expect(agents.map((a) => a.id).sort()).toEqual(["assistant", "host-echo"]);
    expect(agents.find((a) => a.id === "host-echo")!.capabilities.toolApproval).toBe(true);
    const listed = await c.call("GET", "/conversations");
    expect(listed.status).toBe(200);
    expect(listed.body.conversations).toBeInstanceOf(Array);
  });

  it("answers a message and a streamed message, and counts what they cost", async () => {
    const c = client((await boot()).url);
    const id = await c.create();
    const sent = await c.send(id, "hello there");
    expect(sent.status).toBe(200);
    expect(sent.body.response.content).toBe('You said: "hello there"');
    expect(sent.body).toMatchObject({ stopReason: "end_turn", usage: { costUsd: expect.any(Number) } });
    expect(sent.body.usage.costUsd).toBeGreaterThan(0);

    const streamed = await c.stream(id, "again");
    expect(streamed.status).toBe(200);
    expect(streamed.contentType).toContain("text/event-stream");
    expect(streamed.frames.filter((f) => f.type === "stream.text").length).toBeGreaterThan(1);
    expect(streamed.frames.at(-1)).toMatchObject({ type: "stream.done", stopReason: "end_turn" });

    const conversation = (await c.get(id)).conversation;
    expect(conversation.spentUsd).toBeGreaterThan(0);
    expect(conversation.runtime).toMatchObject({ status: "idle", stopReason: "end_turn" });
  });

  it("pauses for an approval, and carries on once it is given", async () => {
    const c = client((await boot()).url);
    const id = await c.create();
    const paused = await c.send(id, "please deploy web");
    expect(paused.body).toMatchObject({ status: "requires_action", stopReason: "requires_action" });
    const action = paused.body.pendingActions[0];
    expect(action).toMatchObject({ type: "tool_approval", toolName: "deploy_service", args: { service: "web" } });
    expect((await c.get(id)).conversation.runtime.status).toBe("requires_action");

    const done = await c.resolve(id, action.id, { type: "tool_approval", decision: "allow" });
    expect(done.status).toBe(200);
    expect(done.body.response.content).toBe("Done. deploy_service said: web 1.0.0 is live");
    expect(await c.events(id)).toEqual(expect.arrayContaining(["action.required", "action.resolved", "agent.tool_use", "agent.tool_result", "session.work_done"]));
  });

  it("asks a question and takes the answer", async () => {
    const c = client((await boot()).url);
    const id = await c.create();
    const asked = await c.send(id, "ask me something");
    const action = asked.body.pendingActions[0];
    expect(action.type).toBe("user_question");
    const answered = await c.resolve(id, action.id, { type: "user_question", answers: { "Which environment?": "staging" } });
    expect(answered.status).toBe(200);
    expect(answered.body.response.content).toContain("staging");
  });

  it("lets the agent read a file the person uploaded", async () => {
    const c = client((await boot()).url);
    const id = await c.create();
    const upload = await fetch(`${(await boot()).url}/files?name=notes.txt&conversationId=${id}`, {
      method: "POST",
      headers: c.headers({ "content-type": "text/plain" }),
      body: "the launch code is 4242",
    });
    expect(upload.status).toBe(201);
    const sent = await c.send(id, "what is in my files?");
    expect(sent.status).toBe(200);
    expect(sent.body.response.content).toContain("the launch code is 4242");
    expect(await c.events(id)).toEqual(expect.arrayContaining(["agent.tool_use", "agent.tool_result"]));
  });

  it("stops a slow answer on request", async () => {
    const c = client((await boot()).url);
    const id = await c.create();
    const sending = c.send(id, "take your time, slow please");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await c.get(id)).conversation.runtime.status).toBe("running");
    const cancelled = await c.call("POST", `/conversations/${id}/cancel`);
    expect(cancelled.body).toMatchObject({ cancelled: true, stopReason: "cancelled" });
    const sent = await sending;
    expect(sent.body).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
    expect((await c.get(id)).conversation.runtime).toMatchObject({ status: "idle", stopReason: "cancelled" });
  });

  it("runs the host-backed agent: streamed text, and an approval of its own", async () => {
    const c = client((await boot()).url);
    const id = await c.create("host-echo");
    const streamed = await c.stream(id, "hi");
    expect(streamed.frames.filter((f) => f.type === "stream.text").length).toBeGreaterThan(1);
    expect(streamed.frames.at(-1)).toMatchObject({ type: "stream.done", content: 'You said: "hi"', stopReason: "end_turn" });

    const paused = await c.send(id, "deploy api");
    expect(paused.body).toMatchObject({ status: "requires_action", pendingActions: [{ toolName: "deploy_service", title: "Deploy api?" }] });
    const done = await c.resolve(id, paused.body.pendingActions[0].id, { type: "tool_approval", decision: "allow" });
    expect(done.body.response.content).toBe("Deployed api.");
    const denied = await c.send(id, "deploy db");
    const no = await c.resolve(id, denied.body.pendingActions[0].id, { type: "tool_approval", decision: "deny" });
    expect(no.body.response.content).toBe("Left db alone.");
  });

  it("keeps people apart: another user sees nothing of the demo user's conversations", async () => {
    const base = (await boot()).url;
    const demo = client(base);
    const id = await demo.create();
    const bob = client(base, "bob");
    expect((await bob.call("GET", `/conversations/${id}`)).status).toBe(403);
    const listed = (await bob.call("GET", "/conversations")).body.conversations as any[];
    expect(listed.find((c) => c.id === id)).toBeUndefined();
  });

  it("speaks CORS to a browser and keeps to its base path", async () => {
    const base = (await boot()).url;
    const preflight = await fetch(`${base}/conversations`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type,last-event-id" },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Last-Event-ID");
    const elsewhere = await fetch(`${new URL(base).origin}/nowhere`);
    expect(elsewhere.status).toBe(404);
    expect((await fetch(`${base}/docs/openapi.json`)).status).toBe(200);
  });
}

describe.skipIf(!hasSdk)("the standalone example", () => {
  describe("on SQLite", () => exampleSuite("sqlite"));
  describe("on MongoDB", () => {
    const infra = inject("storageInfra").mongodb;
    if ("url" in infra) exampleSuite("mongodb");
    else it.skip(`MongoDB is not available here: ${infra.skip}`, () => undefined);
  });
});
