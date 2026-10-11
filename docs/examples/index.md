# Examples

Example projects and code snippets for `@cognipeer/agent-server`.

## Quick Examples

### Basic Express Server

```typescript
import express from 'express';
import {
  createAgentServer,
  createInMemoryProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';

const storage = createInMemoryProvider();

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  allowAnonymousList: true, // a quick start with no sign-in: see "Who may list" in Request Context
  swagger: { enabled: true },
});

agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
});

const app = express();
app.use(express.json());

await storage.connect();
app.use(createExpressMiddleware(agentServer));

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
```

### Next.js App Router

```typescript
// app/api/agents/[...path]/route.ts
import {
  createAgentServer,
  createInMemoryProvider,
  createNextRouteHandlers,
} from '@cognipeer/agent-server';

const storage = createInMemoryProvider();

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
  allowAnonymousList: true, // a quick start with no sign-in: see "Who may list" in Request Context
});

agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
});

await storage.connect();

export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## Standalone server

[`examples/standalone`](https://github.com/Cognipeer/agent-server/tree/main/examples/standalone) in this repository is a complete server as its own process, on SQLite or MongoDB: an agent-sdk agent
(approvals, questions, files, cancel), a host-backed agent, CORS and Swagger. It runs with a scripted model, so no API key is needed:

```bash
cd examples/standalone && npm install
npm run start:sqlite      # or: npm run start:mongodb
```

## More examples

In this repository's [`examples/`](https://github.com/Cognipeer/agent-server/tree/main/examples) folder:

- [`standalone`](https://github.com/Cognipeer/agent-server/tree/main/examples/standalone) - a complete server on SQLite or MongoDB (above)
- [`express-postgres.ts`](https://github.com/Cognipeer/agent-server/blob/main/examples/express-postgres.ts) - Express with PostgreSQL and token authentication
- [`tasks-demo.ts`](https://github.com/Cognipeer/agent-server/blob/main/examples/tasks-demo.ts) - background tasks with a callback server

## Example Repository

See the full examples in our GitHub repository:

[github.com/Cognipeer/agent-server-examples](https://github.com/Cognipeer/agent-server-examples)
