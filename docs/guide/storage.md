# Storage Providers

Storage providers handle persistence of conversations, messages, and files.

## PostgreSQL

The recommended storage provider for production.

### Installation

```bash
npm install pg @types/pg
```

### Configuration

```typescript
import { createPostgresProvider } from '@cognipeer/agent-server';

const storage = createPostgresProvider({
  // Connection string
  connectionString: 'postgresql://user:pass@localhost:5432/mydb',

  // Or separate parameters
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'user',
  password: 'pass',

  // Optional settings
  schema: 'public',           // Default: 'public'
  tablePrefix: 'agent_',      // Default: 'agent_server_'
  autoMigrate: true,          // Default: true - creates tables automatically
  pool: {
    min: 2,
    max: 10,
  },
});

// Connect before using
await storage.connect();
```

### Auto Migration

When `autoMigrate: true`, the provider creates these tables:

```sql
-- Conversations table
CREATE TABLE agent_server_conversations (
  id VARCHAR(255) PRIMARY KEY,
  agent_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255),
  title TEXT,
  metadata JSONB,
  state JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Messages table
CREATE TABLE agent_server_messages (
  id VARCHAR(255) PRIMARY KEY,
  conversation_id VARCHAR(255) NOT NULL REFERENCES agent_server_conversations(id),
  role VARCHAR(50) NOT NULL,
  content JSONB NOT NULL,
  name VARCHAR(255),
  tool_calls JSONB,
  tool_call_id VARCHAR(255),
  files JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Files table
CREATE TABLE agent_server_files (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT,
  content BYTEA,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Environment Variables

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
```

```typescript
const storage = createPostgresProvider({
  connectionString: process.env.DATABASE_URL,
});
```

## MongoDB

Alternative NoSQL storage provider.

### Installation

```bash
npm install mongodb
```

### Configuration

```typescript
import { createMongoDBProvider } from '@cognipeer/agent-server';

const storage = createMongoDBProvider({
  connectionString: 'mongodb://localhost:27017/mydb',
  database: 'mydb',               // Optional if included in connection string
  collectionPrefix: 'agent_',     // Default: 'agent_server_'
  autoIndex: true,                // Default: true - creates indexes
});

await storage.connect();
```

### Collections

The provider creates these collections:

- `agent_server_conversations`
- `agent_server_messages`
- `agent_server_files`

### Indexes

With `autoIndex: true`, these indexes are created:

```javascript
// Conversations
{ agentId: 1 }
{ userId: 1 }
{ createdAt: -1 }

// Messages
{ conversationId: 1, createdAt: 1 }

// Files
{ createdAt: -1 }
```

## Memory Storage

In-memory storage for development and testing.

```typescript
import { createMemoryProvider } from '@cognipeer/agent-server';

const storage = createMemoryProvider();
await storage.connect();
```

::: warning
Memory storage loses all data when the process restarts. Use only for development.
:::

## Custom Storage Provider

Create your own storage provider by extending `BaseStorageProvider`:

```typescript
import { BaseStorageProvider } from '@cognipeer/agent-server';

class MyStorageProvider extends BaseStorageProvider {
  private client: MyDatabaseClient;

  constructor(config: MyConfig) {
    super();
    this.client = new MyDatabaseClient(config);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    await this.client.close();
    this._connected = false;
  }

  // Implement conversation methods
  async createConversation(params: CreateConversationParams): Promise<Conversation> {
    const conversation = {
      id: generateId(),
      ...params,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.client.conversations.insert(conversation);
    return conversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.client.conversations.findOne({ id });
  }

  async updateConversation(id: string, updates: UpdateConversationParams): Promise<Conversation> {
    const conversation = await this.getConversation(id);
    if (!conversation) throw new NotFoundError('Conversation not found');
    
    const updated = {
      ...conversation,
      ...updates,
      updatedAt: new Date(),
    };
    await this.client.conversations.update({ id }, updated);
    return updated;
  }

  async deleteConversation(id: string): Promise<void> {
    await this.client.conversations.delete({ id });
    await this.client.messages.deleteMany({ conversationId: id });
  }

  async listConversations(params: ListConversationsParams): Promise<ListResult<Conversation>> {
    const { agentId, userId, limit = 20, offset = 0 } = params;
    
    const query: any = {};
    if (agentId) query.agentId = agentId;
    if (userId) query.userId = userId;
    
    const items = await this.client.conversations
      .find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    
    const total = await this.client.conversations.count(query);
    
    return { items, total, hasMore: offset + items.length < total };
  }

  // Implement message methods
  async createMessage(params: CreateMessageParams): Promise<Message> {
    const message = {
      id: generateId(),
      ...params,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.client.messages.insert(message);
    return message;
  }

  async getMessages(conversationId: string, params?: GetMessagesParams): Promise<Message[]> {
    const { limit = 100, before } = params || {};
    
    const query: any = { conversationId };
    if (before) query.createdAt = { $lt: before };
    
    return this.client.messages
      .find(query)
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  // Implement file methods
  async saveFile(params: SaveFileParams): Promise<FileRecord> {
    const file = {
      id: generateId(),
      ...params,
      createdAt: new Date(),
    };
    await this.client.files.insert(file);
    return file;
  }

  async getFile(id: string): Promise<FileRecord | null> {
    return this.client.files.findOne({ id });
  }

  async getFileContent(id: string): Promise<Buffer | null> {
    const file = await this.getFile(id);
    return file?.content ?? null;
  }

  async deleteFile(id: string): Promise<void> {
    await this.client.files.delete({ id });
  }
}
```

## Storage Operations

### Conversations

```typescript
// Create
const conversation = await storage.createConversation({
  agentId: 'assistant',
  userId: 'user-123',
  title: 'New Chat',
});

// Get
const conv = await storage.getConversation('conv-id');

// Update
const updated = await storage.updateConversation('conv-id', {
  title: 'Updated Title',
});

// Delete
await storage.deleteConversation('conv-id');

// List
const { items, total, hasMore } = await storage.listConversations({
  agentId: 'assistant',
  userId: 'user-123',
  limit: 20,
  offset: 0,
});
```

### Messages

```typescript
// Create
const message = await storage.createMessage({
  conversationId: 'conv-id',
  role: 'user',
  content: 'Hello!',
});

// Get messages
const messages = await storage.getMessages('conv-id', {
  limit: 50,
});
```

### Files

```typescript
// Save file
const file = await storage.saveFile({
  name: 'document.pdf',
  mimeType: 'application/pdf',
  size: 12345,
  content: Buffer.from('...'),
});

// Get file info
const fileInfo = await storage.getFile('file-id');

// Get file content
const content = await storage.getFileContent('file-id');

// Delete
await storage.deleteFile('file-id');
```

## Next Steps

- [Authentication](/guide/authentication)
- [File Management](/guide/file-management)
- [Custom Storage](/guide/custom-storage)
