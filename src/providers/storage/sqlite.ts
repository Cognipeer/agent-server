/**
 * SQLite Storage Provider
 *
 * File-based storage using SQLite via better-sqlite3.
 * Great for development, small deployments, and single-server setups.
 */

import { BaseStorageProvider, type EventQuery, type StoredEventInput } from "./base.js";
import { NotFoundError } from "../../types.js";
import { nextStopReason } from "../../events.js";
import { MAX_BUFFER_BYTES, pageResult, toBuffer } from "./shared.js";
import type {
  AcquireLeaseParams,
  AcquireLeaseResult,
  ConversationEvent,
  EventSummary,
  Lease,
  ReleaseLeaseParams,
  RenewLeaseParams,
  RequestContext,
  StorageCapabilities,
  Conversation,
  Message,
  FileRecord,
  Task,
  TaskResult,
  CreateConversationParams,
  GetConversationsParams,
  UpdateConversationParams,
  CreateMessageParams,
  GetMessagesParams,
  UpdateMessageParams,
  SaveFileParams,
  CreateTaskParams,
  GetTasksParams,
  UpdateTaskParams,
  CreateTaskResultParams,
  PaginatedResult,
} from "../../types.js";

// better-sqlite3 types - dynamic import to avoid requiring when not used
type Database = {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  pragma(pragma: string): unknown;
  transaction<T>(fn: () => T): () => T;
};

type Statement = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

/** Bumped when `migrate()` gains a step that must run once on existing databases. */
const SCHEMA_VERSION = 5;

export interface SQLiteConfig {
  /**
   * Path to the SQLite database file (e.g., "./data/agent-server.db")
   * Use ":memory:" for in-memory database
   */
  filename: string;

  /**
   * Table prefix (default: "agent_server_")
   */
  tablePrefix?: string;

  /**
   * Auto-create tables on connect (default: true)
   */
  autoMigrate?: boolean;

  /**
   * Enable WAL mode for better concurrent performance (default: true)
   */
  walMode?: boolean;

  /**
   * better-sqlite3 options
   */
  options?: {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: (message?: string) => void;
  };
}

export class SQLiteStorageProvider extends BaseStorageProvider {
  private db: Database | null = null;
  private config: SQLiteConfig;
  private tablePrefix: string;

  constructor(config: SQLiteConfig) {
    super();
    this.config = config;
    this.tablePrefix = config.tablePrefix || "agent_server_";
  }

  // ============================================================================
  // Table names
  // ============================================================================

  private get tables() {
    return {
      conversations: `${this.tablePrefix}conversations`,
      messages: `${this.tablePrefix}messages`,
      files: `${this.tablePrefix}files`,
      fileContents: `${this.tablePrefix}file_contents`,
      tasks: `${this.tablePrefix}tasks`,
      taskResults: `${this.tablePrefix}task_results`,
      events: `${this.tablePrefix}events`,
      eventStreams: `${this.tablePrefix}event_streams`,
      leases: `${this.tablePrefix}leases`,
      meta: `${this.tablePrefix}meta`,
    };
  }

  /** SQLite caps a BLOB / TEXT value at `SQLITE_MAX_LENGTH` (1 GB by default). */
  capabilities(): StorageCapabilities {
    return {
      ...super.capabilities(),
      maxFileBytes: Math.min(1_000_000_000, MAX_BUFFER_BYTES),
      maxStateBytes: 1_000_000_000,
      atomicUpdate: true,
      events: true,
      leases: true,
      fileIndex: true,
      actionDeadlines: true,
      pinnedFirst: true,
    };
  }

