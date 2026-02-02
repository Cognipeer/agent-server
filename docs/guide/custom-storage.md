# Custom Storage

Create your own storage provider for special requirements.

## Base Provider

All storage providers extend `BaseStorageProvider`:

```typescript
import { BaseStorageProvider } from '@cognipeer/agent-server';

abstract class BaseStorageProvider {
  protected _connected: boolean = false;

  get isConnected(): boolean {
    return this._connected;
  }

  // Lifecycle
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  // Conversations
  abstract createConversation(params: CreateConversationParams): Promise<Conversation>;
  abstract getConversation(id: string): Promise<Conversation | null>;
  abstract updateConversation(id: string, params: UpdateConversationParams): Promise<Conversation>;
  abstract deleteConversation(id: string): Promise<void>;
  abstract listConversations(params: ListConversationsParams): Promise<ListResult<Conversation>>;

  // Messages
  abstract createMessage(params: CreateMessageParams): Promise<Message>;
  abstract getMessages(conversationId: string, params?: GetMessagesParams): Promise<Message[]>;

  // Files
  abstract saveFile(params: SaveFileParams): Promise<FileRecord>;
  abstract getFile(id: string): Promise<FileRecord | null>;
  abstract getFileContent(id: string): Promise<Buffer | null>;
  abstract deleteFile(id: string): Promise<void>;
}
```

## Implementation Example

Here's a complete example using SQLite:

