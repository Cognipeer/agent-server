# Storage Providers

Storage providers persist conversations, messages, files and tasks. The package ships four. They are
tested against one shared contract, so an application behaves the same on all of them; what differs is
how much each can hold, whether it survives a restart, and whether several server instances can share it.

| | Memory | SQLite | PostgreSQL | MongoDB |
| --- | --- | --- | --- | --- |
| Import | `createInMemoryProvider` | `createSQLiteProvider` | `createPostgresProvider` | `createMongoDBProvider` |
| Survives a restart | no | yes (a file) | yes | yes |
| Several server instances | no | no (one host) | yes | yes |
| Peer dependency | none | `better-sqlite3` | `pg` | `mongodb` |
| Largest file | `maxFileStorage` (100 MB) | 1 GB | 1 GB | memory (GridFS) |
| Largest conversation state | memory | 1 GB | 250 MiB | **12 MiB** (`maxStateBytes`) |
| File content lives in | process memory | a table (BLOB) | a table (BYTEA) | GridFS |

**Which one?** PostgreSQL for production. MongoDB if that is what you run; mind the state limit below.
SQLite for a single server, a desktop app or a demo. Memory for tests.

## What every provider does the same

The provider contract (`test/storage/contract.ts` in the repository) runs against all four, with a real
database each. In short:

- **Ordering.** Lists and messages are ordered by creation time, and rows created in the same millisecond keep
  their insertion order. Conversations and tasks are listed newest first by default.
- **JSON fields** (`metadata`, `state`, message `content`, tool calls, ...) read back exactly as `JSON.parse(JSON.stringify(value))`
  would give: no `undefined`, no `null` where a field was left out, `Date`s as ISO strings, keys with `$` or `.` kept, and
  text that looks like JSON (`"42"`, `"true"`, `'{"a":1}'`) stays text. String values may contain NUL characters.
- **Absent values** read as `undefined`: no `userId`, no `title`, `files: []` is read as no files. `metadata` and `state` default to `{}`.
- **Copies.** What you get back is yours; changing it never changes what is stored.
- **Messages.** A message counts as activity on its conversation (`updatedAt` moves). `getMessages` pages with
  `limit` / `offset`, or around a message with `before` / `after` (a message id). A message for an unknown conversation
  is refused with a 404.
- **Files.** Content is returned as a `Buffer` with the bytes that were saved, up to the provider's limit.
  A file whose record is refused (unknown conversation or message) leaves no content behind.
  Deleting a conversation deletes its files and their content; deleting a message keeps its files with the conversation.
  A file attached to a message belongs to that message's conversation.
- **Tasks.** Comments are stored (with real `Date`s). A task has one result: creating another replaces the first
  (the `waiting_for_input` cycle writes a partial result, then the final one).
- **Limits are typed.** A write the provider cannot hold is a `StorageLimitError` (HTTP 413, `STORAGE_LIMIT_EXCEEDED`);
  a value a column cannot hold is a `ValidationError` (400); an unknown parent is a `NotFoundError` (404). Never a driver error.

### Capabilities and limits

Every built-in provider reports what it can hold:

```typescript
storage.capabilities();
// { maxFileBytes, maxStateBytes, atomicUpdate, events, leases }
```

The server uses it in three places:

- **Startup.** `limits.maxFileSize` or `limits.maxStateBytes` set above what the provider can hold is a configuration
  error: `createAgentServer` throws instead of failing on the first big upload. When `limits.maxFileSize` is not set,
  uploads are limited to 10 MiB or to the provider's limit, whichever is smaller.
