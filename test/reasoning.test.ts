import { describe, expect, it } from "vitest";
import { createAgentServer, createInMemoryProvider } from "../src/index.js";
import type { HostInvokeInput } from "../src/index.js";

const parseSse = (text: string): any[] =>
  text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => !!l)
    .map((l) => l.slice(5).trim())
    .filter((d) => d.startsWith("{"))
    .map((d) => JSON.parse(d));

async function boot(showReasoning?: boolean) {
  const storage = createInMemoryProvider();
  await storage.connect();
  const server = createAgentServer({
    basePath: "/api",
    storage,
    allowAnonymousList: true,
    runs: { sweepIntervalMs: 0, recoverOnStart: false },
  });
  const seen: HostInvokeInput[] = [];
  server.registerHostAgent({
    info: { id: "h", name: "Host", ...(showReasoning !== undefined && { showReasoning }) },
    invoke: (input, { emit }) => {
      seen.push(input);
      emit({ type: "thinking", text: "hmm " });
      emit({ type: "thinking", text: "ok" });
      emit({ type: "text", text: "answer" });
      return { content: "answer" };
    },
  });
  const call = (method: string, path: string, body?: unknown) => server.handleRoute(method, path, { query: {}, body, headers: {} });
  const id = ((await call("POST", "/conversations", { agentId: "h" })).body as any).conversation.id as string;
  const stream = async (extra: Record<string, unknown> = {}) => {
    const res = await call("POST", `/conversations/${id}/messages`, { message: "hi", stream: true, ...extra });
    let text = "";
    for await (const chunk of res.stream!) text += chunk;
    return parseSse(text);
  };
  return { call, id, seen, stream };
}

describe("reasoning stream", () => {
  it("sends stream.thinking frames that are not part of the answer", async () => {
    const t = await boot();
    const frames = await t.stream();
    expect(frames.filter((f) => f.type === "stream.thinking").map((f) => f.thinking)).toEqual(["hmm ", "ok"]);
    expect(frames.filter((f) => f.type === "stream.text").map((f) => f.text).join("")).toBe("answer");
    const done = frames.find((f) => f.type === "stream.done");
    expect(JSON.stringify(done)).not.toContain("hmm");
  });

  it("sends them when showReasoning is true, and none when it is false", async () => {
    expect((await (await boot(true)).stream()).some((f) => f.type === "stream.thinking")).toBe(true);
    const hidden = await (await boot(false)).stream();
    expect(hidden.some((f) => f.type === "stream.thinking")).toBe(false);
    expect(hidden.some((f) => f.type === "stream.text")).toBe(true);
  });

  it("does not stream thinking in a non-streamed turn", async () => {
    const t = await boot();
    const res = await t.call("POST", `/conversations/${t.id}/messages`, { message: "hi" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("hmm");
  });

  it("publishes showReasoning on the agent descriptor", async () => {
    const t = await boot(false);
    expect(((await t.call("GET", "/agents/h")).body as any).showReasoning).toBe(false);
  });
});

describe("reasoningEffort", () => {
  it.each(["none", "minimal", "low", "medium", "high"])("forwards %s to a host agent", async (effort) => {
    const t = await boot();
    const res = await t.call("POST", `/conversations/${t.id}/messages`, { message: "hi", reasoningEffort: effort });
    expect(res.status).toBe(200);
    expect(t.seen[0]!.reasoningEffort).toBe(effort);
  });

  it("leaves it unset when the request names none", async () => {
    const t = await boot();
    await t.call("POST", `/conversations/${t.id}/messages`, { message: "hi" });
    expect(t.seen[0]!.reasoningEffort).toBeUndefined();
  });

  it("answers 400 for an invalid value, before the agent runs", async () => {
    const t = await boot();
    for (const bad of ["extreme", 3, true]) {
      const res = await t.call("POST", `/conversations/${t.id}/messages`, { message: "hi", reasoningEffort: bad });
      expect(res.status).toBe(400);
      expect((res.body as any).error.message).toContain("reasoningEffort");
    }
    expect(t.seen).toHaveLength(0);
  });

  it("applies to regenerate and edit", async () => {
    const t = await boot();
    const sent = (await t.call("POST", `/conversations/${t.id}/messages`, { message: "hi" })).body as any;
    const regen = await t.call("POST", `/conversations/${t.id}/messages/${sent.response.id}/regenerate`, { reasoningEffort: "high" });
    expect(regen.status).toBe(200);
    expect(t.seen.at(-1)!.reasoningEffort).toBe("high");
    const n = t.seen.length;
    const bad = await t.call("POST", `/conversations/${t.id}/messages/${sent.message.id}/edit`, { content: "yo", reasoningEffort: "x" });
    expect(bad.status).toBe(400);
    expect(t.seen).toHaveLength(n);
    const edited = await t.call("POST", `/conversations/${t.id}/messages/${sent.message.id}/edit`, { content: "yo", reasoningEffort: "low" });
    expect(edited.status).toBe(200);
    expect(t.seen.at(-1)!.reasoningEffort).toBe("low");
    const badRegen = await t.call("POST", `/conversations/${t.id}/messages/${sent.response.id}/regenerate`, { reasoningEffort: "x" });
    expect(badRegen.status).toBe(400);
  });
});