```typescript
import { BaseStorageProvider, NotFoundError } from '@cognipeer/agent-server';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

interface SQLiteConfig {
  filename: string;
  autoMigrate?: boolean;
}

export class SQLiteStorageProvider extends BaseStorageProvider {
  private db: Database.Database;
  private config: SQLiteConfig;

  constructor(config: SQLiteConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    this.db = new Database(this.config.filename);
    
    if (this.config.autoMigrate !== false) {
      await this.migrate();
    }
    
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this.db.close();
    this._connected = false;
  }

  private async migrate(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT,
        title TEXT,
        metadata TEXT,
        state TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        name TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        files TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_key TEXT,
        content BLOB,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id);
      CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
    `);
  }

  // Conversations
  async createConversation(params: CreateConversationParams): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation = {
      id: nanoid(),
      agentId: params.agentId,
      userId: params.userId,
      title: params.title,
      metadata: params.metadata,
      state: params.state,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };

    this.db.prepare(`
      INSERT INTO conversations (id, agent_id, user_id, title, metadata, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      conversation.agentId,
      conversation.userId,
      conversation.title,
      JSON.stringify(conversation.metadata),
      JSON.stringify(conversation.state),
      now,
      now
    );

    return conversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const row = this.db.prepare(`
      SELECT * FROM conversations WHERE id = ?
    `).get(id) as any;

    if (!row) return null;

    return {
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id,
      title: row.title,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      state: row.state ? JSON.parse(row.state) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async updateConversation(id: string, params: UpdateConversationParams): Promise<Conversation> {
    const existing = await this.getConversation(id);
    if (!existing) throw new NotFoundError('Conversation not found');

    const now = new Date().toISOString();
    const updates: string[] = ['updated_at = ?'];
    const values: any[] = [now];

    if (params.title !== undefined) {
      updates.push('title = ?');
      values.push(params.title);
    }
    if (params.metadata !== undefined) {
      updates.push('metadata = ?');
      values.push(JSON.stringify(params.metadata));
    }
    if (params.state !== undefined) {
      updates.push('state = ?');
      values.push(JSON.stringify(params.state));
    }

    values.push(id);

    this.db.prepare(`
      UPDATE conversations SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    return (await this.getConversation(id))!;
  }

  async deleteConversation(id: string): Promise<void> {
    this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  async listConversations(params: ListConversationsParams): Promise<ListResult<Conversation>> {
    const { agentId, userId, limit = 20, offset = 0 } = params;

    let where = '1=1';
    const values: any[] = [];

    if (agentId) {
      where += ' AND agent_id = ?';
      values.push(agentId);
    }
    if (userId) {
      where += ' AND user_id = ?';
      values.push(userId);
    }

    const countRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM conversations WHERE ${where}
    `).get(...values) as any;
    const total = countRow.count;

    values.push(limit, offset);
    const rows = this.db.prepare(`
      SELECT * FROM conversations WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...values) as any[];

    const items = rows.map(row => ({
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id,
      title: row.title,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      state: row.state ? JSON.parse(row.state) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));

    return {
      items,
      total,
      hasMore: offset + items.length < total,
    };
  }

  // Messages
  async createMessage(params: CreateMessageParams): Promise<Message> {
    const now = new Date().toISOString();
    const message = {
      id: nanoid(),
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      name: params.name,
      toolCalls: params.toolCalls,
      toolCallId: params.toolCallId,
      files: params.files,
      metadata: params.metadata,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };

    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, name, tool_calls, tool_call_id, files, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.conversationId,
      message.role,
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      message.name,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolCallId,
      message.files ? JSON.stringify(message.files) : null,
      message.metadata ? JSON.stringify(message.metadata) : null,
      now,
      now
    );

    return message;
  }

  async getMessages(conversationId: string, params?: GetMessagesParams): Promise<Message[]> {
    const { limit = 100, before } = params || {};

    let query = 'SELECT * FROM messages WHERE conversation_id = ?';
    const values: any[] = [conversationId];

    if (before) {
      query += ' AND created_at < ?';
      values.push(before.toISOString());
    }

    query += ' ORDER BY created_at ASC LIMIT ?';
    values.push(limit);

    const rows = this.db.prepare(query).all(...values) as any[];

    return rows.map(row => {
      let content = row.content;
      try {
        content = JSON.parse(row.content);
      } catch {}

      return {
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content,
        name: row.name,
        toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        toolCallId: row.tool_call_id,
        files: row.files ? JSON.parse(row.files) : undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };
    });
  }

  // Files
  async saveFile(params: SaveFileParams): Promise<FileRecord> {
    const now = new Date().toISOString();
    const file = {
      id: nanoid(),
      name: params.name,
      mimeType: params.mimeType,
      size: params.size,
      storageKey: params.storageKey,
      createdAt: new Date(now),
    };

    this.db.prepare(`
      INSERT INTO files (id, name, mime_type, size, storage_key, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      file.id,
      file.name,
      file.mimeType,
      file.size,
      file.storageKey,
      params.content,
      params.metadata ? JSON.stringify(params.metadata) : null,
      now
    );

    return file;
  }

  async getFile(id: string): Promise<FileRecord | null> {
    const row = this.db.prepare(`
      SELECT id, name, mime_type, size, storage_key, metadata, created_at FROM files WHERE id = ?
    `).get(id) as any;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      storageKey: row.storage_key,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: new Date(row.created_at),
    };
  }

  async getFileContent(id: string): Promise<Buffer | null> {
    const row = this.db.prepare(`
      SELECT content FROM files WHERE id = ?
    `).get(id) as any;

    return row?.content ?? null;
  }

  async deleteFile(id: string): Promise<void> {
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }
}

// Factory function
export function createSQLiteProvider(config: SQLiteConfig): SQLiteStorageProvider {
  return new SQLiteStorageProvider(config);
}
```

## Using Custom Provider

```typescript
import { createAgentServer } from '@cognipeer/agent-server';
import { createSQLiteProvider } from './sqlite-provider';

const storage = createSQLiteProvider({
  filename: './data/agents.db',
  autoMigrate: true,
});

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: { enabled: true },
});

await storage.connect();
```

## External File Storage

For production, consider separating file storage:

```typescript
class S3FileStorageProvider extends BaseStorageProvider {
  private s3: S3Client;
  private db: Database; // For metadata

  async saveFile(params: SaveFileParams): Promise<FileRecord> {
    const key = `files/${nanoid()}`;
    
    // Upload to S3
    await this.s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: params.content,
      ContentType: params.mimeType,
    }));
    
    // Save metadata to database
    const file = {
      id: nanoid(),
      name: params.name,
      mimeType: params.mimeType,
      size: params.size,
      storageKey: key,
      createdAt: new Date(),
    };
    
    await this.db.files.insert(file);
    return file;
  }

  async getFileContent(id: string): Promise<Buffer | null> {
    const file = await this.getFile(id);
    if (!file?.storageKey) return null;

    const response = await this.s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: file.storageKey,
    }));

    return Buffer.from(await response.Body!.transformToByteArray());
  }

  async deleteFile(id: string): Promise<void> {
    const file = await this.getFile(id);
    if (file?.storageKey) {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: file.storageKey,
      }));
    }
    await this.db.files.delete({ id });
  }
}
```

## Testing Custom Providers

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('SQLiteStorageProvider', () => {
  let storage: SQLiteStorageProvider;

  beforeEach(async () => {
    storage = createSQLiteProvider({ filename: ':memory:' });
    await storage.connect();
  });

  afterEach(async () => {
    await storage.disconnect();
  });

  it('should create and retrieve conversation', async () => {
    const created = await storage.createConversation({
      agentId: 'test-agent',
      title: 'Test Conversation',
    });

    const retrieved = await storage.getConversation(created.id);
    expect(retrieved).toEqual(created);
  });

  it('should list conversations by agent', async () => {
    await storage.createConversation({ agentId: 'agent-1' });
    await storage.createConversation({ agentId: 'agent-2' });
    await storage.createConversation({ agentId: 'agent-1' });

    const result = await storage.listConversations({ agentId: 'agent-1' });
    expect(result.items).toHaveLength(2);
  });
});
```

## Next Steps

- [Error Handling](/guide/error-handling)
- [API Reference](/api/server)
- [Examples](/examples/)