- **Pauses.** A turn that pauses for a tool approval or a question stores its state (the paused agent run) in the
  conversation. If that state would not fit (`limits.maxStateBytes`, or the provider's `maxStateBytes`), the turn is **not**
  paused: it finishes, and the assistant message carries a `pause_state_too_large` warning (`metadata.warnings`,
  and `warnings` on the response / `stream.done`). See [Human in the loop](./human-in-the-loop.md).
- **Uploads.** A file over `maxFileBytes` is refused with a 413 before anything is stored.

```typescript
createAgentServer({
  storage,
  limits: {
    maxFileSize: 50 * 1024 * 1024,   // upload limit
    maxStateBytes: 4 * 1024 * 1024,  // refuse to pause with a bigger state
    messagePageSize: 50,             // default page of GET /conversations/:id (default 100)
    maxPageSize: 200,                // largest `limit` a client can ask for (default 200)
  },
});
```

### Long conversations

The agent always sees the **whole** conversation: the server reads the history in pages until there is no more.
`GET /conversations/:id` returns one page of messages, the **newest** `limit` by default (oldest first within the
page), with `messagesPage` telling whether there is more on either side:

```http
GET /conversations/conv_1                         # newest 100 messages
GET /conversations/conv_1?before=msg_9&limit=50   # the 50 just older than msg_9
GET /conversations/conv_1?after=msg_9             # the ones newer than msg_9
GET /conversations/conv_1?order=desc              # newest first
```

```json
{ "conversation": {}, "messages": [], "messagesPage": { "limit": 100, "order": "asc", "hasMoreBefore": true, "hasMoreAfter": false } }
```

## PostgreSQL

The recommended storage provider for production.

```bash
npm install pg
```

```typescript
import { createPostgresProvider } from '@cognipeer/agent-server';

const storage = createPostgresProvider({
  connectionString: process.env.DATABASE_URL,
  // or host / port / database / user / password

  schema: 'public',           // default 'public'
  tablePrefix: 'agent_',      // default 'agent_server_'
  autoMigrate: true,          // default true: create / upgrade the tables on connect
  pool: { max: 10 },
});

await storage.connect();
```

### Tables

With `autoMigrate: true` the provider creates (and upgrades) these tables, all named `<prefix><name>`:

| Table | Holds |
| --- | --- |
| `conversations` | `id`, `agent_id`, `user_id`, `title`, `metadata` / `state` (JSONB), `created_at`, `updated_at`, `seq` |
| `messages` | `id`, `conversation_id` (cascade), `role`, `content` (JSONB), `name`, `tool_calls`, `tool_call_id`, `files`, `metadata`, times, `seq` |
| `files` | the file record: `name`, `mime_type`, `size`, `storage_key`, `conversation_id`, `message_id`, `metadata` |
| `file_contents` | `storage_key`, `content` (BYTEA) |
| `tasks` | `agent_id`, `user_id`, `status`, `callback_url`, `input`, `files`, `comments` (JSONB), `metadata`, times, `error`, `seq` |
| `task_results` | `task_id` (unique), `content`, `files`, `metadata`, `usage` |
| `meta` | `schema_version` |

`seq` is the insertion sequence that orders rows created in the same millisecond.

Indexes are named `idx_<prefix>...`, so several prefixes can share a schema:

```sql
-- conversations: (agent_id, created_at, seq), (user_id, created_at, seq), (created_at, seq), (updated_at, seq)
-- messages:      (conversation_id, created_at, seq)
-- files:         (conversation_id), (message_id)
-- tasks:         (agent_id, created_at, seq), (user_id, created_at, seq), (status, created_at, seq), (created_at, seq)
-- task_results:  UNIQUE (task_id)
```

### Upgrading

The schema carries a version (`meta.schema_version`). Connecting an older database runs the missing steps once, under an advisory lock,
so a fleet starting together is safe: it adds `tasks.comments` and the `seq` columns, keeps only the newest result of tasks that had
several, adds the indexes above and drops the old unprefixed ones **if they belong to this prefix's tables**. Nothing is deleted
besides the duplicate results.

### Things to know

- **Limits.** `title`, `agentId`, `userId`, file `name`, `mimeType` and a few other short fields are `VARCHAR`; a longer value is a `400`, not a 500.
- **NUL characters.** PostgreSQL refuses U+0000 in text and JSONB. The provider stores it as an escape (U+0001 followed by `0`, with U+0001 itself doubled)
  and decodes it on the way out, so every value reads back as written. Direct SQL on those columns sees the escaped form.
- **File size.** BYTEA holds 1 GB; the whole file is in memory while it is read or written.

## MongoDB

```bash
npm install mongodb       # driver 6 or newer
```

```typescript
import { createMongoDBProvider } from '@cognipeer/agent-server';

const storage = createMongoDBProvider({
  connectionString: 'mongodb://localhost:27017/mydb',
  database: 'mydb',               // optional if it is in the connection string
  collectionPrefix: 'agent_',     // default 'agent_server_'
  autoIndex: true,                // default true
  maxStateBytes: 12 * 1024 * 1024, // default 12 MiB, at most 15 MiB
});

await storage.connect();
```

### Collections

`<prefix>conversations`, `messages`, `files` (the records), `tasks`, `task_results`, and the GridFS bucket `<prefix>files`
(collections `<prefix>files.files` and `<prefix>files.chunks`), which holds the **content of every file**, whatever its size.
Content written by older versions in `<prefix>file_contents` is still read and deleted. GridFS creates its own two indexes the first time a file is written; with `autoIndex: false` and a user that may not create indexes, create them beforehand.

### Indexes

```javascript
// conversations
{ agentId: 1, createdAt: -1, seq: -1 }, { userId: 1, createdAt: -1, seq: -1 }, { createdAt: -1, seq: -1 }, { updatedAt: -1, seq: -1 }
// messages
{ conversationId: 1, createdAt: 1, seq: 1 }
// files
{ conversationId: 1 }, { messageId: 1 }, { storageKey: 1 } /* unique */
// tasks
{ agentId: 1, createdAt: -1, seq: -1 }, { userId: 1, ... }, { status: 1, ... }, { createdAt: -1, seq: -1 }
// task_results
{ taskId: 1 } /* unique */
```

On connect the provider also drops the single-field indexes of older versions that these cover.

### The 16 MiB document limit

MongoDB limits one document to 16 MiB. Files are not affected (GridFS), but a conversation keeps its `state` in its own document, and that
includes the paused agent run while a tool approval or a question is open. Two things follow:

- `maxStateBytes` (default **12 MiB**) is the most a conversation state may be. It is measured as BSON, which is bigger than JSON for
  numbers and long arrays. A larger state is refused with a `StorageLimitError` (413).
- A turn whose pause would not fit **is not paused** and finishes with a warning, see *Capabilities and limits* above. Lower
  `limits.maxStateBytes` if you want that to happen sooner.

A single message is also one document: content over about 16 MiB is refused with a 413.

`undefined` fields are not stored (the provider connects with `ignoreUndefined`), and keys with `$` or `.` inside `metadata`, `state` and message
content need MongoDB 5.0 or newer.

## SQLite

```bash
npm install better-sqlite3
```

```typescript
import { createSQLiteProvider } from '@cognipeer/agent-server';

const storage = createSQLiteProvider({
  filename: './data/agent-server.db',   // ':memory:' for a throwaway database
  tablePrefix: 'agent_server_',         // default
  autoMigrate: true,                    // default true
  walMode: true,                        // default true
});

await storage.connect();
```

The tables are the same as PostgreSQL's (`TEXT` JSON instead of JSONB, `BLOB` content). Rows created in the same millisecond keep their insertion
order through SQLite's `rowid`. The schema version is kept in `<prefix>meta`, and an older database is upgraded when it is opened.
One process should own the file; several server instances need PostgreSQL or MongoDB.

## Memory

```typescript
import { createInMemoryProvider } from '@cognipeer/agent-server';

const storage = createInMemoryProvider({
  maxFileStorage: 100 * 1024 * 1024,   // total bytes of files, also the largest file (default 100 MB)
  maxConversations: 1000,              // optional
  maxMessagesPerConversation: 5000,    // optional
});
await storage.connect();
```

::: warning
Memory storage loses all data when the process restarts. Use it for development and tests. Anything over its limits is a `StorageLimitError` (413).
:::

## Custom storage

To put your own database or an existing system behind the API, extend `BaseStorageProvider` or implement `StorageProvider`.
See [Custom Storage](./custom-storage.md), which also lists what a provider has to do to follow the contract above.

## Using a provider

```typescript
// Conversations
const conversation = await storage.createConversation({ agentId: 'assistant', userId: 'user-123', title: 'New Chat' });
const found = await storage.getConversation(conversation.id);
await storage.updateConversation(conversation.id, { title: 'Updated Title' });
const { data, total, hasMore } = await storage.getConversations({ agentId: 'assistant', userId: 'user-123', limit: 20, offset: 0 });
await storage.deleteConversation(conversation.id);          // also deletes its messages and files

// Messages
await storage.createMessage({ conversationId: conversation.id, role: 'user', content: 'Hello!' });
const page = await storage.getMessages(conversation.id, { limit: 50, order: 'desc' });
const older = await storage.getMessages(conversation.id, { before: page.data.at(-1)!.id, limit: 50 });

// Files
const file = await storage.saveFile({ name: 'document.pdf', mimeType: 'application/pdf', content: Buffer.from('...'), conversationId: conversation.id });
const bytes = await storage.getFileContent(file.id);         // Buffer
await storage.deleteFile(file.id);
```

## Next Steps

- [Authentication](/guide/authentication)
- [File Management](/guide/file-management)
- [Custom Storage](/guide/custom-storage)
