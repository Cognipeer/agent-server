# Next.js Integration

This guide covers integrating `@cognipeer/agent-server` with Next.js App Router.

## Installation

```bash
npm install @cognipeer/agent-server
```

## Basic Setup

Create a catch-all route handler:

```typescript
// app/api/agents/[...path]/route.ts
import {
  createAgentServer,
  createMemoryProvider,
  createNextRouteHandlers,
} from '@cognipeer/agent-server';

// Create storage (use PostgreSQL or MongoDB in production)
const storage = createMemoryProvider();

// Create agent server
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: { enabled: true },
});

// Register agents
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
}, {
  name: 'Echo Bot',
  description: 'A simple echo bot',
});

// Connect storage
await storage.connect();

// Export route handlers
export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## With PostgreSQL

```typescript
// lib/agent-server.ts
import {
  createAgentServer,
  createPostgresProvider,
} from '@cognipeer/agent-server';
import { createSmartAgent, fromLangchainModel } from '@cognipeer/agent-sdk';
import { ChatOpenAI } from '@langchain/openai';

// Create storage provider
const storage = createPostgresProvider({
  connectionString: process.env.DATABASE_URL!,
});

// Create agent
const model = fromLangchainModel(new ChatOpenAI({
  modelName: 'gpt-4',
  openAIApiKey: process.env.OPENAI_API_KEY,
}));

const assistant = createSmartAgent({
  name: 'Assistant',
  model,
  tools: [],
});

// Create server
export const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: { enabled: true },
});

// Register agent
agentServer.registerSDKAgent('assistant', assistant);

// Initialize storage
let initialized = false;

export async function initializeServer() {
  if (!initialized) {
    await storage.connect();
    initialized = true;
  }
}
```

```typescript
// app/api/agents/[...path]/route.ts
import { createNextRouteHandlers } from '@cognipeer/agent-server';
import { agentServer, initializeServer } from '@/lib/agent-server';

await initializeServer();

export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## With Authentication

```typescript
// lib/agent-server.ts
import {
  createAgentServer,
  createPostgresProvider,
  createJWTAuthProvider,
} from '@cognipeer/agent-server';

const storage = createPostgresProvider({
  connectionString: process.env.DATABASE_URL!,
});

const authProvider = createJWTAuthProvider({
  secret: process.env.JWT_SECRET!,
  extractUserId: (payload) => payload.sub as string,
});

export const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  auth: {
    enabled: true,
    provider: authProvider,
    excludeRoutes: ['/docs', '/docs/*'],
  },
  swagger: { enabled: true },
});
```

## Separate Agents Route

You can also create a separate route for agents only:

```typescript
// app/api/agents/[[...path]]/route.ts
// Note: [[...path]] makes the path optional

import { createNextRouteHandlers } from '@cognipeer/agent-server';
import { agentServer, initializeServer } from '@/lib/agent-server';

await initializeServer();

export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## Environment Variables

```env
# .env.local
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
OPENAI_API_KEY=sk-...
JWT_SECRET=your-secret-key
```

## Route Configuration

Configure routes in `next.config.js` if needed:

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@cognipeer/agent-server'],
  },
};

module.exports = nextConfig;
```

## Using with Server Actions

```typescript
// app/actions.ts
'use server';

import { agentServer, initializeServer } from '@/lib/agent-server';

export async function sendMessage(conversationId: string, message: string) {
  await initializeServer();
  
  // Use storage directly for server actions
  const result = await agentServer.storage.createMessage({
    conversationId,
    role: 'user',
    content: message,
  });
  
  return result;
}
```

## Client Component Integration

```tsx
// app/chat/page.tsx
'use client';

import { Chat } from '@cognipeer/chat-ui';
import '@cognipeer/chat-ui/styles.css';

export default function ChatPage() {
  return (
    <div className="h-screen">
      <Chat
        baseUrl="/api/agents"
        agentId="assistant"
        theme="dark"
      />
    </div>
  );
}
```

## Edge Runtime

For Edge Runtime, use a different approach:

```typescript
// app/api/agents/[...path]/route.ts
import { createNextRouteHandlers } from '@cognipeer/agent-server';
import { agentServer } from '@/lib/agent-server';

// Note: Edge runtime has limitations with some storage providers
export const runtime = 'nodejs'; // Use Node.js runtime

export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## Streaming Support

The Next.js adapter fully supports SSE streaming:

```typescript
// Client request with streaming
const response = await fetch('/api/agents/conversations/123/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    message: 'Hello!',
    streaming: true,
  }),
});

// Handle SSE stream
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const text = decoder.decode(value);
  // Parse SSE events
}
```

## Error Handling

```typescript
// app/api/agents/[...path]/route.ts
import { createNextRouteHandlers } from '@cognipeer/agent-server';
import { agentServer, initializeServer } from '@/lib/agent-server';
import { NextResponse } from 'next/server';

await initializeServer();

const handlers = createNextRouteHandlers(agentServer);

// Wrap with error handling if needed
export async function GET(request: Request, context: any) {
  try {
    return await handlers.GET(request, context);
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
```

## Next Steps

- [Storage Providers](/guide/storage)
- [Authentication](/guide/authentication)
- [Streaming](/guide/streaming)
