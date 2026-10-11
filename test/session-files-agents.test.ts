/**
 * Files for the other kinds of agent (Chat Completions, Responses, custom handlers), what an agent says about
 * what it accepts, tasks that come with files, a storage provider without a file index, and the adapters that
 * carry a file as its raw bytes.
 */

import http from "node:http";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStorageProvider, createAgentServer, createInMemoryProvider, createNodeHandler } from "../src/index.js";
import type { AgentHandler, StorageProvider } from "../src/index.js";
import { createExpressMiddleware } from "../src/adapters/express.js";
import { mountOnFastify } from "../src/adapters/fastify.js";
import { createNextHandler } from "../src/adapters/next.js";
import { eventually, listen, memoryStorage } from "./helpers.js";
import { PNG, b64, boot as bootServer, errorOf, lastUser, recordingAgent } from "./files-helpers.js";
import type { Boot } from "./files-helpers.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider } from "./storage/providers.js";

let active: { current: OpenedProvider } | undefined;
const currentStorage = (): StorageProvider => active!.current.storage;
const boot = (o: Boot = {}) => bootServer({ ...o, storage: o.storage ?? currentStorage() });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

// ----------------------------------------------------------------------------
// Chat Completions / Responses agents
// ----------------------------------------------------------------------------

describe("agents that call an OpenAI-compatible API", () => {
  async function upstream(reply: (url: string) => unknown) {
    const requests: Array<{ url: string; body: any }> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        requests.push({ url: req.url ?? "", body: JSON.parse(raw) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply(req.url ?? "")));
      });
    });
    const { url, close } = await listen(server);
    closers.push(close);
    return { url, requests };
  }

  async function bootApi(kind: "chat" | "responses", url: string, files?: Record<string, unknown>) {
    const storage = await memoryStorage();
    const server = createAgentServer({ basePath: "/api", storage, runs: { sweepIntervalMs: 0, recoverOnStart: false } });
    const info = { name: "A" };
    if (kind === "chat") server.registerChatCompletionsAgent("a", { baseUrl: url, apiKey: "k", model: "m" }, info, { files });
    else server.registerResponsesAgent("a", { baseUrl: url, apiKey: "k", model: "m" }, info, { files });
    const call = (method: string, path: string, extra: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}) =>
      server.handleRoute(method, path, { query: extra.query ?? {}, body: extra.body, headers: extra.headers });
    const id = ((await call("POST", "/conversations", { body: { agentId: "a" } })).body as any).conversation.id as string;
    const upload = async (name: string, bytes: Buffer | string, type: string) =>
      ((await call("POST", "/files", { body: Buffer.from(bytes), headers: { "content-type": type }, query: { name, conversationId: id } })).body as any).file.id as string;
    const send = (message: string, fileIds: string[] = []) => call("POST", `/conversations/${id}/messages`, { body: { message, fileIds } });
    return { id, upload, send, storage };
  }

  const chatReply = () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  const responsesReply = () => ({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });

  it("Chat Completions: gets the documents in the user turn and a picture as a data URL", async () => {
    const up = await upstream(chatReply);
    const t = await bootApi("chat", up.url, { vision: true });
    const doc = await t.upload("notes.txt", "remember the milk", "text/plain");
    const pic = await t.upload("cat.png", PNG, "image/png");
    expect((await t.send("what do you see?", [doc, pic])).status).toBe(200);

    const messages = up.requests[0]!.body.messages as any[];
    const user = messages.at(-1);
    expect(user.role).toBe("user");
    expect(user.content[0].text).toContain("what do you see?");
    expect(user.content[0].text).toContain('<document name="notes.txt"');
    expect(user.content[0].text).toContain("remember the milk");
    expect(user.content[0].text).toContain("1 image shown below");
    expect(user.content[1]).toEqual({ type: "text", text: `[Attached image: "cat.png" (id ${pic})]` });
    expect(user.content[2]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } });
    // the stored message is what the person typed
    const [stored] = await t.storage.getMessages(t.id).then((page) => page.data);
    expect(stored!.content).toBe("what do you see?");
  });

  it("Chat Completions: a text-only turn is still a plain string", async () => {
    const up = await upstream(chatReply);
    const t = await bootApi("chat", up.url);
    await t.send("hello");
    expect(up.requests[0]!.body.messages.at(-1)).toMatchObject({ role: "user", content: "hello" });
  });

  it("Chat Completions: cuts a document at the limit, as there is no way to read pages", async () => {
    const up = await upstream(chatReply);
    const t = await bootApi("chat", up.url, { inlineMaxTokens: 10 });
    const doc = await t.upload("long.txt", "x".repeat(500), "text/plain");
    const res = await t.send("read", [doc]);
    expect(((res.body as any).warnings as any[]).map((w) => w.code)).toEqual(["file_truncated"]);
    const content = up.requests[0]!.body.messages.at(-1).content as string;
    expect(content).toContain(`shown_chars="40" total_chars="500"`);
  });

  it("Responses: gets input_text and input_image parts", async () => {
    const up = await upstream(responsesReply);
    const t = await bootApi("responses", up.url, { vision: true });
    const doc = await t.upload("notes.txt", "remember the milk", "text/plain");
    const pic = await t.upload("cat.png", PNG, "image/png");
    await t.send("what do you see?", [doc, pic]);
    await t.send("and again?");

    const first = up.requests[0]!.body.input as any[];
    const user = first.at(-1);
    expect(user.role).toBe("user");
    expect(user.content[0]).toMatchObject({ type: "input_text" });
    expect(user.content[0].text).toContain("remember the milk");
    expect(user.content[1]).toEqual({ type: "input_text", text: `[Attached image: "cat.png" (id ${pic})]` });
    expect(user.content[2]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}` });

    // later turns: the earlier message is rebuilt the same way, the answer stays a string
    const second = up.requests[1]!.body.input as any[];
    expect(second[0].content[2]).toMatchObject({ type: "input_image" });
    expect(second[1]).toMatchObject({ role: "assistant", content: "ok" });
    expect(second.at(-1)).toMatchObject({ role: "user", content: "and again?" });
  });

  it("only mentions the picture when the agent does not read images", async () => {
    const up = await upstream(chatReply);
    const t = await bootApi("chat", up.url);
    const pic = await t.upload("cat.png", PNG, "image/png");
    const res = await t.send("what do you see?", [pic]);
    expect(typeof up.requests[0]!.body.messages.at(-1).content).toBe("string");
    expect(up.requests[0]!.body.messages.at(-1).content).toContain("cannot read images");
    expect(((res.body as any).warnings as any[]).map((w) => w.code)).toEqual(["images_not_supported"]);
  });
});

// ----------------------------------------------------------------------------
// Custom handlers
// ----------------------------------------------------------------------------

describe("custom handlers", () => {
  it("get the files of the message with real ids, and can read them - only theirs", async () => {
    const seen: any[] = [];
    const handler: AgentHandler = {
      async processMessage(params) {
        const [file] = params.files ?? [];
        seen.push({
          message: params.message,
          files: params.files,
          content: file ? (await params.getFileContent!(file.id))?.toString() : undefined,
          text: file ? await params.getFileText!(file.id) : undefined,
          foreign: await params.getFileContent!(foreignId),
          foreignText: await params.getFileText!(foreignId),
          nothing: await params.getFileContent!("file_nope"),
        });
        return { content: "handled" };
      },
    };
    const storage = await memoryStorage();
    const t = await bootServer({ handler, storage });
    const id = await t.conversation();
    const other = await t.conversation();
    const foreignId = (await t.fileOf(t.uploadRaw(other, "theirs.txt", "not yours"))).id;

    const res = await t.send(id, "process", { files: [{ name: "in.txt", content: b64("inline body"), mimeType: "text/plain" }] });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("process"); // what the person typed; the files are not in it
    expect(seen[0].files).toEqual([{ id: expect.stringMatching(/^file_/), name: "in.txt", mimeType: "text/plain", size: 11 }]);
    expect(seen[0]).toMatchObject({ content: "inline body", text: "inline body", foreign: null, foreignText: null, nothing: null });
  });

  it("can read them when they answer an action, too", async () => {
    let resolved: any;
    const handler: AgentHandler = {
      async processMessage() {
        return { content: "", status: "requires_action", pendingActions: [{ id: "q1", type: "user_question", questions: [{ question: "ok?" }] }] };
      },
      async resolveAction(params) {
        resolved = { read: typeof params.getFileContent, text: typeof params.getFileText };
        return { content: "done" };
      },
    };
    const t = await bootServer({ handler, storage: await memoryStorage() });
    const id = await t.conversation();
    await t.send(id, "go");
    const res = await t.call("POST", `/conversations/${id}/actions/q1`, { body: { resolution: { type: "user_question", answers: { "ok?": "yes" } } } });
    expect(res.status).toBe(200);
    expect(resolved).toEqual({ read: "function", text: "function" });
  });
});

// ----------------------------------------------------------------------------
// What an agent says about what it accepts
// ----------------------------------------------------------------------------

describe("agent info", () => {
  it("says what the agent accepts, in capabilities and in the keys the first chat-ui read", async () => {
    const t = await bootServer({
      storage: await memoryStorage(),
      files: { maxFiles: 4, maxFileSize: 5_000_000 },
      agentFiles: { vision: true, allowedMimeTypes: ["image/*", "application/pdf"], retentionDays: 7 },
    });
    const info = (await t.call("GET", "/agents/a")).body as any;
    expect(info.capabilities.attachments).toEqual({
      enabled: true,
      maxFiles: 4,
      maxFileSize: 5_000_000,
      allowedMimeTypes: ["image/*", "application/pdf"],
      acceptsImages: true,
      retentionDays: 7,
    });
    // (the server adds what a chat client shows around the agent - `experience`, see test/portal-actions.test.ts)
    expect(info.metadata).toMatchObject({
      enableFileUpload: true,
      maxFileSize: 5_000_000,
      maxFiles: 4,
      allowedFileTypes: ["image/*", "application/pdf"],
      acceptsImages: true,
    });
    const listed = ((await t.call("GET", "/agents")).body as any).agents[0];
    expect(listed.capabilities.attachments).toEqual(info.capabilities.attachments);
    expect(t.server.getAgents()[0]!.capabilities!.attachments!.acceptsImages).toBe(true);
  });

  it("reports an agent that takes no files and one that cannot read images", async () => {
    const off = await bootServer({ storage: await memoryStorage(), agentFiles: { enabled: false } });
    expect(((await off.call("GET", "/agents/a")).body as any).capabilities.attachments).toMatchObject({ enabled: false, acceptsImages: false });
    expect(((await off.call("GET", "/agents/a")).body as any).metadata.enableFileUpload).toBe(false);
    const plain = await bootServer({ storage: await memoryStorage() });
    const info = (await plain.call("GET", "/agents/a")).body as any;
    // (without a setting of its own an agent keeps files for the default 30 days)
    expect(info.capabilities.attachments).toMatchObject({ enabled: true, acceptsImages: false, maxFiles: 10, retentionDays: 30 });
    // 0 = kept until the conversation goes
    const forever = await bootServer({ storage: await memoryStorage(), files: { retentionDays: 0 } });
    expect(((await forever.call("GET", "/agents/a")).body as any).capabilities.attachments.retentionDays).toBe(0);
    expect(info.metadata.allowedFileTypes).toBeUndefined();
  });

  it("lets what the host set win, field by field", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      agents: [
        {
          info: { id: "a", name: "A", capabilities: { attachments: { maxFiles: 99 } }, metadata: { maxFileSize: 5, custom: "kept" } },
          sdkAgent: recordingAgent(),
          files: { vision: true },
        },
      ],
    });
    const info = (await server.handleRoute("GET", "/agents/a", { query: {} })).body as any;
    expect(info.capabilities.attachments).toMatchObject({ maxFiles: 99, acceptsImages: true, enabled: true });
    expect(info.metadata).toMatchObject({ maxFileSize: 5, custom: "kept", maxFiles: 99, acceptsImages: true });
  });

  it("is what the adapters let through: the biggest upload any agent accepts", async () => {
    const server = createAgentServer({
      basePath: "/api",
      storage: await memoryStorage(),
      agents: [{ info: { id: "big", name: "Big" }, sdkAgent: recordingAgent(), files: { maxFileSize: 50_000_000 } }],
    });
    expect(server.maxUploadBytes()).toBe(50_000_000);
    const plain = createAgentServer({ basePath: "/api", storage: await memoryStorage() });
    expect(plain.maxUploadBytes()).toBe(10 * 1024 * 1024);
  });

  it("refuses a server whose files.maxFileSize the storage cannot hold", async () => {
    const storage = createInMemoryProvider({ maxFileStorage: 1000 });
    await storage.connect();
    expect(() => createAgentServer({ basePath: "/api", storage, files: { maxFileSize: 5000 } })).toThrow(/files\.maxFileSize/);
  });
});

// ----------------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------------

function tasksSuite() {
  it("keep the files they come with in the conversation they run in, and the agent reads them", async () => {
    const agent = recordingAgent();
    const t = await boot({ agent, identity: true });
    const res = await t.call("POST", "/tasks", {
      user: "ann",
      body: { agentId: "a", input: "summarise the file", files: [{ name: "in.txt", content: b64("task body"), mimeType: "text/plain" }] },
    });
    expect(res.status).toBe(201);
    const task = (res.body as any).task;
    expect(task.conversationId).toMatch(/^conv_/);
    expect(task.files).toEqual([expect.objectContaining({ name: "in.txt", size: 9 })]);

    const record = await t.storage.getFile(task.files[0].id);
    expect(record).toMatchObject({ conversationId: task.conversationId, userId: "ann", agentId: "a" });
    expect((await t.storage.getConversation(task.conversationId))!.metadata).toMatchObject({ taskId: task.id, source: "task" });

    await eventually(async () => (await t.storage.getTask(task.id))?.status === "completed", 5000, "the task to complete");
    expect(lastUser(agent).content).toContain("task body");
    // the file is the task owner's, and goes when the conversation does
    expect((await t.call("GET", `/files/${record!.id}`, { user: "ann" })).status).toBe(200);
    expect((await t.call("GET", `/files/${record!.id}`, { user: "bob" })).status).toBe(404);
    await t.storage.deleteConversation(task.conversationId);
    expect(await t.storage.getFile(record!.id)).toBeNull();
  });

  it("refuse a file the agent does not accept, and leave nothing behind", async () => {
    const t = await boot({ agentFiles: { allowedMimeTypes: ["text/plain"] } });
    const before = (await t.storage.getConversations({ agentId: "a" })).total;
    const res = await t.call("POST", "/tasks", {
      body: { agentId: "a", input: "x", files: [{ name: "a.pdf", content: b64("x"), mimeType: "application/pdf" }] },
    });
    expect(res.status).toBe(415);
    expect(errorOf(res).code).toBe("unsupported_file_type");
    expect((await t.storage.getConversations({ agentId: "a" })).total).toBe(before);
  });

  it("still run without files, in a conversation made when they start", async () => {
    const agent = recordingAgent();
    const t = await boot({ agent });
    const res = await t.call("POST", "/tasks", { body: { agentId: "a", input: "no files" } });
    const task = (res.body as any).task;
    expect(task.conversationId).toBeUndefined();
    await eventually(async () => (await t.storage.getTask(task.id))?.status === "completed", 5000, "the task to complete");
    expect((await t.storage.getTask(task.id))!.conversationId).toMatch(/^conv_/);
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
    describe("tasks with files", tasksSuite);
  });
}

// ----------------------------------------------------------------------------
// A storage provider without a file index
// ----------------------------------------------------------------------------

describe("a storage provider that cannot list or purge files", () => {
  async function bare() {
    const inner = createInMemoryProvider();
    await inner.connect();
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "listFiles" || prop === "purgeExpiredFiles") return undefined;
        if (prop === "capabilities") return () => ({ ...target.capabilities(), fileIndex: false });
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorageProvider;
  }

  it("still takes uploads and gives them to the agent; lists the files that messages carry", async () => {
    const agent = recordingAgent();
    const t = await bootServer({ agent, storage: await bare(), agentFiles: { attachNewUploads: true, maxFiles: 1 } });
    const id = await t.conversation();
    const a = await t.fileOf(t.uploadRaw(id, "a.txt", "alpha"));
    // the limit cannot be counted without the index: it is not enforced
    const b = await t.fileOf(t.uploadRaw(id, "b.txt", "beta"));
    // nothing is found to ride along either
    const sent = await t.send(id, "read a", { fileIds: [a.id] });
    expect((sent.body as any).message.files.map((f: any) => f.id)).toEqual([a.id]);
    expect(lastUser(agent).content).toContain("alpha");

    const listed = (await t.call("GET", `/conversations/${id}/files`)).body as any;
    expect(listed.files.map((f: any) => f.id)).toEqual([a.id]);
    expect(listed).toMatchObject({ total: 1, maxFiles: 1 });
    expect(b.id).toBeTruthy();
    expect(await t.server.purgeExpiredFiles()).toBe(0);
  });
});

describe("a custom provider that reports its capabilities", () => {
  it("is only asked for the file index when it says it has one", async () => {
    class Custom extends InMemoryStorageProvider {
      // (an older provider: knows nothing of fileIndex)
      capabilities() {
        const { fileIndex: _ignored, ...rest } = super.capabilities();
        return rest;
      }
      async listFiles(): Promise<never> {
        throw new Error("listFiles must not be called");
      }
    }
    const storage = new Custom();
    await storage.connect();
    const t = await bootServer({ storage, agentFiles: { maxFiles: 1, attachNewUploads: true } });
    const id = await t.conversation();
    const file = await t.fileOf(t.uploadRaw(id, "a.txt", "alpha"));
    expect((await t.send(id, "go", { fileIds: [file.id] })).status).toBe(200);
    expect((await t.call("GET", `/conversations/${id}/files`)).status).toBe(200);
    expect(await t.server.purgeExpiredFiles()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Adapters
// ----------------------------------------------------------------------------

describe("uploading a file as itself through the adapters", () => {
  async function bootHttp() {
    const server = createAgentServer({ basePath: "/api/agents", storage: await memoryStorage(), agents: [{ info: { id: "bot", name: "Bot" }, sdkAgent: recordingAgent() }], limits: { maxFileSize: 100_000 } });
    const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "bot" } });
    return { server, conversationId: (created.body as any).conversation.id as string };
  }

  const bytes = Buffer.concat([PNG, Buffer.from([0xff, 0xfe, 0x00, 0x80])]);

  it("Node: reads the bytes, keeps them exact, and keeps the JSON upload working", async () => {
    const { server, conversationId } = await bootHttp();
    const handle = createNodeHandler(server);
    const { url, close } = await listen(http.createServer(async (req, res) => void (await handle(req, res))));
    closers.push(close);
    const base = `${url}/api/agents`;

    for (const type of ["image/png", "text/plain", "application/octet-stream", "application/x-weird"]) {
      const res = await fetch(`${base}/files?name=blob.bin&conversationId=${conversationId}`, { method: "POST", headers: { "content-type": type }, body: bytes });
      expect(res.status, type).toBe(201);
      const { file } = (await res.json()) as any;
      expect(file).toMatchObject({ size: bytes.length, conversationId });
      const download = await fetch(`${base}/files/${file.id}/content`);
      expect(Buffer.from(await download.arrayBuffer()).equals(bytes), type).toBe(true);
    }
    const json = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: { name: "a.txt", content: b64("json"), mimeType: "text/plain" }, conversationId }),
    });
    expect(json.status).toBe(201);
    // no Content-Type at all is still the JSON it always was
    const bare = await fetch(`${base}/files`, { method: "POST", body: Buffer.from(JSON.stringify({ file: { name: "b.txt", content: b64("bare"), mimeType: "text/plain" } })) });
    expect(bare.status).toBe(201);
  });

  it("Node: refuses a body over the limit with a 413 before reading it all", async () => {
    const { server, conversationId } = await bootHttp();
    const handle = createNodeHandler(server, { maxBodyBytes: 1000 });
    const { url, close } = await listen(http.createServer(async (req, res) => void (await handle(req, res))));
    closers.push(close);
    const res = await fetch(`${url}/api/agents/files?name=big.bin&conversationId=${conversationId}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(5000, 1),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("Node: lets through a file as large as the biggest an agent accepts", async () => {
    const server = createAgentServer({
      basePath: "/api/agents",
      storage: await memoryStorage(),
      agents: [{ info: { id: "bot", name: "Bot" }, sdkAgent: recordingAgent(), files: { maxFileSize: 3_000_000 } }],
    });
    const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "bot" } });
    const conversationId = (created.body as any).conversation.id;
    const handle = createNodeHandler(server);
    const { url, close } = await listen(http.createServer(async (req, res) => void (await handle(req, res))));
    closers.push(close);
    const res = await fetch(`${url}/api/agents/files?name=big.bin&conversationId=${conversationId}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(2_500_000, 7),
    });
    expect(res.status).toBe(201);
  });

  it("Fastify: hands the bytes over for any type, without disturbing the app's other routes", async () => {
    const { server, conversationId } = await bootHttp();
    const app = Fastify();
    app.post("/elsewhere", async (request) => ({ got: request.body }));
    mountOnFastify(app, server, { prefix: "/p/:k", uploadBodyLimit: 200_000 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const { port } = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/p/k1`;

    for (const type of ["image/png", "text/plain", "application/octet-stream", "application/pdf"]) {
      const res = await fetch(`${base}/files?name=blob.bin&conversationId=${conversationId}`, { method: "POST", headers: { "content-type": type }, body: bytes });
      expect(res.status, type).toBe(201);
      const { file } = (await res.json()) as any;
      const download = await fetch(`${base}/files/${file.id}/content`);
      expect(Buffer.from(await download.arrayBuffer()).equals(bytes), type).toBe(true);
    }
    const json = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: { name: "a.txt", content: b64("json"), mimeType: "text/plain" }, conversationId }),
    });
    expect(json.status).toBe(201);
    // the parsers belong to the mounted plugin: the app's own text route still gets a string
    const elsewhere = await fetch(`http://127.0.0.1:${port}/elsewhere`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
    expect(await elsewhere.json()).toEqual({ got: "hello" });
  });

  it("Express: takes what express.raw() left, or reads the request itself", async () => {
    const { server, conversationId } = await bootHttp();
    const mw = createExpressMiddleware(server);
    const upload = async (req: any) => {
      let status = 0;
      let payload: any;
      const res: any = {
        status(c: number) { status = c; return res; },
        json(b: unknown) { payload = b; return res; }, send() { return res; }, set() { return res; }, write() { return true; }, end() {},
      };
      await mw(req, res, () => {});
      return { status, payload };
    };
    const common = { method: "POST", path: "/api/agents/files", originalUrl: `/api/agents/files?name=x.bin&conversationId=${conversationId}`, query: { name: "x.bin", conversationId }, headers: { "content-type": "image/png" } };

    // a body parser already made a Buffer
    const parsed = await upload({ ...common, body: bytes });
    expect(parsed.status).toBe(201);
    expect(parsed.payload.file.size).toBe(bytes.length);

    // nothing parsed it: the stream is read
    const stream = Object.assign(Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]), { ...common });
    const streamed = await upload(stream);
    expect(streamed.status).toBe(201);
    expect(streamed.payload.file.size).toBe(bytes.length);
    expect((await server.getConfig().storage.getFileContent(streamed.payload.file.id))!.equals(bytes)).toBe(true);

    // an express.json() that left `{}` on a type it does not parse: read the stream too
    const left = Object.assign(Readable.from([bytes]), { ...common, body: {} });
    expect((await upload(left)).status).toBe(201);
  });

  it("Fastify: refuses a raw upload over the limit of the upload route with a 413", async () => {
    const { server, conversationId } = await bootHttp();
    const app = Fastify();
    mountOnFastify(app, server, { prefix: "/p", bodyLimit: 1_000, uploadBodyLimit: 5_000 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const { port } = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/p`;
    const upload = (size: number) =>
      fetch(`${base}/files?name=big.bin&conversationId=${conversationId}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(size, 1) });
    expect((await upload(4_000)).status).toBe(201);
    const big = await upload(6_000);
    expect(big.status).toBe(413);
    expect(((await big.json()) as any).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("Express: refuses a stream over the body limit with a 413", async () => {
    const { server, conversationId } = await bootHttp();
    let status = 0;
    let payload: any;
    const res: any = {
      status(c: number) { status = c; return res; },
      json(b: unknown) { payload = b; return res; }, send() { return res; }, set() { return res; }, write() { return true; }, end() {},
    };
    const limited = createAgentServer({ basePath: "/api/agents", storage: server.getConfig().storage, agents: [{ info: { id: "bot", name: "Bot" }, sdkAgent: recordingAgent() }], limits: { maxBodySize: 100 } });
    const small = createExpressMiddleware(limited);
    const req = Object.assign(Readable.from([Buffer.alloc(300, 1)]), {
      method: "POST", path: "/api/agents/files", originalUrl: `/api/agents/files?name=x.bin&conversationId=${conversationId}`,
      query: { name: "x.bin", conversationId }, headers: { "content-type": "application/octet-stream" },
    });
    await small(req as any, res, () => {});
    expect(status).toBe(413);
    expect(payload.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("Next: reads the body as bytes", async () => {
    const { server, conversationId } = await bootHttp();
    const handler = createNextHandler(server);
    const res = await handler(
      new Request(`http://x/api/agents/files?name=x.bin&conversationId=${conversationId}`, { method: "POST", headers: { "content-type": "image/png" }, body: bytes }) as never
    );
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as any;
    expect(file.size).toBe(bytes.length);
    expect((await server.getConfig().storage.getFileContent(file.id))!.equals(bytes)).toBe(true);
    const json = await handler(
      new Request("http://x/api/agents/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: { name: "a.txt", content: b64("j"), mimeType: "text/plain" }, conversationId }) }) as never
    );
    expect(json.status).toBe(201);
  });
});
