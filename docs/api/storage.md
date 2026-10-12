# Storage Providers API

API reference for storage providers. The guide, with the limits and the schemas: [Storage Providers](../guide/storage).

| Factory | Peer dependency | |
| --- | --- | --- |
| `createInMemoryProvider(config?)` | none | development and tests |
| `createSQLiteProvider(config)` | `better-sqlite3` | one process, one file |
| `createPostgresProvider(config)` | `pg` | production |
| `createMongoDBProvider(config)` | `mongodb` | production |

All four implement `StorageProvider` and report `capabilities()`; they are tested against one shared contract.

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

  // Create / upgrade the tables on connect (default: true)
  autoMigrate?: boolean;

  // Connection pool options
  pool?: {
    min?: number;
    max?: number;
    idleTimeoutMillis?: number;
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

  // Largest conversation state in bytes (default 12 MiB, at most 15 MiB): a document is limited to 16 MiB
  maxStateBytes?: number;
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

## createSQLiteProvider

Creates a SQLite storage provider (`better-sqlite3`). One process owns the file.

```typescript
import { createSQLiteProvider } from '@cognipeer/agent-server';

const storage = createSQLiteProvider({ filename: './data/agent-server.db' });
await storage.connect();
```

```typescript
interface SQLiteConfig {
  // Path of the database file; ':memory:' for a throwaway database
  filename: string;

  // Table prefix (default: 'agent_server_')
  tablePrefix?: string;

  // Create / upgrade the tables on connect (default: true)
  autoMigrate?: boolean;

  // Write-ahead logging (default: true)
  walMode?: boolean;

  // better-sqlite3 options
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number; verbose?: (message?: string) => void };
}
```

## createInMemoryProvider

Creates an in-memory storage provider (for development and tests).

```typescript
import { createInMemoryProvider } from '@cognipeer/agent-server';

const storage = createInMemoryProvider({
  maxFileStorage: 100 * 1024 * 1024,  // total bytes of files, also the largest file (default 100 MB)
  maxConversations: 1000,             // optional
  maxMessagesPerConversation: 5000,   // optional
});
await storage.connect();
```

::: warning
Memory storage loses all data when the process restarts. Anything over its limits is a `StorageLimitError` (413).
:::

## BaseStorageProvider

An abstract class to build a provider on. `StorageProvider` is the interface the server uses; `BaseStorageProvider` implements it on top of `_`-prefixed methods
you write, and adds what is the same for every provider: ids, validation, the checks that make an unknown conversation a `NotFoundError`, normalised results. See
[Custom Storage](../guide/custom-storage).

```typescript
import { BaseStorageProvider } from '@cognipeer/agent-server';

abstract class BaseStorageProvider implements StorageProvider {
  isConnected(): boolean;
  capabilities(): StorageCapabilities;   // override with your real limits and features

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  // Conversations: _createConversation, _getConversation, _getConversations, _updateConversation, _deleteConversation
  //                (optional: _updateConversationIf, for compare-and-set updates)
  // Messages:      _createMessage, _getMessages, _getMessage, _deleteMessage (optional: _updateMessage)
  // Files:         _saveFile, _getFile, _getFileContent, _deleteFile (optional: _listFiles, _purgeExpiredFiles)
  // Tasks:         _createTask, _getTask, _getTasks, _updateTask, _deleteTask, _createTaskResult, _getTaskResult
  // Event log (optional): _appendEvents, _listEvents, _eventSummaries, _pruneEvents
  // Leases (optional):    _acquireLease, _renewLease, _releaseLease, _getLeases, _markLeaseCancel, _listExpiredLeases
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
// Resolves null if not found
```

#### updateConversation(id, params)

Update a conversation.

```typescript
const updated = await storage.updateConversation('conv-123', {
  title: 'New Title',
  state: { messageCount: 5 },
});
```

Throws `NotFoundError` if conversation doesn't exist. Every update bumps `conversation.version`; `params.actionDueAt` (a `Date`, `null` clears it) records when the earliest open approval lapses.

#### updateConversationIf(id, ifVersion, params)

Compare-and-set (`capabilities().atomicUpdate`, all built-in providers): updates only if the conversation is still at `ifVersion`, resolves the updated conversation, or `null` when someone else updated it first.

```typescript
const fresh = await storage.getConversation('conv-123');
const updated = await storage.updateConversationIf!('conv-123', fresh!.version!, { state: { ...fresh!.state, step: 2 } });
if (!updated) {
  // somebody was faster: read again and redo the change
}
```

#### deleteConversation(id)

Delete a conversation, its messages, its files (record and content) and its event log.

```typescript
await storage.deleteConversation('conv-123');
```

#### getConversations(params)

List conversations with filtering and pagination. Newest created first unless `orderBy` / `order` say otherwise.

```typescript
const { data, total, limit, offset, hasMore } = await storage.getConversations({
  agentId: 'assistant',
  userId: 'user-123',
  limit: 20,
  offset: 0,
  orderBy: 'updatedAt',
});
```

`data` is the page; every list method of the interface answers a [`PaginatedResult`](./types#paginatedresult).

### Messages

#### createMessage(params)

Create a new message. It counts as activity on its conversation (`updatedAt` moves).

```typescript
const message = await storage.createMessage({
  conversationId: 'conv-123',
  role: 'user',
  content: 'Hello!',
  files: [{ id: 'file-1', name: 'doc.pdf', mimeType: 'application/pdf', size: 1234 }],
});
```

#### getMessages(conversationId, params?)

A page of a conversation's messages, oldest first by default.

```typescript
const page = await storage.getMessages('conv-123', { limit: 50, order: 'desc' });
const older = await storage.getMessages('conv-123', { before: page.data.at(-1)!.id, limit: 50 });
// page.data: Message[]; page.total, page.hasMore describe the whole set that matched
```

`before` / `after` are message ids of the conversation; `offset` pages by position.

#### getMessage(id) / updateMessage(id, params) / deleteMessage(id)

`getMessage` resolves `null` for an unknown id. `updateMessage` (optional; the built-in providers have it) replaces a stored message's `content` and / or `metadata` - the server uses it to
record how an approval ended on the message that asked for it. `deleteMessage` keeps the message's files with the conversation.

### Files

#### saveFile(params)

Save a file.

```typescript
const file = await storage.saveFile({
  name: 'document.pdf',
  mimeType: 'application/pdf',
  content: Buffer.from('...'),
  conversationId: 'conv_1',          // optional: the file belongs to this conversation and goes with it
  userId: 'user-123',                // optional: who uploaded it (the file routes only show it to them)
  agentId: 'contracts',              // optional
  expiresAt: new Date(Date.now() + 30 * 86_400_000),   // optional: purgeExpiredFiles deletes it after this
  metadata: { source: 'upload' },
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

#### listFiles(params) / purgeExpiredFiles(params)

The file index (`capabilities().fileIndex`; all four built-in providers have it). `listFiles` gives a conversation's files, oldest first, as a `PaginatedResult`;
`purgeExpiredFiles` deletes the files that expired - record and content, earliest expiry first - and resolves how many.

```typescript
const page = await storage.listFiles!({ conversationId: 'conv_1', limit: 100, offset: 0, order: 'asc' });
const deleted = await storage.purgeExpiredFiles!({ before: new Date(), limit: 500 });
```

#### deleteFile(id)

Delete a file.

```typescript
await storage.deleteFile('file-123');
```

### Tasks

`createTask`, `getTask`, `getTasks`, `updateTask`, `deleteTask`, `createTaskResult`, `getTaskResult`. A task records the conversation it runs in
(`conversationId`, settable on create and update, filterable in `getTasks`) and can be `cancelled`.

### Events

`storage.events` is the conversation's durable event log (`undefined` when the provider has none; check `capabilities().events`).

```typescript
const events = storage.events!;

// append: atomic, ordered; seq is 1, 2, 3 ... per conversation, never repeated (MongoDB can leave a hole after a failed append)
const stored = await events.append('conv_1', [
  { type: 'user.message', data: { content: 'hi' }, runId: 'run_1' },
  { type: 'session.status_running', data: { trigger: 'message' }, runId: 'run_1' },
]);

// list: oldest first (order: 'desc' for newest first)
const page = await events.list('conv_1', { after: 40, types: ['agent.message'], limit: 100 });
// { events: ConversationEvent[], hasMore: boolean, lastSeq: number }

const summary = await events.summary!(['conv_1', 'conv_2']);
// { conv_1: { lastSeq: 41, stopReason: 'end_turn' } }   (conversations without events are left out)

await events.prune!(new Date(Date.now() - 30 * 86_400_000));   // delete older events; seq keeps counting
```

An unknown conversation is a `NotFoundError` on `append`. The log is deleted with its conversation.

### Leases

A time-limited claim on a key, held by one owner. The server holds `conv:<conversationId>` for the length of a run.

```typescript
const result = await storage.acquireLease!({ key: 'conv:conv_1', owner: 'node-a', ttlMs: 60_000, data: { runId: 'run_1' } });
if (result.acquired) {
  // result.lease; result.takenOver is the expired lease that was replaced, if any
} else {
  // result.lease is the holder's
}

await storage.renewLease!({ key, owner, ttlMs });        // Lease | null (null: lost)
await storage.releaseLease!({ key, owner });             // boolean
await storage.getLeases!([key1, key2]);                  // the live ones
await storage.markLeaseCancel!(key);                     // ask the holder to stop; it sees `cancelRequested` when it renews
await storage.listExpiredLeases!({ prefix: 'conv:' });   // the residue of holders that died, oldest first
```

## Capabilities

```typescript
storage.capabilities();
// { maxFileBytes, maxStateBytes, atomicUpdate, events, leases, fileIndex, actionDeadlines }
```

What the provider can hold and which optional parts it has; see the [guide](../guide/storage#capabilities-and-limits). A provider that omits `capabilities()` is treated as unbounded and without the optional parts.

## Error Handling

Storage operations throw typed errors, never a driver's:

- `NotFoundError` - an unknown parent (a message for a conversation that does not exist, an update of a missing record)
- `ValidationError` - a value the storage cannot hold (a title longer than the column)
- `StorageLimitError` - a file or a conversation state over the provider's limit (HTTP 413)
- Connection errors - the database is unreachable (a plain `Error` from the driver)

```typescript
import { NotFoundError } from '@cognipeer/agent-server';

try {
  await storage.updateConversation('invalid-id', { title: 'x' });
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('Conversation not found');
  }
}
```
