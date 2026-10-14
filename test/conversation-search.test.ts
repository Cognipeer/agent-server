import { describe, expect, it, vi } from "vitest";
import { createAgentServer, createInMemoryProvider, type StorageProvider } from "../src/index.js";
import { fakeSdkAgent, memoryStorage } from "./helpers.js";

const agents = [{ info: { id: "a", name: "A" }, sdkAgent: fakeSdkAgent(async () => ({ content: "ok" })) }];
const asUser = (id: string) => ({ query: {}, headers: { "x-user": id } });

async function boot(storage: StorageProvider) {
  return createAgentServer({
    basePath: "/api",
    storage,
    agents,
    auth: { enabled: false, resolveUserId: (c) => c.headers?.["x-user"] as string | undefined },
  });
}

const list = (server: Awaited<ReturnType<typeof boot>>, user: string, query: Record<string, string>) =>
  server.handleRoute("GET", "/conversations", { ...asUser(user), query });

describe("GET /conversations?q=", () => {
  it("searches titles and message text through the storage ('full')", async () => {
    const storage = await memoryStorage();
    const server = await boot(storage);
    const a = await storage.createConversation({ agentId: "a", userId: "u1", title: "Invoices" });
    const b = await storage.createConversation({ agentId: "a", userId: "u1", title: "Chat" });
    await storage.createMessage({ conversationId: b.id, role: "user", content: "where is my INVOICE?" });
    await storage.createConversation({ agentId: "a", userId: "u2", title: "invoice of u2" });

    const res = await list(server, "u1", { q: "  invoice " });
    expect(res.status).toBe(200);
    const body = res.body as { conversations: Array<{ id: string; searchMatch?: { field: string; snippet: string } }>; total: number; searchMode: string };
    expect(body.searchMode).toBe("full");
    expect(body.total).toBe(2);
    expect(body.conversations.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(body.conversations.find((c) => c.id === b.id)!.searchMatch).toMatchObject({ field: "message", snippet: "where is my INVOICE?" });
    expect(JSON.stringify(body)).not.toContain("u2");
  });

  it("advertises the search mode on GET /agents", async () => {
    const full = await boot(await memoryStorage());
    expect(((await full.handleRoute("GET", "/agents", asUser("u1"))).body as { features: unknown }).features).toEqual({ conversationSearch: "full" });

    const inner = await memoryStorage();
    const titleOnly = await boot({ ...bind(inner), capabilities: () => ({ ...inner.capabilities!(), search: false }) });
    expect(((await titleOnly.handleRoute("GET", "/agents", asUser("u1"))).body as { features: unknown }).features).toEqual({ conversationSearch: "title" });
  });

  it("answers 400 invalid_request for a long q and treats a one-character q as no search", async () => {
    const storage = await memoryStorage();
    const server = await boot(storage);
    await storage.createConversation({ agentId: "a", userId: "u1", title: "x" });
    await storage.createConversation({ agentId: "a", userId: "u1", title: "y" });
    const long = await list(server, "u1", { q: "a".repeat(201) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(long.body)).toContain("invalid_request");
    const short = (await list(server, "u1", { q: "x" })).body as { total: number; searchMode?: string };
    expect(short.total).toBe(2);
    expect(short.searchMode).toBeUndefined();
  });

  it("falls back to titles of the recent conversations when the storage cannot search", async () => {
    const inner = createInMemoryProvider();
    await inner.connect();
    const searchSpy = vi.fn();
    const storage = {
      ...bind(inner),
      capabilities: () => ({ ...inner.capabilities!(), search: false }),
      getConversations: (p: Parameters<StorageProvider["getConversations"]>[0], c?: Parameters<StorageProvider["getConversations"]>[1]) => {
        if (p.search !== undefined) searchSpy();
        return inner.getConversations(p, c);
      },
    } as StorageProvider;
    const server = await boot(storage);
    const hit = await inner.createConversation({ agentId: "a", userId: "u1", title: "Budget 100% plan" });
    const other = await inner.createConversation({ agentId: "a", userId: "u1", title: "Holiday" });
    await inner.createMessage({ conversationId: other.id, role: "user", content: "budget in a message only" });
    await inner.createConversation({ agentId: "a", userId: "u2", title: "Budget of u2" });

    const res = await list(server, "u1", { q: "budget" });
    const body = res.body as { conversations: Array<{ id: string; searchMatch?: unknown }>; total: number; searchMode: string };
    expect(res.status).toBe(200);
    expect(body.searchMode).toBe("title");
    expect(body.conversations.map((c) => c.id)).toEqual([hit.id]);
    expect(body.conversations[0]!.searchMatch).toEqual({ field: "title", snippet: "Budget 100% plan" });
    expect(searchSpy).not.toHaveBeenCalled();
    expect(((await list(server, "u1", { q: "0%" })).body as { total: number }).total).toBe(1);
  });
});

/** The methods of a provider as plain functions, so an object spread keeps them working. */
function bind(storage: StorageProvider): StorageProvider {
  const out: Record<string, unknown> = {};
  for (let proto = Object.getPrototypeOf(storage); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      const value = (storage as unknown as Record<string, unknown>)[key];
      if (key !== "constructor" && typeof value === "function" && !(key in out)) out[key] = value.bind(storage);
    }
  }
  return out as unknown as StorageProvider;
}
