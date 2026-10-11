/**
 * PostgreSQL Storage Provider
 */

import { BaseStorageProvider, type EventQuery, type StoredEventInput } from "./base.js";
import { NotFoundError, ValidationError } from "../../types.js";
import { nextStopReason } from "../../events.js";
import { MAX_BUFFER_BYTES, pageResult } from "./shared.js";
import type {
  AcquireLeaseParams,
  AcquireLeaseResult,
  ConversationEvent,
  EventSummary,
  Lease,
  ReleaseLeaseParams,
  RenewLeaseParams,
  RequestContext,
  Conversation,
  Message,
  FileRecord,
  Task,
  TaskResult,
  StorageCapabilities,
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

// pg types - we import dynamically to avoid requiring pg when not used
type QueryResult<T> = { rows: T[]; rowCount: number | null };

type Pool = {
  connect(): Promise<PoolClient>;
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type PoolClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(destroy?: boolean): void;
};

/** Bumped when `migrate()` gains a step that must run once on existing databases. */
const SCHEMA_VERSION = 5;

/** `bytea` holds 1 GB; `jsonb` a little over 255 MiB. */
const MAX_FILE_BYTES = 1_000_000_000;
const MAX_STATE_BYTES = 250 * 1024 * 1024;

/** `VARCHAR(n)` limits of the tables, checked up front so an over-long value is a 400, not a 500. */
const LIMITS = {
  agentId: 255,
  userId: 255,
  title: 500,
  role: 50,
  name: 255,
  toolCallId: 255,
  fileName: 500,
  mimeType: 255,
  callbackUrl: 2000,
  taskStatus: 50,
  conversationId: 64,
  eventType: 64,
  runId: 64,
  leaseKey: 128,
  leaseOwner: 128,
} as const;

export interface PostgresConfig {
  /**
   * Connection string (e.g., "postgresql://user:pass@host:port/db")
   */
  connectionString?: string;

  /**
   * Or individual connection params
   */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;

  /**
   * Schema name (default: "public")
   */
  schema?: string;

  /**
   * Table prefix (default: "agent_server_")
   */
  tablePrefix?: string;

  /**
   * Auto-create tables on connect (default: true)
   */
  autoMigrate?: boolean;

  /**
   * Pool configuration
   */
  pool?: {
    min?: number;
    max?: number;
    idleTimeoutMillis?: number;
  };
}

// ----------------------------------------------------------------------------
// NUL characters. PostgreSQL refuses U+0000 in text and in jsonb, but a tool
// result or a model answer can contain one. Strings are stored with U+0001 as
// an escape character (U+0001 -> U+0001 U+0001, U+0000 -> U+0001 "0") and
// decoded on the way out, so every value reads back exactly as it was written.
// ----------------------------------------------------------------------------

const ESC = "\u0001";
const NUL = "\u0000";

const encodeText = (value: string): string =>
  value.includes(NUL) || value.includes(ESC)
    ? value.replaceAll(ESC, ESC + ESC).replaceAll(NUL, ESC + "0")
    : value;

function decodeText(value: string): string {
  if (!value.includes(ESC)) return value;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const next = value[i + 1];
    if (value[i] === ESC && (next === ESC || next === "0")) {
      out += next === ESC ? ESC : NUL;
      i++;
    } else {
      out += value[i];
    }
  }
  return out;
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[fn(key)] = mapStrings(item, fn);
    return out;
  }
  return value;
}

/** A value as the JSON text of a jsonb parameter (NUL-safe). `undefined` is `null`. */
function toJsonb(value: unknown): string {
  const text = JSON.stringify(value === undefined ? null : value);
  // The escaped forms of U+0000 / U+0001 are all that can need the slow path
  return /\\u000[01]/.test(text) ? JSON.stringify(mapStrings(JSON.parse(text), encodeText)) : text;
}

/** jsonb text from the server as a value (NUL-safe); used as the pg type parser. */
function fromJsonb(text: string): unknown {
  const value = JSON.parse(text);
  return text.includes("\\u0001") ? mapStrings(value, decodeText) : value;
}

