---
layout: home

hero:
  name: Agent Server
  text: REST API Infrastructure for AI Agents
  tagline: Framework-agnostic server with built-in storage, authentication, streaming, and Swagger UI
  image:
    src: /agent-server/logo.svg
    alt: Agent Server
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/Cognipeer/agent-server

features:
  - icon: 🤖
    title: Agent SDK Integration
    details: Register agents created with @cognipeer/agent-sdk directly and expose them as REST APIs.
  - icon: 🔧
    title: Custom Handler Support
    details: Integrate agents from any library with a simple handler interface.
  - icon: 🏠
    title: Host-backed Agents
    details: Serve an agent that runs in your own backend - it streams, pauses for approvals and is cancelled like any other.
  - icon: 💾
    title: Multiple Storage Backends
    details: PostgreSQL, MongoDB, SQLite and in-memory providers, tested against one contract, with auto-migration.
  - icon: ⏯️
    title: Runs That Outlive the Connection
    details: A turn keeps running when the client leaves; cancel it, follow it from another client, one turn at a time per conversation.
  - icon: ✅
    title: Approvals and Budgets
    details: Tool approvals and questions that lapse, who may answer, edited arguments, per-conversation spend limits.
  - icon: 🔐
    title: Authentication
    details: Token providers, or your own identity per request; conversations belong to their user.
  - icon: 📡
    title: SSE Streaming
    details: Real-time response streaming with Server-Sent Events.
  - icon: 📚
    title: Swagger UI
    details: Automatic OpenAPI documentation with interactive Swagger UI.
  - icon: 📁
    title: File Management
    details: Built-in file upload and download with storage integration.
  - icon: 🌐
    title: Framework Agnostic
    details: Works with Express, Next.js, and other frameworks via adapters.
---

## Quick Start

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

## Basic Usage

```typescript
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';
import { createSmartAgent } from '@cognipeer/agent-sdk';

// Storage provider
const storage = createPostgresProvider({
  connectionString: 'postgresql://user:pass@localhost:5432/mydb',
});

// Agent server
const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  allowAnonymousList: true, // a quick start with no sign-in: see "Who may list" in Request Context
  swagger: {
    enabled: true,
    path: '/docs',
    title: 'My Agent API',
  },
});

// Register your agent
const myAgent = createSmartAgent({
  name: 'Assistant',
  model: myLLMModel,
  tools: [...],
});
agentServer.registerSDKAgent('assistant', myAgent, {
  description: 'A helpful assistant',
});

// Express app
const app = express();
app.use(express.json());

await storage.connect();
app.use(createExpressMiddleware(agentServer));

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('Swagger UI at http://localhost:3000/api/agents/docs');
});
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /agents | List all agents |
| GET | /agents/:agentId | Get agent details |
| GET | /conversations | List conversations |
| POST | /conversations | Create new conversation |
| GET | /conversations/:id | Get conversation with messages |
| PATCH | /conversations/:id | Update conversation |
| DELETE | /conversations/:id | Delete conversation |
| GET | /conversations/:id/messages | List messages |
| POST | /conversations/:id/messages | Send message |
| POST | /files | Upload file |
| GET | /files/:fileId | Get file metadata |
| GET | /files/:fileId/content | Download file |
| DELETE | /files/:fileId | Delete file |
