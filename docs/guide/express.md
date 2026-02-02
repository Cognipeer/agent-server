# Express.js Integration

This guide covers integrating `@cognipeer/agent-server` with Express.js.

## Installation

```bash
npm install @cognipeer/agent-server express
```

## Basic Setup

```typescript
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';

async function main() {
  // Create storage provider
  const storage = createPostgresProvider({
    connectionString: process.env.DATABASE_URL,
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
  });

  // Register agents
  agentServer.registerCustomAgent('echo', {
    processMessage: async ({ message }) => ({
      content: `Echo: ${message}`,
    }),
  });

  // Create Express app
  const app = express();
  app.use(express.json());

  // Connect to database
  await storage.connect();

  // Mount agent server middleware
  app.use(createExpressMiddleware(agentServer));

  // Start server
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Swagger UI at http://localhost:${port}/api/agents/docs`);
  });
}

main().catch(console.error);
```

## With Agent SDK

```typescript
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';
import { createSmartAgent, createTool, fromLangchainModel } from '@cognipeer/agent-sdk';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

async function main() {
  const storage = createPostgresProvider({
    connectionString: process.env.DATABASE_URL,
  });

  // Create tools
  const weatherTool = createTool({
    name: 'get_weather',
    description: 'Get the current weather for a location',
    schema: z.object({
      location: z.string().describe('The city name'),
    }),
    func: async ({ location }) => {
      return { temperature: 22, conditions: 'Sunny', location };
    },
  });

  // Create agent
  const model = fromLangchainModel(new ChatOpenAI({
    modelName: 'gpt-4',
  }));

  const assistant = createSmartAgent({
    name: 'Weather Assistant',
    model,
    tools: [weatherTool],
    systemMessage: 'You are a helpful weather assistant.',
  });

  // Create server
  const agentServer = createAgentServer({
    basePath: '/api/agents',
    storage,
    swagger: { enabled: true },
  });

  // Register SDK agent
  agentServer.registerSDKAgent('weather-assistant', assistant, {
    description: 'An AI assistant that can check the weather',
    version: '1.0.0',
  });

  const app = express();
  app.use(express.json());

  await storage.connect();
  app.use(createExpressMiddleware(agentServer));

  app.listen(3000);
}
```

## With Authentication

```typescript
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createTokenAuthProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';

async function main() {
  const storage = createPostgresProvider({
    connectionString: process.env.DATABASE_URL,
  });

  // Create auth provider
  const authProvider = createTokenAuthProvider({
    tokens: {
      [process.env.API_KEY_1]: 'user-1',
      [process.env.API_KEY_2]: 'user-2',
    },
  });

  const agentServer = createAgentServer({
    basePath: '/api/agents',
    storage,
    auth: {
      enabled: true,
      provider: authProvider,
      excludeRoutes: ['/docs', '/docs/*'], // Public routes
    },
    swagger: { enabled: true },
  });

  // Register agents...

  const app = express();
  app.use(express.json());

  await storage.connect();
  app.use(createExpressMiddleware(agentServer));

  app.listen(3000);
}
```

## With CORS

```typescript
import express from 'express';
import cors from 'cors';
import {
  createAgentServer,
  createPostgresProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';

async function main() {
  const storage = createPostgresProvider({
    connectionString: process.env.DATABASE_URL,
  });

  const agentServer = createAgentServer({
    basePath: '/api/agents',
    storage,
    cors: {
      enabled: true,
      origins: ['http://localhost:3000', 'https://myapp.com'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      headers: ['Content-Type', 'Authorization'],
    },
  });

  const app = express();
  
  // Or use Express CORS middleware for more control
  app.use(cors({
    origin: ['http://localhost:3000', 'https://myapp.com'],
    credentials: true,
  }));
  
  app.use(express.json());

  await storage.connect();
  app.use(createExpressMiddleware(agentServer));

  app.listen(3000);
}
```

## Mounting on a Sub-path

```typescript
const app = express();

// Mount at custom path
app.use('/v1', createExpressMiddleware(agentServer));

// Now routes are:
// GET /v1/api/agents/agents
// POST /v1/api/agents/conversations
// etc.
```

## Error Handling

```typescript
const app = express();

app.use(express.json());
app.use(createExpressMiddleware(agentServer));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  const status = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  res.status(status).json({ error: message });
});
```

## Graceful Shutdown

```typescript
const app = express();

await storage.connect();
app.use(createExpressMiddleware(agentServer));

const server = app.listen(3000);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  
  server.close(async () => {
    await storage.disconnect();
    console.log('Server closed');
    process.exit(0);
  });
});
```

## TypeScript Configuration

Recommended `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

## Next Steps

- [Next.js Integration](/guide/nextjs)
- [Storage Providers](/guide/storage)
- [Authentication](/guide/authentication)
