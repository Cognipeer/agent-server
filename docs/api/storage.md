# Storage Providers API

API reference for storage providers.

## createPostgresProvider

Creates a PostgreSQL storage provider.

```typescript
import { createPostgresProvider } from '@cognipeer/agent-server';

const storage = createPostgresProvider(config);
```

### Configuration

```typescript
interface PostgresConfig {
  // Connection string (preferred)
  connectionString?: string;

  // Or separate connection params
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;

  // Schema name (default: 'public')
  schema?: string;

  // Table prefix (default: 'agent_server_')
  tablePrefix?: string;

  // Auto-create tables (default: true)
  autoMigrate?: boolean;

  // Connection pool options
  pool?: {
    min?: number;
    max?: number;
  };
}
```

### Example

```typescript
const storage = createPostgresProvider({
  connectionString: 'postgresql://user:pass@localhost:5432/mydb',
  tablePrefix: 'agent_',
  autoMigrate: true,
  pool: { min: 2, max: 10 },
});

await storage.connect();
```

## createMongoDBProvider

Creates a MongoDB storage provider.

```typescript
import { createMongoDBProvider } from '@cognipeer/agent-server';

const storage = createMongoDBProvider(config);
```

### Configuration

```typescript
interface MongoDBConfig {
  // Connection string
  connectionString: string;

  // Database name (optional if in connection string)
  database?: string;

  // Collection prefix (default: 'agent_server_')
  collectionPrefix?: string;

  // Auto-create indexes (default: true)
  autoIndex?: boolean;
}
```

### Example

```typescript
const storage = createMongoDBProvider({
  connectionString: 'mongodb://localhost:27017/mydb',
  collectionPrefix: 'agent_',
  autoIndex: true,
});

await storage.connect();
```

## createMemoryProvider

Creates an in-memory storage provider (for development).

```typescript
import { createMemoryProvider } from '@cognipeer/agent-server';

const storage = createMemoryProvider();
await storage.connect();
```

::: warning
Memory storage loses all data when the process restarts.
:::

## BaseStorageProvider

Base class for all storage providers.

```typescript
abstract class BaseStorageProvider {
  protected _connected: boolean = false;

  get isConnected(): boolean;

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

## Storage Methods

### Lifecycle

#### connect()

Connect to the storage backend.

```typescript
await storage.connect();
```

Must be called before using any other methods.

#### disconnect()

Disconnect from the storage backend.

```typescript
await storage.disconnect();
```

### Conversations

#### createConversation(params)

Create a new conversation.

```typescript
const conversation = await storage.createConversation({
  agentId: 'assistant',
  userId: 'user-123',
  title: 'My Chat',
  metadata: { source: 'web' },
  state: { messageCount: 0 },
});
```

#### getConversation(id)

Get a conversation by ID.

```typescript
const conversation = await storage.getConversation('conv-123');
// Returns null if not found
```

#### updateConversation(id, params)

Update a conversation.

```typescript
const updated = await storage.updateConversation('conv-123', {
  title: 'New Title',
  state: { messageCount: 5 },
});
```

Throws `NotFoundError` if conversation doesn't exist.

#### deleteConversation(id)

Delete a conversation and its messages.

```typescript
await storage.deleteConversation('conv-123');
```

#### listConversations(params)

List conversations with filtering and pagination.

```typescript
const { items, total, hasMore } = await storage.listConversations({
  agentId: 'assistant',
  userId: 'user-123',
  limit: 20,
  offset: 0,
});
```

### Messages

#### createMessage(params)

Create a new message.

```typescript
const message = await storage.createMessage({
  conversationId: 'conv-123',
  role: 'user',
  content: 'Hello!',
  files: [{ id: 'file-1', name: 'doc.pdf', mimeType: 'application/pdf', size: 1234 }],
});
```

#### getMessages(conversationId, params?)

Get messages for a conversation.

```typescript
const messages = await storage.getMessages('conv-123', {
  limit: 50,
  before: new Date('2025-01-01'),
});
```

### Files

#### saveFile(params)

Save a file.

```typescript
const file = await storage.saveFile({
  name: 'document.pdf',
  mimeType: 'application/pdf',
  size: 12345,
  content: Buffer.from('...'),
  metadata: { uploadedBy: 'user-123' },
});
```

#### getFile(id)

Get file metadata.

```typescript
const file = await storage.getFile('file-123');
// Returns null if not found
```

#### getFileContent(id)

Get file content as Buffer.

```typescript
const content = await storage.getFileContent('file-123');
// Returns null if not found
```

#### deleteFile(id)

Delete a file.

```typescript
await storage.deleteFile('file-123');
```

## Error Handling

Storage operations may throw:

- `NotFoundError` - Resource not found
- Connection errors - Database connection issues
- Validation errors - Invalid parameters

```typescript
try {
  await storage.getConversation('invalid-id');
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('Conversation not found');
  }
}
```
