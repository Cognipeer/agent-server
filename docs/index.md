---
layout: home

hero:
  name: Agent Server
  text: Ship Agent APIs Without Rebuilding The Server Layer
  tagline: Framework-agnostic infrastructure for storage, authentication, file handling, streaming, and Swagger-backed agent APIs across Express, Next.js, and custom runtimes.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Study Architecture
      link: /guide/architecture

features:
  - title: SDK Agents And Custom Handlers
    details: Register agents built with `@cognipeer/agent-sdk` or expose your own runtime handlers through the same REST surface.
  - title: Storage That Does Not Start From Scratch
    details: Use the built-in PostgreSQL, MongoDB, and SQLite providers instead of rebuilding conversation and file persistence for every deployment.
  - title: Auth, Files, And Streaming In One Runtime
    details: Keep token or JWT auth, file uploads, and SSE response delivery inside the same server layer that already knows your agent routes.
  - title: Framework Adapters That Match Real Integrations
    details: Start with Express or Next.js and keep a clean path toward custom adapters when your hosting model does not fit the defaults.
  - title: Swagger And REST Contracts Ready To Inspect
    details: Publish interactive API docs and predictable endpoints without manually maintaining separate OpenAPI scaffolding.
  - title: Examples And Guides That Stay Operational
    details: Move from setup into adapters, providers, auth, and endpoint details without losing the shape of the existing docs tree.
---

## Start Here

If you are integrating Agent Server for the first time, this is the shortest useful reading order:

1. [Getting Started](/guide/getting-started) to boot a working server quickly.
2. [Core Concepts](/guide/core-concepts) to understand agents, conversations, storage, and files.
3. [Architecture](/guide/architecture) to see how adapters, providers, and API routes fit together.

If you already know the basics, jump directly to the part that matches your work:

- Wiring an app runtime? Start with [Express.js](/guide/express) or [Next.js](/guide/nextjs).
- Choosing persistence and auth? Start with [Storage Providers](/guide/storage) and [Authentication](/guide/authentication).
- Building against the runtime contract? Start with [API Reference](/api/server) and [REST Endpoints](/api/endpoints).

## Choose Your Integration Path

| Start with | Best for | What you get |
| --- | --- | --- |
| Guide | Teams standing up the server for the first time | Setup, architecture, adapters, storage, auth, files, and streaming guidance |
| API Reference | Backend teams implementing or extending the runtime | Server interfaces, types, adapters, providers, and endpoint contracts |
| Examples | Teams that want a runnable starting point | Express, Next.js, storage-backed, and auth-aware sample integrations |

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

```ts
import express from 'express';
import {
  createAgentServer,
  createPostgresProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';

const storage = createPostgresProvider({
  connectionString: process.env.DATABASE_URL!,
});

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  swagger: {
    enabled: true,
    path: '/docs',
    title: 'My Agent API',
  },
});

const app = express();
app.use(express.json());

await storage.connect();
app.use(createExpressMiddleware(agentServer));
app.listen(3000);
```

## Docs Map

- [Guide](/guide/getting-started): setup, concepts, adapters, storage, auth, file management, streaming, and Swagger guidance.
- [Architecture](/guide/architecture): how the server runtime, adapters, providers, and API surface are layered.
- [API Reference](/api/server): core interfaces, types, adapters, providers, and REST endpoint contracts.
- [Examples](/examples/): runnable integration paths for Express, Next.js, custom agents, and auth flows.

## Production Checklist

- Decide early which framework adapter and storage backend own your runtime so conversations and files do not get reworked later.
- Confirm your auth model, base path, and streaming expectations before publishing endpoints to consuming clients.
- Keep Swagger enabled in environments where API inspection shortens integration loops.
- Validate file handling, conversation persistence, and error behavior together instead of treating them as separate subsystems.
- Run `npm run docs:build` when docs or examples change so links and frontmatter stay valid.

## What This Site Covers

- A practical path from install to a production-ready agent API server without rebuilding transport, persistence, and auth plumbing by hand.
- The runtime contracts behind adapters, providers, endpoint behavior, and framework integration.
- The operational guidance needed to move from local examples into real deployments.
- A docs shell aligned with the wider Cognipeer docs surfaces while preserving Agent Server's own structure and examples.
