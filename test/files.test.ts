import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentRegistration } from "../src/index.js";
import { mountOnFastify } from "../src/adapters/fastify.js";
import { fakeSdkAgent, memoryStorage, parseSse } from "./helpers.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const bot = (seen: Array<{ role: string; content: string }[]> = []): AgentRegistration => ({
  info: { id: "bot", name: "Bot" },
  sdkAgent: fakeSdkAgent(async (params) => {
    seen.push(params.messages);
    return { content: "ok" };
  }),
});

const b64 = (text: string) => Buffer.from(text).toString("base64");

async function boot(config: Partial<Parameters<typeof createAgentServer>[0]> = {}, adapter: { bodyLimit?: number; uploadBodyLimit?: number } = {}) {
  const server = createAgentServer({ basePath: "/x", storage: await memoryStorage(), agents: [bot()], ...config });
  const app = Fastify();
  mountOnFastify(app, server, { prefix: "/p/:k", ...adapter });
  await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  const { port } = app.server.address() as { port: number };
  const url = `http://127.0.0.1:${port}/p/k1`;
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const conversation = (await (await post("/conversations", { agentId: "bot" })).json() as any).conversation;
  return { url, post, conversation };
}

async function upload(post: (p: string, b: unknown) => Promise<Response>, conversationId: string, text = "hello", name = "a.txt") {
  const res = await post("/files", { file: { name, content: b64(text), mimeType: "text/plain" }, conversationId });
  return { res, body: (await res.json()) as any };
}

describe("messages that attach uploaded files by id", () => {
  it("puts the stored records on the user message, streamed or not", async () => {
    const { post, url, conversation } = await boot();
    const first = await upload(post, conversation.id, "hello", "a.txt");
    expect(first.res.status).toBe(201);
    const second = await upload(post, conversation.id, "world!", "b.txt");

    const plain = await post(`/conversations/${conversation.id}/messages`, { message: "read these", fileIds: [first.body.file.id] });
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as any).message.files).toEqual([
      { id: first.body.file.id, name: "a.txt", mimeType: "text/plain", size: 5 },
    ]);

    const streamed = await post(`/conversations/${conversation.id}/messages`, { message: "and this", stream: true, fileIds: [second.body.file.id] });
    expect(streamed.status).toBe(200);
    expect(parseSse(await streamed.text()).some((e) => e.type === "stream.done")).toBe(true);

    const history = (await (await fetch(`${url}/conversations/${conversation.id}/messages`)).json()) as any;
    const withFiles = history.messages.filter((m: any) => m.files?.length);
    expect(withFiles.map((m: any) => m.files[0].name)).toEqual(["a.txt", "b.txt"]);
  });

  it("refuses an unknown id, someone else's conversation's file, a malformed list and too many files", async () => {
    const { post, conversation } = await boot({ limits: { maxFiles: 2 } });
    const other = (await (await post("/conversations", { agentId: "bot" })).json() as any).conversation;
    const foreign = await upload(post, other.id);
    const url = `/conversations/${conversation.id}/messages`;

    expect((await post(url, { message: "x", fileIds: ["nope"] })).status).toBe(404);
    expect((await post(url, { message: "x", fileIds: [foreign.body.file.id] })).status).toBe(404);
    expect((await post(url, { message: "x", fileIds: "nope" })).status).toBe(400);
    const own = [await upload(post, conversation.id, "1", "1.txt"), await upload(post, conversation.id, "2", "2.txt"), await upload(post, conversation.id, "3", "3.txt")];
    const tooMany = await post(url, { message: "x", fileIds: own.map((f) => f.body.file.id) });
    expect(tooMany.status).toBe(400);
    // streamed requests are refused as HTTP statuses too, before any SSE starts
    const streamedBad = await post(url, { message: "x", stream: true, fileIds: ["nope"] });
    expect(streamedBad.status).toBe(404);
    expect(streamedBad.headers.get("content-type")).not.toBe("text/event-stream");
  });

  it("keeps working without fileIds (inline files are still described, not stored)", async () => {
    const { post, conversation } = await boot();
    const res = await post(`/conversations/${conversation.id}/messages`, {
      message: "x",
      files: [{ name: "i.txt", content: b64("inline"), mimeType: "text/plain" }],
    });
    expect(((await res.json()) as any).message.files[0]).toMatchObject({ name: "i.txt", size: 6 });
  });
});

describe("upload size and the Fastify body limit", () => {
  it("rejects a file over limits.maxFileSize before decoding it", async () => {
    const { post, conversation } = await boot({ limits: { maxFileSize: 10 } });
    const big = await upload(post, conversation.id, "x".repeat(200));
    expect(big.res.status).toBe(400);
    expect(big.body.error.message).toContain("exceeds");
    expect((await upload(post, conversation.id, "tiny")).res.status).toBe(201);
  });

  it("raises the body limit on POST /files alone", async () => {
    const { post, url, conversation } = await boot(
      { limits: { maxFileSize: 100_000 } },
      { bodyLimit: 2_000, uploadBodyLimit: 200_000 },
    );
    // the same payload is fine as an upload ...
    const ok = await upload(post, conversation.id, "y".repeat(50_000));
    expect(ok.res.status).toBe(201);
    // ... and refused (413) on any other route
    const message = await post(`/conversations/${conversation.id}/messages`, { message: "z".repeat(50_000) });
    expect(message.status).toBe(413);
    // the upload route has a ceiling too
    const huge = await upload(post, conversation.id, "y".repeat(400_000));
    expect(huge.res.status).toBe(413);
    // other methods and paths under /files keep working through the catch-all
    expect((await fetch(`${url}/files/${ok.body.file.id}`)).status).toBe(200);
  });
});
