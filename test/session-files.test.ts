/**
 * Files in conversations, over every storage provider (memory, SQLite, MongoDB, PostgreSQL): uploads (raw bytes
 * and JSON), the limits of an agent, who may see a file, retention, and what the agent is given - documents inline
 * or in pages, images by reference.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionFileTools, withSessionImages } from "../src/index.js";
import type { StorageProvider } from "../src/index.js";
import { eventually, gate } from "./helpers.js";
import { PNG, b64, boot as bootServer, errorOf, lastUser, recordingAgent, textOf } from "./files-helpers.js";
import type { Boot } from "./files-helpers.js";
import { PROVIDER_NAMES, describeProvider, useProvider } from "./storage/providers.js";
import type { OpenedProvider } from "./storage/providers.js";

let active: { current: OpenedProvider } | undefined;
const currentStorage = (): StorageProvider => active!.current.storage;

const boot = (o: Boot = {}) => bootServer({ ...o, storage: o.storage ?? currentStorage() });

// ----------------------------------------------------------------------------
// The suite
// ----------------------------------------------------------------------------

function filesSuite() {
  describe("uploading", () => {
    it("stores a file sent as itself: owned, in its conversation, and due for the retention sweep", async () => {
      const t = await boot({ identity: true });
      const id = await t.conversation("ann");
      const before = Date.now();
      const file = await t.fileOf(t.uploadRaw(id, "pic.png", PNG, "image/png", "ann"));
      expect(file).toMatchObject({ name: "pic.png", mimeType: "image/png", size: PNG.length, conversationId: id, userId: "ann", agentId: "a" });
      const expiresAt = new Date((file as any).expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 86_400_000 - 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 1000);

      // the bytes come back exactly
      const download = await t.call("GET", `/files/${file.id}/content`, { user: "ann" });
      expect(download.status).toBe(200);
      expect(Buffer.from(download.raw!).equals(PNG)).toBe(true);
    });

    it("keeps the JSON upload working, and normalises the type", async () => {
      const t = await boot();
      const id = await t.conversation();
      const file = await t.fileOf(t.uploadJson(id, "notes.txt", "hello", "text/plain; charset=utf-8"));
      expect(file).toMatchObject({ name: "notes.txt", mimeType: "text/plain", size: 5, conversationId: id });
      const guessed = await t.fileOf(t.uploadJson(id, "report.csv", "a,b", "application/octet-stream"));
      expect(guessed.mimeType).toBe("text/csv");
    });

    it("needs the file's name when it is sent as itself, and refuses an empty file", async () => {
      const t = await boot();
      const id = await t.conversation();
      const nameless = await t.call("POST", "/files", { body: Buffer.from("x"), headers: { "content-type": "text/plain" }, query: { conversationId: id } });
      expect(nameless.status).toBe(400);
      expect(errorOf(nameless).message).toContain("name is required");
      const empty = await t.uploadRaw(id, "e.txt", "");
      expect(empty.status).toBe(400);
      expect(errorOf(empty)).toMatchObject({ code: "VALIDATION_ERROR", message: "File is empty" });
    });

    it("can be told the type in the query instead of the header", async () => {
      const t = await boot();
      const id = await t.conversation();
      const res = await t.call("POST", "/files", {
        body: Buffer.from("a,b"),
        headers: { "content-type": "application/octet-stream" },
        query: { name: "data.bin", conversationId: id, mimeType: "text/csv" },
      });
      expect(((res.body as any).file as any).mimeType).toBe("text/csv");
    });

    it("refuses a conversation that does not exist, and one that is somebody else's", async () => {
      const t = await boot({ identity: true });
      const mine = await t.conversation("ann");
      expect((await t.uploadRaw("conv_nope", "a.txt", "x", "text/plain", "ann")).status).toBe(404);
      expect((await t.uploadRaw(mine, "a.txt", "x", "text/plain", "bob")).status).toBe(403);
      expect((await t.uploadJson(mine, "a.txt", "x", "text/plain", "bob")).status).toBe(403);
    });

    it("applies the settings of the conversation's agent", async () => {
      const t = await boot({ agentFiles: { maxFileSize: 100, allowedMimeTypes: ["text/*", "image/png"], maxFiles: 2 } });
      const id = await t.conversation();

      const big = await t.uploadRaw(id, "big.txt", "x".repeat(101));
      expect(big.status).toBe(400);
      expect(errorOf(big)).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "file_too_large", maxBytes: 100 } });
      expect(errorOf(big).message).toContain("exceeds limit of 100 bytes");

      const wrongType = await t.uploadRaw(id, "a.pdf", "%PDF", "application/pdf");
      expect(wrongType.status).toBe(415);
      expect(errorOf(wrongType)).toMatchObject({ code: "unsupported_file_type", details: { mimeType: "application/pdf" } });

      await t.fileOf(t.uploadRaw(id, "1.txt", "one"));
      await t.fileOf(t.uploadRaw(id, "2.png", PNG, "image/png"));
      const full = await t.uploadRaw(id, "3.txt", "three");
      expect(full.status).toBe(409);
      expect(errorOf(full)).toMatchObject({ code: "too_many_files", details: { maxFiles: 2, held: 2 } });
    });

    it("refuses every upload to an agent that takes no files", async () => {
      const t = await boot({ agentFiles: { enabled: false } });
      const id = await t.conversation();
      for (const res of [await t.uploadRaw(id, "a.txt", "x"), await t.uploadJson(id, "a.txt", "x")]) {
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe("attachments_disabled");
      }
      const message = await t.send(id, "hi", { files: [{ name: "a.txt", content: b64("x"), mimeType: "text/plain" }] });
      expect(message.status).toBe(403);
      expect(errorOf(message).code).toBe("attachments_disabled");
      // a message without files is none of its business
      expect((await t.send(id, "hi")).status).toBe(200);
    });

    it("takes the server's settings for an agent that sets none, and an agent's own win", async () => {
      const t = await boot({ files: { maxFiles: 1, retentionDays: 0 }, agentFiles: { maxFiles: 2 } });
      const id = await t.conversation();
      const first = await t.fileOf(t.uploadRaw(id, "1.txt", "a"));
      // retentionDays 0 = never expires
      expect((first as any).expiresAt).toBeUndefined();
      await t.fileOf(t.uploadRaw(id, "2.txt", "b"));
      expect((await t.uploadRaw(id, "3.txt", "c")).status).toBe(409);
    });

    it("can store a file that belongs to no conversation, which then cannot be attached anywhere", async () => {
      const t = await boot();
      const loose = await t.fileOf(t.uploadRaw(undefined, "loose.txt", "x"));
      expect((loose as any).conversationId).toBeUndefined();
      const id = await t.conversation();
      const res = await t.send(id, "see", { fileIds: [loose.id] });
      expect(res.status).toBe(404);
    });
  });

  describe("who may see a file", () => {
    it("shows a file to the person who uploaded it, and answers 404 to anyone else", async () => {
      const t = await boot({ identity: true });
      const id = await t.conversation("ann");
      const file = await t.fileOf(t.uploadRaw(id, "private.txt", "secret", "text/plain", "ann"));

      for (const path of [`/files/${file.id}`, `/files/${file.id}/content`]) {
        expect((await t.call("GET", path, { user: "ann" })).status).toBe(200);
        expect((await t.call("GET", path, { user: "bob" })).status).toBe(404);
      }
      expect((await t.call("DELETE", `/files/${file.id}`, { user: "bob" })).status).toBe(404);
      // still there
      expect((await t.call("GET", `/files/${file.id}`, { user: "ann" })).status).toBe(200);
      expect((await t.call("DELETE", `/files/${file.id}`, { user: "ann" })).status).toBe(204);
      expect((await t.call("GET", `/files/${file.id}`, { user: "ann" })).status).toBe(404);
    });

    it("does not let a message attach somebody else's file, or a file of another conversation", async () => {
      const t = await boot({ identity: true });
      const annsChat = await t.conversation("ann");
      const annsOther = await t.conversation("ann");
      const bobsChat = await t.conversation("bob");
      const file = await t.fileOf(t.uploadRaw(annsChat, "a.txt", "mine", "text/plain", "ann"));

      expect((await t.send(bobsChat, "read it", { fileIds: [file.id] }, "bob")).status).toBe(404);
      expect((await t.send(annsOther, "read it", { fileIds: [file.id] }, "ann")).status).toBe(404);
      expect((await t.send(annsChat, "read it", { fileIds: [file.id] }, "ann")).status).toBe(200);
    });

    it("follows the conversation for a file stored without an owner, and hides one with neither", async () => {
      const t = await boot({ identity: true });
      const id = await t.conversation("ann");
      const ownerless = await t.storage.saveFile({ name: "o.txt", mimeType: "text/plain", content: Buffer.from("o"), conversationId: id });
      const nobodys = await t.storage.saveFile({ name: "n.txt", mimeType: "text/plain", content: Buffer.from("n") });
      expect((await t.call("GET", `/files/${ownerless.id}`, { user: "ann" })).status).toBe(200);
      expect((await t.call("GET", `/files/${ownerless.id}`, { user: "bob" })).status).toBe(404);
      expect((await t.call("GET", `/files/${nobodys.id}`, { user: "ann" })).status).toBe(404);
    });

    it("is open to a caller whose identity the server does not enforce (as conversations are)", async () => {
      const t = await boot();
      const id = await t.conversation();
      const file = await t.fileOf(t.uploadRaw(id, "a.txt", "x"));
      expect((await t.call("GET", `/files/${file.id}`)).status).toBe(200);
      const nobodys = await t.storage.saveFile({ name: "n.txt", mimeType: "text/plain", content: Buffer.from("n") });
      expect((await t.call("GET", `/files/${nobodys.id}`)).status).toBe(200);
    });
  });

  describe("downloading", () => {
    it("never lets a file name or type reach a header unchecked", async () => {
      const t = await boot();
      const id = await t.conversation();
      const evil = await t.storage.saveFile({
        name: 'ev"il\r\nX-Injected: 1.html',
        mimeType: "text/html\r\nX-Injected: 1",
        content: Buffer.from("<script>alert(1)</script>"),
        conversationId: id,
      });
      const res = await t.call("GET", `/files/${evil.id}/content`);
      expect(res.status).toBe(200);
      const headers = res.headers!;
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(headers["Content-Disposition"]).not.toMatch(/[\r\n]/);
      expect(headers["Content-Disposition"]).toMatch(/^attachment; filename="/);
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Cache-Control"]).toContain("private");
    });

    it("offers a picture in place on request, and active content only ever as a download", async () => {
      const t = await boot();
      const id = await t.conversation();
      const png = await t.fileOf(t.uploadRaw(id, "p.png", PNG, "image/png"));
      const svg = await t.fileOf(t.uploadRaw(id, "s.svg", "<svg/>", "image/svg+xml"));
      const disposition = async (fileId: string, query: Record<string, string> = {}) =>
        (await t.call("GET", `/files/${fileId}/content`, { query })).headers!["Content-Disposition"];
      expect(await disposition(png.id)).toMatch(/^attachment/);
      expect(await disposition(png.id, { disposition: "inline" })).toMatch(/^inline/);
      expect(await disposition(svg.id, { disposition: "inline" })).toMatch(/^attachment/);
    });
  });

  describe("listing a conversation's files", () => {
    it("lists them oldest first with the conversation's limit, to the person who may see them", async () => {
      const t = await boot({ identity: true, agentFiles: { maxFiles: 5 } });
      const id = await t.conversation("ann");
      const first = await t.fileOf(t.uploadRaw(id, "1.txt", "a", "text/plain", "ann"));
      const second = await t.fileOf(t.uploadRaw(id, "2.txt", "b", "text/plain", "ann"));
      const res = await t.call("GET", `/conversations/${id}/files`, { user: "ann" });
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.files.map((f: any) => f.id)).toEqual([first.id, second.id]);
      expect(body).toMatchObject({ total: 2, maxFiles: 5, hasMore: false });
      const paged = (await t.call("GET", `/conversations/${id}/files`, { user: "ann", query: { limit: "1", offset: "1" } })).body as any;
      expect(paged.files.map((f: any) => f.id)).toEqual([second.id]);
      expect(paged).toMatchObject({ total: 2, limit: 1, offset: 1, hasMore: false });
      expect((await t.call("GET", `/conversations/${id}/files`, { user: "bob" })).status).toBe(403);
      expect((await t.call("GET", `/conversations/conv_nope/files`, { user: "ann" })).status).toBe(404);
    });
  });

  describe("retention", () => {
    it("deletes the files past their time - record and content - and keeps the others", async () => {
      const t = await boot();
      const id = await t.conversation();
      const past = new Date(Date.now() - 60_000);
      const stale = await t.storage.saveFile({ name: "stale.txt", mimeType: "text/plain", content: Buffer.from("s"), conversationId: id, expiresAt: past });
      const fresh = await t.fileOf(t.uploadRaw(id, "fresh.txt", "f"));
      const before = await active!.current.blobCount();

      expect(await t.server.purgeExpiredFiles()).toBeGreaterThanOrEqual(1);
      expect(await t.storage.getFile(stale.id)).toBeNull();
      expect(await t.storage.getFile(fresh.id)).not.toBeNull();
      expect(await active!.current.blobCount()).toBeLessThan(before);
    });

    it("runs by itself with the first request", async () => {
      const probe = await boot();
      const id = await probe.conversation();
      const stale = await probe.storage.saveFile({
        name: "stale.txt", mimeType: "text/plain", content: Buffer.from("s"), conversationId: id, expiresAt: new Date(Date.now() - 1000),
      });
      const t = await boot({ config: { runs: { sweepIntervalMs: 0, recoverOnStart: true } } });
      await t.call("GET", "/agents");
      await eventually(async () => (await t.storage.getFile(stale.id)) === null, 4000, "the sweep to delete the expired file");
    });

    it("can be switched off", async () => {
      const probe = await boot();
      const id = await probe.conversation();
      const stale = await probe.storage.saveFile({
        name: "stale.txt", mimeType: "text/plain", content: Buffer.from("s"), conversationId: id, expiresAt: new Date(Date.now() - 1000),
      });
      const t = await boot({ files: { purgeIntervalMs: 0 }, config: { runs: { sweepIntervalMs: 0, recoverOnStart: true } } });
      await t.call("GET", "/agents");
      await new Promise((r) => setTimeout(r, 100));
      expect(await t.storage.getFile(stale.id)).not.toBeNull();
      // ... and still available by hand
      await t.server.purgeExpiredFiles();
      expect(await t.storage.getFile(stale.id)).toBeNull();
    });

    it("is done by one node at a time", async () => {
      const t = await boot();
      const id = await t.conversation();
      const stale = await t.storage.saveFile({ name: "stale.txt", mimeType: "text/plain", content: Buffer.from("s"), conversationId: id, expiresAt: new Date(Date.now() - 1000) });
      // another node is purging right now
      const claim = await t.storage.acquireLease!({ key: "files:purge", owner: "other-node", ttlMs: 60_000 });
      expect(claim.acquired).toBe(true);
      expect(await t.server.purgeExpiredFiles()).toBe(0);
      expect(await t.storage.getFile(stale.id)).not.toBeNull();
      await t.storage.releaseLease!({ key: "files:purge", owner: "other-node" });
      expect(await t.server.purgeExpiredFiles()).toBeGreaterThanOrEqual(1);
      expect(await t.storage.getFile(stale.id)).toBeNull();
      // and it gives the lease back
      expect(await t.storage.getLeases!(["files:purge"])).toEqual([]);
    });

    it("goes with its conversation", async () => {
      const t = await boot({ identity: true });
      const id = await t.conversation("ann");
      const file = await t.fileOf(t.uploadRaw(id, "a.txt", "x", "text/plain", "ann"));
      expect((await t.call("DELETE", `/conversations/${id}`, { user: "ann" })).status).toBe(204);
      expect(await t.storage.getFile(file.id)).toBeNull();
      expect((await t.call("GET", `/files/${file.id}`, { user: "ann" })).status).toBe(404);
    });
  });

  describe("files sent with a message", () => {
    it("are stored first: owned, in the conversation, with ids the message carries", async () => {
      const agent = recordingAgent();
      const t = await boot({ identity: true, agent });
      const id = await t.conversation("ann");
      const res = await t.send(id, "see", { files: [{ name: "inline.txt", content: b64("inline body"), mimeType: "text/plain" }] }, "ann");
      expect(res.status).toBe(200);
      const [attached] = (res.body as any).message.files;
      expect(attached).toMatchObject({ name: "inline.txt", mimeType: "text/plain", size: 11 });
      expect(attached.id).toMatch(/^file_/);

      const stored = await t.storage.getFile(attached.id);
      expect(stored).toMatchObject({ conversationId: id, userId: "ann", agentId: "a", name: "inline.txt" });
      expect((await t.storage.getFileContent(attached.id))!.toString()).toBe("inline body");
      // downloadable by its id (it used to be a throwaway one that 404ed)
      expect((await t.call("GET", `/files/${attached.id}/content`, { user: "ann" })).status).toBe(200);
      // and the agent was given it
      expect(textOf(lastUser(agent).content)).toContain('<document name="inline.txt"');
    });

    it("count against the conversation, and are checked before the turn starts", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent, agentFiles: { maxFiles: 1, allowedMimeTypes: ["text/plain"], maxFileSize: 10 } });
      const id = await t.conversation();
      const file = (name: string, content: string, mimeType = "text/plain") => ({ name, content: b64(content), mimeType });

      expect((await t.send(id, "x", { files: [file("a.pdf", "x", "application/pdf")] })).status).toBe(415);
      expect((await t.send(id, "x", { files: [file("a.txt", "x".repeat(11))] })).status).toBe(400);
      expect((await t.send(id, "x", { files: [file("a.txt", ""), file("b", "y")] })).status).toBe(400);
      expect((await t.send(id, "x", { files: [{ name: "a.txt" }] })).status).toBe(400);
      expect((await t.send(id, "x", { files: "nope" })).status).toBe(400);
      expect((await t.send(id, "x", { files: [file("a.txt", "1"), file("b.txt", "2")] })).status).toBe(409);
      expect(agent.calls).toHaveLength(0);
      expect(await messageCount(t, id)).toBe(0);

      expect((await t.send(id, "x", { files: [file("a.txt", "1")] })).status).toBe(200);
      expect((await t.send(id, "again", { files: [file("b.txt", "2")] })).status).toBe(409);
    });

    it("are not stored when the conversation is busy", async () => {
      const started = gate();
      const release = gate();
      const agent = recordingAgent({ run: async () => { started.open(); await release.promise; } });
      const t = await boot({ agent });
      const id = await t.conversation();
      const first = t.send(id, "first");
      await started.promise;
      const second = await t.send(id, "second", { files: [{ name: "late.txt", content: b64("late"), mimeType: "text/plain" }] });
      expect(second.status).toBe(409);
      expect(errorOf(second).code).toBe("conversation_busy");
      expect((await t.storage.listFiles!({ conversationId: id })).total).toBe(0);
      release.open();
      await first;
    });

    it("are refused as an HTTP status when streamed, too", async () => {
      const t = await boot({ agentFiles: { allowedMimeTypes: ["text/plain"] } });
      const id = await t.conversation();
      const res = await t.send(id, "x", { stream: true, files: [{ name: "a.pdf", content: b64("x"), mimeType: "application/pdf" }] });
      expect(res.status).toBe(415);
      expect(res.stream).toBeUndefined();
    });
  });
}


// ----------------------------------------------------------------------------
// What the agent is given
// ----------------------------------------------------------------------------

const LIST = "session_files_list";
const READ = "session_files_read";
const VIEW = "session_files_view_image";

/** An agent-sdk-shaped agent that pauses on its first call and finishes after the decision. */
function pausingAgent(seen: any[], runtime?: { tools?: string[]; model?: unknown }) {
  return {
    ...(runtime ? { __runtime: { tools: (runtime.tools ?? []).map((name) => ({ name })), model: runtime.model } } : {}),
    invoke: async (input: any) => {
      seen.push(input);
      const decided = (input.pendingApprovals ?? []).find((a: any) => a.status === "approved");
      if (!decided) {
        const state = {
          messages: [...(input.messages ?? []), { role: "assistant", content: "" }],
          pendingApprovals: [
            { id: "ap1", toolCallId: "call1", toolName: "deploy", args: {}, status: "pending", requestedAt: new Date().toISOString(), metadata: { prompt: "Deploy?" } },
          ],
          pendingUserQuestions: [],
          ctx: {},
        };
        return { content: "", messages: state.messages, metadata: {}, state };
      }
      return { content: "done", messages: [], metadata: {}, state: { messages: input.messages ?? [], pendingApprovals: [], pendingUserQuestions: [] } };
    },
    resolveToolApproval: (state: any, r: any) => ({
      ...state,
      pendingApprovals: state.pendingApprovals.map((a: any) => (a.id === r.id ? { ...a, status: r.approved ? "approved" : "rejected" } : a)),
    }),
    resolveUserQuestion: (state: any) => state,
  };
}

