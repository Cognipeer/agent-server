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
        expect((check.prepare("SELECT value FROM agent_server_meta WHERE key = 'schema_version'").get() as any).value).toBe("2");
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

  describe("limits", () => {
    it("reports SQLite's own file and state limits", async () => {
      const provider = createSQLiteProvider({ filename: ":memory:" });
      expect(provider.capabilities()).toMatchObject({ maxFileBytes: 1_000_000_000, maxStateBytes: 1_000_000_000 });
    });
  });
});