/** `value` if it fits a `VARCHAR(max)` column (counted in characters, like PostgreSQL), else a 400. */
function fits(field: string, value: string | undefined | null, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (value.includes(NUL)) throw new ValidationError(`${field} must not contain a NUL character`);
  if (Array.from(value).length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return value;
}

/** Same, for a column whose text is NUL-escaped: the stored (escaped) form is what must fit. */
function fitsEncoded(field: string, value: string | undefined | null, max: number): string | null {
  if (value === undefined || value === null) return null;
  const encoded = encodeText(value);
  if (Array.from(encoded).length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return encoded;
}

export class PostgresStorageProvider extends BaseStorageProvider {
  private pool: Pool | null = null;
  private config: PostgresConfig;
  private schema: string;
  private tablePrefix: string;

  constructor(config: PostgresConfig) {
    super();
    this.config = config;
    this.schema = config.schema || "public";
    this.tablePrefix = config.tablePrefix || "agent_server_";
  }

  capabilities(): StorageCapabilities {
    return {
      ...super.capabilities(),
      maxFileBytes: Math.min(MAX_FILE_BYTES, MAX_BUFFER_BYTES),
      maxStateBytes: MAX_STATE_BYTES,
      atomicUpdate: true,
      events: true,
      leases: true,
      fileIndex: true,
      actionDeadlines: true,
    };
  }

  // ============================================================================
  // Table names
  // ============================================================================

  private get tables() {
    return {
      conversations: `"${this.schema}"."${this.tablePrefix}conversations"`,
      messages: `"${this.schema}"."${this.tablePrefix}messages"`,
      files: `"${this.schema}"."${this.tablePrefix}files"`,
      fileContents: `"${this.schema}"."${this.tablePrefix}file_contents"`,
      tasks: `"${this.schema}"."${this.tablePrefix}tasks"`,
      taskResults: `"${this.schema}"."${this.tablePrefix}task_results"`,
      events: `"${this.schema}"."${this.tablePrefix}events"`,
      eventStreams: `"${this.schema}"."${this.tablePrefix}event_streams"`,
      leases: `"${this.schema}"."${this.tablePrefix}leases"`,
      meta: `"${this.schema}"."${this.tablePrefix}meta"`,
    };
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    if (this._connected) return;

    try {
      // Dynamic import of pg
      const pg = (await import("pg" as any)) as any;
      const Pool = pg.default?.Pool || pg.Pool;
      const pgTypes = pg.default?.types || pg.types;

      const poolConfig = this.config.connectionString
        ? { connectionString: this.config.connectionString }
        : {
            host: this.config.host,
            port: this.config.port,
            database: this.config.database,
            user: this.config.user,
            password: this.config.password,
          };

      this.pool = new Pool({
        ...poolConfig,
        min: this.config.pool?.min ?? 2,
        max: this.config.pool?.max ?? 10,
        idleTimeoutMillis: this.config.pool?.idleTimeoutMillis ?? 30000,
        // jsonb is read through fromJsonb (NUL-safe); every other type keeps pg's parser
        types: {
          getTypeParser: (oid: number, format?: string) =>
            oid === 3802 || oid === 114 ? fromJsonb : pgTypes.getTypeParser(oid, format),
        },
      }) as Pool;
      // An idle client dropped by the server must not crash the process
      this.pool!.on("error", (error) => {
        console.error("[agent-server] PostgreSQL pool error:", error.message);
      });

      // Test connection
      const client = await (this.pool as Pool).connect();
      client.release();

      // Auto-migrate if enabled
      if (this.config.autoMigrate !== false) {
        await this.migrate();
      }

      this._connected = true;
    } catch (error) {
      await this.pool?.end().catch(() => undefined);
      this.pool = null;
      throw new Error(`Failed to connect to PostgreSQL: ${(error as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this._connected = false;
  }

  /** Runs `fn` in one transaction on its own connection. */
  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error("Pool not initialized");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async migrate(): Promise<void> {
    if (!this.pool) throw new Error("Pool not initialized");

    // One instance migrates at a time: a fleet booting together must not race on the DDL
    const client = await this.pool.connect();
    const lockKey = hash32(`${this.schema}.${this.tablePrefix}`);
    try {
      await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
      try {
        await this.migrateLocked(client);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      }
    } finally {
      client.release();
    }
  }

  private async migrateLocked(db: PoolClient): Promise<void> {
    // Create schema if not exists
    await db.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);

    // Create conversations table
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.conversations} (
        id VARCHAR(64) PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255),
        title VARCHAR(500),
        metadata JSONB DEFAULT '{}',
        state JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        version INTEGER NOT NULL DEFAULT 0,
        action_due_at TIMESTAMPTZ
      )
    `);

    // Create messages table
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.messages} (
        id VARCHAR(64) PRIMARY KEY,
        conversation_id VARCHAR(64) NOT NULL REFERENCES ${this.tables.conversations}(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL,
        content JSONB NOT NULL,
        name VARCHAR(255),
        tool_calls JSONB,
        tool_call_id VARCHAR(255),
        files JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create files table
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.files} (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(500) NOT NULL,
        mime_type VARCHAR(255) NOT NULL,
        size INTEGER NOT NULL,
        storage_key VARCHAR(255) NOT NULL,
        conversation_id VARCHAR(64) REFERENCES ${this.tables.conversations}(id) ON DELETE SET NULL,
        message_id VARCHAR(64) REFERENCES ${this.tables.messages}(id) ON DELETE SET NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create file contents table (for storing actual file data in DB)
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.fileContents} (
        storage_key VARCHAR(255) PRIMARY KEY,
        content BYTEA NOT NULL
      )
    `);

    // Create tasks table
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.tasks} (
        id VARCHAR(64) PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255),
        conversation_id VARCHAR(64),
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        callback_url VARCHAR(2000),
        input TEXT NOT NULL,
        files JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error TEXT
      )
    `);

    // Create task results table
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.taskResults} (
        id VARCHAR(64) PRIMARY KEY,
        task_id VARCHAR(64) NOT NULL REFERENCES ${this.tables.tasks}(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        files JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        usage JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.meta} (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const versionRow = await db.query<{ value: string }>(
      `SELECT value FROM ${this.tables.meta} WHERE key = 'schema_version'`
    );
    const version = Number(versionRow.rows[0]?.value ?? 1);
    if (version >= SCHEMA_VERSION) return;

    // Schema version 2 (also what a fresh database gets after the tables above):
    // task comments, an insertion sequence for ordering, one result per task, and the
    // indexes of the time-ordered lists. Version 3: the event log, leases, and the
    // conversation a task runs in. Version 4: who uploaded a file, for which agent and when it
    // expires. Version 5: the conversation version and action deadline. Every step is additive and repeatable.
    await db.query("BEGIN");
    try {
      const t = this.tables;
      if (version < 2) await this.migrateToV2(db);

      await db.query(`ALTER TABLE ${t.tasks} ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(64)`);
      await db.query(`CREATE INDEX IF NOT EXISTS "idx_${this.tablePrefix}tasks_conv" ON ${t.tasks} (conversation_id)`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${t.events} (
          conversation_id VARCHAR(64) NOT NULL REFERENCES ${t.conversations}(id) ON DELETE CASCADE,
          seq BIGINT NOT NULL,
          type VARCHAR(64) NOT NULL,
          data JSONB NOT NULL DEFAULT '{}',
          run_id VARCHAR(64),
          created_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (conversation_id, seq)
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS "idx_${this.tablePrefix}events_created" ON ${t.events} (created_at)`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${t.eventStreams} (
          conversation_id VARCHAR(64) PRIMARY KEY REFERENCES ${t.conversations}(id) ON DELETE CASCADE,
          last_seq BIGINT NOT NULL,
          stop_reason VARCHAR(64),
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${t.leases} (
          key VARCHAR(128) PRIMARY KEY,
          owner VARCHAR(128) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          data JSONB NOT NULL DEFAULT '{}',
          cancel_requested BOOLEAN NOT NULL DEFAULT FALSE
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS "idx_${this.tablePrefix}leases_expires" ON ${t.leases} (expires_at)`);

      // Version 4
      await db.query(`ALTER TABLE ${t.files} ADD COLUMN IF NOT EXISTS user_id VARCHAR(255)`);
      await db.query(`ALTER TABLE ${t.files} ADD COLUMN IF NOT EXISTS agent_id VARCHAR(255)`);
      await db.query(`ALTER TABLE ${t.files} ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
      // Rows saved in the same millisecond keep their insertion order, like conversations and messages
      await db.query(`ALTER TABLE ${t.files} ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY`);
      await db.query(
        `CREATE INDEX IF NOT EXISTS "idx_${this.tablePrefix}files_conv_t" ON ${t.files} (conversation_id, created_at, seq)`
      );
      // (the single-column index of version 2 is a prefix of it)
      await db.query(`DROP INDEX IF EXISTS "${this.schema}"."idx_${this.tablePrefix}files_conv"`);
      // The retention sweep only looks at files that expire
      await db.query(
        `CREATE INDEX IF NOT EXISTS "idx_${this.tablePrefix}files_expires" ON ${t.files} (expires_at) WHERE expires_at IS NOT NULL`
      );

      // Version 5: conversations carry a version (compare-and-set updates) and the moment their earliest pending
      // action lapses (the expiry sweep, which only looks at conversations that have one)
      await db.query(`ALTER TABLE ${t.conversations} ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0`);
      await db.query(`ALTER TABLE ${t.conversations} ADD COLUMN IF NOT EXISTS action_due_at TIMESTAMPTZ`);
      await db.query(
        `CREATE INDEX IF NOT EXISTS "idx_${this.tablePrefix}conv_due" ON ${t.conversations} (action_due_at) WHERE action_due_at IS NOT NULL`
      );

      await db.query(
        `INSERT INTO ${t.meta} (key, value) VALUES ('schema_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(SCHEMA_VERSION)]
      );
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  /** Schema version 2 (runs inside the migration transaction). */
  private async migrateToV2(db: PoolClient): Promise<void> {
    const t = this.tables;
    await db.query(`ALTER TABLE ${t.tasks} ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]'`);
    for (const table of [t.conversations, t.messages, t.tasks]) {
      // Rows created in the same millisecond keep their insertion order
      await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY`);
    }

    // Databases from before this version may hold several results for one task: keep the newest
    await db.query(
      `DELETE FROM ${t.taskResults} a USING ${t.taskResults} b
       WHERE a.task_id = b.task_id AND (a.created_at, a.id) < (b.created_at, b.id)`
    );

    const p = this.tablePrefix;
    const indexes: Array<[string, string, string]> = [
      ["conv_agent_t", t.conversations, "agent_id, created_at, seq"],
      ["conv_user_t", t.conversations, "user_id, created_at, seq"],
      ["conv_created", t.conversations, "created_at, seq"],
      ["conv_updated", t.conversations, "updated_at, seq"],
      ["msg_conv_t", t.messages, "conversation_id, created_at, seq"],
      ["files_msg", t.files, "message_id"],
      ["tasks_agent_t", t.tasks, "agent_id, created_at, seq"],
      ["tasks_user_t", t.tasks, "user_id, created_at, seq"],
      ["tasks_status_t", t.tasks, "status, created_at, seq"],
      ["tasks_created", t.tasks, "created_at, seq"],
    ];
    for (const [name, table, columns] of indexes) {
      await db.query(`CREATE INDEX IF NOT EXISTS "idx_${p}${name}" ON ${table} (${columns})`);
    }
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_${p}taskres_task_uq" ON ${t.taskResults} (task_id)`
    );

    // Index names are schema-wide in PostgreSQL, so the old unprefixed ones could belong to another
    // prefix's tables. Drop a legacy index only when it is on one of ours.
    const legacy: Array<[string, string]> = [
      [t.conversations, "idx_conversations_agent_id"],
      [t.conversations, "idx_conversations_user_id"],
      [t.messages, "idx_messages_conversation_id"],
      [t.files, "idx_files_conversation_id"],
      [t.tasks, "idx_tasks_agent_id"],
      [t.tasks, "idx_tasks_user_id"],
      [t.tasks, "idx_tasks_status"],
      [t.taskResults, "idx_task_results_task_id"],
    ];
    for (const [table, name] of legacy) {
      const bare = table.split(".")[1]!.replaceAll('"', "");
      const owned = await db.query(
        "SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3",
        [this.schema, bare, name]
      );
      if (owned.rows.length > 0) await db.query(`DROP INDEX IF EXISTS "${this.schema}"."${name}"`);
    }
  }

  // ============================================================================
  // Conversations
  // ============================================================================

  protected async _createConversation(
    id: string,
    params: CreateConversationParams
  ): Promise<Conversation> {
    if (!this.pool) throw new Error("Pool not initialized");

    const now = new Date();
    const result = await this.pool.query<DbConversation>(
      `INSERT INTO ${this.tables.conversations}
       (id, agent_id, user_id, title, metadata, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [
        id,
        fits("agentId", params.agentId, LIMITS.agentId),
        fits("userId", params.userId || null, LIMITS.userId),
        fitsEncoded("title", params.title || null, LIMITS.title),
        toJsonb(params.metadata || {}),
        toJsonb(params.state || {}),
        now,
      ]
    );

    return this.mapConversation(result.rows[0]);
  }

  protected async _getConversation(id: string): Promise<Conversation | null> {
    if (!this.pool) throw new Error("Pool not initialized");

    const result = await this.pool.query<DbConversation>(
      `SELECT * FROM ${this.tables.conversations} WHERE id = $1`,
      [id]
    );

    return result.rows[0] ? this.mapConversation(result.rows[0]) : null;
  }

  protected async _getConversations(
    params: GetConversationsParams
  ): Promise<PaginatedResult<Conversation>> {
    if (!this.pool) throw new Error("Pool not initialized");

    const normalized = this.normalizeParams(params, { limit: 20, offset: 0 });
    const orderBy = params.orderBy === "updatedAt" ? "updated_at" : "created_at";
    const order = params.order === "asc" ? "ASC" : "DESC";

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params.agentId) {
      conditions.push(`agent_id = $${paramIndex++}`);
      values.push(params.agentId);
    }
    if (params.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      values.push(params.userId);
    }
    if (params.actionDueBefore) {
      conditions.push(`action_due_at IS NOT NULL AND action_due_at <= $${paramIndex++}`);
      values.push(params.actionDueBefore);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${this.tables.conversations} ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get paginated results; the insertion sequence breaks ties between rows created in one millisecond
    const ordering = params.actionDueBefore ? "action_due_at ASC, seq ASC" : `${orderBy} ${order}, seq ${order}`;
    const result = await this.pool.query<DbConversation>(
      `SELECT * FROM ${this.tables.conversations}
       ${whereClause}
       ORDER BY ${ordering}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...values, normalized.limit, normalized.offset]
    );

    return pageResult(
      result.rows.map((row) => this.mapConversation(row)),
      total,
      normalized.limit,
      normalized.offset
    );
  }

  protected async _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    if (!this.pool) throw new Error("Pool not initialized");

    const { updates, values, next } = this.conversationAssignments(params);
    values.push(id);

    const result = await this.pool.query<DbConversation>(
      `UPDATE ${this.tables.conversations}
       SET ${updates.join(", ")}
       WHERE id = $${next}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new NotFoundError("Conversation", id);
    }

    return this.mapConversation(result.rows[0]);
  }

  /** The `SET` clauses of a conversation update (every update bumps `version`); `next` is the next free parameter number. */
  private conversationAssignments(params: UpdateConversationParams): { updates: string[]; values: unknown[]; next: number } {
    // The app clock stamps every time, so created_at / updated_at / message times agree
    const updates: string[] = ["updated_at = $1", "version = version + 1"];
    const values: unknown[] = [new Date()];
    let paramIndex = 2;

    if (params.title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(fitsEncoded("title", params.title, LIMITS.title));
    }
    if (params.metadata !== undefined) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(toJsonb(params.metadata));
    }
    if (params.state !== undefined) {
      updates.push(`state = $${paramIndex++}`);
      values.push(toJsonb(params.state));
    }
    if (params.actionDueAt !== undefined) {
      updates.push(`action_due_at = $${paramIndex++}`);
      values.push(params.actionDueAt);
    }
    return { updates, values, next: paramIndex };
  }

  protected async _updateConversationIf(
    id: string,
    ifVersion: number,
    params: UpdateConversationParams
  ): Promise<Conversation | null> {
    if (!this.pool) throw new Error("Pool not initialized");
    const { updates, values, next } = this.conversationAssignments(params);
    values.push(id, ifVersion);

    // One statement: the version test and the write cannot be separated (a concurrent writer waits on the row lock, then re-tests)
    const result = await this.pool.query<DbConversation>(
      `UPDATE ${this.tables.conversations}
       SET ${updates.join(", ")}
       WHERE id = $${next} AND version = $${next + 1}
       RETURNING *`,
      values
    );
    if (result.rows[0]) return this.mapConversation(result.rows[0]);
    const exists = await this.pool.query(`SELECT 1 FROM ${this.tables.conversations} WHERE id = $1`, [id]);
    if (exists.rows.length === 0) throw new NotFoundError("Conversation", id);
    return null;
  }

  protected async _deleteConversation(id: string): Promise<void> {
    // Its files go with it (the foreign key would only detach them); messages cascade.
    await this.withTransaction(async (db) => {
      await db.query(
        `DELETE FROM ${this.tables.fileContents}
         WHERE storage_key IN (SELECT storage_key FROM ${this.tables.files} WHERE conversation_id = $1)`,
        [id]
      );
      await db.query(`DELETE FROM ${this.tables.files} WHERE conversation_id = $1`, [id]);
      await db.query(`DELETE FROM ${this.tables.conversations} WHERE id = $1`, [id]);
    });
  }

  // ============================================================================
  // Messages
  // ============================================================================

  protected async _createMessage(id: string, params: CreateMessageParams): Promise<Message> {
    if (!this.pool) throw new Error("Pool not initialized");

    const now = new Date();
    // One statement: touching the conversation (new activity) is also the existence check,
    // and nothing is inserted when no row was touched.
    const result = await this.pool.query<DbMessage>(
      `WITH touched AS (
         UPDATE ${this.tables.conversations} SET updated_at = $10::timestamptz WHERE id = $2::varchar RETURNING id
       )
       INSERT INTO ${this.tables.messages}
         (id, conversation_id, role, content, name, tool_calls, tool_call_id, files, metadata, created_at, updated_at)
       SELECT $1::varchar, touched.id, $3::varchar, $4::jsonb, $5::varchar, $6::jsonb, $7::varchar, $8::jsonb, $9::jsonb,
              $10::timestamptz, $10::timestamptz
       FROM touched
       RETURNING *`,
      [
        id,
        params.conversationId,
        fits("role", params.role, LIMITS.role),
        toJsonb(params.content),
        fitsEncoded("name", params.name || null, LIMITS.name),
        params.toolCalls ? toJsonb(params.toolCalls) : null,
        fits("toolCallId", params.toolCallId || null, LIMITS.toolCallId),
        toJsonb(params.files || []),
        toJsonb(params.metadata || {}),
        now,
      ]
    );
    if (!result.rows[0]) throw new NotFoundError("Conversation", params.conversationId);

    return this.mapMessage(result.rows[0]);
  }

  protected async _getMessages(
    conversationId: string,
    params?: GetMessagesParams
  ): Promise<PaginatedResult<Message>> {
    if (!this.pool) throw new Error("Pool not initialized");

    const normalized = this.normalizeParams(params || {}, { limit: 100, offset: 0 });
    const order = params?.order === "desc" ? "DESC" : "ASC";

    // Only messages older / newer than the cursor message, by (created_at, insertion sequence)
    let cursorClause = "";
    const values: unknown[] = [conversationId];
    const cursor = params?.before ?? params?.after;
    if (cursor) {
      const exists = await this.pool.query(
        `SELECT 1 FROM ${this.tables.messages} WHERE id = $1 AND conversation_id = $2`,
        [cursor, conversationId]
      );
      if (exists.rows.length === 0) throw new NotFoundError("Message", cursor);
      values.push(cursor);
      cursorClause = `AND (created_at, seq) ${params?.before ? "<" : ">"}
        (SELECT created_at, seq FROM ${this.tables.messages} WHERE id = $2)`;
    }

    // Get total count
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${this.tables.messages} WHERE conversation_id = $1 ${cursorClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get paginated results
    const result = await this.pool.query<DbMessage>(
      `SELECT * FROM ${this.tables.messages}
       WHERE conversation_id = $1 ${cursorClause}
       ORDER BY created_at ${order}, seq ${order}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, normalized.limit, normalized.offset]
    );

    return pageResult(
      result.rows.map((row) => this.mapMessage(row)),
      total,
      normalized.limit,
      normalized.offset
    );
  }

  protected async _getMessage(id: string): Promise<Message | null> {
    if (!this.pool) throw new Error("Pool not initialized");

    const result = await this.pool.query<DbMessage>(
      `SELECT * FROM ${this.tables.messages} WHERE id = $1`,
      [id]
    );

    return result.rows[0] ? this.mapMessage(result.rows[0]) : null;
  }

  protected async _updateMessage(id: string, params: UpdateMessageParams): Promise<Message> {
    if (!this.pool) throw new Error("Pool not initialized");
    const updates: string[] = ["updated_at = $1"];
    const values: unknown[] = [new Date()];
    let paramIndex = 2;
    if (params.content !== undefined) {
      updates.push(`content = $${paramIndex++}`);
      values.push(toJsonb(params.content));
    }
    if (params.metadata !== undefined) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(toJsonb(params.metadata));
    }
    values.push(id);
    const result = await this.pool.query<DbMessage>(
      `UPDATE ${this.tables.messages} SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    if (!result.rows[0]) throw new NotFoundError("Message", id);
    return this.mapMessage(result.rows[0]);
  }

  protected async _deleteMessage(id: string): Promise<void> {
    if (!this.pool) throw new Error("Pool not initialized");
    // Its files stay with the conversation (message_id is set to NULL)
    await this.pool.query(`DELETE FROM ${this.tables.messages} WHERE id = $1`, [id]);
  }

  // ============================================================================
  // Files
  // ============================================================================

  protected async _saveFile(
    id: string,
    params: SaveFileParams & { storageKey: string; size: number }
  ): Promise<FileRecord> {
    if (!this.pool) throw new Error("Pool not initialized");

    // Content and record in one statement: a refused record leaves no orphan blob
    try {
      const result = await this.pool.query<DbFile>(
        `WITH stored AS (
           INSERT INTO ${this.tables.fileContents} (storage_key, content) VALUES ($1, $2)
         )
         INSERT INTO ${this.tables.files}
           (id, name, mime_type, size, storage_key, conversation_id, message_id, user_id, agent_id, expires_at, metadata, created_at)
         VALUES ($3, $4, $5, $6, $1, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          params.storageKey,
          params.content,
          id,
          fitsEncoded("file name", params.name, LIMITS.fileName),
          fits("mimeType", params.mimeType, LIMITS.mimeType),
          params.size,
          params.conversationId || null,
          params.messageId || null,
          fits("userId", params.userId || null, LIMITS.userId),
          fits("agentId", params.agentId || null, LIMITS.agentId),
          params.expiresAt ?? null,
          toJsonb(params.metadata || {}),
          new Date(),
        ]
      );
      return this.mapFile(result.rows[0]);
    } catch (error) {
      const failure = error as { code?: string; detail?: string };
      if (failure.code === "23503") {
        const missingMessage = failure.detail?.includes("message_id");
        throw missingMessage
          ? new NotFoundError("Message", params.messageId ?? "")
          : new NotFoundError("Conversation", params.conversationId ?? "");
      }
      throw error;
    }
  }

  protected async _getFile(id: string): Promise<FileRecord | null> {
    if (!this.pool) throw new Error("Pool not initialized");

    const result = await this.pool.query<DbFile>(
      `SELECT * FROM ${this.tables.files} WHERE id = $1`,
      [id]
    );

    return result.rows[0] ? this.mapFile(result.rows[0]) : null;
  }

  protected async _getFileContent(id: string): Promise<Buffer | null> {
    if (!this.pool) throw new Error("Pool not initialized");

    const result = await this.pool.query<{ content: Buffer }>(
      `SELECT c.content AS content
       FROM ${this.tables.files} f
       JOIN ${this.tables.fileContents} c ON c.storage_key = f.storage_key
       WHERE f.id = $1`,
      [id]
    );

    return result.rows[0]?.content ?? null;
  }

  protected async _deleteFile(id: string): Promise<void> {
    if (!this.pool) throw new Error("Pool not initialized");

    // Record and content together
    await this.pool.query(
      `WITH gone AS (
         DELETE FROM ${this.tables.files} WHERE id = $1 RETURNING storage_key
       )
       DELETE FROM ${this.tables.fileContents} WHERE storage_key IN (SELECT storage_key FROM gone)`,
      [id]
    );
  }

  protected async _listFiles(params: {
    conversationId: string;
    limit: number;
    offset: number;
    order: "asc" | "desc";
  }): Promise<PaginatedResult<FileRecord>> {
    if (!this.pool) throw new Error("Pool not initialized");
    const order = params.order === "desc" ? "DESC" : "ASC";

    const count = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.tables.files} WHERE conversation_id = $1`,
      [params.conversationId]
    );
    const total = parseInt(count.rows[0].count, 10);
    // The insertion sequence breaks ties between files saved in one millisecond
    const result = await this.pool.query<DbFile>(
      `SELECT * FROM ${this.tables.files} WHERE conversation_id = $1
       ORDER BY created_at ${order}, seq ${order} LIMIT $2 OFFSET $3`,
      [params.conversationId, params.limit, params.offset]
    );
    return pageResult(result.rows.map((row) => this.mapFile(row)), total, params.limit, params.offset);
  }

  protected async _purgeExpiredFiles(params: { before: Date; limit: number }): Promise<number> {
    if (!this.pool) throw new Error("Pool not initialized");

    // Records and contents together; `SKIP LOCKED` keeps two nodes purging at once off each other's rows
    const result = await this.pool.query(
      `WITH due AS (
         SELECT id FROM ${this.tables.files}
         WHERE expires_at IS NOT NULL AND expires_at <= $1
         ORDER BY expires_at, seq LIMIT $2
         FOR UPDATE SKIP LOCKED
       ), gone AS (
         DELETE FROM ${this.tables.files} WHERE id IN (SELECT id FROM due) RETURNING storage_key
       ), blobs AS (
         DELETE FROM ${this.tables.fileContents} WHERE storage_key IN (SELECT storage_key FROM gone)
       )
       SELECT COUNT(*) AS count FROM gone`,
      [params.before, params.limit]
    );
    return parseInt((result.rows[0] as { count: string }).count, 10);
  }

  // ============================================================================
  // Tasks
  // ============================================================================

  protected async _createTask(
    id: string,
    params: CreateTaskParams
  ): Promise<Task> {
    if (!this.pool) throw new Error("Pool not initialized");

    const now = new Date();
    const result = await this.pool.query<DbTask>(
      `INSERT INTO ${this.tables.tasks}
       (id, agent_id, user_id, conversation_id, status, callback_url, input, files, comments, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]', $9, $10, $10)
       RETURNING *`,
      [
        id,
        fits("agentId", params.agentId, LIMITS.agentId),
        fits("userId", params.userId || null, LIMITS.userId),
        fits("conversationId", params.conversationId || null, LIMITS.conversationId),
        "pending",
        fits("callbackUrl", params.callbackUrl || null, LIMITS.callbackUrl),
        encodeText(params.input),
        toJsonb(params.files || []),
        toJsonb(params.metadata || {}),
        now,
      ]
    );

    return this.mapTask(result.rows[0]);
  }

  protected async _getTask(id: string): Promise<Task | null> {
    if (!this.pool) throw new Error("Pool not initialized");

    const result = await this.pool.query<DbTask>(
      `SELECT * FROM ${this.tables.tasks} WHERE id = $1`,
      [id]
    );

    return result.rows[0] ? this.mapTask(result.rows[0]) : null;
  }

  protected async _getTasks(
    params: GetTasksParams
  ): Promise<PaginatedResult<Task>> {
    if (!this.pool) throw new Error("Pool not initialized");

    const normalized = this.normalizeParams(params, { limit: 20, offset: 0 });

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params.agentId) {
      conditions.push(`agent_id = $${paramIndex++}`);
      values.push(params.agentId);
    }
    if (params.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      values.push(params.userId);
    }
    if (params.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(params.status);
    }
    if (params.conversationId) {
      conditions.push(`conversation_id = $${paramIndex++}`);
      values.push(params.conversationId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${this.tables.tasks} ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count);

    // Get paginated data
    const orderBy = params.orderBy === "updatedAt" ? "updated_at" : "created_at";
    const order = params.order === "asc" ? "ASC" : "DESC";

    const result = await this.pool.query<DbTask>(
      `SELECT * FROM ${this.tables.tasks} ${whereClause}
       ORDER BY ${orderBy} ${order}, seq ${order}
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, normalized.limit, normalized.offset]
    );

    return pageResult(
      result.rows.map((row) => this.mapTask(row)),
      total,
      normalized.limit,
      normalized.offset
    );
  }

  protected async _updateTask(
    id: string,
    params: UpdateTaskParams
  ): Promise<Task> {
    if (!this.pool) throw new Error("Pool not initialized");

    const updates: string[] = ["updated_at = $1"];
    const values: unknown[] = [new Date()];
    let paramIndex = 2;

    if (params.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(fits("status", params.status, LIMITS.taskStatus));
    }
    if (params.conversationId !== undefined) {
      updates.push(`conversation_id = $${paramIndex++}`);
      values.push(fits("conversationId", params.conversationId, LIMITS.conversationId));
    }
    if (params.startedAt !== undefined) {
      updates.push(`started_at = $${paramIndex++}`);
      values.push(params.startedAt);
    }
    if (params.completedAt !== undefined) {
      updates.push(`completed_at = $${paramIndex++}`);
      values.push(params.completedAt);
    }
    if (params.error !== undefined) {
      updates.push(`error = $${paramIndex++}`);
      values.push(encodeText(params.error));
    }
    if (params.metadata !== undefined) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(toJsonb(params.metadata));
    }
    if (params.comments !== undefined) {
      updates.push(`comments = $${paramIndex++}`);
      values.push(toJsonb(params.comments));
    }

    values.push(id);

    const result = await this.pool.query<DbTask>(
      `UPDATE ${this.tables.tasks}
       SET ${updates.join(", ")}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (!result.rows[0]) {
      throw new NotFoundError("Task", id);
    }

    return this.mapTask(result.rows[0]);
  }

  protected async _deleteTask(id: string): Promise<void> {
    if (!this.pool) throw new Error("Pool not initialized");

    // Results are cascade deleted via foreign key
    await this.pool.query(`DELETE FROM ${this.tables.tasks} WHERE id = $1`, [id]);
  }

  // ============================================================================
  // Task Results
  // ============================================================================

  protected async _createTaskResult(
    id: string,
    params: CreateTaskResultParams
  ): Promise<TaskResult> {
    if (!this.pool) throw new Error("Pool not initialized");

    // One result per task: a second one replaces the first (and keeps its id)
    try {
      const result = await this.pool.query<DbTaskResult>(
        `INSERT INTO ${this.tables.taskResults}
         (id, task_id, content, files, metadata, usage, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (task_id) DO UPDATE SET
           content = EXCLUDED.content,
           files = EXCLUDED.files,
           metadata = EXCLUDED.metadata,
           usage = EXCLUDED.usage,
           created_at = EXCLUDED.created_at
         RETURNING *`,
        [
          id,
          params.taskId,
          encodeText(params.content),
          toJsonb(params.files || []),
          toJsonb(params.metadata || {}),
          params.usage ? toJsonb(params.usage) : null,
          new Date(),
        ]
      );
      return this.mapTaskResult(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23503") throw new NotFoundError("Task", params.taskId);
      throw error;
    }
  }

  protected async _getTaskResult(taskId: string): Promise<TaskResult | null> {
    if (!this.pool) throw new Error("Pool not initialized");

    const result = await this.pool.query<DbTaskResult>(
      `SELECT * FROM ${this.tables.taskResults} WHERE task_id = $1`,
      [taskId]
    );

    return result.rows[0] ? this.mapTaskResult(result.rows[0]) : null;
  }

  // ============================================================================
  // Events
  // ============================================================================

  protected async _appendEvents(
    conversationId: string,
    events: StoredEventInput[]
  ): Promise<ConversationEvent[]> {
    return this.withTransaction(async (db) => {
      // The counter row is the lock: appends to one conversation queue up behind each other, so
      // the sequence ascends without gaps or repeats. Creating it also checks the conversation exists.
      try {
        await db.query(
          `INSERT INTO ${this.tables.eventStreams} (conversation_id, last_seq, updated_at)
           VALUES ($1, 0, $2) ON CONFLICT (conversation_id) DO NOTHING`,
          [conversationId, events[0]!.createdAt]
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23503") throw new NotFoundError("Conversation", conversationId);
        throw error;
      }
      const stream = await db.query<{ last_seq: string; stop_reason: string | null }>(
        `SELECT last_seq, stop_reason FROM ${this.tables.eventStreams} WHERE conversation_id = $1 FOR UPDATE`,
        [conversationId]
      );
      let seq = Number(stream.rows[0]!.last_seq);

      const stored: ConversationEvent[] = [];
      for (const event of events) {
        seq += 1;
        await db.query(
          `INSERT INTO ${this.tables.events} (conversation_id, seq, type, data, run_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            conversationId,
            seq,
            fits("event type", event.type, LIMITS.eventType),
            toJsonb(event.data),
            fits("event runId", event.runId ?? null, LIMITS.runId),
            event.createdAt,
          ]
        );
        stored.push({
          conversationId,
          seq,
          type: event.type,
          data: event.data,
          runId: event.runId,
          createdAt: event.createdAt,
        });
      }
      await db.query(
        `UPDATE ${this.tables.eventStreams} SET last_seq = $2, stop_reason = $3, updated_at = $4 WHERE conversation_id = $1`,
        [conversationId, seq, nextStopReason(stream.rows[0]!.stop_reason, events) ?? null, events[events.length - 1]!.createdAt]
      );
      return stored;
    });
  }

  protected async _listEvents(conversationId: string, query: EventQuery): Promise<ConversationEvent[]> {
    if (!this.pool) throw new Error("Pool not initialized");

    const conditions = ["conversation_id = $1", "seq > $2"];
    const values: unknown[] = [conversationId, query.after];
    if (query.before !== undefined) {
      values.push(query.before);
      conditions.push(`seq < $${values.length}`);
    }
    if (query.types?.length) {
      values.push(query.types);
      conditions.push(`type = ANY($${values.length}::varchar[])`);
    }
    values.push(query.limit);
    const result = await this.pool.query<DbEvent>(
      `SELECT * FROM ${this.tables.events} WHERE ${conditions.join(" AND ")}
       ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"} LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => this.mapEvent(row));
  }

  protected async _eventSummaries(conversationIds: string[]): Promise<Record<string, EventSummary>> {
    if (!this.pool) throw new Error("Pool not initialized");
    const result = await this.pool.query<{ conversation_id: string; last_seq: string; stop_reason: string | null }>(
      `SELECT conversation_id, last_seq, stop_reason FROM ${this.tables.eventStreams}
       WHERE conversation_id = ANY($1::varchar[])`,
      [conversationIds]
    );
    const out: Record<string, EventSummary> = {};
    for (const row of result.rows) {
      out[row.conversation_id] = { lastSeq: Number(row.last_seq), ...(row.stop_reason ? { stopReason: row.stop_reason } : {}) };
    }
    return out;
  }

  protected async _pruneEvents(before: Date): Promise<number> {
    if (!this.pool) throw new Error("Pool not initialized");
    const result = await this.pool.query(`DELETE FROM ${this.tables.events} WHERE created_at < $1`, [before]);
    return result.rowCount ?? 0;
  }

  private mapEvent(row: DbEvent): ConversationEvent {
    return {
      conversationId: row.conversation_id,
      seq: Number(row.seq),
      type: row.type,
      data: row.data,
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
      data: row.data,
      cancelRequested: row.cancel_requested === true,
    };
  }

  protected async _acquireLease(
    params: AcquireLeaseParams & { now: Date; expiresAt: Date },
    _ctx?: RequestContext
  ): Promise<AcquireLeaseResult> {
    const key = fits("lease key", params.key, LIMITS.leaseKey)!;
    const owner = fits("lease owner", params.owner, LIMITS.leaseOwner)!;

    return this.withTransaction(async (db): Promise<AcquireLeaseResult> => {
      // The row lock decides between two nodes that ask at once. A key nobody has used yet has no row
      // to lock, so the first insert races: the loser's insert is a no-op and it looks again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const found = await db.query<DbLease>(`SELECT * FROM ${this.tables.leases} WHERE key = $1 FOR UPDATE`, [key]);
        const row = found.rows[0];
        if (!row) {
          const inserted = await db.query<DbLease>(
            `INSERT INTO ${this.tables.leases} (key, owner, expires_at, data, cancel_requested)
             VALUES ($1, $2, $3, $4, FALSE) ON CONFLICT (key) DO NOTHING RETURNING *`,
            [key, owner, params.expiresAt, toJsonb(params.data ?? {})]
          );
          if (inserted.rows[0]) return { acquired: true, lease: this.mapLease(inserted.rows[0]) };
          continue;
        }
        const live = new Date(row.expires_at).getTime() > params.now.getTime();
        if (live && row.owner !== owner) return { acquired: false, lease: this.mapLease(row) };
        const updated = await db.query<DbLease>(
          `UPDATE ${this.tables.leases}
           SET owner = $2, expires_at = $3, data = $4, cancel_requested = FALSE WHERE key = $1 RETURNING *`,
          [key, owner, params.expiresAt, toJsonb(params.data ?? {})]
        );
        // An expired lease is the residue of a holder that died
        return !live
          ? { acquired: true, lease: this.mapLease(updated.rows[0]!), takenOver: this.mapLease(row) }
          : { acquired: true, lease: this.mapLease(updated.rows[0]!) };
      }
      throw new Error(`Could not acquire the lease ${key}: it keeps changing hands`);
    });
  }

  protected async _renewLease(params: RenewLeaseParams & { now: Date; expiresAt: Date }): Promise<Lease | null> {
    if (!this.pool) throw new Error("Pool not initialized");
    const result = await this.pool.query<DbLease>(
      `UPDATE ${this.tables.leases} SET expires_at = $3
       WHERE key = $1 AND owner = $2 AND expires_at > $4 RETURNING *`,
      [params.key, params.owner, params.expiresAt, params.now]
    );
    return result.rows[0] ? this.mapLease(result.rows[0]) : null;
  }

  protected async _releaseLease(params: ReleaseLeaseParams): Promise<boolean> {
    if (!this.pool) throw new Error("Pool not initialized");
    const result = await this.pool.query(`DELETE FROM ${this.tables.leases} WHERE key = $1 AND owner = $2`, [
      params.key,
      params.owner,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  protected async _getLeases(keys: string[], now: Date): Promise<Lease[]> {
    if (!this.pool) throw new Error("Pool not initialized");
    const result = await this.pool.query<DbLease>(
      `SELECT * FROM ${this.tables.leases} WHERE key = ANY($1::varchar[]) AND expires_at > $2`,
      [keys, now]
    );
    return result.rows.map((row) => this.mapLease(row));
  }

  protected async _markLeaseCancel(key: string, now: Date): Promise<boolean> {
    if (!this.pool) throw new Error("Pool not initialized");
    const result = await this.pool.query(
      `UPDATE ${this.tables.leases} SET cancel_requested = TRUE WHERE key = $1 AND expires_at > $2`,
      [key, now]
    );
    return (result.rowCount ?? 0) > 0;
  }

  protected async _listExpiredLeases(params: { prefix?: string; limit: number; now: Date }): Promise<Lease[]> {
    if (!this.pool) throw new Error("Pool not initialized");
    const values: unknown[] = [params.now];
    let prefix = "";
    if (params.prefix) {
      values.push(params.prefix.length, params.prefix);
      prefix = `AND left(key, $2) = $3`;
    }
    values.push(params.limit);
    const result = await this.pool.query<DbLease>(
      `SELECT * FROM ${this.tables.leases} WHERE expires_at <= $1 ${prefix}
       ORDER BY expires_at, key LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => this.mapLease(row));
  }

  // ============================================================================
  // Mappers
  // ============================================================================

  // jsonb columns arrive already decoded (see the type parser in connect()); text columns
  // that were NUL-escaped on the way in are decoded here.

  private mapConversation(row: DbConversation): Conversation {
    return {
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id || undefined,
      title: row.title ? decodeText(row.title) : undefined,
      metadata: row.metadata,
      state: row.state,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      version: Number(row.version ?? 0),
      actionDueAt: row.action_due_at ? new Date(row.action_due_at) : undefined,
    };
  }

  private mapMessage(row: DbMessage): Message {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as Message["role"],
      // jsonb already holds the content as written: a string stays a string even when it looks like JSON
      content: row.content as string | Message["content"],
      name: row.name ? decodeText(row.name) : undefined,
      toolCalls: (row.tool_calls as Message["toolCalls"]) ?? undefined,
      toolCallId: row.tool_call_id || undefined,
      files: (row.files as Message["files"]) ?? undefined,
      metadata: row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapFile(row: DbFile): FileRecord {
    return {
      id: row.id,
      name: decodeText(row.name),
      mimeType: row.mime_type,
      size: row.size,
      storageKey: row.storage_key,
      conversationId: row.conversation_id || undefined,
      messageId: row.message_id || undefined,
      userId: row.user_id || undefined,
      agentId: row.agent_id || undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      metadata: row.metadata,
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
      input: decodeText(row.input),
      files: (row.files as Task["files"]) ?? undefined,
      comments: (row.comments as Task["comments"]) ?? undefined,
      metadata: row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      error: row.error ? decodeText(row.error) : undefined,
    };
  }

  private mapTaskResult(row: DbTaskResult): TaskResult {
    return {
      id: row.id,
      taskId: row.task_id,
      content: decodeText(row.content),
      files: (row.files as TaskResult["files"]) ?? undefined,
      metadata: row.metadata,
      usage: (row.usage as TaskResult["usage"]) ?? undefined,
      createdAt: new Date(row.created_at),
    };
  }
}

/** A stable 31-bit hash, the key of the migration advisory lock. */
function hash32(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

// ============================================================================
// Internal DB types
// ============================================================================

interface DbConversation {
  id: string;
  agent_id: string;
  user_id: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  version: number | null;
  action_due_at: string | null;
}

interface DbMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: unknown;
  name: string | null;
  tool_calls: unknown | null;
  tool_call_id: string | null;
  files: unknown;
  metadata: Record<string, unknown>;
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
  metadata: Record<string, unknown>;
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
  files: unknown;
  comments: unknown;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

interface DbEvent {
  conversation_id: string;
  seq: string | number;
  type: string;
  data: Record<string, unknown>;
  run_id: string | null;
  created_at: string;
}

interface DbLease {
  key: string;
  owner: string;
  expires_at: string;
  data: Record<string, unknown>;
  cancel_requested: boolean;
}

interface DbTaskResult {
  id: string;
  task_id: string;
  content: string;
  files: unknown;
  metadata: Record<string, unknown>;
  usage: unknown | null;
  created_at: string;
}

// Export factory function
export function createPostgresProvider(config: PostgresConfig): PostgresStorageProvider {
  return new PostgresStorageProvider(config);
}
