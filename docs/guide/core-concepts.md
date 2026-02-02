# Core Concepts

Understanding the core concepts of `@cognipeer/agent-server` will help you build robust AI agent APIs.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Request                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Framework Adapter                         │
│              (Express, Next.js, etc.)                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Agent Server                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Router    │  │    Auth     │  │   Swagger/OpenAPI   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                              │                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    Agent Registry                        │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │ │
│  │  │  SDK Agent  │  │ SDK Agent   │  │  Custom Agent   │  │ │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Storage Provider                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  PostgreSQL │  │   MongoDB   │  │      Memory         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### Agent Server

The core class that handles routing, agent registration, and request processing.

```typescript
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: { enabled: true },
  auth: { enabled: true, provider: authProvider },
  cors: { enabled: true, origins: ['http://localhost:3000'] },
});
```

### Agents

Agents are the AI components that process messages. There are two types:

#### SDK Agents

Created with `@cognipeer/agent-sdk`:

```typescript
import { createSmartAgent } from '@cognipeer/agent-sdk';

const assistant = createSmartAgent({
  name: 'Assistant',
  model: myModel,
  tools: [myTool],
});

agentServer.registerSDKAgent('assistant', assistant);
```

#### Custom Agents

Simple handler interface for any AI backend:

```typescript
agentServer.registerCustomAgent('my-agent', {
  processMessage: async ({ message, conversationId, files, state }) => {
    const response = await myAIService.chat(message);
    return {
      content: response.text,
      state: { lastInteraction: Date.now() },
    };
  },
});
```

### Storage Providers

Storage providers handle persistence of conversations, messages, and files.

```typescript
// PostgreSQL
const storage = createPostgresProvider({
  connectionString: 'postgresql://...',
});

// MongoDB
const storage = createMongoDBProvider({
  connectionString: 'mongodb://...',
});

// Memory (for development)
const storage = createMemoryProvider();
```

### Auth Providers

Authentication providers validate requests and identify users.

```typescript
// Token-based
const auth = createTokenAuthProvider({
  tokens: { 'api-key-1': 'user-1' },
});

// JWT
const auth = createJWTAuthProvider({
  secret: 'your-secret',
});
```

### Framework Adapters

Adapters translate HTTP framework requests to the agent server interface.

```typescript
// Express
app.use(createExpressMiddleware(agentServer));

// Next.js
export const { GET, POST, PATCH, DELETE } = createNextRouteHandlers(agentServer);
```

## Request Flow

1. **Client Request** - HTTP request from client
2. **Adapter** - Framework adapter parses request
3. **Authentication** - Auth provider validates token
4. **Router** - Routes to appropriate handler
5. **Agent** - Processes message with AI
6. **Storage** - Saves conversation/messages
7. **Response** - Returns result (or streams)

## Data Model

### Conversation

```typescript
interface Conversation {
  id: string;
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

### Message

```typescript
interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  files?: FileAttachment[];
  createdAt: Date;
  updatedAt: Date;
}
```

### File Attachment

```typescript
interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  storageKey?: string;
}
```

## Streaming

The server supports Server-Sent Events (SSE) for real-time streaming:

```typescript
// Client sends message with streaming enabled
POST /conversations/:id/messages
{
  "message": "Hello",
  "streaming": true
}

// Server responds with SSE stream
event: stream.start
data: {"conversationId":"...","messageId":"..."}

event: stream.text
data: {"text":"Hello","isFinal":false}

event: stream.text
data: {"text":" there!","isFinal":false}

event: stream.done
data: {"message":{...}}
```

## Next Steps

- [Architecture](/guide/architecture) - Detailed architecture
- [Storage Providers](/guide/storage) - Database setup
- [Authentication](/guide/authentication) - Securing your API
