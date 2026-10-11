# @cognipeer/agent-server

REST API server infrastructure - a ready-made API layer for AI agents.


Documentation: <https://docs.cognipeer.com/agent-server/guide/getting-started>

## Features

- 🤖 **Agent SDK Integration**: Directly register agents built with `@cognipeer/agent-sdk`
- 🔧 **Custom Handler Support**: Integrate agents built with other libraries
- 🏠 **Host-backed agents**: serve an agent that runs in your own backend - it streams with typed events, pauses for approvals by returning `pendingActions`, is cancelled through a signal and a hook, and the server keeps the messages, the events and the pause (`registerHostAgent`)
- 💾 **Multiple Storage**: PostgreSQL, MongoDB (GridFS for files), SQLite and in-memory, all tested against one provider contract
- 🔐 **Authentication & tenancy**: token and JWT providers, or your own identity per request; conversations belong to their user, and a list that names no user is refused (`allowAnonymousList` opts out)
- 📚 **Swagger UI**: Automatic OpenAPI documentation
- 🌐 **Framework Agnostic**: Works with Express, Next.js, Fastify, and raw Node HTTP
- 🧩 **Request Context & Dynamic Agents**: Resolve user/tenant per request, serve a different agent list and storage scope per request
- 📁 **Files the agent reads**: upload a file as itself or as JSON; it is owned by the uploader, limited per agent, deleted after `retentionDays` or with its conversation, and its text (PDF and Office with `@cognipeer/to-markdown`) or picture reaches the agent - inline, in pages with `session_files_read`, or as an image by reference
- ✅ **Approvals that hold up**: several people can answer the actions of one pause at once without losing an answer, requests lapse (and are denied or dropped) instead of waiting for ever, you decide who may answer, edited arguments are checked against the tool's schema, and the paused message records who decided what
- 💰 **Usage & budgets**: per-turn usage from agent-sdk's ledger (a resumed turn is never counted twice), cost from your price list, a spend limit per conversation that stops a turn, waits for a raise, and carries on (`POST /continue`)
- 💬 **A chat around the conversation**: regenerate an answer, edit a message and resend, pin / rename / bulk-delete conversations, generated titles, starters and a welcome text, thumbs up / down with reasons, and export as Markdown, JSON or a print page - see [Chat experience](docs/guide/chat-experience.md)
- 🪟 **Embeddable**: per-request bearer auth (no cookies), `client_tool` requests that run in the embedding page, a `rateLimit` hook with release for stream caps, and an `audit` hook - see [Embedding & limits](docs/guide/embedding.md)
- ⏯️ **Runs that outlive the connection**: a turn keeps running when the client disconnects; cancel it, follow it from another client (event log + SSE), one turn at a time per conversation across server instances

## Installation

```bash
npm install @cognipeer/agent-server
```

You also need to install the storage provider and framework you want to use:

```bash
# For PostgreSQL
npm install pg

# For MongoDB
npm install mongodb

# For SQLite (one process, one file)
npm install better-sqlite3

# For Express
npm install express
```

A complete runnable server - SQLite or MongoDB, an agent-sdk agent with approvals and files, a host-backed agent - is in [`examples/standalone`](examples/standalone).

## Quick Start

### Usage with Express

```typescript
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';
import { createSmartAgent } from '@cognipeer/agent-sdk';

// Create storage provider
const storage = createPostgresProvider({
  connectionString: 'postgresql://user:pass@localhost:5432/mydb',
});

// Create agent server
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  allowAnonymousList: true, // a quick start with no sign-in: see "Who may list" in Request Context
  swagger: {
    enabled: true,
    path: '/docs',
    title: 'My Agent API',
  },
  auth: {
    enabled: false, // Disabled for now
  },
});

// Register SDK agent
const myAgent = createSmartAgent({
  name: 'Assistant',
  model: myLLMModel,
  tools: [...],
});
agentServer.registerSDKAgent('assistant', myAgent, {
  description: 'A helpful assistant',
});

// Register custom agent
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
}, {
  name: 'Echo Bot',
  description: 'Echoes your messages',
});

// Create Express app
const app = express();
app.use(express.json());

// Connect to storage and start server
await storage.connect();
app.use(createExpressMiddleware(agentServer));

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('Swagger UI at http://localhost:3000/api/agents/docs');
});
```

### Usage with Next.js App Router

```typescript
// app/api/agents/[...path]/route.ts
import {
  createAgentServer,
  createMongoDBProvider,
  createNextRouteHandlers,
} from "@cognipeer/agent-server";

const storage = createMongoDBProvider({
  connectionString: "mongodb://localhost:27017/mydb",
});

const agentServer = createAgentServer({
  basePath: "/api/agents",
  storage,
  allowAnonymousList: true, // a quick start with no sign-in: see "Who may list" in Request Context
  swagger: { enabled: true },
});

// Register agents
// ...

// Connect to storage
await storage.connect();

// Export route handlers
export const { GET, POST, PATCH, DELETE, OPTIONS } =
  createNextRouteHandlers(agentServer);
```

## API Endpoints

