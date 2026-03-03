/**
 * SQLite Storage Provider
 *
 * File-based storage using SQLite via better-sqlite3.
 * Great for development, small deployments, and single-server setups.
 */

import { BaseStorageProvider } from "./base.js";
import type {
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
};

type Statement = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

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
    };
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    if (this._connected) return;

    try {
      // Dynamic import of better-sqlite3
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        updated_at TEXT DEFAULT (datetime('now'))
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

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}conv_agent ON ${this.tables.conversations}(agent_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}conv_user ON ${this.tables.conversations}(user_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}msg_conv ON ${this.tables.messages}(conversation_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}files_conv ON ${this.tables.files}(conversation_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}tasks_agent ON ${this.tables.tasks}(agent_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}tasks_user ON ${this.tables.tasks}(user_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}tasks_status ON ${this.tables.tasks}(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}taskres_task ON ${this.tables.taskResults}(task_id)`);
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM ${this.tables.conversations} ${whereClause}`
    ).get(...values) as { count: number };
    const total = countRow.count;

    const rows = this.db.prepare(
      `SELECT * FROM ${this.tables.conversations} ${whereClause}
       ORDER BY ${orderBy} ${order}
       LIMIT ? OFFSET ?`
    ).all(...values, normalized.limit, normalized.offset) as DbConversation[];

    return {
      data: rows.map((row) => this.mapConversation(row)),
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + rows.length < total,
    };
  }

  protected async _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    if (!this.db) throw new Error("Database not initialized");

    const updates: string[] = ["updated_at = ?"];
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

    values.push(id);

    this.db.prepare(
      `UPDATE ${this.tables.conversations} SET ${updates.join(", ")} WHERE id = ?`
    ).run(...values);

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.conversations} WHERE id = ?`
    ).get(id) as DbConversation | undefined;

    if (!row) {
      throw new Error(`Conversation not found: ${id}`);
    }

    return this.mapConversation(row);
  }

  protected async _deleteConversation(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    this.db.prepare(`DELETE FROM ${this.tables.conversations} WHERE id = ?`).run(id);
  }

  // ============================================================================
  // Messages
  // ============================================================================

  protected async _createMessage(id: string, params: CreateMessageParams): Promise<Message> {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date().toISOString();
    const content = JSON.stringify(params.content);

    this.db.prepare(
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

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM ${this.tables.messages} WHERE conversation_id = ?`
    ).get(conversationId) as { count: number };
    const total = countRow.count;

    const rows = this.db.prepare(
      `SELECT * FROM ${this.tables.messages}
       WHERE conversation_id = ?
       ORDER BY created_at ${order}
       LIMIT ? OFFSET ?`
    ).all(conversationId, normalized.limit, normalized.offset) as DbMessage[];

    return {
      data: rows.map((row) => this.mapMessage(row)),
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + rows.length < total,
    };
  }

  protected async _getMessage(id: string): Promise<Message | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.messages} WHERE id = ?`
    ).get(id) as DbMessage | undefined;

    return row ? this.mapMessage(row) : null;
  }

  protected async _deleteMessage(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
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

    const now = new Date().toISOString();

    // Save file content
    this.db.prepare(
      `INSERT INTO ${this.tables.fileContents} (storage_key, content) VALUES (?, ?)`
    ).run(params.storageKey, params.content);

    // Save file metadata
    this.db.prepare(
      `INSERT INTO ${this.tables.files}
       (id, name, mime_type, size, storage_key, conversation_id, message_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.name,
      params.mimeType,
      params.size,
      params.storageKey,
      params.conversationId || null,
      params.messageId || null,
      JSON.stringify(params.metadata || {}),
      now
    );

    return {
      id,
      name: params.name,
      mimeType: params.mimeType,
      size: params.size,
      storageKey: params.storageKey,
      conversationId: params.conversationId,
      messageId: params.messageId,
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

    const fileRow = this.db.prepare(
      `SELECT storage_key FROM ${this.tables.files} WHERE id = ?`
    ).get(id) as { storage_key: string } | undefined;

    if (!fileRow) return null;

    const contentRow = this.db.prepare(
      `SELECT content FROM ${this.tables.fileContents} WHERE storage_key = ?`
    ).get(fileRow.storage_key) as { content: Buffer } | undefined;

    return contentRow?.content || null;
  }

  protected async _deleteFile(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    const fileRow = this.db.prepare(
      `SELECT storage_key FROM ${this.tables.files} WHERE id = ?`
    ).get(id) as { storage_key: string } | undefined;

    if (fileRow) {
      this.db.prepare(
        `DELETE FROM ${this.tables.fileContents} WHERE storage_key = ?`
      ).run(fileRow.storage_key);
      this.db.prepare(
        `DELETE FROM ${this.tables.files} WHERE id = ?`
      ).run(id);
    }
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
       (id, agent_id, user_id, status, callback_url, input, files, comments, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.agentId,
      params.userId || null,
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM ${this.tables.tasks} ${whereClause}`
    ).get(...values) as { count: number };
    const total = countRow.count;

    const rows = this.db.prepare(
      `SELECT * FROM ${this.tables.tasks} ${whereClause}
       ORDER BY ${orderBy} ${order}
       LIMIT ? OFFSET ?`
    ).all(...values, normalized.limit, normalized.offset) as DbTask[];

    return {
      data: rows.map((row) => this.mapTask(row)),
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + rows.length < total,
    };
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

    this.db.prepare(
      `UPDATE ${this.tables.tasks} SET ${updates.join(", ")} WHERE id = ?`
    ).run(...values);

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.tasks} WHERE id = ?`
    ).get(id) as DbTask | undefined;

    if (!row) {
      throw new Error(`Task not found: ${id}`);
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

    const now = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO ${this.tables.taskResults}
       (id, task_id, content, files, metadata, usage, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.taskId,
      params.content,
      JSON.stringify(params.files || []),
      JSON.stringify(params.metadata || {}),
      params.usage ? JSON.stringify(params.usage) : null,
      now
    );

    return {
      id,
      taskId: params.taskId,
      content: params.content,
      files: params.files,
      metadata: params.metadata || {},
      usage: params.usage,
      createdAt: new Date(now),
    };
  }

  protected async _getTaskResult(taskId: string): Promise<TaskResult | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT * FROM ${this.tables.taskResults} WHERE task_id = ?`
    ).get(taskId) as DbTaskResult | undefined;

    return row ? this.mapTaskResult(row) : null;
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
  metadata: string;
  created_at: string;
}

interface DbTask {
  id: string;
  agent_id: string;
  user_id: string | null;
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
