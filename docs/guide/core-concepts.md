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
│  │  │  SDK Agent  │  │ Host Agent  │  │  Custom Agent   │  │ │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Storage Provider                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  PostgreSQL │  │   MongoDB   │  │  SQLite / Memory    │  │
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

Agents are the AI components that process messages. There are four ways to bring one:

#### SDK Agents

Created with `@cognipeer/agent-sdk`; they can use tools that need approval, ask the user questions, and read the conversation's files:

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

Simple handler interface for any AI backend; it answers once per message:

```typescript
agentServer.registerCustomAgent('my-agent', {
  processMessage: async ({ message, conversationId, files, state }) => {
    const response = await myAIService.chat(message);
    return {
      content: response.text,
      state: { lastInteraction: Date.now() },
    };
  },
}, { name: 'My agent' });
```

#### Host-backed Agents

An agent whose work runs in your own backend. It streams with typed events, pauses by returning `pendingActions`, and the server keeps the messages, the events and the pause
([Host-backed agents](./host-agents.md)):

```typescript
agentServer.registerHostAgent({
  info: { id: 'support', name: 'Support' },
  async invoke({ message }, { emit, signal }) {
    for await (const chunk of backend.stream(message, { signal })) emit({ type: 'text', text: chunk });
    return {};
  },
});
```

#### OpenAI-compatible endpoints

`registerChatCompletionsAgent` and `registerResponsesAgent` serve a Chat Completions or Responses API endpoint as an agent ([Custom Agents](./custom-agents.md)).

### Storage Providers

Storage providers handle persistence of conversations, messages, files, tasks and the event log. All four behave the same ([Storage Providers](./storage.md)):

```typescript
// PostgreSQL
const storage = createPostgresProvider({
  connectionString: 'postgresql://...',
});

// MongoDB
const storage = createMongoDBProvider({
  connectionString: 'mongodb://...',
});

// SQLite (one process)
const storage = createSQLiteProvider({ filename: './data/agent-server.db' });

// Memory (for development)
const storage = createInMemoryProvider();
```

### Auth

Token providers validate requests and identify users; `resolveContext` is the way to bring your own identity (a session cookie) and per-request data ([Request Context](./request-context.md)).
Conversations belong to the user who created them, and the lists return one user's.

```typescript
// Token-based
const auth = createTokenAuthProvider({
  tokens: { 'api-key-1': 'user-1' },
});

// JWT (verifies the signature with the secret; see Authentication for what else it checks)
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
2. **Adapter** - Framework adapter parses request (and validates the token)
3. **Context** - `resolveContext` names the user and carries your data
4. **Router** - Routes to appropriate handler
5. **Run** - A message becomes a run: one per conversation, detached from the connection
6. **Agent** - Processes the message (and may pause for an approval)
7. **Storage** - Saves the messages, the pause and the event log
8. **Response** - Returns the result (or streams it)

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
  // in API responses: where the conversation is in its run lifecycle, and its budget
  runtime?: { status: 'idle' | 'running' | 'requires_action' | 'budget_paused'; stopReason?: string; lastEventSeq: number; pendingActionIds: string[] };
  budget?: { maxCostUsd: number; onReach: 'pause' | 'stop' } | null;
  spentUsd?: number;
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

```
// Client sends a message with streaming enabled
POST /conversations/:id/messages
{ "message": "Hello", "stream": true }

// Server responds with SSE: one JSON object per `data:` line
data: {"type":"stream.start","conversationId":"...","messageId":"...","seq":2}

data: {"type":"stream.text","text":"Hello","isFinal":false,"seq":2}

data: {"type":"stream.text","text":" there!","isFinal":false,"seq":2}

data: {"type":"stream.done","conversationId":"...","messageId":"...","content":"Hello there!","stopReason":"end_turn","runId":"run_x1","seq":5}
```

Closing the connection does not stop the turn; pick it up again with the event stream ([Streaming](./streaming.md), [Runs, Cancel & Reattach](./runs.md)).

## Next Steps

- [Architecture](/guide/architecture) - Detailed architecture
- [Storage Providers](/guide/storage) - Database setup
- [Authentication](/guide/authentication) - Securing your API