| Method | Endpoint                    | Description                       |
| ------ | --------------------------- | --------------------------------- |
| GET    | /agents                     | List all agents                   |
| GET    | /agents/:agentId            | Agent details                     |
| GET    | /conversations              | List conversations                |
| POST   | /conversations              | Create new conversation           |
| GET    | /conversations/:id          | Conversation details and messages |
| PATCH  | /conversations/:id          | Update conversation (title, metadata, budget) |
| DELETE | /conversations/:id          | Delete conversation               |
| GET    | /conversations/:id/messages | List messages                     |
| POST   | /conversations/:id/messages | Send message                      |
| POST   | /conversations/:id/actions/:actionId | Resolve a pending tool approval / question |
| POST   | /conversations/:id/continue | Carry on a turn the budget stopped |
| GET    | /conversations/:id/remembered-tools | Tools approved "for the session" |
| DELETE | /conversations/:id/remembered-tools/:tool | Forget one: it asks again |
| POST   | /conversations/:id/cancel   | Cancel the running turn (or the open approvals) |
| GET    | /conversations/:id/events   | The conversation's event log  |
| GET    | /conversations/:id/events/stream | Replay and follow the event log (SSE) |
| GET    | /conversations/:id/files    | The files the conversation holds  |
| POST   | /files                      | Upload a file (its bytes, or JSON) |
| GET    | /files/:fileId              | File metadata                     |
| GET    | /files/:fileId/content      | Download file                     |
| DELETE | /files/:fileId              | Delete file                       |
| POST   | /tasks                      | Create a background task          |
| GET    | /tasks                      | List tasks                        |
| GET    | /tasks/:taskId              | Task details (and result)         |
| GET    | /tasks/:taskId/status       | Task status                       |
| GET    | /tasks/:taskId/result       | Task result                       |
| POST   | /tasks/:taskId/cancel       | Cancel a task                     |
| GET / POST | /tasks/:taskId/comments | Read / add comments (continue the task) |

`GET /conversations` and `GET /tasks` list one user's records and need a user (`401 identity_required` otherwise, unless `allowAnonymousList: true`).
The full reference is in [docs/api/endpoints.md](docs/api/endpoints.md); the server serves its own OpenAPI document at `{basePath}/docs/openapi.json`.

## Storage Providers

### PostgreSQL

```typescript
import { createPostgresProvider } from "@cognipeer/agent-server";

const storage = createPostgresProvider({
  // With connection string
  connectionString: "postgresql://user:pass@localhost:5432/mydb",

  // Or with separate parameters
  host: "localhost",
  port: 5432,
  database: "mydb",
  user: "user",
  password: "pass",

  // Optional
  schema: "public", // Default: 'public'
  tablePrefix: "agent_", // Default: 'agent_server_'
  autoMigrate: true, // Default: true - auto-create tables
  pool: {
    min: 2,
    max: 10,
  },
});

await storage.connect();
```

### MongoDB

```typescript
import { createMongoDBProvider } from "@cognipeer/agent-server";

const storage = createMongoDBProvider({
  connectionString: "mongodb://localhost:27017/mydb",
  database: "mydb", // Optional
  collectionPrefix: "agent_", // Default: 'agent_server_'
  autoIndex: true, // Default: true
});

await storage.connect();
```

### SQLite

```typescript
import { createSQLiteProvider } from "@cognipeer/agent-server";

const storage = createSQLiteProvider({
  filename: "./data/agent-server.db", // ':memory:' for a throwaway database
});

await storage.connect();
```

One process owns the file; several server instances need PostgreSQL or MongoDB. See [docs/guide/storage.md](docs/guide/storage.md) for what each provider can hold.

## Authentication

### Token-Based Auth

```typescript
import { createTokenAuthProvider } from "@cognipeer/agent-server";

const authProvider = createTokenAuthProvider({
  // Static tokens
  tokens: {
    "my-api-key": "user-1",
    "another-key": "user-2",
  },

  // Or custom validation
  validateFn: async (token) => {
    const user = await myDatabase.findUserByToken(token);
    if (user) {
      return { valid: true, userId: user.id };
    }
    return { valid: false, error: "Invalid token" };
  },
});

const agentServer = createAgentServer({
  // ...
  auth: {
    enabled: true,
    provider: authProvider,
    headerName: "Authorization", // Default
    tokenPrefix: "Bearer ", // Default
    excludeRoutes: ["/docs", "/docs/*"], // Routes accessible without auth
  },
});
```

### JWT Auth

```typescript
import { createJWTAuthProvider } from "@cognipeer/agent-server";

const authProvider = createJWTAuthProvider({
  secret: "my-jwt-secret",
  algorithm: "HS256", // Default
  issuer: "my-app", // Optional - for validation
  audience: "my-api", // Optional - for validation
  extractUserId: (payload) => payload.sub as string,
});
```

The built-in JWT provider verifies the token's signature with the configured key (HS256/384/512, RS256/384/512 or ES256/384/512; the algorithm comes from the configuration, never from the
token) and checks expiry, issuer and audience. It holds one static key and has no JWKS support: for keys that rotate, verify in front of the server or write an `AuthProvider` with a JWT
library - see [docs/guide/authentication.md](docs/guide/authentication.md).

