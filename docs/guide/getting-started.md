# Getting Started

This guide will help you set up `@cognipeer/agent-server` in your project.

## Installation

Install the core package:

::: code-group

```bash [npm]
npm install @cognipeer/agent-server
```

```bash [yarn]
yarn add @cognipeer/agent-server
```

```bash [pnpm]
pnpm add @cognipeer/agent-server
```

:::

Install your preferred storage provider and framework:

```bash
# PostgreSQL
npm install pg

# MongoDB
npm install mongodb

# Express
npm install express
```

## Quick Start with Express

Here's a minimal example to get you started:

```typescript
import express from 'express';
import {
  createAgentServer,
  createMemoryProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';

// Create an in-memory storage (for development)
const storage = createMemoryProvider();

// Create the agent server
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: { enabled: true },
});

// Register a simple echo agent
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
}, {
  name: 'Echo Bot',
  description: 'A simple echo bot',
});

// Create Express app
const app = express();
app.use(express.json());

// Connect storage and start server
await storage.connect();
app.use(createExpressMiddleware(agentServer));

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('Swagger UI at http://localhost:3000/api/agents/docs');
});
```

## Quick Start with Next.js

For Next.js App Router:

```typescript
// app/api/agents/[...path]/route.ts
import {
  createAgentServer,
  createMemoryProvider,
  createNextRouteHandlers,
} from '@cognipeer/agent-server';

const storage = createMemoryProvider();

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: { enabled: true },
});

// Register your agents
agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
});

await storage.connect();

export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## Using with Agent SDK

If you're using `@cognipeer/agent-sdk`, you can register agents directly:

```typescript
import { createSmartAgent, fromLangchainModel } from '@cognipeer/agent-sdk';
import { ChatOpenAI } from '@langchain/openai';

// Create your agent
const myAgent = createSmartAgent({
  name: 'Assistant',
  model: fromLangchainModel(new ChatOpenAI({ modelName: 'gpt-4' })),
  tools: [...],
});

// Register with the server
agentServer.registerSDKAgent('assistant', myAgent, {
  description: 'A helpful AI assistant',
});
```

## Project Structure

Here's a recommended project structure:

```
my-agent-app/
├── src/
│   ├── index.ts           # Main entry point
│   ├── agents/
│   │   ├── assistant.ts   # Agent definitions
│   │   └── tools/         # Agent tools
│   └── config/
│       └── database.ts    # Storage configuration
├── package.json
└── tsconfig.json
```

## Environment Variables

We recommend using environment variables for configuration:

```env
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb

# Authentication
JWT_SECRET=your-secret-key

# Server
PORT=3000
NODE_ENV=development
```

## Next Steps

- [Core Concepts](/guide/core-concepts) - Understand the architecture
- [Storage Providers](/guide/storage) - Set up PostgreSQL or MongoDB
- [Authentication](/guide/authentication) - Secure your API
- [Express Integration](/guide/express) - Detailed Express setup
- [Next.js Integration](/guide/nextjs) - Detailed Next.js setup
