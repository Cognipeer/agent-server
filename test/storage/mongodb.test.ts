import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StorageLimitError, createAgentServer, createMongoDBProvider } from "../../src/index.js";
import { runStorageContract } from "./contract.js";
import { describeProvider } from "./providers.js";

const MiB = 1024 * 1024;

describeProvider("mongodb", (harness) => {
  runStorageContract(harness.name, (options) => harness.open(options));

  /** A raw driver connection to the store `open()` made, for looking behind the provider. */
  async function raw<T>(
    where: Record<string, string>,
    fn: (db: import("mongodb").Db, mongodb: typeof import("mongodb")) => Promise<T>
  ): Promise<T> {
    const mongodb = await import("mongodb");
    const client = await new mongodb.MongoClient(where.url!).connect();
    try {
      return await fn(client.db(where.database), mongodb);
    } finally {
      await client.close();
    }
  }

  describe("file content", () => {
    it("lives in GridFS, whatever its size, and not in a document", async () => {
      const opened = await harness.open();
      try {
        const small = await opened.storage.saveFile({ name: "s.txt", mimeType: "text/plain", content: Buffer.from("tiny") });
        const big = await opened.storage.saveFile({ name: "b.bin", mimeType: "application/octet-stream", content: randomBytes(18 * MiB) });
        await raw(opened.where, async (db) => {
          const stored = await db.collection("agent_server_files.files").find().toArray();
          expect(stored.map((f) => f._id).sort()).toEqual([small.storageKey, big.storageKey].sort());
          expect(await db.collection("agent_server_file_contents").countDocuments()).toBe(0);
          expect(await db.collection("agent_server_files.chunks").countDocuments()).toBeGreaterThan(1);
          // the record collection is a different one from GridFS's
          expect(await db.collection("agent_server_files").countDocuments()).toBe(2);
        });
        expect((await opened.storage.getFileContent(big.id))!.length).toBe(18 * MiB);
      } finally {
        await opened.close();
      }
    });

    it("still reads (and deletes) content that an older version stored in one document", async () => {
      const opened = await harness.open();
      try {
        const content = randomBytes(1024);
        await raw(opened.where, async (db, mongodb) => {
          await db.collection("agent_server_file_contents").insertOne({ _id: "legacy-key.bin" as any, content: new mongodb.Binary(content) });
          await db.collection("agent_server_files").insertOne({
            _id: "file_legacy" as any,
            name: "legacy.bin",
            mimeType: "application/octet-stream",
            size: content.length,
            storageKey: "legacy-key.bin",
            conversationId: null,
            messageId: null,
            metadata: {},
            createdAt: new Date(),
          });
        });
        const read = await opened.storage.getFileContent("file_legacy");
        expect(Buffer.isBuffer(read)).toBe(true);
        expect(read!.equals(content)).toBe(true);

        await opened.storage.deleteFile("file_legacy");
        expect(await opened.storage.getFile("file_legacy")).toBeNull();
        expect(await opened.blobCount()).toBe(0);
      } finally {
        await opened.close();
      }
    });
  });

  describe("a file whose content upload fails part-way", () => {
    it("leaves no chunks behind, and no file", async () => {
      const opened = await harness.open();
      try {
        const bucket = (opened.storage as unknown as { bucket: { openUploadStreamWithId: (...args: unknown[]) => any } }).bucket;
        const open = bucket.openUploadStreamWithId.bind(bucket);
        let broken = true;
        bucket.openUploadStreamWithId = (...args: unknown[]) => {
          const stream = open(...args);
          if (!broken) return stream;
          // write enough for whole chunks to be stored, then fail before the upload is finished
          const end = stream.end.bind(stream);
          stream.end = (content: Buffer) => {
            stream.write(content, () => setTimeout(() => stream.destroy(new Error("the connection dropped mid-upload")), 100));
            return stream;
          };
          void end;
          return stream;
        };

        await expect(
          opened.storage.saveFile({ name: "big.bin", mimeType: "application/octet-stream", content: randomBytes(1 * MiB) })
        ).rejects.toThrow(/dropped mid-upload/);

        await raw(opened.where, async (db) => {
          expect(await db.collection("agent_server_files.chunks").countDocuments()).toBe(0);
          expect(await db.collection("agent_server_files.files").countDocuments()).toBe(0);
          expect(await db.collection("agent_server_files").countDocuments()).toBe(0);
        });

        // and the provider carries on: the next upload is stored normally
        broken = false;
        const content = randomBytes(300_000);
        const file = await opened.storage.saveFile({ name: "ok.bin", mimeType: "application/octet-stream", content });
        expect((await opened.storage.getFileContent(file.id))!.equals(content)).toBe(true);
        expect(await opened.blobCount()).toBe(1);
      } finally {
        await opened.close();
      }
    });
  });

  describe("the event log summary", () => {
    it("reports the newest stored event, not the sequence numbers already handed out", async () => {
      const opened = await harness.open();
      try {
        const conv = await opened.storage.createConversation({ agentId: "a" });
        const events = opened.storage.events!;
        // hold the insert of the next append: its numbers are reserved, its events are not stored yet
        const db = (opened.storage as unknown as { db: { collection: (name: string, ...rest: unknown[]) => any } }).db;
        const collection = db.collection.bind(db);
        const reached: { open?: () => void } = {};
        const entered = new Promise<void>((resolve) => (reached.open = resolve));
        let letGo!: () => void;
        const held = new Promise<void>((resolve) => (letGo = resolve));
        let hold = false;
        db.collection = (name: string, ...rest: unknown[]) => {
          const target = collection(name, ...rest);
          if (!hold || name !== "agent_server_events") return target;
          return new Proxy(target, {
            get(object, prop) {
              if (prop === "insertMany") {
                return async (...args: unknown[]) => {
                  reached.open!();
                  await held;
                  return object.insertMany(...args);
                };
              }
              const value = Reflect.get(object, prop);
              return typeof value === "function" ? value.bind(object) : value;
            },
          });
        };

        await events.append(conv.id, [{ type: "user.message" }, { type: "session.status_running" }]);
        expect((await events.summary!([conv.id]))[conv.id]).toEqual({ lastSeq: 2 });

        hold = true;
        const pending = events.append(conv.id, [{ type: "agent.message" }, { type: "agent.message" }, { type: "session.work_done" }]);
        await entered;
        // 5 numbers are out; 2 events are stored
        await raw(opened.where, async (rawDb) => {
          expect((await rawDb.collection("agent_server_event_streams").findOne({ _id: conv.id as never }))?.lastSeq).toBe(5);
        });
        expect((await events.summary!([conv.id]))[conv.id]).toEqual({ lastSeq: 2 });
        expect((await events.list(conv.id, { limit: 1, order: "desc" })).events[0]!.seq).toBe(2);

        hold = false;
        letGo();
        expect((await pending).map((e) => e.seq)).toEqual([3, 4, 5]);
        expect((await events.summary!([conv.id]))[conv.id]).toEqual({ lastSeq: 5 });
      } finally {
        await opened.close();
      }
    });

    it("does not count numbers burned by an append that failed, and keeps counting past them", async () => {
      const opened = await harness.open();
      try {
        const conv = await opened.storage.createConversation({ agentId: "a" });
        const events = opened.storage.events!;
        await events.append(conv.id, [{ type: "x" }]);
        // an event already stored under the number the next append will get: its insert is refused (duplicate key)
        await raw(opened.where, async (db) => {
          await db.collection("agent_server_events").insertOne({ conversationId: conv.id, seq: 2, type: "squatter", data: {}, runId: null, createdAt: new Date() } as never);
        });
        await expect(events.append(conv.id, [{ type: "y" }])).rejects.toBeDefined();
        // the failed append reserved number 2 and stored nothing of its own: the summary says what its own appends stored
        expect((await events.summary!([conv.id]))[conv.id]).toEqual({ lastSeq: 1 });
        // numbers are never handed out twice: the next append goes on from 3
        const next = await events.append(conv.id, [{ type: "z" }]);
        expect(next[0]!.seq).toBe(3);
        expect((await events.summary!([conv.id]))[conv.id]).toEqual({ lastSeq: 3 });
      } finally {
        await opened.close();
      }
    });

    it("reads a stream written before committedSeq existed from its lastSeq", async () => {
      const opened = await harness.open();
      try {
        const conv = await opened.storage.createConversation({ agentId: "a" });
        await raw(opened.where, async (db) => {
          await db.collection("agent_server_event_streams").insertOne({ _id: conv.id as never, lastSeq: 7, updatedAt: new Date() });
        });
        expect((await opened.storage.events!.summary!([conv.id]))[conv.id]).toEqual({ lastSeq: 7 });
      } finally {
        await opened.close();
      }
    });
  });

  describe("conversation state", () => {
    it("is limited to maxStateBytes (12 MiB by default) and reports it", async () => {
      expect(createMongoDBProvider({ connectionString: "mongodb://x" }).capabilities().maxStateBytes).toBe(12 * MiB);
      expect(createMongoDBProvider({ connectionString: "mongodb://x", maxStateBytes: 4096 }).capabilities().maxStateBytes).toBe(4096);
    });

    it("refuses a maxStateBytes a document cannot hold, when connecting", async () => {
      const opened = await harness.open();
      try {
        for (const maxStateBytes of [0, 16 * MiB, 1.5]) {
          const provider = createMongoDBProvider({ connectionString: opened.where.url!, database: opened.where.database, maxStateBytes });
          await expect(provider.connect()).rejects.toThrow(/maxStateBytes/);
        }
      } finally {
        await opened.close();
      }
    });

    it("refuses a state over the limit with a 413 and keeps the stored one", async () => {
      const opened = await harness.open();
      try {
        const provider = createMongoDBProvider({ connectionString: opened.where.url!, database: opened.where.database, maxStateBytes: 100_000 });
        await provider.connect();
        const conv = await provider.createConversation({ agentId: "a", state: { n: 1 } });
        await expect(provider.updateConversation(conv.id, { state: { blob: "x".repeat(200_000) } })).rejects.toBeInstanceOf(StorageLimitError);
        await expect(provider.createConversation({ agentId: "a", state: { blob: "x".repeat(200_000) } })).rejects.toMatchObject({ statusCode: 413 });
        expect((await provider.getConversation(conv.id))!.state).toEqual({ n: 1 });
        await provider.disconnect();
      } finally {
        await opened.close();
      }
    });

    it("measures the state as BSON: numbers are small as JSON and large in a document", async () => {
      const opened = await harness.open();
      try {
        const conv = await opened.storage.createConversation({ agentId: "a" });
        // ~3 MB of JSON, ~18 MB of BSON (each array element carries its index as a key)
        const numbers = Array.from({ length: 1_500_000 }, (_, i) => i % 10);
        expect(JSON.stringify(numbers).length).toBeLessThan(opened.storage.capabilities!().maxStateBytes);
        await expect(opened.storage.updateConversation(conv.id, { state: { numbers } })).rejects.toMatchObject({ statusCode: 413 });
      } finally {
        await opened.close();
      }
    });

    it("a pause the document cannot hold ends the turn with a warning instead of failing it", async () => {
      const opened = await harness.open();
      try {
        const numbers = Array.from({ length: 1_500_000 }, (_, i) => i % 10);
        const agent = {
          invoke: async () => ({
            content: "",
            metadata: {},
            state: {
              messages: [],
              big: numbers,
              pendingApprovals: [{ id: "ap1", toolCallId: "c1", toolName: "deploy", args: {}, status: "pending" }],
              pendingUserQuestions: [],
            },
          }),
          resolveToolApproval: (state: unknown) => state,
          resolveUserQuestion: (state: unknown) => state,
        };
        const server = createAgentServer({
          basePath: "/api",
          storage: opened.storage,
          agents: [{ info: { id: "a", name: "A" }, sdkAgent: agent }],
        });
        const created = await server.handleRoute("POST", "/conversations", { query: {}, body: { agentId: "a" } });
        const id = (created.body as any).conversation.id;
        const res = await server.handleRoute("POST", `/conversations/${id}/messages`, { query: {}, body: { message: "deploy" } });
        expect(res.status).toBe(200);
        expect((res.body as any).status).toBeUndefined();
        expect((res.body as any).warnings[0].code).toBe("pause_state_too_large");
        const conv = await server.handleRoute("GET", `/conversations/${id}`, { query: {} });
        expect((conv.body as any).messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
        expect((conv.body as any).pendingActions).toBeUndefined();
      } finally {
        await opened.close();
      }
    });
  });

  describe("indexes", () => {
    it("replaces the single-field indexes of older versions with the ones the sorted lists use", async () => {
      const opened = await harness.open();
      try {
        await opened.storage.disconnect();
        await raw(opened.where, async (db) => {
          await db.collection("agent_server_conversations").createIndex({ agentId: 1 });
          await db.collection("agent_server_conversations").createIndex({ createdAt: -1 });
          await db.collection("agent_server_messages").createIndex({ conversationId: 1 });
          await db.collection("agent_server_messages").createIndex({ conversationId: 1, createdAt: 1 });
        });
        await opened.reopen();
        await raw(opened.where, async (db) => {
          const names = async (collection: string) => (await db.collection(collection).indexes()).map((i) => i.name);
          expect(await names("agent_server_conversations")).toEqual(
            expect.arrayContaining(["agentId_1_createdAt_-1_seq_-1", "createdAt_-1_seq_-1", "updatedAt_-1_seq_-1"])
          );
          expect(await names("agent_server_conversations")).not.toContain("agentId_1");
          expect(await names("agent_server_conversations")).not.toContain("createdAt_-1");
          expect(await names("agent_server_messages")).toEqual(["_id_", "conversationId_1_createdAt_1_seq_1"]);
          expect(await names("agent_server_task_results")).toContain("taskId_1");
          expect((await db.collection("agent_server_files").indexes()).find((i) => i.name === "storageKey_1")?.unique).toBe(true);
        });
      } finally {
        await opened.close();
      }
    });
  });

  describe("connecting", () => {
    it("gives up cleanly when the server is unreachable", async () => {
      const provider = createMongoDBProvider({ connectionString: "mongodb://127.0.0.1:1/none?serverSelectionTimeoutMS=300" });
      await expect(provider.connect()).rejects.toThrow(/Failed to connect to MongoDB/);
      expect(provider.isConnected()).toBe(false);
    });
  });
});
