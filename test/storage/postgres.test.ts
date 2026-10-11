import { describe, expect, it } from "vitest";
import { ValidationError, createPostgresProvider } from "../../src/index.js";
import { runStorageContract } from "./contract.js";
import { describeProvider } from "./providers.js";

describeProvider("postgres", (harness) => {
  runStorageContract(harness.name, (options) => harness.open(options));

  /** A raw client on the same server, in a schema of its own that is dropped afterwards. */
  async function inSchema<T>(fn: (ctx: { schema: string; url: string; sql: (text: string, values?: unknown[]) => Promise<any[]> }) => Promise<T>): Promise<T> {
    const opened = await harness.open();
    const { url, schema } = opened.where as { url: string; schema: string };
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      // a schema the provider has not touched yet: drop the one `open()` migrated
      await opened.storage.disconnect();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.query(`CREATE SCHEMA "${schema}"`);
      return await fn({ schema, url, sql: async (text, values) => (await client.query(text, values)).rows });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  }

  /** The tables and indexes exactly as 0.3.0 created them (index names not qualified by the prefix). */
  const create030 = (schema: string, prefix = "agent_server_") => `
    CREATE TABLE "${schema}"."${prefix}conversations" (id VARCHAR(64) PRIMARY KEY, agent_id VARCHAR(255) NOT NULL, user_id VARCHAR(255), title VARCHAR(500),
      metadata JSONB DEFAULT '{}', state JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE "${schema}"."${prefix}messages" (id VARCHAR(64) PRIMARY KEY, conversation_id VARCHAR(64) NOT NULL REFERENCES "${schema}"."${prefix}conversations"(id) ON DELETE CASCADE,
      role VARCHAR(50) NOT NULL, content JSONB NOT NULL, name VARCHAR(255), tool_calls JSONB, tool_call_id VARCHAR(255), files JSONB DEFAULT '[]', metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE "${schema}"."${prefix}files" (id VARCHAR(64) PRIMARY KEY, name VARCHAR(500) NOT NULL, mime_type VARCHAR(255) NOT NULL, size INTEGER NOT NULL, storage_key VARCHAR(255) NOT NULL,
      conversation_id VARCHAR(64) REFERENCES "${schema}"."${prefix}conversations"(id) ON DELETE SET NULL, message_id VARCHAR(64) REFERENCES "${schema}"."${prefix}messages"(id) ON DELETE SET NULL,
      metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE "${schema}"."${prefix}file_contents" (storage_key VARCHAR(255) PRIMARY KEY, content BYTEA NOT NULL);
    CREATE TABLE "${schema}"."${prefix}tasks" (id VARCHAR(64) PRIMARY KEY, agent_id VARCHAR(255) NOT NULL, user_id VARCHAR(255), status VARCHAR(50) NOT NULL DEFAULT 'pending',
      callback_url VARCHAR(2000), input TEXT NOT NULL, files JSONB DEFAULT '[]', metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, error TEXT);
    CREATE TABLE "${schema}"."${prefix}task_results" (id VARCHAR(64) PRIMARY KEY, task_id VARCHAR(64) NOT NULL REFERENCES "${schema}"."${prefix}tasks"(id) ON DELETE CASCADE,
      content TEXT NOT NULL, files JSONB DEFAULT '[]', metadata JSONB DEFAULT '{}', usage JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE INDEX idx_conversations_agent_id ON "${schema}"."${prefix}conversations"(agent_id);
    CREATE INDEX idx_messages_conversation_id ON "${schema}"."${prefix}messages"(conversation_id);
    CREATE INDEX idx_task_results_task_id ON "${schema}"."${prefix}task_results"(task_id);
  `;

  describe("upgrading a database created by 0.3.0", () => {
    it("keeps its data, adds what 0.3.1 needs, keeps the newest result per task and enforces one from then on", async () => {
      await inSchema(async ({ schema, url, sql }) => {
        await sql(create030(schema));
        await sql(`INSERT INTO "${schema}"."agent_server_conversations" (id, agent_id, title) VALUES ('conv_old', 'a', 'old chat')`);
        await sql(`INSERT INTO "${schema}"."agent_server_messages" (id, conversation_id, role, content) VALUES ('msg_old', 'conv_old', 'user', '"hello"')`);
        await sql(`INSERT INTO "${schema}"."agent_server_tasks" (id, agent_id, input) VALUES ('task_old', 'a', 'do it')`);
        await sql(`INSERT INTO "${schema}"."agent_server_task_results" (id, task_id, content, created_at) VALUES
          ('res_1', 'task_old', 'partial', '2026-01-01T00:00:00Z'), ('res_2', 'task_old', 'final', '2026-01-01T00:00:05Z')`);

        const provider = createPostgresProvider({ connectionString: url, schema });
        await provider.connect();
        expect((await provider.getConversation("conv_old"))?.title).toBe("old chat");
        expect((await provider.getMessages("conv_old")).data[0]?.content).toBe("hello");
        expect((await provider.getTaskResult("task_old"))?.content).toBe("final");
        const replaced = await provider.createTaskResult({ taskId: "task_old", content: "newer" });
        expect(replaced.id).toBe("res_2");
        // the comments column exists now, and ordering columns
        const task = await provider.updateTask("task_old", { comments: [{ id: "c", taskId: "task_old", role: "user", content: "hi", createdAt: new Date(0) }] });
        expect(task.comments).toHaveLength(1);
        await provider.disconnect();

        expect(await sql(`SELECT COUNT(*)::int AS n FROM "${schema}"."agent_server_task_results"`)).toEqual([{ n: 1 }]);
        expect((await sql(`SELECT value FROM "${schema}"."agent_server_meta" WHERE key = 'schema_version'`))[0].value).toBe("5");
        const columns = (await sql(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name IN ('seq', 'comments', 'conversation_id')`,
          [schema]
        )).map((r) => `${r.table_name}.${r.column_name}`);
        expect(columns).toEqual(
          expect.arrayContaining([
            "agent_server_conversations.seq",
            "agent_server_messages.seq",
            "agent_server_tasks.seq",
            "agent_server_tasks.comments",
            "agent_server_tasks.conversation_id",
          ])
        );
        const tables = (await sql(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [schema])).map((r) => r.tablename);
        expect(tables).toEqual(expect.arrayContaining(["agent_server_events", "agent_server_event_streams", "agent_server_leases"]));
        const indexes = (await sql(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [schema])).map((r) => r.indexname);
        expect(indexes).toContain("idx_agent_server_taskres_task_uq");
        expect(indexes).toContain("idx_agent_server_msg_conv_t");
        // its own legacy indexes are replaced
        expect(indexes).not.toContain("idx_messages_conversation_id");
        expect(indexes).not.toContain("idx_task_results_task_id");

        // the second start does not migrate again
        const again = createPostgresProvider({ connectionString: url, schema });
        await again.connect();
        expect((await again.getTaskResult("task_old"))?.content).toBe("newer");
        await again.disconnect();
      });
    });

    it("upgrades the previous schema (version 2): adds the event log, the leases and the task link", async () => {
      const opened = await harness.open();
      const { url, schema } = opened.where as { url: string; schema: string };
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const conv = await opened.storage.createConversation({ agentId: "a", title: "kept" });
        const task = await opened.storage.createTask({ agentId: "a", input: "old task" });
        await opened.storage.disconnect();

        // take it back to what version 2 had
        await client.query(`
          DROP TABLE "${schema}"."agent_server_events"; DROP TABLE "${schema}"."agent_server_event_streams"; DROP TABLE "${schema}"."agent_server_leases";
          ALTER TABLE "${schema}"."agent_server_tasks" DROP COLUMN conversation_id;
          UPDATE "${schema}"."agent_server_meta" SET value = '2' WHERE key = 'schema_version';
        `);

        const upgraded = createPostgresProvider({ connectionString: url, schema });
        await upgraded.connect();
        expect((await upgraded.getConversation(conv.id))?.title).toBe("kept");
        expect((await upgraded.getTask(task.id))?.input).toBe("old task");
        expect((await upgraded.events!.append(conv.id, [{ type: "x" }]))[0]!.seq).toBe(1);
        expect(await upgraded.acquireLease!({ key: "k", owner: "o", ttlMs: 1000 })).toMatchObject({ acquired: true });
        expect((await upgraded.updateTask(task.id, { conversationId: conv.id })).conversationId).toBe(conv.id);
        await upgraded.disconnect();
        expect((await client.query(`SELECT value FROM "${schema}"."agent_server_meta" WHERE key = 'schema_version'`)).rows[0].value).toBe("5");
        // the provider that `open()` gave us is closed; the harness closes the schema
        opened.storage = createPostgresProvider({ connectionString: url, schema });
        await opened.storage.connect();
      } finally {
        await client.end();
        await opened.close();
      }
    });

    it("upgrades the previous schema (version 3): files learn their owner, agent and expiry", async () => {
      const opened = await harness.open();
      const { url, schema } = opened.where as { url: string; schema: string };
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const conv = await opened.storage.createConversation({ agentId: "a" });
        const old = await opened.storage.saveFile({ name: "old.txt", mimeType: "text/plain", content: Buffer.from("old"), conversationId: conv.id });
        await opened.storage.disconnect();

        // take it back to what version 3 had
        await client.query(`
          DROP INDEX "${schema}"."idx_agent_server_files_conv_t"; DROP INDEX "${schema}"."idx_agent_server_files_expires";
          ALTER TABLE "${schema}"."agent_server_files" DROP COLUMN user_id, DROP COLUMN agent_id, DROP COLUMN expires_at, DROP COLUMN seq;
          CREATE INDEX "idx_agent_server_files_conv" ON "${schema}"."agent_server_files" (conversation_id);
          UPDATE "${schema}"."agent_server_meta" SET value = '3' WHERE key = 'schema_version';
        `);

        const upgraded = createPostgresProvider({ connectionString: url, schema });
        await upgraded.connect();
        expect((await upgraded.getFile(old.id))).toMatchObject({ name: "old.txt", userId: undefined, expiresAt: undefined });
        const fresh = await upgraded.saveFile({
          name: "new.txt", mimeType: "text/plain", content: Buffer.from("new"), conversationId: conv.id, userId: "u1", agentId: "a", expiresAt: new Date(Date.now() - 1000),
        });
        expect((await upgraded.listFiles!({ conversationId: conv.id })).data.map((f) => f.id)).toEqual([old.id, fresh.id]);
        expect(await upgraded.purgeExpiredFiles!({ before: new Date() })).toBe(1);
        expect(await upgraded.getFile(fresh.id)).toBeNull();
        await upgraded.disconnect();
        const indexes = (await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'agent_server_files'`, [schema])).rows.map((r) => r.indexname);
        expect(indexes).toEqual(expect.arrayContaining(["idx_agent_server_files_conv_t", "idx_agent_server_files_expires"]));
        expect(indexes).not.toContain("idx_agent_server_files_conv");
        expect((await client.query(`SELECT value FROM "${schema}"."agent_server_meta" WHERE key = 'schema_version'`)).rows[0].value).toBe("5");
        opened.storage = createPostgresProvider({ connectionString: url, schema });
        await opened.storage.connect();
      } finally {
        await client.end();
        await opened.close();
      }
    });

    it("upgrades the previous schema (version 4): conversations learn their version and deadline", async () => {
      const opened = await harness.open();
      const { url, schema } = opened.where as { url: string; schema: string };
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const conv = await opened.storage.createConversation({ agentId: "a", title: "kept", state: { s: 1 } });
        const message = await opened.storage.createMessage({ conversationId: conv.id, role: "user", content: "old" });
        await opened.storage.disconnect();

        // take it back to what version 4 had
        await client.query(`
          DROP INDEX "${schema}"."idx_agent_server_conv_due";
          ALTER TABLE "${schema}"."agent_server_conversations" DROP COLUMN version, DROP COLUMN action_due_at;
          UPDATE "${schema}"."agent_server_meta" SET value = '4' WHERE key = 'schema_version';
        `);

        const upgraded = createPostgresProvider({ connectionString: url, schema });
        await upgraded.connect();
        const read = (await upgraded.getConversation(conv.id))!;
        expect(read).toMatchObject({ title: "kept", state: { s: 1 }, version: 0 });
        expect(read.actionDueAt).toBeUndefined();
        expect((await upgraded.getMessage(message.id))?.content).toBe("old");
        expect(await upgraded.updateConversationIf!(conv.id, 1, { title: "stale" })).toBeNull();
        const due = new Date(Date.now() - 1000);
        expect((await upgraded.updateConversationIf!(conv.id, 0, { actionDueAt: due }))!.version).toBe(1);
        expect((await upgraded.getConversations({ actionDueBefore: new Date() })).data.map((c) => c.id)).toContain(conv.id);
        await upgraded.disconnect();

        expect((await client.query(`SELECT value FROM "${schema}"."agent_server_meta" WHERE key = 'schema_version'`)).rows[0].value).toBe("5");
        const indexes = (await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'agent_server_conversations'`, [schema])).rows.map((r) => r.indexname);
        expect(indexes).toContain("idx_agent_server_conv_due");
        opened.storage = createPostgresProvider({ connectionString: url, schema });
        await opened.storage.connect();
      } finally {
        await client.end();
        await opened.close();
      }
    });

    it("leaves alone a legacy index name that belongs to another prefix's tables", async () => {
      await inSchema(async ({ schema, url, sql }) => {
        // two installations in one schema: only one of them could create the unprefixed index names
        await sql(create030(schema, "other_"));
        await sql(`
          CREATE TABLE "${schema}"."agent_server_conversations" (id VARCHAR(64) PRIMARY KEY, agent_id VARCHAR(255) NOT NULL, user_id VARCHAR(255), title VARCHAR(500),
            metadata JSONB DEFAULT '{}', state JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());`);
        const provider = createPostgresProvider({ connectionString: url, schema });
        await provider.connect();
        await provider.disconnect();
        const indexes = (await sql(`SELECT indexname, tablename FROM pg_indexes WHERE schemaname = $1`, [schema]));
        expect(indexes).toContainEqual({ indexname: "idx_conversations_agent_id", tablename: "other_conversations" });
        expect(indexes.some((i) => i.tablename === "agent_server_conversations" && i.indexname === "idx_agent_server_conv_agent_t")).toBe(true);
      });
    });
  });

  describe("migration", () => {
    it("is safe when several instances start at once", async () => {
      await inSchema(async ({ schema, url }) => {
        const providers = Array.from({ length: 5 }, () => createPostgresProvider({ connectionString: url, schema }));
        await Promise.all(providers.map((p) => p.connect()));
        const made = await Promise.all(providers.map((p) => p.createConversation({ agentId: "a" })));
        expect(new Set(made.map((c) => c.id)).size).toBe(5);
        await Promise.all(providers.map((p) => p.disconnect()));
      });
    });

    it("lets two table prefixes share a schema", async () => {
      await inSchema(async ({ schema, url }) => {
        const one = createPostgresProvider({ connectionString: url, schema, tablePrefix: "one_" });
        const two = createPostgresProvider({ connectionString: url, schema, tablePrefix: "two_" });
        await one.connect();
        await two.connect();
        const a = await one.createConversation({ agentId: "a" });
        expect(await two.getConversation(a.id)).toBeNull();
        await one.disconnect();
        await two.disconnect();
      });
    });

    it("does not migrate with autoMigrate: false", async () => {
      await inSchema(async ({ schema, url }) => {
        const provider = createPostgresProvider({ connectionString: url, schema, autoMigrate: false });
        await provider.connect();
        await expect(provider.createConversation({ agentId: "a" })).rejects.toThrow();
        await provider.disconnect();
      });
    });

    it("gives up cleanly when the database is unreachable", async () => {
      const provider = createPostgresProvider({ connectionString: "postgres://nobody:none@127.0.0.1:1/none" });
      await expect(provider.connect()).rejects.toThrow(/Failed to connect to PostgreSQL/);
      expect(provider.isConnected()).toBe(false);
    });
  });

  describe("text PostgreSQL cannot hold", () => {
    it("stores NUL characters as an escape and returns them unchanged", async () => {
      const opened = await harness.open();
      try {
        const { url, schema } = opened.where as { url: string; schema: string };
        const text = "a\u0000b \u0001 \u00010 \u0001\u0001 \u0000\u0000";
        const conv = await opened.storage.createConversation({ agentId: "a", title: text, state: { [text]: text, list: [text] } });
        const message = await opened.storage.createMessage({ conversationId: conv.id, role: "user", content: text });

        const { default: pg } = await import("pg");
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        try {
          const row = (await client.query(`SELECT title, state::text AS state FROM "${schema}"."agent_server_conversations" WHERE id = $1`, [conv.id])).rows[0];
          expect(row.title).not.toContain("\u0000");
          expect(row.state).not.toContain("\\u0000");
        } finally {
          await client.end();
        }

        const read = await opened.storage.getConversation(conv.id);
        expect(read?.title).toBe(text);
        expect(read?.state).toEqual({ [text]: text, list: [text] });
        expect((await opened.storage.getMessage(message.id))?.content).toBe(text);
      } finally {
        await opened.close();
      }
    });

    it("answers 400 for a value longer than its column, or with a NUL where the column cannot escape one", async () => {
      const opened = await harness.open();
      try {
        await expect(opened.storage.createConversation({ agentId: "a".repeat(256) })).rejects.toBeInstanceOf(ValidationError);
        await expect(opened.storage.createConversation({ agentId: "a", userId: "u\u0000" })).rejects.toMatchObject({ statusCode: 400 });
        await expect(opened.storage.createConversation({ agentId: "a", title: "é".repeat(501) })).rejects.toMatchObject({ statusCode: 400 });
        // 500 characters of a multi-byte letter is fine: the limit counts characters, not bytes or UTF-16 units
        await expect(opened.storage.createConversation({ agentId: "a", title: "😀".repeat(500) })).resolves.toBeDefined();
      } finally {
        await opened.close();
      }
    });
  });

  describe("limits", () => {
    it("reports bytea and jsonb sizes", () => {
      const caps = createPostgresProvider({ connectionString: "postgres://x" }).capabilities();
      expect(caps.maxFileBytes).toBe(1_000_000_000);
      expect(caps.maxStateBytes).toBe(250 * 1024 * 1024);
    });
  });
});