/** A model that records what the SDK sends. */
function recordingModel() {
  const sent: any[][] = [];
  const model: any = {
    modelName: "fake",
    invoke: async (messages: any[]) => {
      sent.push(messages);
      return { role: "assistant", content: "ok" };
    },
    bindTools: () => model,
  };
  return { model, sent };
}

const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const imagesIn = (content: unknown): any[] => (Array.isArray(content) ? content.filter((p) => p.type === "image_url") : []);

function assemblySuite() {
  describe("documents", () => {
    it("go into the turn when they fit, and the stored message keeps what the person typed", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent });
      const id = await t.conversation();
      const file = await t.fileOf(t.uploadRaw(id, "a.txt", "alpha"));
      expect((await t.send(id, "summarise", { fileIds: [file.id] })).status).toBe(200);

      const content = lastUser(agent).content as string;
      expect(content.startsWith("summarise\n\n<attachments source=\"session-files\">\n")).toBe(true);
      expect(content).toContain("The person attached 1 file: 1 document included below.");
      expect(content).toContain(`<document name="a.txt" id="${file.id}">\nalpha\n</document>`);

      const [stored] = await t.messages(id);
      expect(stored.content).toBe("summarise");
      expect(stored.files).toEqual([{ id: file.id, name: "a.txt", mimeType: "text/plain", size: 5 }]);
    });

    it("are put in front of the agent again on a later turn, the same way", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent });
      const id = await t.conversation();
      const file = await t.fileOf(t.uploadRaw(id, "a.txt", "alpha"));
      await t.send(id, "first", { fileIds: [file.id] });
      await t.send(id, "and now?");

      const second = agent.calls[1]!.messages.filter((m: any) => m.role === "user");
      expect(second).toHaveLength(2);
      expect(second[0].content).toBe(agent.calls[0]!.messages[0].content);
      expect(second[0].content).toContain("alpha");
      expect(second[1].content).toBe("and now?");
    });

    it("go through the host's extractor first, and through the default when it declines", async () => {
      const agent = recordingAgent();
      const t = await boot({
        agent,
        files: { extractText: (file, bytes) => (file.mimeType === "application/x-custom" ? `CUSTOM(${bytes.toString()})` : undefined) },
      });
      const id = await t.conversation();
      const custom = await t.fileOf(t.uploadRaw(id, "c.dat", "payload", "application/x-custom"));
      const plain = await t.fileOf(t.uploadRaw(id, "p.txt", "plain"));
      await t.send(id, "read", { fileIds: [custom.id, plain.id] });
      const content = lastUser(agent).content as string;
      expect(content).toContain("CUSTOM(payload)");
      expect(content).toContain("\nplain\n");
    });

    it("are read in pages with the session file tools when they are too long", async () => {
      const text = "0123456789".repeat(100); // 1000 characters = about 250 tokens
      const results: Record<string, string> = {};
      let fileId = "";
      let foreignId = "";
      const tools = Object.fromEntries(createSessionFileTools().map((tool) => [tool.name, tool]));
      const agent = recordingAgent({
        runtime: { tools: [LIST, READ] },
        run: async () => {
          results.list = await tools[LIST]!.func({});
          results.page2 = await tools[READ]!.func({ fileId, page: 2 });
          results.foreign = await tools[READ]!.func({ fileId: foreignId });
        },
      });
      const t = await boot({ agent, agentFiles: { inlineMaxTokens: 50, readPageChars: 400 } });
      const id = await t.conversation();
      const other = await t.conversation();
      fileId = (await t.fileOf(t.uploadRaw(id, "long.txt", text))).id;
      foreignId = (await t.fileOf(t.uploadRaw(other, "theirs.txt", "not for you"))).id;

      const res = await t.send(id, "read it", { fileIds: [fileId] });
      expect(res.status).toBe(200);
      const content = lastUser(agent).content as string;
      expect(content).toContain(`1 document to read with the tools (${LIST}, ${READ})`);
      expect(content).toContain(`- "long.txt" (id ${fileId}, 3 pages)`);
      expect(content).not.toContain("0123456789");
      expect((res.body as any).warnings).toBeUndefined();

      expect(JSON.parse(results.list!)).toEqual([{ fileId, name: "long.txt", mimeType: "text/plain", size: 1000, readable: true }]);
      expect(JSON.parse(results.page2!)).toEqual({ text: text.slice(400, 800), page: 2, pages: 3 });
      expect(results.foreign).toContain("is not attached to this conversation");
    });

    it("are cut at the limit, with a warning, for an agent that has no way to read pages", async () => {
      const agent = recordingAgent({ runtime: { tools: [] } });
      const t = await boot({ agent, agentFiles: { inlineMaxTokens: 50 } }); // room for 200 characters
      const id = await t.conversation();
      const file = await t.fileOf(t.uploadRaw(id, "long.txt", "z".repeat(1000)));
      const res = await t.send(id, "read it", { fileIds: [file.id] });

      const content = lastUser(agent).content as string;
      expect(content).toContain("1 document included below in part");
      expect(content).toContain(`truncated="true" shown_chars="200" total_chars="1000"`);
      expect(content).toContain("z".repeat(200));
      expect(content).not.toContain("z".repeat(201));
      expect((res.body as any).warnings).toEqual([expect.objectContaining({ code: "file_truncated" })]);
      const assistant = (await t.messages(id)).at(-1);
      expect(assistant.metadata.warnings).toEqual([expect.objectContaining({ code: "file_truncated" })]);
    });

    it("say so when a file has no readable text, and when it has expired", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent });
      const id = await t.conversation();
      const binary = await t.fileOf(t.uploadRaw(id, "blob.zip", Buffer.from([80, 75, 3, 4, 0, 1]), "application/zip"));
      const gone = await t.fileOf(t.uploadRaw(id, "old.txt", "was here"));
      await t.send(id, "look", { fileIds: [binary.id, gone.id] });
      await t.storage.deleteFile(gone.id);
      await t.send(id, "again");

      const first = agent.calls[0]!.messages[0].content as string;
      expect(first).toContain("1 document whose text could not be extracted");
      expect(first).toContain(`[File "blob.zip" (id ${binary.id}) is attached, but its text could not be extracted.]`);
      const later = agent.calls[1]!.messages[0].content as string;
      expect(later).toContain("1 file no longer available");
      expect(later).toContain(`[File "old.txt" (id ${gone.id}) is no longer available.]`);
    });
  });

  describe("a file that cannot be read", () => {
    it("is named, with a warning, when the host's extractor fails - and the turn goes on", async () => {
      const agent = recordingAgent();
      const t = await boot({
        agent,
        files: { extractText: async () => { throw new Error("ocr down"); } },
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const id = await t.conversation();
      const file = await t.fileOf(t.uploadRaw(id, "scan.pdf", "%PDF", "application/pdf"));
      const res = await t.send(id, "read", { fileIds: [file.id] });
      error.mockRestore();
      expect(res.status).toBe(200);
      expect(lastUser(agent).content).toContain("is attached, but its text could not be extracted");
      expect((res.body as any).warnings).toEqual([expect.objectContaining({ code: "file_unreadable", fileId: file.id })]);
    });

    it("is a gone image on a later turn: named, never sent", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent, agentFiles: { vision: true } });
      const id = await t.conversation();
      const pic = await t.fileOf(t.uploadRaw(id, "cat.png", PNG, "image/png"));
      await t.send(id, "look", { fileIds: [pic.id] });
      await t.storage.deleteFile(pic.id);
      await t.send(id, "again?");
      const first = agent.calls[1]!.messages.filter((m: any) => m.role === "user")[0];
      expect(imagesIn(first.content)).toEqual([]);
      expect(textOf(first.content)).toContain(`[File "cat.png" (id ${pic.id}) is no longer available.]`);
    });
  });

  describe("uploads nobody has sent yet", () => {
    it("ride along with the next message when the agent is set up for it, once", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent, agentFiles: { attachNewUploads: true } });
      const id = await t.conversation();
      const a = await t.fileOf(t.uploadRaw(id, "a.txt", "alpha"));
      const b = await t.fileOf(t.uploadRaw(id, "b.txt", "beta"));
      const first = await t.send(id, "go");
      expect((first.body as any).message.files.map((f: any) => f.id)).toEqual([a.id, b.id]);
      expect(lastUser(agent).content).toContain("2 documents included below");
      const second = await t.send(id, "and?");
      expect((second.body as any).message.files).toBeUndefined();
    });

    it("stay where they are by default", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent });
      const id = await t.conversation();
      await t.fileOf(t.uploadRaw(id, "a.txt", "alpha"));
      const res = await t.send(id, "go");
      expect((res.body as any).message.files).toBeUndefined();
      expect(lastUser(agent).content).toBe("go");
    });

    it("do not duplicate a file the message names, and stop at the message's limit", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent, agentFiles: { attachNewUploads: true }, config: { limits: { maxFiles: 2 } } });
      const id = await t.conversation();
      const a = await t.fileOf(t.uploadRaw(id, "a.txt", "alpha"));
      await t.fileOf(t.uploadRaw(id, "b.txt", "beta"));
      await t.fileOf(t.uploadRaw(id, "c.txt", "gamma"));
      const res = await t.send(id, "go", { fileIds: [a.id] });
      expect((res.body as any).message.files.map((f: any) => f.name)).toEqual(["a.txt", "b.txt"]);
    });
  });

  describe("images", () => {
    it("are only mentioned to an agent that cannot read them", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent });
      const id = await t.conversation();
      const pic = await t.fileOf(t.uploadRaw(id, "cat.png", PNG, "image/png"));
      const res = await t.send(id, "what is this?", { fileIds: [pic.id] });
      const content = lastUser(agent).content;
      expect(typeof content).toBe("string");
      expect(content).toContain(`[Image "cat.png" (id ${pic.id}) is attached, but this agent cannot read images.]`);
      expect((res.body as any).warnings).toEqual([expect.objectContaining({ code: "images_not_supported" })]);
    });

    it("are handed to an agent whose model is not wrapped as bytes, with a handle that names them", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent, agentFiles: { vision: true } });
      const id = await t.conversation();
      const pic = await t.fileOf(t.uploadRaw(id, "cat.png", PNG, "image/png"));
      await t.send(id, "what is this?", { fileIds: [pic.id] });

      const parts = lastUser(agent).content as any[];
      expect(parts[0].text).toContain("The person attached 1 file: 1 image shown below.");
      expect(parts[1]).toEqual({ type: "text", text: `[Attached image: "cat.png" (id ${pic.id})]` });
      expect(parts[2]).toEqual({
        type: "image_url",
        image_url: { url: PNG_URL },
        fileId: pic.id,
        name: "cat.png",
      });
    });

    it("stay references for an agent whose model is wrapped, which reads them where the model is called", async () => {
      const { model, sent } = recordingModel();
      const wrapped = withSessionImages(model);
      let shown: any[] = [];
      const agent = recordingAgent({
        runtime: { tools: [], model: wrapped },
        run: async (input) => {
          shown = input.messages;
          await wrapped.bindTools([]).invoke(input.messages);
        },
      });
      const t = await boot({ agent, agentFiles: { vision: true } });
      const id = await t.conversation();
      const pic = await t.fileOf(t.uploadRaw(id, "cat.png", PNG, "image/png"));
      await t.send(id, "what is this?", { fileIds: [pic.id] });

      // the SDK is given a reference ...
      expect(imagesIn(shown.at(-1).content)).toEqual([
        { type: "image_url", image_url: { url: `session-file://${pic.id}` }, fileId: pic.id, name: "cat.png" },
      ]);
      // ... and the model gets the bytes
      expect(imagesIn(sent[0]!.at(-1).content)).toEqual([
        { type: "image_url", image_url: { url: PNG_URL }, fileId: pic.id, name: "cat.png" },
      ]);
    });

    it("can be looked at again through the tool, which the wrapped model answers with the picture", async () => {
      const { model, sent } = recordingModel();
      const wrapped = withSessionImages(model);
      const tools = Object.fromEntries(createSessionFileTools({ viewImage: true }).map((tool) => [tool.name, tool]));
      let picId = "";
      const agent = recordingAgent({
        runtime: { tools: [LIST, READ, VIEW], model: wrapped },
        run: async (input) => {
          const result = await tools[VIEW]!.func({ fileId: picId });
          await wrapped.invoke([
            ...input.messages,
            { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
            { role: "tool", name: VIEW, tool_call_id: "c1", content: result },
          ]);
        },
      });
      const t = await boot({ agent, agentFiles: { vision: true, carryRecentImages: 0 } });
      const id = await t.conversation();
      picId = (await t.fileOf(t.uploadRaw(id, "cat.png", PNG, "image/png"))).id;
      await t.send(id, "look", { fileIds: [picId] });
      const seen = sent[0]!;
      expect(seen.at(-1).role).toBe("user");
      expect(seen.at(-1).content[0].text).toContain("the image you asked to look at");
      expect(imagesIn(seen.at(-1).content)[0].image_url.url).toBe(PNG_URL);
    });

    it("never reach a stored paused state as bytes, and are read again when the turn resumes", async () => {
      const seen: any[] = [];
      const agent = pausingAgent(seen);
      const t = await boot({ agent, agentFiles: { vision: true } });
      const id = await t.conversation();
      const pic = await t.fileOf(t.uploadRaw(id, "cat.png", PNG, "image/png"));
      const paused = await t.send(id, "deploy this picture", { fileIds: [pic.id] });
      expect((paused.body as any).status).toBe("requires_action");
      // the agent was given the bytes ...
      expect(imagesIn(seen[0].messages.at(-1).content)[0].image_url.url).toBe(PNG_URL);
      // ... but what was stored holds a reference
      const stored = JSON.stringify((await t.storage.getConversation(id))!.state);
      expect(stored).not.toContain(PNG.toString("base64"));
      expect(stored).toContain(`session-file://${pic.id}`);

      const resumed = await t.call("POST", `/conversations/${id}/actions/ap1`, { body: { resolution: { type: "tool_approval", decision: "allow" } } });
      expect(resumed.status).toBe(200);
      const messages = seen[1].messages as any[];
      const image = messages.flatMap((m) => imagesIn(m.content))[0];
      expect(image.image_url).toEqual({ url: PNG_URL });
    });

    it("keep showing only the newest few, and name the older ones", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent, agentFiles: { vision: true, carryRecentImages: 1 } });
      const id = await t.conversation();
      for (const name of ["one", "two", "three"]) {
        const pic = await t.fileOf(t.uploadRaw(id, `${name}.png`, PNG, "image/png"));
        await t.send(id, name, { fileIds: [pic.id] });
      }
      const users = agent.calls[2]!.messages.filter((m: any) => m.role === "user");
      expect(users.map((m: any) => imagesIn(m.content).length)).toEqual([0, 1, 1]);
      expect(textOf(users[0].content)).toContain('"one.png"');
      expect(textOf(users[0].content)).toContain("was attached earlier and is not shown in this request");
      // a text-only follow-up still sees the last one
      await t.send(id, "what colour was it?");
      const followUp = agent.calls[3]!.messages.filter((m: any) => m.role === "user");
      expect(followUp.map((m: any) => imagesIn(m.content).length)).toEqual([0, 0, 1, 0]);
    });

    it("point an older image at the tool only when the agent can use it", async () => {
      const plain = recordingAgent();
      const withTool = recordingAgent({ runtime: { tools: [LIST, READ, VIEW], model: withSessionImages(recordingModel().model) } });
      for (const [agent, mentions] of [[plain, false], [withTool, true]] as const) {
        const t = await boot({ agent, agentFiles: { vision: true, carryRecentImages: 0 } });
        const id = await t.conversation();
        for (const name of ["one", "two"]) {
          const pic = await t.fileOf(t.uploadRaw(id, `${name}.png`, PNG, "image/png"));
          await t.send(id, name, { fileIds: [pic.id] });
        }
        const older = textOf(agent.calls[1]!.messages.filter((m: any) => m.role === "user")[0].content);
        expect(older).toContain("was attached earlier and is not shown in this request");
        expect(older.includes(VIEW), String(mentions)).toBe(mentions);
      }
    });

    it("stay within the number a request may carry", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent, agentFiles: { vision: true, maxImages: 2 } });
      const id = await t.conversation();
      const pics = [];
      for (const name of ["a", "b", "c"]) pics.push((await t.fileOf(t.uploadRaw(id, `${name}.png`, PNG, "image/png"))).id);
      await t.send(id, "all three", { fileIds: pics });
      const parts = lastUser(agent).content as any[];
      expect(imagesIn(parts)).toHaveLength(2);
      const placeholder = parts.find((p) => p.type === "text" && p.text.includes("is not shown: a request carries at most 2 images"));
      expect(placeholder.text).toContain('"a.png"');
    });

    it("are told apart from documents in the first line of a mixed message", async () => {
      const agent = recordingAgent({ runtime: { tools: [LIST, READ] } });
      const t = await boot({ agent, agentFiles: { vision: true, inlineMaxTokens: 5 } });
      const id = await t.conversation();
      const docs = [await t.fileOf(t.uploadRaw(id, "a.txt", "a".repeat(100))), await t.fileOf(t.uploadRaw(id, "b.txt", "b".repeat(100))), await t.fileOf(t.uploadRaw(id, "c.txt", "c".repeat(100)))];
      const pic = await t.fileOf(t.uploadRaw(id, "p.png", PNG, "image/png"));
      await t.send(id, "everything", { fileIds: [...docs.map((d) => d.id), pic.id] });
      const parts = lastUser(agent).content as any[];
      expect(parts[0].text).toContain(`The person attached 4 files: 3 documents to read with the tools (${LIST}, ${READ}), 1 image shown below.`);
    });
  });

  describe("an image on a model that is told what it can look at", () => {
    it("gets only the pictures every provider accepts", async () => {
      const agent = recordingAgent();
      const t = await boot({ agent, agentFiles: { vision: true } });
      const id = await t.conversation();
      const svg = await t.fileOf(t.uploadRaw(id, "logo.svg", "<svg>logo</svg>", "image/svg+xml"));
      await t.send(id, "what is this?", { fileIds: [svg.id] });
      // an SVG is a document: its text is given, not a picture
      expect(typeof lastUser(agent).content).toBe("string");
      expect(lastUser(agent).content).toContain("<svg>logo</svg>");
    });
  });
}

async function messageCount(t: Awaited<ReturnType<typeof boot>>, id: string): Promise<number> {
  return (await t.storage.getMessages(id)).total;
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
    filesSuite();
    assemblySuite();
  });
}
