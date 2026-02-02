# Server API

The main `AgentServer` class and factory function.

## createAgentServer

Creates a new agent server instance.

```typescript
import { createAgentServer } from '@cognipeer/agent-server';

const agentServer = createAgentServer(config);
```

### Parameters

#### config

```typescript
interface AgentServerConfig {
  // Base path for all routes (e.g., '/api/agents')
  basePath: string;

  // Storage provider for persistence
  storage: StorageProvider;

  // Swagger UI configuration
  swagger?: {
    enabled: boolean;
    path?: string;        // Default: '/docs'
    title?: string;
    version?: string;
    description?: string;
  };

  // Authentication configuration
  auth?: {
    enabled: boolean;
    provider?: AuthProvider;
    headerName?: string;  // Default: 'Authorization'
    tokenPrefix?: string; // Default: 'Bearer '
    excludeRoutes?: string[];
    resolveUserId?: (ctx: ResolveContext) => Promise<string | undefined>;
  };

  // CORS configuration
  cors?: {
    enabled: boolean;
    origins?: string[];
    methods?: string[];
    headers?: string[];
  };
}
```

### Returns

`AgentServer` - The agent server instance.

## AgentServer

The main server class.

### Methods

#### registerSDKAgent

Register an agent created with `@cognipeer/agent-sdk`.

```typescript
agentServer.registerSDKAgent(id, agent, info?);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| id | `string` | Unique agent identifier |
| agent | `SmartAgent` | Agent from agent-sdk |
| info | `Partial<AgentInfo>` | Optional agent metadata |

```typescript
import { createSmartAgent } from '@cognipeer/agent-sdk';

const assistant = createSmartAgent({
  name: 'Assistant',
  model: myModel,
});

agentServer.registerSDKAgent('assistant', assistant, {
  description: 'A helpful assistant',
  version: '1.0.0',
});
```

#### registerCustomAgent

Register a custom agent handler.

```typescript
agentServer.registerCustomAgent(id, handler, info?);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| id | `string` | Unique agent identifier |
| handler | `AgentHandler` | Custom handler object |
| info | `Partial<AgentInfo>` | Optional agent metadata |

```typescript
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
}, {
  name: 'Echo Bot',
  description: 'Echoes messages',
});
```

#### getAgent

Get a registered agent by ID.

```typescript
const agent = agentServer.getAgent(id);
```

Returns `AgentRegistration | undefined`.

#### listAgents

List all registered agents.

```typescript
const agents = agentServer.listAgents();
```

Returns `AgentInfo[]`.

#### handleRequest

Process an HTTP request (used by adapters).

```typescript
const result = await agentServer.handleRequest(method, path, context);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| method | `string` | HTTP method |
| path | `string` | Request path |
| context | `RouteContext` | Request context |

Returns `Promise<RouteResult>`.

#### getOpenAPISpec

Get the OpenAPI specification.

```typescript
const spec = agentServer.getOpenAPISpec();
```

Returns the OpenAPI 3.0 specification object.

### Properties

#### storage

Access the storage provider.

```typescript
const storage = agentServer.storage;
```

#### config

Access the server configuration.

```typescript
const config = agentServer.config;
```

## AgentInfo

Agent metadata interface.

```typescript
interface AgentInfo {
  // Unique identifier
  id: string;

  // Display name
  name: string;

  // Description
  description?: string;

  // Version string
  version?: string;

  // Custom metadata
  metadata?: Record<string, unknown>;
}
```

## AgentHandler

Custom agent handler interface.

```typescript
interface AgentHandler {
  processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult>;
}
```

### ProcessMessageParams

```typescript
interface ProcessMessageParams {
  // Conversation ID
  conversationId: string;

  // User message
  message: string;

  // Attached files
  files?: FileAttachment[];

  // Conversation state
  state?: Record<string, unknown>;

  // Request metadata
  metadata?: Record<string, unknown>;
}
```

### ProcessMessageResult

```typescript
interface ProcessMessageResult {
  // Response content
  content: string;

  // Response files
  files?: FileAttachment[];

  // Updated state
  state?: Record<string, unknown>;

  // Response metadata
  metadata?: Record<string, unknown>;

  // Token usage
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}
```

## RouteContext

Request context passed to handlers.

```typescript
interface RouteContext {
  // Authenticated user (from auth provider)
  user?: AuthUser;

  // URL parameters (e.g., { id: '123' })
  params: Record<string, string>;

  // Query parameters
  query: Record<string, string | string[] | undefined>;

  // Request body
  body?: unknown;
}
```

## RouteResult

Handler response object.

```typescript
interface RouteResult<T = unknown> {
  // HTTP status code
  status: number;

  // Response body
  body?: T;

  // Response headers
  headers?: Record<string, string>;

  // Raw buffer (for file downloads)
  raw?: Buffer;

  // SSE stream generator
  stream?: AsyncGenerator<string, void, unknown>;
}
```

## Example Usage

```typescript
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createTokenAuthProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';
import { createSmartAgent, fromLangchainModel } from '@cognipeer/agent-sdk';
import { ChatOpenAI } from '@langchain/openai';

// Storage
const storage = createPostgresProvider({
  connectionString: process.env.DATABASE_URL,
});

// Auth
const auth = createTokenAuthProvider({
  tokens: { [process.env.API_KEY]: 'admin' },
});

// Server
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  auth: { enabled: true, provider: auth },
  swagger: { enabled: true },
});

// SDK Agent
const assistant = createSmartAgent({
  name: 'Assistant',
  model: fromLangchainModel(new ChatOpenAI()),
});

agentServer.registerSDKAgent('assistant', assistant);

// Custom Agent
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
});

// Express
const app = express();
app.use(express.json());

await storage.connect();
app.use(createExpressMiddleware(agentServer));

app.listen(3000);
```