## Custom Agent Handler

You can integrate your own agent without using the SDK:

```typescript
agentServer.registerCustomAgent(
  "my-agent",
  {
    processMessage: async (params) => {
      const { conversationId, message, files, state, metadata } = params;

      // Your own AI logic
      const response = await myAIService.chat(message, {
        history: await getHistory(conversationId),
        files,
      });

      return {
        content: response.text,
        files: response.attachments,
        state: { ...state, lastMessageAt: new Date() },
        usage: {
          inputTokens: response.usage.prompt,
          outputTokens: response.usage.completion,
          totalTokens: response.usage.total,
        },
      };
    },
  },
  {
    name: "My Custom Agent",
    description: "A custom AI agent",
    version: "1.0.0",
    metadata: { capabilities: ["chat", "files"] },
  },
);
```

## Host-backed agents

An agent that runs in your own backend streams with typed events and returns a typed result; the server stores the messages, the pending actions, the events and the runtime status:

```typescript
agentServer.registerHostAgent({
  info: { id: "support", name: "Support", capabilities: { toolApproval: true } },

  async invoke({ message, history, files, context }, { emit, signal }) {
    for await (const chunk of backend.stream(message, { signal })) emit({ type: "text", text: chunk });
    const run = await backend.finish();
    return run.needsApproval
      ? { pendingActions: [{ id: run.requestId, type: "tool_approval", toolName: run.tool, args: run.args }] }
      : { usage: run.usage };
  },
  async resolveAction({ actionId, resolution }, { emit, signal }) {
    return { content: (await backend.answer(actionId, resolution, { signal })).text };
  },
  async cancel({ runId, reason }) { await backend.cancel(runId); },
});
```

See [docs/guide/host-agents.md](docs/guide/host-agents.md).

## Request Context & Dynamic Agents

Resolve who is calling (and anything else your host knows, e.g. tenant) once per
request. The result reaches agents, storage and `resolveUserId`:

```typescript
const server = createAgentServer({
  basePath: "/api/portal",
  storage, // receives the context as its last argument on every call
  resolveContext: async (req) => {
    const session = await lookupSession(req.cookies.sid); // req.headers / req.query / req.mountParams too
    return session ? { user: { id: session.userId }, data: { tenantId: session.tenantId } } : null; // null -> 401
  },
  // array, or resolved per request
  agents: async (ctx) => loadAgentsFor(ctx.data.tenantId as string),
});
```

With `resolveContext` set the resolved identity is authoritative: `userId` sent by
the client is ignored, and conversations owned by another user answer 403. The lists return the
resolved user's own, and a request with no user cannot list (`401 identity_required`; a single-user
server sets `allowAnonymousList: true`).
Unknown agents (not served to this request) answer 404. See
[docs/guide/request-context.md](docs/guide/request-context.md).

### Fastify and raw Node

```typescript
import Fastify from "fastify";
import { mountOnFastify } from "@cognipeer/agent-server/fastify";

const app = Fastify();
// the prefix may be parameterised; params arrive as req.mountParams in resolveContext
mountOnFastify(app, server, { prefix: "/api/portal/:portalKey" });
```

```typescript
import http from "node:http";
import { createNodeHandler } from "@cognipeer/agent-server";

const handle = createNodeHandler(server); // serves under server basePath
http.createServer(async (req, res) => {
  if (!(await handle(req, res))) { res.statusCode = 404; res.end(); }
}).listen(3000);
```

## Custom Storage Provider

Extend `BaseStorageProvider` (connection check + ids) and implement the `_`-hooks,
or implement the `StorageProvider` interface directly. Every hook receives the
per-request `RequestContext` as its last argument:

```typescript
import { BaseStorageProvider, type RequestContext } from "@cognipeer/agent-server";

class MyStorageProvider extends BaseStorageProvider {
  async connect() { this._connected = true; }
  async disconnect() { this._connected = false; }

  protected async _createConversation(id, params, ctx?: RequestContext) {
    // e.g. stamp ctx?.data.tenantId so reads can be scoped
  }
  protected async _getConversation(id, ctx?: RequestContext) { /* scope by ctx */ }

  // ...implement the other abstract methods (see docs/guide/custom-storage.md)
}
```

## CORS Configuration

```typescript
const agentServer = createAgentServer({
  // ...
  cors: {
    enabled: true,
    origins: ["http://localhost:3000", "https://myapp.com"],
    methods: ["GET", "POST", "PATCH", "DELETE"],
    headers: ["Content-Type", "Authorization"],
  },
});
```

## Swagger UI

```typescript
const agentServer = createAgentServer({
  // ...
  swagger: {
    enabled: true,
    path: "/docs", // Default: '/docs'
    title: "My Agent API", // API title
    version: "1.0.0", // API version
    description: "AI Agent REST API",
  },
});
```

You can access the Swagger UI at `{basePath}/docs`.
The OpenAPI spec is available at `{basePath}/docs/openapi.json`.

## Roadmap

- [ ] WebSocket support
- [ ] Rate limiting
- [ ] Request logging
- [ ] Metrics and monitoring

## License

MIT
