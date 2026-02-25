# @cognipeer/agent-server

REST API server infrastructure - a ready-made API layer for AI agents.

## Features

- 🤖 **Agent SDK Integration**: Directly register agents built with `@cognipeer/agent-sdk`
- 🔧 **Custom Handler Support**: Integrate agents built with other libraries
- 💾 **Multiple Storage**: PostgreSQL and MongoDB support
- 🔐 **Authentication**: Token-based and JWT authentication
- 📚 **Swagger UI**: Automatic OpenAPI documentation
- 🌐 **Framework Agnostic**: Works with Express, Next.js, and other frameworks
- 📁 **File Management**: File uploads and viewing files sent by AI

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

# For Express
npm install express
```

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
} from '@cognipeer/agent-server';

const storage = createMongoDBProvider({
  connectionString: 'mongodb://localhost:27017/mydb',
});

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: { enabled: true },
});

// Register agents
// ...

// Connect to storage
await storage.connect();

// Export route handlers
export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /agents | List all agents |
| GET | /agents/:agentId | Agent details |
| GET | /conversations | List conversations |
| POST | /conversations | Create new conversation |
| GET | /conversations/:id | Conversation details and messages |
| PATCH | /conversations/:id | Update conversation |
| DELETE | /conversations/:id | Delete conversation |
| GET | /conversations/:id/messages | List messages |
| POST | /conversations/:id/messages | Send message |
| POST | /files | Upload file |
| GET | /files/:fileId | File metadata |
| GET | /files/:fileId/content | Download file |
| DELETE | /files/:fileId | Delete file |

## Storage Providers

### PostgreSQL

```typescript
import { createPostgresProvider } from '@cognipeer/agent-server';

const storage = createPostgresProvider({
  // With connection string
  connectionString: 'postgresql://user:pass@localhost:5432/mydb',

  // Or with separate parameters
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'user',
  password: 'pass',

  // Optional
  schema: 'public',          // Default: 'public'
  tablePrefix: 'agent_',     // Default: 'agent_server_'
  autoMigrate: true,         // Default: true - auto-create tables
  pool: {
    min: 2,
    max: 10,
  },
});

await storage.connect();
```

### MongoDB

```typescript
import { createMongoDBProvider } from '@cognipeer/agent-server';

const storage = createMongoDBProvider({
  connectionString: 'mongodb://localhost:27017/mydb',
  database: 'mydb',              // Optional
  collectionPrefix: 'agent_',    // Default: 'agent_server_'
  autoIndex: true,               // Default: true
});

await storage.connect();
```

## Authentication

### Token-Based Auth

```typescript
import { createTokenAuthProvider } from '@cognipeer/agent-server';

const authProvider = createTokenAuthProvider({
  // Static tokens
  tokens: {
    'my-api-key': 'user-1',
    'another-key': 'user-2',
  },

  // Or custom validation
  validateFn: async (token) => {
    const user = await myDatabase.findUserByToken(token);
    if (user) {
      return { valid: true, userId: user.id };
    }
    return { valid: false, error: 'Invalid token' };
  },
});

const agentServer = createAgentServer({
  // ...
  auth: {
    enabled: true,
    provider: authProvider,
    headerName: 'Authorization',    // Default
    tokenPrefix: 'Bearer ',         // Default
    excludeRoutes: ['/docs', '/docs/*'],  // Routes accessible without auth
  },
});
```

### JWT Auth

```typescript
import { createJWTAuthProvider } from '@cognipeer/agent-server';

const authProvider = createJWTAuthProvider({
  secret: 'my-jwt-secret',
  algorithm: 'HS256',           // Default
  issuer: 'my-app',             // Optional - for validation
  audience: 'my-api',           // Optional - for validation
  extractUserId: (payload) => payload.sub as string,
});
```

## Custom Agent Handler

You can integrate your own agent without using the SDK:

```typescript
agentServer.registerCustomAgent('my-agent', {
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
}, {
  name: 'My Custom Agent',
  description: 'A custom AI agent',
  version: '1.0.0',
  metadata: { capabilities: ['chat', 'files'] },
});
```

## Custom Storage Provider

You can create your own storage provider:

```typescript
import { BaseStorageProvider } from '@cognipeer/agent-server';

class MyStorageProvider extends BaseStorageProvider {
  async connect() {
    // Establish connection
    this._connected = true;
  }

  async disconnect() {
    // Close connection
    this._connected = false;
  }

  protected async _createConversation(id, params) {
    // Create conversation
  }

  // Implement other abstract methods...
}
```

## CORS Configuration

```typescript
const agentServer = createAgentServer({
  // ...
  cors: {
    enabled: true,
    origins: ['http://localhost:3000', 'https://myapp.com'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    headers: ['Content-Type', 'Authorization'],
  },
});
```

## Swagger UI

```typescript
const agentServer = createAgentServer({
  // ...
  swagger: {
    enabled: true,
    path: '/docs',           // Default: '/docs'
    title: 'My Agent API',   // API title
    version: '1.0.0',        // API version
    description: 'AI Agent REST API',
  },
});
```

You can access the Swagger UI at `{basePath}/docs`.
The OpenAPI spec is available at `{basePath}/docs/openapi.json`.

## Roadmap

- [ ] HTTP Event Stream (SSE) support - real-time response streaming
- [ ] WebSocket support
- [ ] Rate limiting
- [ ] Request logging
- [ ] Metrics and monitoring

## License

MIT
