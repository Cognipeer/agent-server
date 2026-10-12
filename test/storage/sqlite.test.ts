import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSQLiteProvider } from "../../src/index.js";
import { runStorageContract } from "./contract.js";
import { describeProvider } from "./providers.js";

describeProvider("sqlite", (harness) => {
  runStorageContract(harness.name, (options) => harness.open(options));

  describe("upgrading a database created by 0.3.0", () => {
    /** The tables and indexes exactly as 0.3.0 created them. */
    function create030(db: import("better-sqlite3").Database) {
      db.exec(`
        CREATE TABLE agent_server_conversations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT, title TEXT,
          metadata TEXT DEFAULT '{}', state TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE agent_server_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_server_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL, content TEXT NOT NULL, name TEXT, tool_calls TEXT, tool_call_id TEXT, files TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE agent_server_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, storage_key TEXT NOT NULL,
          conversation_id TEXT REFERENCES agent_server_conversations(id) ON DELETE SET NULL, message_id TEXT REFERENCES agent_server_messages(id) ON DELETE SET NULL,
          metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE agent_server_file_contents (storage_key TEXT PRIMARY KEY, content BLOB NOT NULL);
        CREATE TABLE agent_server_tasks (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT, status TEXT NOT NULL DEFAULT 'pending', callback_url TEXT,
          input TEXT NOT NULL, files TEXT DEFAULT '[]', comments TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT, error TEXT);
        CREATE TABLE agent_server_task_results (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_server_tasks(id) ON DELETE CASCADE,
          content TEXT NOT NULL, files TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}', usage TEXT, created_at TEXT DEFAULT (datetime('now')));
        CREATE INDEX idx_agent_server_conv_agent ON agent_server_conversations(agent_id);
        CREATE INDEX idx_agent_server_conv_user ON agent_server_conversations(user_id);
        CREATE INDEX idx_agent_server_msg_conv ON agent_server_messages(conversation_id);
        CREATE INDEX idx_agent_server_files_conv ON agent_server_files(conversation_id);
        CREATE INDEX idx_agent_server_tasks_agent ON agent_server_tasks(agent_id);
        CREATE INDEX idx_agent_server_tasks_user ON agent_server_tasks(user_id);
        CREATE INDEX idx_agent_server_tasks_status ON agent_server_tasks(status);
        CREATE INDEX idx_agent_server_taskres_task ON agent_server_task_results(task_id);
      `);
    }

    it("keeps its data, keeps the newest of several results per task, and enforces one from then on", async () => {
      const { default: Database } = await import("better-sqlite3");
      const dir = await mkdtemp(path.join(tmpdir(), "agent-server-sqlite-upgrade-"));
      const file = path.join(dir, "old.db");
      try {
        const old = new Database(file);
        create030(old);
        old.prepare("INSERT INTO agent_server_conversations (id, agent_id, title, created_at, updated_at) VALUES ('conv_old', 'a', 'old chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
        old.prepare("INSERT INTO agent_server_messages (id, conversation_id, role, content, created_at, updated_at) VALUES ('msg_old', 'conv_old', 'user', ?, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')").run(JSON.stringify("hello"));
        old.prepare("INSERT INTO agent_server_tasks (id, agent_id, input) VALUES ('task_old', 'a', 'do it')").run();
        for (const [id, content] of [["res_1", "partial"], ["res_2", "final"]]) {
          old.prepare("INSERT INTO agent_server_task_results (id, task_id, content) VALUES (?, 'task_old', ?)").run(id, content);
        }
        old.close();

        const provider = createSQLiteProvider({ filename: file });
        await provider.connect();
        expect((await provider.getConversation("conv_old"))?.title).toBe("old chat");
        expect((await provider.getMessages("conv_old")).data[0]?.content).toBe("hello");
        expect((await provider.getTaskResult("task_old"))?.content).toBe("final");

        const replaced = await provider.createTaskResult({ taskId: "task_old", content: "newer" });
        expect(replaced.id).toBe("res_2");
        expect((await provider.getTaskResult("task_old"))?.content).toBe("newer");
        await provider.disconnect();

        const check = new Database(file, { readonly: true });
        expect((check.prepare("SELECT COUNT(*) AS n FROM agent_server_task_results").get() as any).n).toBe(1);
        expect((check.prepare("SELECT value FROM agent_server_meta WHERE key = 'schema_version'").get() as any).value).toBe("5");
        const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((r) => r.name);
        expect(tables).toEqual(expect.arrayContaining(["agent_server_events", "agent_server_event_streams", "agent_server_leases"]));
        const taskColumns = (check.prepare("PRAGMA table_info(agent_server_tasks)").all() as any[]).map((r) => r.name);
        expect(taskColumns).toContain("conversation_id");
        const indexes = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as any[]).map((r) => r.name);
        expect(indexes).toContain("idx_agent_server_taskres_task_uq");
        expect(indexes).toContain("idx_agent_server_msg_conv_t");
        expect(indexes).not.toContain("idx_agent_server_msg_conv");
        check.close();

        // a second start does the migration work once, not again
        const again = createSQLiteProvider({ filename: file });
        await again.connect();
        expect((await again.getTaskResult("task_old"))?.content).toBe("newer");
        await again.disconnect();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("upgrading a database from the previous schema (version 2)", () => {
    it("adds the event log, the leases and the task link, and keeps what was there", async () => {
      const { default: Database } = await import("better-sqlite3");
      const dir = await mkdtemp(path.join(tmpdir(), "agent-server-sqlite-v2-"));
      const file = path.join(dir, "v2.db");
      try {
        const first = createSQLiteProvider({ filename: file });
        await first.connect();
        const conv = await first.createConversation({ agentId: "a", title: "kept" });
        const task = await first.createTask({ agentId: "a", input: "old task" });
        await first.disconnect();

        // take it back to what version 2 had: no event log, no leases, no tasks.conversation_id
        const raw = new Database(file);
        raw.exec(`
          DROP TABLE agent_server_events; DROP TABLE agent_server_event_streams; DROP TABLE agent_server_leases;
          DROP INDEX idx_agent_server_tasks_conv; ALTER TABLE agent_server_tasks DROP COLUMN conversation_id;
          UPDATE agent_server_meta SET value = '2' WHERE key = 'schema_version';
        `);
        raw.close();

        const upgraded = createSQLiteProvider({ filename: file });
        await upgraded.connect();
        expect((await upgraded.getConversation(conv.id))?.title).toBe("kept");
        expect((await upgraded.getTask(task.id))?.input).toBe("old task");
        expect((await upgraded.events!.append(conv.id, [{ type: "x" }]))[0]!.seq).toBe(1);
        expect(await upgraded.acquireLease!({ key: "k", owner: "o", ttlMs: 1000 })).toMatchObject({ acquired: true });
        expect((await upgraded.updateTask(task.id, { conversationId: conv.id })).conversationId).toBe(conv.id);
        await upgraded.disconnect();

        const check = new Database(file, { readonly: true });
        expect((check.prepare("SELECT value FROM agent_server_meta WHERE key = 'schema_version'").get() as any).value).toBe("5");
        check.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("upgrading a database from the previous schema (version 3)", () => {
    it("gives files an owner, an agent and an expiry, and keeps what was there", async () => {
      const { default: Database } = await import("better-sqlite3");
      const dir = await mkdtemp(path.join(tmpdir(), "agent-server-sqlite-v3-"));
      const file = path.join(dir, "v3.db");
      try {
        const first = createSQLiteProvider({ filename: file });
        await first.connect();
        const conv = await first.createConversation({ agentId: "a" });
        const old = await first.saveFile({ name: "old.txt", mimeType: "text/plain", content: Buffer.from("old"), conversationId: conv.id });
        await first.disconnect();

        const raw = new Database(file);
        raw.exec(`
          DROP INDEX idx_agent_server_files_conv_t; DROP INDEX idx_agent_server_files_expires;
          ALTER TABLE agent_server_files DROP COLUMN user_id; ALTER TABLE agent_server_files DROP COLUMN agent_id; ALTER TABLE agent_server_files DROP COLUMN expires_at;
          UPDATE agent_server_meta SET value = '3' WHERE key = 'schema_version';
        `);
        raw.close();

        const upgraded = createSQLiteProvider({ filename: file });
        await upgraded.connect();
        expect(await upgraded.getFile(old.id)).toMatchObject({ name: "old.txt", userId: undefined, expiresAt: undefined });
        const fresh = await upgraded.saveFile({
          name: "new.txt", mimeType: "text/plain", content: Buffer.from("new"), conversationId: conv.id, userId: "u1", agentId: "a", expiresAt: new Date(Date.now() - 1000),
        });
        expect((await upgraded.listFiles!({ conversationId: conv.id })).data.map((f) => f.id)).toEqual([old.id, fresh.id]);
        expect(await upgraded.purgeExpiredFiles!({ before: new Date() })).toBe(1);
        await upgraded.disconnect();

        const check = new Database(file, { readonly: true });
        expect((check.prepare("SELECT value FROM agent_server_meta WHERE key = 'schema_version'").get() as any).value).toBe("5");
        const columns = (check.prepare("PRAGMA table_info(agent_server_files)").all() as any[]).map((r) => r.name);
        expect(columns).toEqual(expect.arrayContaining(["user_id", "agent_id", "expires_at"]));
        const indexes = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as any[]).map((r) => r.name);
        expect(indexes).toEqual(expect.arrayContaining(["idx_agent_server_files_conv_t", "idx_agent_server_files_expires"]));
        check.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("upgrading a database from the previous schema (version 4)", () => {
    it("gives conversations a version and a deadline, and keeps what was there", async () => {
      const { default: Database } = await import("better-sqlite3");
      const dir = await mkdtemp(path.join(tmpdir(), "agent-server-sqlite-v4-"));
      const file = path.join(dir, "v4.db");
      try {
        const first = createSQLiteProvider({ filename: file });
        await first.connect();
        const conv = await first.createConversation({ agentId: "a", title: "kept", state: { s: 1 } });
        const message = await first.createMessage({ conversationId: conv.id, role: "user", content: "old" });
        await first.disconnect();

        const raw = new Database(file);
        raw.exec(`
          DROP INDEX idx_agent_server_conv_due;
          ALTER TABLE agent_server_conversations DROP COLUMN version; ALTER TABLE agent_server_conversations DROP COLUMN action_due_at;
          UPDATE agent_server_meta SET value = '4' WHERE key = 'schema_version';
        `);
        raw.close();

        const upgraded = createSQLiteProvider({ filename: file });
        await upgraded.connect();
        const read = (await upgraded.getConversation(conv.id))!;
        expect(read).toMatchObject({ title: "kept", state: { s: 1 }, version: 0 });
        expect(read.actionDueAt).toBeUndefined();
        expect((await upgraded.getMessage(message.id))?.content).toBe("old");
        // compare-and-set and the deadline work on the old rows
        expect(await upgraded.updateConversationIf!(conv.id, 1, { title: "stale" })).toBeNull();
        const due = new Date(Date.now() - 1000);
        expect((await upgraded.updateConversationIf!(conv.id, 0, { actionDueAt: due }))!.version).toBe(1);
        expect((await upgraded.getConversations({ actionDueBefore: new Date() })).data.map((c) => c.id)).toEqual([conv.id]);
        await upgraded.disconnect();

        const check = new Database(file, { readonly: true });
        expect((check.prepare("SELECT value FROM agent_server_meta WHERE key = 'schema_version'").get() as any).value).toBe("5");
        const columns = (check.prepare("PRAGMA table_info(agent_server_conversations)").all() as any[]).map((r) => r.name);
        expect(columns).toEqual(expect.arrayContaining(["version", "action_due_at"]));
        const indexes = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as any[]).map((r) => r.name);
        expect(indexes).toContain("idx_agent_server_conv_due");
        check.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("limits", () => {
    it("reports SQLite's own file and state limits", async () => {
      const provider = createSQLiteProvider({ filename: ":memory:" });
      expect(provider.capabilities()).toMatchObject({ maxFileBytes: 1_000_000_000, maxStateBytes: 1_000_000_000 });
    });
  });
});
