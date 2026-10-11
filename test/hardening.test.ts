import { describe, expect, it, vi } from "vitest";
import { createAgentServer, type StorageProvider } from "../src/index.js";
import { fakeSdkAgent, memoryStorage, parseSse } from "./helpers.js";

const ctxFor = (userId: string) => () => ({ user: { id: userId }, data: {} });

async function streamError(mask: boolean, thrown: unknown) {
  const server = createAgentServer({
    basePath: "/api",
    storage: await memoryStorage(),
    maskServerErrors: mask,
    agents: [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => { throw thrown; }) }],
  });
  const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } });
  const id = (created.body as { conversation: { id: string } }).conversation.id;
  const res = await server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message: "hi", stream: true } });
  let text = "";
  for await (const chunk of res.stream!) text += chunk;
  return parseSse(text).find((e) => e.type === "stream.error");
}

describe("maskServerErrors", () => {
  const driverError = new Error("MongoServerError: connection string mongodb://user:pw@host failed");
  const hostError = Object.assign(new Error("Wait for it to finish"), { statusCode: 409, code: "CONVERSATION_BUSY" });

  it("keeps messages by default (backwards compatible)", async () => {
    expect((await streamError(false, driverError))?.error).toContain("MongoServerError");
  });

  it("hides the message of a plain error in the SSE stream", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const event = await streamError(true, driverError);
    expect(event).toMatchObject({ error: "An unexpected error occurred", code: "INTERNAL_ERROR" });
    expect(JSON.stringify(event)).not.toContain("mongodb");
  });

  it("lets a host-authored 4xx error through with its own code", async () => {
    expect(await streamError(true, hostError)).toMatchObject({ error: "Wait for it to finish", code: "CONVERSATION_BUSY" });
  });

  it("lets a deliberate 5xx through when it is marked expose: true", async () => {
    const unavailable = Object.assign(new Error("The assistant could not answer right now."), { statusCode: 502, code: "AGENT_UNAVAILABLE", expose: true });
    expect(await streamError(true, unavailable)).toMatchObject({ error: "The assistant could not answer right now.", code: "AGENT_UNAVAILABLE" });
    const unmarked = Object.assign(new Error("db password leaked"), { statusCode: 502 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await streamError(true, unmarked))?.error).toBe("An unexpected error occurred");
  });

  it("hides storage errors in the HTTP body and keeps 4xx messages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inner = await memoryStorage();
    const storage = new Proxy(inner, {
      get(t, p, r) {
        if (p === "getConversations") return async () => { throw new Error("BSON field skip must be >= 0"); };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as StorageProvider;
    const server = createAgentServer({ basePath: "/api", storage, maskServerErrors: true, resolveContext: ctxFor("u1") });
    const res = await server.handleRoute("GET", "/conversations", { query: {} });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("BSON");
    // an explicit 4xx stays readable
    const notFound = await server.handleRoute("GET", "/conversations/missing", { query: {} });
    expect(notFound.status).toBe(404);
    expect((notFound.body as { error: { message: string } }).error.message).toMatch(/not found/i);
  });
});

describe("paging is clamped before storage", () => {
  it("floors negative offsets and caps the limit", async () => {
    const inner = await memoryStorage();
    const seen: Array<Record<string, unknown>> = [];
    const storage = new Proxy(inner, {
      get(t, p, r) {
        // (only what a client asked for: the expiry sweep looks for lapsed requests with its own query)
        if (p === "getConversations") return async (params: Record<string, unknown>) => { if (!params.actionDueBefore) seen.push(params); return { data: [], total: 0, limit: 0, offset: 0, hasMore: false }; };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as StorageProvider;
    const server = createAgentServer({ basePath: "/api", storage, allowAnonymousList: true });
    await server.handleRoute("GET", "/conversations", { query: { limit: "999999", offset: "-5" } });
    await server.handleRoute("GET", "/conversations", { query: { limit: "-3", offset: "abc" } });
    expect(seen[0]).toMatchObject({ limit: 200, offset: 0 });
    expect(seen[1]).toMatchObject({ limit: 20, offset: 0 });
  });
});

describe("trusted identity is fail-closed", () => {
  it("refuses a conversation that carries no owner", async () => {
    const storage = await memoryStorage();
    const orphan = await storage.createConversation({ agentId: "a" } as never);
    const server = createAgentServer({
      basePath: "/api",
      storage,
      resolveContext: ctxFor("u1"),
      agents: [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "x" })) }],
    });
    const read = await server.handleRoute("GET", `/conversations/${orphan.id}`, { query: {} });
    expect(read.status).toBe(403);
    const send = await server.handleRoute("POST", `/conversations/${orphan.id}/messages`, { query: {}, body: { message: "hi" } });
    expect(send.status).toBe(403);
  });
});