  /** Runs `fn` in one transaction (the driver is synchronous, so nothing interleaves). */
  private tx<T>(fn: () => T): T {
    if (!this.db) throw new Error("Database not initialized");
    return this.db.transaction(fn)();
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    if (this._connected) return;

    try {
      // Dynamic import of better-sqlite3
      const BetterSqlite3 = await import("better-sqlite3" as any);
      const SqliteDatabase = BetterSqlite3.default || BetterSqlite3;

      this.db = new SqliteDatabase(this.config.filename, this.config.options || {}) as Database;

      // Enable WAL mode for better performance (default: true)
      if (this.config.walMode !== false) {
        this.db!.pragma("journal_mode = WAL");
      }

      // Enable foreign keys
      this.db!.pragma("foreign_keys = ON");

      // Auto-migrate if enabled
      if (this.config.autoMigrate !== false) {
        this.migrate();
      }

      this._connected = true;
    } catch (error) {
      throw new Error(`Failed to connect to SQLite: ${(error as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this._connected = false;
  }

  private migrate(): void {
    if (!this.db) throw new Error("Database not initialized");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.conversations} (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT,
        title TEXT,
        metadata TEXT DEFAULT '{}',
        state TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        version INTEGER NOT NULL DEFAULT 0,
        action_due_at TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.messages} (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES ${this.tables.conversations}(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        name TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        files TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.files} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        conversation_id TEXT REFERENCES ${this.tables.conversations}(id) ON DELETE SET NULL,
        message_id TEXT REFERENCES ${this.tables.messages}(id) ON DELETE SET NULL,
        user_id TEXT,
        agent_id TEXT,
        expires_at TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.fileContents} (
        storage_key TEXT PRIMARY KEY,
        content BLOB NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.tasks} (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT,
        conversation_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        callback_url TEXT,
        input TEXT NOT NULL,
        files TEXT DEFAULT '[]',
        comments TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.taskResults} (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES ${this.tables.tasks}(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        files TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        usage TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.meta} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // The event log: one row per event, and one row per conversation that counts them (the next
    // sequence number and the stop reason of the last finished turn).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.events} (
        conversation_id TEXT NOT NULL REFERENCES ${this.tables.conversations}(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        run_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      ) WITHOUT ROWID
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.eventStreams} (
        conversation_id TEXT PRIMARY KEY REFERENCES ${this.tables.conversations}(id) ON DELETE CASCADE,
        last_seq INTEGER NOT NULL,
        stop_reason TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tables.leases} (
        key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        cancel_requested INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Create indexes. Rows are listed by time with the insertion order (rowid) breaking
    // ties, so the time indexes lead; the rowid is implicit in every index.
    const p = this.tablePrefix;
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}conv_agent_t ON ${this.tables.conversations}(agent_id, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}conv_user_t ON ${this.tables.conversations}(user_id, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}conv_created ON ${this.tables.conversations}(created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}conv_updated ON ${this.tables.conversations}(updated_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}msg_conv_t ON ${this.tables.messages}(conversation_id, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}files_conv ON ${this.tables.files}(conversation_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}files_msg ON ${this.tables.files}(message_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}tasks_agent_t ON ${this.tables.tasks}(agent_id, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}tasks_user_t ON ${this.tables.tasks}(user_id, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}tasks_status_t ON ${this.tables.tasks}(status, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}tasks_created ON ${this.tables.tasks}(created_at)`);

    // Event log lookups: pruning by age, expired-lease sweeps
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}events_created ON ${this.tables.events}(created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}leases_expires ON ${this.tables.leases}(expires_at)`);

    const version = Number(
      (this.db.prepare(`SELECT value FROM ${this.tables.meta} WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined)?.value ?? 1
    );
    if (version < SCHEMA_VERSION) {
      this.tx(() => {
        const db = this.db!;
        // Schema version 2: one result per task. Databases from before it may hold several.
        if (version < 2) {
          db.exec(
            `DELETE FROM ${this.tables.taskResults}
             WHERE rowid NOT IN (SELECT MAX(rowid) FROM ${this.tables.taskResults} GROUP BY task_id)`
          );
          // Single-column indexes the time-leading ones above replace
          for (const legacy of ["conv_agent", "conv_user", "msg_conv", "tasks_agent", "tasks_user", "tasks_status", "taskres_task"]) {
            db.exec(`DROP INDEX IF EXISTS idx_${p}${legacy}`);
          }
          db.exec(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_${p}taskres_task_uq ON ${this.tables.taskResults}(task_id)`
          );
        }
        // Schema version 3: tasks run in a conversation
        const columns = db.prepare(`PRAGMA table_info(${this.tables.tasks})`).all() as Array<{ name: string }>;
        if (!columns.some((c) => c.name === "conversation_id")) {
          db.exec(`ALTER TABLE ${this.tables.tasks} ADD COLUMN conversation_id TEXT`);
        }
        // Schema version 4: files know who uploaded them, for which agent, and when they expire
        const fileColumns = db.prepare(`PRAGMA table_info(${this.tables.files})`).all() as Array<{ name: string }>;
        for (const column of ["user_id", "agent_id", "expires_at"]) {
          if (!fileColumns.some((c) => c.name === column)) {
            db.exec(`ALTER TABLE ${this.tables.files} ADD COLUMN ${column} TEXT`);
          }
        }
        // Schema version 5: conversations carry a version (compare-and-set updates) and the moment their
        // earliest pending action lapses (the expiry sweep)
        const conversationColumns = db.prepare(`PRAGMA table_info(${this.tables.conversations})`).all() as Array<{ name: string }>;
        if (!conversationColumns.some((c) => c.name === "version")) {
          db.exec(`ALTER TABLE ${this.tables.conversations} ADD COLUMN version INTEGER NOT NULL DEFAULT 0`);
        }
        if (!conversationColumns.some((c) => c.name === "action_due_at")) {
          db.exec(`ALTER TABLE ${this.tables.conversations} ADD COLUMN action_due_at TEXT`);
        }
        db.prepare(
          `INSERT INTO ${this.tables.meta} (key, value) VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(String(SCHEMA_VERSION));
      });
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}tasks_conv ON ${this.tables.tasks}(conversation_id)`);
    // The expiry sweep only looks at conversations that wait on an action with a deadline
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${p}conv_due ON ${this.tables.conversations}(action_due_at) WHERE action_due_at IS NOT NULL`
    );
    // Files of a conversation by age, and the retention sweep (only files that expire are in the index)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${p}files_conv_t ON ${this.tables.files}(conversation_id, created_at)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${p}files_expires ON ${this.tables.files}(expires_at) WHERE expires_at IS NOT NULL`
    );
  }

  // ============================================================================
  // Conversations
  // ============================================================================

  protected async _createConversation(
    id: string,
    params: CreateConversationParams
  ): Promise<Conversation> {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO ${this.tables.conversations} (id, agent_id, user_id, title, metadata, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.agentId,
      params.userId || null,
      params.title || null,
      JSON.stringify(params.metadata || {}),
      JSON.stringify(params.state || {}),
      now,
      now
    );

    return {
      id,
      agentId: params.agentId,
      userId: params.userId,
      title: params.title,
      metadata: params.metadata || {},
      state: params.state || {},
      createdAt: new Date(now),
      updatedAt: new Date(now),
      version: 0,
    };
  }

  protected async _getConversation(id: string): Promise<Conversation | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.conversations} WHERE id = ?`
    ).get(id) as DbConversation | undefined;

    return row ? this.mapConversation(row) : null;
  }

  protected async _getConversations(
    params: GetConversationsParams
  ): Promise<PaginatedResult<Conversation>> {
    if (!this.db) throw new Error("Database not initialized");

    const normalized = this.normalizeParams(params, { limit: 20, offset: 0 });
    const orderBy = params.orderBy === "updatedAt" ? "updated_at" : "created_at";
    const order = params.order === "asc" ? "ASC" : "DESC";

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.agentId) {
      conditions.push("agent_id = ?");
      values.push(params.agentId);
    }
    if (params.userId) {
      conditions.push("user_id = ?");
      values.push(params.userId);
    }
    if (params.actionDueBefore) {
      conditions.push("action_due_at IS NOT NULL AND action_due_at <= ?");
      values.push(params.actionDueBefore.toISOString());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM ${this.tables.conversations} ${whereClause}`
    ).get(...values) as { count: number };
    const total = countRow.count;

    // Insertion order (rowid) breaks ties between rows created in the same millisecond
    // `pinnedFirst`: conversations with metadata.pinned === true lead, each group in the requested order
    const pinned = params.pinnedFirst ? "CASE WHEN json_extract(metadata, '$.pinned') = 1 THEN 0 ELSE 1 END, " : "";
    const ordering = params.actionDueBefore
      ? "action_due_at ASC, rowid ASC"
      : `${pinned}${orderBy} ${order}, rowid ${order}`;
    const rows = this.db.prepare(
      `SELECT * FROM ${this.tables.conversations} ${whereClause}
       ORDER BY ${ordering}
       LIMIT ? OFFSET ?`
    ).all(...values, normalized.limit, normalized.offset) as DbConversation[];

    return pageResult(rows.map((row) => this.mapConversation(row)), total, normalized.limit, normalized.offset);
  }

  protected async _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    if (!this.db) throw new Error("Database not initialized");

    const { updates, values } = this.conversationAssignments(params);
    values.push(id);

    const changed = this.db.prepare(
      `UPDATE ${this.tables.conversations} SET ${updates.join(", ")} WHERE id = ?`
    ).run(...values).changes;
    if (changed === 0) throw new NotFoundError("Conversation", id);

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.conversations} WHERE id = ?`
    ).get(id) as DbConversation | undefined;

    if (!row) {
      throw new NotFoundError("Conversation", id);
    }

    return this.mapConversation(row);
  }

  /** The `SET` clauses of a conversation update (every update bumps `version`). */
  private conversationAssignments(params: UpdateConversationParams): { updates: string[]; values: unknown[] } {
    const updates: string[] = ["updated_at = ?", "version = version + 1"];
    const values: unknown[] = [new Date().toISOString()];

    if (params.title !== undefined) {
      updates.push("title = ?");
      values.push(params.title);
    }
    if (params.metadata !== undefined) {
      updates.push("metadata = ?");
      values.push(JSON.stringify(params.metadata));
    }
    if (params.state !== undefined) {
      updates.push("state = ?");
      values.push(JSON.stringify(params.state));
    }
    if (params.actionDueAt !== undefined) {
      updates.push("action_due_at = ?");
      values.push(params.actionDueAt === null ? null : params.actionDueAt.toISOString());
    }
    return { updates, values };
  }

  protected async _updateConversationIf(
    id: string,
    ifVersion: number,
    params: UpdateConversationParams
  ): Promise<Conversation | null> {
    if (!this.db) throw new Error("Database not initialized");
    const { updates, values } = this.conversationAssignments(params);
    values.push(id, ifVersion);

    // One statement: the version test and the write cannot be separated
    const changed = this.db.prepare(
      `UPDATE ${this.tables.conversations} SET ${updates.join(", ")} WHERE id = ? AND version = ?`
    ).run(...values).changes;
    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.conversations} WHERE id = ?`
    ).get(id) as DbConversation | undefined;
    if (!row) throw new NotFoundError("Conversation", id);
    return changed === 0 ? null : this.mapConversation(row);
  }

  protected async _deleteConversation(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;
    // Its files go with it (the foreign key would only detach them); messages cascade.
    this.tx(() => {
      db.prepare(
        `DELETE FROM ${this.tables.fileContents}
         WHERE storage_key IN (SELECT storage_key FROM ${this.tables.files} WHERE conversation_id = ?)`
      ).run(id);
      db.prepare(`DELETE FROM ${this.tables.files} WHERE conversation_id = ?`).run(id);
      db.prepare(`DELETE FROM ${this.tables.conversations} WHERE id = ?`).run(id);
    });
  }

  // ============================================================================
  // Messages
  // ============================================================================

  protected async _createMessage(id: string, params: CreateMessageParams): Promise<Message> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;

    const now = new Date().toISOString();
    const content = JSON.stringify(params.content);

    this.tx(() => {
      // A new message is activity on the conversation; no row changed = no such conversation
      const touched = db.prepare(
        `UPDATE ${this.tables.conversations} SET updated_at = ? WHERE id = ?`
      ).run(now, params.conversationId).changes;
      if (touched === 0) throw new NotFoundError("Conversation", params.conversationId);

      db.prepare(
        `INSERT INTO ${this.tables.messages}
         (id, conversation_id, role, content, name, tool_calls, tool_call_id, files, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        params.conversationId,
        params.role,
        content,
        params.name || null,
        params.toolCalls ? JSON.stringify(params.toolCalls) : null,
        params.toolCallId || null,
        JSON.stringify(params.files || []),
        JSON.stringify(params.metadata || {}),
        now,
        now
      );
    });

    return {
      id,
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      name: params.name,
      toolCalls: params.toolCalls,
      toolCallId: params.toolCallId,
      files: params.files,
      metadata: params.metadata || {},
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  protected async _getMessages(
    conversationId: string,
    params?: GetMessagesParams
  ): Promise<PaginatedResult<Message>> {
    if (!this.db) throw new Error("Database not initialized");

    const normalized = this.normalizeParams(params || {}, { limit: 100, offset: 0 });
    const order = params?.order === "desc" ? "DESC" : "ASC";

    // Only messages older / newer than the cursor message, by (created_at, insertion order)
    let cursorClause = "";
    const cursorValues: unknown[] = [];
    const cursor = params?.before ?? params?.after;
    if (cursor) {
      const exists = this.db.prepare(
        `SELECT 1 AS ok FROM ${this.tables.messages} WHERE id = ? AND conversation_id = ?`
      ).get(cursor, conversationId);
      if (!exists) throw new NotFoundError("Message", cursor);
      cursorClause = `AND (created_at, rowid) ${params?.before ? "<" : ">"}
        (SELECT created_at, rowid FROM ${this.tables.messages} WHERE id = ?)`;
      cursorValues.push(cursor);
    }

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM ${this.tables.messages} WHERE conversation_id = ? ${cursorClause}`
    ).get(conversationId, ...cursorValues) as { count: number };
    const total = countRow.count;

    const rows = this.db.prepare(
      `SELECT * FROM ${this.tables.messages}
       WHERE conversation_id = ? ${cursorClause}
       ORDER BY created_at ${order}, rowid ${order}
       LIMIT ? OFFSET ?`
    ).all(conversationId, ...cursorValues, normalized.limit, normalized.offset) as DbMessage[];

    return pageResult(rows.map((row) => this.mapMessage(row)), total, normalized.limit, normalized.offset);
  }

  protected async _getMessage(id: string): Promise<Message | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.messages} WHERE id = ?`
    ).get(id) as DbMessage | undefined;

    return row ? this.mapMessage(row) : null;
  }

  protected async _updateMessage(id: string, params: UpdateMessageParams): Promise<Message> {
    if (!this.db) throw new Error("Database not initialized");
    const updates: string[] = ["updated_at = ?"];
    const values: unknown[] = [new Date().toISOString()];
    if (params.content !== undefined) {
      updates.push("content = ?");
      values.push(JSON.stringify(params.content));
    }
    if (params.metadata !== undefined) {
      updates.push("metadata = ?");
      values.push(JSON.stringify(params.metadata));
    }
    values.push(id);
    const changed = this.db.prepare(`UPDATE ${this.tables.messages} SET ${updates.join(", ")} WHERE id = ?`).run(...values).changes;
    if (changed === 0) throw new NotFoundError("Message", id);
    const row = this.db.prepare(`SELECT * FROM ${this.tables.messages} WHERE id = ?`).get(id) as DbMessage | undefined;
    if (!row) throw new NotFoundError("Message", id);
    return this.mapMessage(row);
  }

  protected async _deleteMessage(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    // Its files stay with the conversation (message_id is set to NULL)
    this.db.prepare(`DELETE FROM ${this.tables.messages} WHERE id = ?`).run(id);
  }

  // ============================================================================
  // Files
  // ============================================================================

  protected async _saveFile(
    id: string,
    params: SaveFileParams & { storageKey: string; size: number }
  ): Promise<FileRecord> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;

    const now = new Date().toISOString();

    // Content and record in one transaction: a refused record leaves no orphan blob
    this.tx(() => {
      if (params.conversationId) {
        const found = db.prepare(`SELECT 1 AS ok FROM ${this.tables.conversations} WHERE id = ?`).get(params.conversationId);
        if (!found) throw new NotFoundError("Conversation", params.conversationId);
      }

      db.prepare(
        `INSERT INTO ${this.tables.fileContents} (storage_key, content) VALUES (?, ?)`
      ).run(params.storageKey, params.content);

      db.prepare(
        `INSERT INTO ${this.tables.files}
         (id, name, mime_type, size, storage_key, conversation_id, message_id, user_id, agent_id, expires_at, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        params.name,
        params.mimeType,
        params.size,
        params.storageKey,
        params.conversationId || null,
        params.messageId || null,
        params.userId || null,
        params.agentId || null,
        params.expiresAt ? params.expiresAt.toISOString() : null,
        JSON.stringify(params.metadata || {}),
        now
      );
    });

    return {
      id,
      name: params.name,
      mimeType: params.mimeType,
      size: params.size,
      storageKey: params.storageKey,
      conversationId: params.conversationId,
      messageId: params.messageId,
      userId: params.userId,
      agentId: params.agentId,
      expiresAt: params.expiresAt,
      metadata: params.metadata || {},
      createdAt: new Date(now),
    };
  }

  protected async _getFile(id: string): Promise<FileRecord | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.files} WHERE id = ?`
    ).get(id) as DbFile | undefined;

    return row ? this.mapFile(row) : null;
  }

  protected async _getFileContent(id: string): Promise<Buffer | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT c.content AS content
       FROM ${this.tables.files} f
       JOIN ${this.tables.fileContents} c ON c.storage_key = f.storage_key
       WHERE f.id = ?`
    ).get(id) as { content: Buffer } | undefined;

    return row ? toBuffer(row.content) : null;
  }

  protected async _deleteFile(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;

    this.tx(() => {
      const fileRow = db.prepare(
        `SELECT storage_key FROM ${this.tables.files} WHERE id = ?`
      ).get(id) as { storage_key: string } | undefined;

      if (fileRow) {
        db.prepare(`DELETE FROM ${this.tables.fileContents} WHERE storage_key = ?`).run(fileRow.storage_key);
        db.prepare(`DELETE FROM ${this.tables.files} WHERE id = ?`).run(id);
      }
    });
  }

  protected async _listFiles(params: {
    conversationId: string;
    limit: number;
    offset: number;
    order: "asc" | "desc";
  }): Promise<PaginatedResult<FileRecord>> {
    if (!this.db) throw new Error("Database not initialized");
    const order = params.order === "desc" ? "DESC" : "ASC";

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM ${this.tables.files} WHERE conversation_id = ?`).get(params.conversationId) as {
        count: number;
      }
    ).count;
    // Insertion order (rowid) breaks ties between files saved in the same millisecond
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.tables.files} WHERE conversation_id = ?
         ORDER BY created_at ${order}, rowid ${order} LIMIT ? OFFSET ?`
      )
      .all(params.conversationId, params.limit, params.offset) as DbFile[];
    return pageResult(rows.map((row) => this.mapFile(row)), total, params.limit, params.offset);
  }

  protected async _purgeExpiredFiles(params: { before: Date; limit: number }): Promise<number> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;

    return this.tx(() => {
      const due = db
        .prepare(
          `SELECT id, storage_key FROM ${this.tables.files}
           WHERE expires_at IS NOT NULL AND expires_at <= ?
           ORDER BY expires_at, rowid LIMIT ?`
        )
        .all(params.before.toISOString(), params.limit) as Array<{ id: string; storage_key: string }>;
      for (const row of due) {
        db.prepare(`DELETE FROM ${this.tables.fileContents} WHERE storage_key = ?`).run(row.storage_key);
        db.prepare(`DELETE FROM ${this.tables.files} WHERE id = ?`).run(row.id);
      }
      return due.length;
    });
  }

  // ============================================================================
  // Tasks
  // ============================================================================

  protected async _createTask(
    id: string,
    params: CreateTaskParams
  ): Promise<Task> {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO ${this.tables.tasks}
       (id, agent_id, user_id, conversation_id, status, callback_url, input, files, comments, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.agentId,
      params.userId || null,
      params.conversationId || null,
      "pending",
      params.callbackUrl || null,
      params.input,
      JSON.stringify(params.files || []),
      JSON.stringify([]),
      JSON.stringify(params.metadata || {}),
      now,
      now
    );

    return {
      id,
      agentId: params.agentId,
      userId: params.userId,
      conversationId: params.conversationId,
      status: "pending",
      callbackUrl: params.callbackUrl,
      input: params.input,
      files: params.files,
      comments: [],
      metadata: params.metadata || {},
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  protected async _getTask(id: string): Promise<Task | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.tasks} WHERE id = ?`
    ).get(id) as DbTask | undefined;

    return row ? this.mapTask(row) : null;
  }

  protected async _getTasks(
    params: GetTasksParams
  ): Promise<PaginatedResult<Task>> {
    if (!this.db) throw new Error("Database not initialized");

    const normalized = this.normalizeParams(params, { limit: 20, offset: 0 });
    const orderBy = params.orderBy === "updatedAt" ? "updated_at" : "created_at";
    const order = params.order === "asc" ? "ASC" : "DESC";

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.agentId) {
      conditions.push("agent_id = ?");
      values.push(params.agentId);
    }
    if (params.userId) {
      conditions.push("user_id = ?");
      values.push(params.userId);
    }
    if (params.status) {
      conditions.push("status = ?");
      values.push(params.status);
    }
    if (params.conversationId) {
      conditions.push("conversation_id = ?");
      values.push(params.conversationId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM ${this.tables.tasks} ${whereClause}`
    ).get(...values) as { count: number };
    const total = countRow.count;

    const rows = this.db.prepare(
      `SELECT * FROM ${this.tables.tasks} ${whereClause}
       ORDER BY ${orderBy} ${order}, rowid ${order}
       LIMIT ? OFFSET ?`
    ).all(...values, normalized.limit, normalized.offset) as DbTask[];

    return pageResult(rows.map((row) => this.mapTask(row)), total, normalized.limit, normalized.offset);
  }

  protected async _updateTask(
    id: string,
    params: UpdateTaskParams
  ): Promise<Task> {
    if (!this.db) throw new Error("Database not initialized");

    const updates: string[] = ["updated_at = ?"];
    const values: unknown[] = [new Date().toISOString()];

    if (params.status !== undefined) {
      updates.push("status = ?");
      values.push(params.status);
    }
    if (params.conversationId !== undefined) {
      updates.push("conversation_id = ?");
      values.push(params.conversationId);
    }
    if (params.startedAt !== undefined) {
      updates.push("started_at = ?");
      values.push(params.startedAt.toISOString());
    }
    if (params.completedAt !== undefined) {
      updates.push("completed_at = ?");
      values.push(params.completedAt.toISOString());
    }
    if (params.error !== undefined) {
      updates.push("error = ?");
      values.push(params.error);
    }
    if (params.metadata !== undefined) {
      updates.push("metadata = ?");
      values.push(JSON.stringify(params.metadata));
    }
    if (params.comments !== undefined) {
      updates.push("comments = ?");
      values.push(JSON.stringify(params.comments));
    }

    values.push(id);

    const changed = this.db.prepare(
      `UPDATE ${this.tables.tasks} SET ${updates.join(", ")} WHERE id = ?`
    ).run(...values).changes;
    if (changed === 0) throw new NotFoundError("Task", id);

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.tasks} WHERE id = ?`
    ).get(id) as DbTask | undefined;

    if (!row) {
      throw new NotFoundError("Task", id);
    }

    return this.mapTask(row);
  }

  protected async _deleteTask(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    this.db.prepare(`DELETE FROM ${this.tables.tasks} WHERE id = ?`).run(id);
  }

  // ============================================================================
  // Task Results
  // ============================================================================

  protected async _createTaskResult(
    id: string,
    params: CreateTaskResultParams
  ): Promise<TaskResult> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;

    const now = new Date().toISOString();

    // One result per task: a second one replaces the first (and keeps its id)
    const row = this.tx(() => {
      const exists = db.prepare(`SELECT 1 AS ok FROM ${this.tables.tasks} WHERE id = ?`).get(params.taskId);
      if (!exists) throw new NotFoundError("Task", params.taskId);

      db.prepare(
        `INSERT INTO ${this.tables.taskResults}
         (id, task_id, content, files, metadata, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           content = excluded.content,
           files = excluded.files,
           metadata = excluded.metadata,
           usage = excluded.usage,
           created_at = excluded.created_at`
      ).run(
        id,
        params.taskId,
        params.content,
        JSON.stringify(params.files || []),
        JSON.stringify(params.metadata || {}),
        params.usage ? JSON.stringify(params.usage) : null,
        now
      );

      return db.prepare(
        `SELECT * FROM ${this.tables.taskResults} WHERE task_id = ?`
      ).get(params.taskId) as DbTaskResult;
    });

    return this.mapTaskResult(row);
  }

  protected async _getTaskResult(taskId: string): Promise<TaskResult | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.taskResults} WHERE task_id = ?`
    ).get(taskId) as DbTaskResult | undefined;

    return row ? this.mapTaskResult(row) : null;
  }

  // ============================================================================
  // Events
  // ============================================================================

  protected async _appendEvents(
    conversationId: string,
    events: StoredEventInput[]
  ): Promise<ConversationEvent[]> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;

    // One transaction (the driver is synchronous, so appends never interleave): the counter row
    // hands out the sequence numbers, so they ascend without gaps or repeats.
    return this.tx(() => {
      const exists = db.prepare(`SELECT 1 AS ok FROM ${this.tables.conversations} WHERE id = ?`).get(conversationId);
      if (!exists) throw new NotFoundError("Conversation", conversationId);

      const stream = db.prepare(
        `SELECT last_seq, stop_reason FROM ${this.tables.eventStreams} WHERE conversation_id = ?`
      ).get(conversationId) as { last_seq: number; stop_reason: string | null } | undefined;
      let seq = stream?.last_seq ?? 0;

      const insert = db.prepare(
        `INSERT INTO ${this.tables.events} (conversation_id, seq, type, data, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const stored: ConversationEvent[] = [];
      for (const event of events) {
        seq += 1;
        insert.run(conversationId, seq, event.type, JSON.stringify(event.data), event.runId ?? null, event.createdAt.toISOString());
        stored.push({
          conversationId,
          seq,
          type: event.type,
          data: event.data,
          runId: event.runId,
          createdAt: event.createdAt,
        });
      }
      const stopReason = nextStopReason(stream?.stop_reason, events) ?? null;
      db.prepare(
        `INSERT INTO ${this.tables.eventStreams} (conversation_id, last_seq, stop_reason, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           last_seq = excluded.last_seq, stop_reason = excluded.stop_reason, updated_at = excluded.updated_at`
      ).run(conversationId, seq, stopReason, events[events.length - 1]!.createdAt.toISOString());
      return stored;
    });
  }

  protected async _listEvents(conversationId: string, query: EventQuery): Promise<ConversationEvent[]> {
    if (!this.db) throw new Error("Database not initialized");

    const conditions = ["conversation_id = ?", "seq > ?"];
    const values: unknown[] = [conversationId, query.after];
    if (query.before !== undefined) {
      conditions.push("seq < ?");
      values.push(query.before);
    }
    if (query.types?.length) {
      conditions.push(`type IN (${query.types.map(() => "?").join(", ")})`);
      values.push(...query.types);
    }
    const rows = this.db.prepare(
      `SELECT * FROM ${this.tables.events} WHERE ${conditions.join(" AND ")}
       ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"} LIMIT ?`
    ).all(...values, query.limit) as DbEvent[];
    return rows.map((row) => this.mapEvent(row));
  }

  protected async _eventSummaries(conversationIds: string[]): Promise<Record<string, EventSummary>> {
    if (!this.db) throw new Error("Database not initialized");
    const out: Record<string, EventSummary> = {};
    // SQLite caps bound parameters; chunk the lookup
    for (let i = 0; i < conversationIds.length; i += 500) {
      const chunk = conversationIds.slice(i, i + 500);
      const rows = this.db.prepare(
        `SELECT conversation_id, last_seq, stop_reason FROM ${this.tables.eventStreams}
         WHERE conversation_id IN (${chunk.map(() => "?").join(", ")})`
      ).all(...chunk) as Array<{ conversation_id: string; last_seq: number; stop_reason: string | null }>;
      for (const row of rows) {
        out[row.conversation_id] = { lastSeq: row.last_seq, ...(row.stop_reason ? { stopReason: row.stop_reason } : {}) };
      }
    }
    return out;
  }

  protected async _pruneEvents(before: Date): Promise<number> {
    if (!this.db) throw new Error("Database not initialized");
    return this.db.prepare(`DELETE FROM ${this.tables.events} WHERE created_at < ?`).run(before.toISOString()).changes;
  }

  private mapEvent(row: DbEvent): ConversationEvent {
    return {
      conversationId: row.conversation_id,
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.data),
      runId: row.run_id || undefined,
      createdAt: new Date(row.created_at),
    };
  }

  // ============================================================================
  // Leases
  // ============================================================================

  private mapLease(row: DbLease): Lease {
    return {
      key: row.key,
      owner: row.owner,
      expiresAt: new Date(row.expires_at),
      data: JSON.parse(row.data),
      cancelRequested: row.cancel_requested === 1,
    };
  }

  protected async _acquireLease(
    params: AcquireLeaseParams & { now: Date; expiresAt: Date },
    _ctx?: RequestContext
  ): Promise<AcquireLeaseResult> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;
    const now = params.now.toISOString();

    return this.tx((): AcquireLeaseResult => {
      const row = db.prepare(`SELECT * FROM ${this.tables.leases} WHERE key = ?`).get(params.key) as DbLease | undefined;
      const live = !!row && row.expires_at > now;
      if (row && live && row.owner !== params.owner) {
        return { acquired: false, lease: this.mapLease(row) };
      }
      db.prepare(
        `INSERT INTO ${this.tables.leases} (key, owner, expires_at, data, cancel_requested)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(key) DO UPDATE SET
           owner = excluded.owner, expires_at = excluded.expires_at, data = excluded.data, cancel_requested = 0`
      ).run(params.key, params.owner, params.expiresAt.toISOString(), JSON.stringify(params.data ?? {}));
      const lease: Lease = {
        key: params.key,
        owner: params.owner,
        expiresAt: params.expiresAt,
        data: params.data ?? {},
        cancelRequested: false,
      };
      // An expired lease is the residue of a holder that died
      return row && !live
        ? { acquired: true, lease, takenOver: this.mapLease(row) }
        : { acquired: true, lease };
    });
  }

  protected async _renewLease(params: RenewLeaseParams & { now: Date; expiresAt: Date }): Promise<Lease | null> {
    if (!this.db) throw new Error("Database not initialized");
    const db = this.db;
    return this.tx(() => {
      const changed = db.prepare(
        `UPDATE ${this.tables.leases} SET expires_at = ? WHERE key = ? AND owner = ? AND expires_at > ?`
      ).run(params.expiresAt.toISOString(), params.key, params.owner, params.now.toISOString()).changes;
      if (changed === 0) return null;
      return this.mapLease(db.prepare(`SELECT * FROM ${this.tables.leases} WHERE key = ?`).get(params.key) as DbLease);
    });
  }

  protected async _releaseLease(params: ReleaseLeaseParams): Promise<boolean> {
    if (!this.db) throw new Error("Database not initialized");
    return (
      this.db.prepare(`DELETE FROM ${this.tables.leases} WHERE key = ? AND owner = ?`).run(params.key, params.owner)
        .changes > 0
    );
  }

  protected async _getLeases(keys: string[], now: Date): Promise<Lease[]> {
    if (!this.db) throw new Error("Database not initialized");
    const out: Lease[] = [];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const rows = this.db.prepare(
        `SELECT * FROM ${this.tables.leases} WHERE key IN (${chunk.map(() => "?").join(", ")}) AND expires_at > ?`
      ).all(...chunk, now.toISOString()) as DbLease[];
      out.push(...rows.map((row) => this.mapLease(row)));
    }
    return out;
  }

  protected async _markLeaseCancel(key: string, now: Date): Promise<boolean> {
    if (!this.db) throw new Error("Database not initialized");
    return (
      this.db.prepare(`UPDATE ${this.tables.leases} SET cancel_requested = 1 WHERE key = ? AND expires_at > ?`).run(
        key,
        now.toISOString()
      ).changes > 0
    );
  }

  protected async _listExpiredLeases(params: { prefix?: string; limit: number; now: Date }): Promise<Lease[]> {
    if (!this.db) throw new Error("Database not initialized");
    const conditions = ["expires_at <= ?"];
    const values: unknown[] = [params.now.toISOString()];
    if (params.prefix) {
      // substr compare: the prefix is data, not a LIKE pattern
      conditions.push("substr(key, 1, ?) = ?");
      values.push(params.prefix.length, params.prefix);
    }
    const rows = this.db.prepare(
      `SELECT * FROM ${this.tables.leases} WHERE ${conditions.join(" AND ")} ORDER BY expires_at, key LIMIT ?`
    ).all(...values, params.limit) as DbLease[];
    return rows.map((row) => this.mapLease(row));
  }

  // ============================================================================
  // Mappers
  // ============================================================================

  private mapConversation(row: DbConversation): Conversation {
    return {
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id || undefined,
      title: row.title || undefined,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      state: typeof row.state === "string" ? JSON.parse(row.state) : row.state,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      version: Number(row.version ?? 0),
      actionDueAt: row.action_due_at ? new Date(row.action_due_at) : undefined,
    };
  }

  private mapMessage(row: DbMessage): Message {
    let content: string | Message["content"];
    if (typeof row.content === "string") {
      try {
        content = JSON.parse(row.content);
      } catch {
        content = row.content;
      }
    } else {
      content = row.content as string | Message["content"];
    }

    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as Message["role"],
      content,
      name: row.name || undefined,
      toolCalls: row.tool_calls
        ? typeof row.tool_calls === "string"
          ? JSON.parse(row.tool_calls)
          : row.tool_calls
        : undefined,
      toolCallId: row.tool_call_id || undefined,
      files:
        typeof row.files === "string" ? JSON.parse(row.files) : row.files || undefined,
      metadata:
        typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapFile(row: DbFile): FileRecord {
    return {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      storageKey: row.storage_key,
      conversationId: row.conversation_id || undefined,
      messageId: row.message_id || undefined,
      userId: row.user_id || undefined,
      agentId: row.agent_id || undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      metadata:
        typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      createdAt: new Date(row.created_at),
    };
  }

  private mapTask(row: DbTask): Task {
    return {
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id || undefined,
      conversationId: row.conversation_id || undefined,
      status: row.status as Task["status"],
      callbackUrl: row.callback_url || undefined,
      input: row.input,
      files: typeof row.files === "string" ? JSON.parse(row.files) : row.files || undefined,
      comments: typeof row.comments === "string" ? JSON.parse(row.comments) : row.comments || undefined,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      error: row.error || undefined,
    };
  }

  private mapTaskResult(row: DbTaskResult): TaskResult {
    return {
      id: row.id,
      taskId: row.task_id,
      content: row.content,
      files: typeof row.files === "string" ? JSON.parse(row.files) : row.files || undefined,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      usage: row.usage ? (typeof row.usage === "string" ? JSON.parse(row.usage) : row.usage) : undefined,
      createdAt: new Date(row.created_at),
    };
  }
}

// ============================================================================
// Internal DB types
// ============================================================================

interface DbConversation {
  id: string;
  agent_id: string;
  user_id: string | null;
  title: string | null;
  metadata: string;
  state: string;
  created_at: string;
  updated_at: string;
  version: number | null;
  action_due_at: string | null;
}

interface DbMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  name: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  files: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface DbFile {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  storage_key: string;
  conversation_id: string | null;
  message_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  expires_at: string | null;
  metadata: string;
  created_at: string;
}

interface DbTask {
  id: string;
  agent_id: string;
  user_id: string | null;
  conversation_id: string | null;
  status: string;
  callback_url: string | null;
  input: string;
  files: string;
  comments: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

interface DbEvent {
  conversation_id: string;
  seq: number;
  type: string;
  data: string;
  run_id: string | null;
  created_at: string;
}

interface DbLease {
  key: string;
  owner: string;
  expires_at: string;
  data: string;
  cancel_requested: number;
}

interface DbTaskResult {
  id: string;
  task_id: string;
  content: string;
  files: string;
  metadata: string;
  usage: string | null;
  created_at: string;
}

// Export factory function
export function createSQLiteProvider(config: SQLiteConfig): SQLiteStorageProvider {
  return new SQLiteStorageProvider(config);
}
