import { describe, expect, it } from "vitest";
import { createAgentServer } from "../src/index.js";
import { fakeSdkAgent, memoryStorage, parseSse } from "./helpers.js";

async function stream(agent: ReturnType<typeof fakeSdkAgent>) {
  const server = createAgentServer({
    basePath: "/api",
    storage: await memoryStorage(),
    agents: [{ info: { id: "a", name: "A" }, sdkAgent: agent }],
  });
  const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } });
  const id = (created.body as { conversation: { id: string } }).conversation.id;
  const res = await server.handleRoute("POST", `/conversations/${id}/messages`, {
    query: {},
    body: { message: "hi", stream: true },
  });
  let text = "";
  for await (const chunk of res.stream!) text += chunk;
  const events = parseSse(text);
  const messages = await server.handleRoute("GET", `/conversations/${id}/messages`, { query: {} });
  return { events, saved: (messages.body as { messages: Array<{ role: string; content: string }> }).messages };
}

describe("SDK agent final content", () => {
  it("emits the final answer once as stream.text when the agent never streamed", async () => {
    const { events, saved } = await stream(fakeSdkAgent(async () => ({ content: "final answer" })));
    const types = events.map((e) => e.type);
    expect(types).toEqual(["stream.start", "stream.text", "stream.done"]);
    expect(events[1]).toMatchObject({ text: "final answer", isFinal: true });
    expect(events[2]).toMatchObject({ content: "final answer" });
    expect(saved.at(-1)).toMatchObject({ role: "assistant", content: "final answer" });
  });

  it("uses the isFinal chunk when the agent result carries no content (console-experience wrapper)", async () => {
    const { events, saved } = await stream(
      fakeSdkAgent(async (_p, config) => {
        config?.onStream?.({ text: "from final chunk", isFinal: true });
        return { content: "" };
      })
    );
    expect(events.filter((e) => e.type === "stream.text")).toHaveLength(1);
    expect(events.find((e) => e.type === "stream.text")).toMatchObject({ text: "from final chunk" });
    expect(events.at(-1)).toMatchObject({ type: "stream.done", content: "from final chunk" });
    expect(saved.at(-1)?.content).toBe("from final chunk");
  });

  it("does not duplicate text for agents that streamed", async () => {
    const { events } = await stream(
      fakeSdkAgent(async (_p, config) => {
        config?.onStream?.({ text: "Hel" });
        config?.onStream?.({ text: "lo" });
        config?.onStream?.({ text: "Hello", isFinal: true });
        return { content: "Hello" };
      })
    );
    const texts = events.filter((e) => e.type === "stream.text").map((e) => e.text);
    expect(texts).toEqual(["Hel", "lo"]);
    expect(events.at(-1)).toMatchObject({ type: "stream.done", content: "Hello" });
  });

  it("emits nothing extra for an empty answer", async () => {
    const { events } = await stream(fakeSdkAgent(async () => ({ content: "" })));
    expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.done"]);
  });
});

describe("SDK agent failure while streaming", () => {
  it("ends the stream with a stream.error event instead of hanging or leaking an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { events, saved } = await stream(
        fakeSdkAgent(async (_p, config) => {
          config?.onStream?.({ text: "partial " });
          throw new Error("model exploded");
        })
      );
      expect(events.map((e) => e.type)).toEqual(["stream.start", "stream.text", "stream.error"]);
      expect(events.at(-1)).toMatchObject({ error: "model exploded" });
      // the user message was stored, no assistant message was
      expect(saved.map((m) => m.role)).toEqual(["user"]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
