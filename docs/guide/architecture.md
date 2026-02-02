# Architecture

This page provides a detailed overview of the `@cognipeer/agent-server` architecture.

## Framework-Agnostic Core

The agent server is designed to be framework-agnostic. The core `AgentServer` class handles all business logic, while framework adapters handle HTTP specifics.

```typescript
// Core handles routing and logic
class AgentServer {
  constructor(config: AgentServerConfig);
  registerSDKAgent(id: string, agent: SmartAgent, info?: Partial<AgentInfo>): void;
  registerCustomAgent(id: string, handler: AgentHandler, info?: Partial<AgentInfo>): void;
  handleRequest(method: string, path: string, ctx: RouteContext): Promise<RouteResult>;
}

// Adapters translate HTTP
createExpressMiddleware(server: AgentServer): RequestHandler;
createNextRouteHandlers(server: AgentServer): NextRouteHandlers;
```

## Module Structure

```
@cognipeer/agent-server
├── index.ts              # Main exports
├── server.ts             # AgentServer class
├── types.ts              # Type definitions
├── swagger.ts            # OpenAPI generation
├── adapters/
│   ├── express.ts        # Express adapter
│   └── next.ts           # Next.js adapter
└── providers/
    ├── auth/
    │   ├── token.ts      # Token auth provider
    │   └── jwt.ts        # JWT auth provider
    └── storage/
        ├── base.ts       # Base storage class
        ├── memory.ts     # In-memory storage
        ├── postgres.ts   # PostgreSQL storage
        └── mongodb.ts    # MongoDB storage
```

## Request Handling

### Route Registration

Routes are registered during server initialization:

```typescript
// Internal route structure
interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

// Routes are matched in order
const routes: Route[] = [
  { method: 'GET', pattern: /^\/agents$/, handler: listAgents },
  { method: 'GET', pattern: /^\/agents\/([^/]+)$/, handler: getAgent },
  // ...
];
```

### Route Context

Each request receives a context object:

```typescript
interface RouteContext {
  user?: AuthUser;              // Authenticated user
  params: Record<string, string>; // URL parameters
  query: Record<string, string>;  // Query parameters
  body?: unknown;                 // Request body
}
```

### Route Result

Handlers return a result object:

```typescript
interface RouteResult<T = unknown> {
  status: number;
  body?: T;
  headers?: Record<string, string>;
  raw?: Buffer;                   // For file downloads
  stream?: AsyncGenerator<string>; // For SSE streaming
}
```

## Agent Registration

### SDK Agents

SDK agents are wrapped to work with the server:

```typescript
registerSDKAgent(id: string, agent: SmartAgent, info?: Partial<AgentInfo>): void {
  this.agents.set(id, {
    type: 'sdk',
    agent,
    info: {
      id,
      name: info?.name ?? agent.name,
      description: info?.description,
      ...info,
    },
  });
}
```

### Custom Agents

Custom agents implement the `AgentHandler` interface:

```typescript
interface AgentHandler {
  processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult>;
}

interface ProcessMessageParams {
  conversationId: string;
  message: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
}

interface ProcessMessageResult {
  content: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
  usage?: TokenUsage;
}
```

## Storage Architecture

### Base Provider

All storage providers extend `BaseStorageProvider`:

```typescript
abstract class BaseStorageProvider {
  protected _connected: boolean = false;

  get isConnected(): boolean {
    return this._connected;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  // Conversations
  abstract createConversation(...): Promise<Conversation>;
  abstract getConversation(id: string): Promise<Conversation | null>;
  abstract updateConversation(...): Promise<Conversation>;
  abstract deleteConversation(id: string): Promise<void>;
  abstract listConversations(...): Promise<ListResult<Conversation>>;

  // Messages
  abstract createMessage(...): Promise<Message>;
  abstract getMessages(...): Promise<Message[]>;

  // Files
  abstract saveFile(...): Promise<FileRecord>;
  abstract getFile(id: string): Promise<FileRecord | null>;
  abstract getFileContent(id: string): Promise<Buffer | null>;
  abstract deleteFile(id: string): Promise<void>;
}
```

### Provider Implementations

Each provider implements storage-specific logic:

```typescript
// PostgreSQL
class PostgresProvider extends BaseStorageProvider {
  private pool: Pool;

  async connect() {
    await this.pool.connect();
    if (this.config.autoMigrate) {
      await this.runMigrations();
    }
  }
}

// MongoDB
class MongoDBProvider extends BaseStorageProvider {
  private client: MongoClient;
  private db: Db;

  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.config.database);
  }
}
```

## Authentication Flow

```
Request
   │
   ▼
┌──────────────────┐
│ Extract Token    │
│ from Header      │
└──────────────────┘
   │
   ▼
┌──────────────────┐
│ Auth Provider    │
│ Validate Token   │
└──────────────────┘
   │
   ├──── Invalid ──────▶ 401 Unauthorized
   │
   ▼
┌──────────────────┐
│ Add User to      │
│ Route Context    │
└──────────────────┘
   │
   ▼
Route Handler
```

## Streaming Architecture

SSE streaming is implemented using async generators:

```typescript
async *streamResponse(params: StreamParams): AsyncGenerator<string> {
  yield formatSSE('stream.start', { conversationId, messageId });

  for await (const chunk of agent.streamResponse(message)) {
    if (chunk.type === 'text') {
      yield formatSSE('stream.text', { text: chunk.text });
    }
    if (chunk.type === 'tool_call') {
      yield formatSSE('stream.tool_call', chunk.data);
    }
  }

  yield formatSSE('stream.done', { message: finalMessage });
}

function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

## Error Handling

Custom error types for proper HTTP responses:

```typescript
class AuthenticationError extends Error {
  statusCode = 401;
}

class NotFoundError extends Error {
  statusCode = 404;
}

class ValidationError extends Error {
  statusCode = 400;
}

// Error handling in routes
try {
  // Handle request
} catch (error) {
  if (error instanceof AuthenticationError) {
    return { status: 401, body: { error: error.message } };
  }
  // ...
}
```

## Next Steps

- [Express Integration](/guide/express)
- [Next.js Integration](/guide/nextjs)
- [Storage Providers](/guide/storage)
