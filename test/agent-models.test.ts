import { describe, expect, it, vi } from "vitest";
import { createAgentServer, createInMemoryProvider } from "../src/index.js";
import type { AgentModelOption, HostInvokeInput } from "../src/index.js";

const make = async () => {
  const storage = createInMemoryProvider();
  await storage.connect();
  return storage;
};

const models: AgentModelOption[] = [
  { key: "main", label: "Main", default: true },
  { key: "fast", label: "Fast", description: "Cheaper", default: false },
];

async function boot(withModels = true) {
  const server = createAgentServer({
    basePath: "/api",
    storage: await make(),
    allowAnonymousList: true,
    runs: { sweepIntervalMs: 0, recoverOnStart: false },
  });
  const seen: HostInvokeInput[] = [];
  server.registerHostAgent({
    info: { id: "h", name: "Host", ...(withModels && { models }) },
    invoke: (input) => {
      seen.push(input);
      return { content: "ok" };
    },
  });
  const call = (method: string, path: string, body?: unknown) => server.handleRoute(method, path, { query: {}, body, headers: {} });
  const id = ((await call("POST", "/conversations", { agentId: "h" })).body as any).conversation.id as string;
  return { server, call, id, seen };
}

describe("agent models", () => {
  it("advertises models on the agent descriptor", async () => {
    const { call } = await boot();
    const list = (await call("GET", "/agents")).body as any;
    expect(list.agents[0].models).toEqual(models);
    expect(((await call("GET", "/agents/h")).body as any).models).toEqual(models);
  });

  it("omits models when the agent has none", async () => {
    const { call } = await boot(false);
    expect(((await call("GET", "/agents/h")).body as any).models).toBeUndefined();
  });

  it("forwards the requested model to a host agent and records it on the answer", async () => {
    const { call, id, seen } = await boot();
    const res = await call("POST", `/conversations/${id}/messages`, { message: "hi", model: "fast" });
    expect(res.status).toBe(200);
    expect(seen[0]!.model).toBe("fast");
    expect((res.body as any).response.metadata.model).toBe("fast");
  });

  it("records the advertised default when no model is requested", async () => {
    const { call, id, seen } = await boot();
    const res = await call("POST", `/conversations/${id}/messages`, { message: "hi" });
    expect(seen[0]!.model).toBeUndefined();
    expect((res.body as any).response.metadata.model).toBe("main");
  });

  it("rejects a model that is not advertised with 400 model_not_allowed", async () => {
    const { call, id, seen } = await boot();
    const res = await call("POST", `/conversations/${id}/messages`, { message: "hi", model: "gpt-x" });
    expect(res.status).toBe(400);
    expect((res.body as any).error.code).toBe("model_not_allowed");
    expect(seen).toHaveLength(0);
  });

  it("rejects any model for an agent that advertises none, and a non-string model", async () => {
    const { call, id } = await boot(false);
    const res = await call("POST", `/conversations/${id}/messages`, { message: "hi", model: "x" });
    expect((res.body as any).error.code).toBe("model_not_allowed");
    const bad = await call("POST", `/conversations/${id}/messages`, { message: "hi", model: 5 });
    expect(bad.status).toBe(400);
  });

  it("applies to regenerate and edit", async () => {
    const { call, id, seen } = await boot();
    const sent = (await call("POST", `/conversations/${id}/messages`, { message: "hi" })).body as any;
    const regen = await call("POST", `/conversations/${id}/messages/${sent.response.id}/regenerate`, { model: "fast" });
    expect(regen.status).toBe(200);
    expect(seen.at(-1)!.model).toBe("fast");
    const denied = await call("POST", `/conversations/${id}/messages/${sent.message.id}/edit`, { content: "yo", model: "nope" });
    expect((denied.body as any).error.code).toBe("model_not_allowed");
    const edited = await call("POST", `/conversations/${id}/messages/${sent.message.id}/edit`, { content: "yo", model: "fast" });
    expect(edited.status).toBe(200);
    expect(seen.at(-1)!.model).toBe("fast");
  });

  it("calls selectModel before an sdk agent turn and validates static models", async () => {
    const server = createAgentServer({ basePath: "/api", storage: await make(), allowAnonymousList: true, runs: { sweepIntervalMs: 0, recoverOnStart: false } });
    const selectModel = vi.fn();
    const invoke = vi.fn(async () => ({ content: "sdk", messages: [] }));
    server.registerSDKAgent("s", { invoke }, { models }, { selectModel });
    const call = (m: string, p: string, body?: unknown) => server.handleRoute(m, p, { query: {}, body, headers: {} });
    const id = ((await call("POST", "/conversations", { agentId: "s" })).body as any).conversation.id as string;
    await call("POST", `/conversations/${id}/messages`, { message: "hi", model: "fast" });
    expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ model: "fast", conversationId: id }));
    expect(() => server.registerCustomAgent("c", { processMessage: async () => ({ content: "" }) }, { name: "C", models: [{ key: "", label: "", default: true }] })).toThrow(/key/);
  });
});
