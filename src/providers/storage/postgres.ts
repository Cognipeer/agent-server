/**
 * PostgreSQL Storage Provider
 */

import { BaseStorageProvider } from "./base.js";
import type {
  Conversation,
  Message,
  FileRecord,
  CreateConversationParams,
  GetConversationsParams,
  UpdateConversationParams,
  CreateMessageParams,
  GetMessagesParams,
  SaveFileParams,
  PaginatedResult,
} from "../../types.js";

// pg types - we import dynamically to avoid requiring pg when not used
type Pool = {
  connect(): Promise<PoolClient>;
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  end(): Promise<void>;
};

type PoolClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  release(): void;
};

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

  // ============================================================================
  // Table names
  // ============================================================================

  private get tables() {
    return {
      conversations: `"${this.schema}"."${this.tablePrefix}conversations"`,
      messages: `"${this.schema}"."${this.tablePrefix}messages"`,
      files: `"${this.schema}"."${this.tablePrefix}files"`,
      fileContents: `"${this.schema}"."${this.tablePrefix}file_contents"`,
    };
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    if (this._connected) return;

    try {
      // Dynamic import of pg
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pg = await import("pg" as any);
      const Pool = pg.default?.Pool || pg.Pool;

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

  private async migrate(): Promise<void> {
    if (!this.pool) throw new Error("Pool not initialized");

    // Create schema if not exists
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);

    // Create conversations table
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.conversations} (
        id VARCHAR(64) PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255),
        title VARCHAR(500),
        metadata JSONB DEFAULT '{}',
        state JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create messages table
    await this.pool.query(`
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
    await this.pool.query(`
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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.fileContents} (
        storage_key VARCHAR(255) PRIMARY KEY,
        content BYTEA NOT NULL
      )
    `);

    // Create indexes
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_agent_id 
      ON ${this.tables.conversations}(agent_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id 
      ON ${this.tables.conversations}(user_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id 
      ON ${this.tables.messages}(conversation_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_files_conversation_id 
      ON ${this.tables.files}(conversation_id)
    `);
  }

  // ============================================================================
  // Conversations
  // ============================================================================

  protected async _createConversation(
    id: string,
    params: CreateConversationParams
  ): Promise<Conversation> {
    if (!this.pool) throw new Error("Pool not initialized");

    const result = await this.pool.query<DbConversation>(
      `INSERT INTO ${this.tables.conversations} 
       (id, agent_id, user_id, title, metadata, state)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        params.agentId,
        params.userId || null,
        params.title || null,
        JSON.stringify(params.metadata || {}),
        JSON.stringify(params.state || {}),
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${this.tables.conversations} ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get paginated results
    const result = await this.pool.query<DbConversation>(
      `SELECT * FROM ${this.tables.conversations} 
       ${whereClause}
       ORDER BY ${orderBy} ${order}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...values, normalized.limit, normalized.offset]
    );

    return {
      data: result.rows.map((row) => this.mapConversation(row)),
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + result.rows.length < total,
    };
  }

  protected async _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    if (!this.pool) throw new Error("Pool not initialized");

    const updates: string[] = ["updated_at = NOW()"];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params.title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(params.title);
    }
    if (params.metadata !== undefined) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(params.metadata));
    }
    if (params.state !== undefined) {
      updates.push(`state = $${paramIndex++}`);
      values.push(JSON.stringify(params.state));
    }

    values.push(id);

    const result = await this.pool.query<DbConversation>(
      `UPDATE ${this.tables.conversations} 
       SET ${updates.join(", ")}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error(`Conversation not found: ${id}`);
    }

    return this.mapConversation(result.rows[0]);
  }

  protected async _deleteConversation(id: string): Promise<void> {
    if (!this.pool) throw new Error("Pool not initialized");
    await this.pool.query(`DELETE FROM ${this.tables.conversations} WHERE id = $1`, [id]);
  }

  // ============================================================================
  // Messages
  // ============================================================================

  protected async _createMessage(id: string, params: CreateMessageParams): Promise<Message> {
    if (!this.pool) throw new Error("Pool not initialized");

    const content =
      typeof params.content === "string" ? params.content : JSON.stringify(params.content);

    const result = await this.pool.query<DbMessage>(
      `INSERT INTO ${this.tables.messages}
       (id, conversation_id, role, content, name, tool_calls, tool_call_id, files, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        params.conversationId,
        params.role,
        content,
        params.name || null,
        params.toolCalls ? JSON.stringify(params.toolCalls) : null,
        params.toolCallId || null,
        JSON.stringify(params.files || []),
        JSON.stringify(params.metadata || {}),
      ]
    );

    return this.mapMessage(result.rows[0]);
  }

  protected async _getMessages(
    conversationId: string,
    params?: GetMessagesParams
  ): Promise<PaginatedResult<Message>> {
    if (!this.pool) throw new Error("Pool not initialized");

    const normalized = this.normalizeParams(params || {}, { limit: 100, offset: 0 });
    const order = params?.order === "desc" ? "DESC" : "ASC";

    // Get total count
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${this.tables.messages} WHERE conversation_id = $1`,
      [conversationId]
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get paginated results
    const result = await this.pool.query<DbMessage>(
      `SELECT * FROM ${this.tables.messages}
       WHERE conversation_id = $1
       ORDER BY created_at ${order}
       LIMIT $2 OFFSET $3`,
      [conversationId, normalized.limit, normalized.offset]
    );

    return {
      data: result.rows.map((row) => this.mapMessage(row)),
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + result.rows.length < total,
    };
  }

  protected async _getMessage(id: string): Promise<Message | null> {
    if (!this.pool) throw new Error("Pool not initialized");

    const result = await this.pool.query<DbMessage>(
      `SELECT * FROM ${this.tables.messages} WHERE id = $1`,
      [id]
    );

    return result.rows[0] ? this.mapMessage(result.rows[0]) : null;
  }

  protected async _deleteMessage(id: string): Promise<void> {
    if (!this.pool) throw new Error("Pool not initialized");
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

    // Save file content
    await this.pool.query(
      `INSERT INTO ${this.tables.fileContents} (storage_key, content) VALUES ($1, $2)`,
      [params.storageKey, params.content]
    );

    // Save file metadata
    const result = await this.pool.query<DbFile>(
      `INSERT INTO ${this.tables.files}
       (id, name, mime_type, size, storage_key, conversation_id, message_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        params.name,
        params.mimeType,
        params.size,
        params.storageKey,
        params.conversationId || null,
        params.messageId || null,
        JSON.stringify(params.metadata || {}),
      ]
    );

    return this.mapFile(result.rows[0]);
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

    // First get the storage key
    const fileResult = await this.pool.query<DbFile>(
      `SELECT storage_key FROM ${this.tables.files} WHERE id = $1`,
      [id]
    );

    if (!fileResult.rows[0]) return null;

    // Then get the content
    const contentResult = await this.pool.query<{ content: Buffer }>(
      `SELECT content FROM ${this.tables.fileContents} WHERE storage_key = $1`,
      [fileResult.rows[0].storage_key]
    );

    return contentResult.rows[0]?.content || null;
  }

  protected async _deleteFile(id: string): Promise<void> {
    if (!this.pool) throw new Error("Pool not initialized");

    // Get storage key first
    const fileResult = await this.pool.query<DbFile>(
      `SELECT storage_key FROM ${this.tables.files} WHERE id = $1`,
      [id]
    );

    if (fileResult.rows[0]) {
      // Delete content
      await this.pool.query(
        `DELETE FROM ${this.tables.fileContents} WHERE storage_key = $1`,
        [fileResult.rows[0].storage_key]
      );
      // Delete metadata
      await this.pool.query(`DELETE FROM ${this.tables.files} WHERE id = $1`, [id]);
    }
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
}

// ============================================================================
// Internal DB types
// ============================================================================

interface DbConversation {
  id: string;
  agent_id: string;
  user_id: string | null;
  title: string | null;
  metadata: Record<string, unknown> | string;
  state: Record<string, unknown> | string;
  created_at: string;
  updated_at: string;
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
  metadata: Record<string, unknown> | string;
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
  metadata: Record<string, unknown> | string;
  created_at: string;
}

// Export factory function
export function createPostgresProvider(config: PostgresConfig): PostgresStorageProvider {
  return new PostgresStorageProvider(config);
}
