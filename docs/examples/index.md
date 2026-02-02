# Examples

Example projects and code snippets for `@cognipeer/agent-server`.

## Quick Examples

### Basic Express Server

```typescript
import express from 'express';
import {
  createAgentServer,
  createMemoryProvider,
  createExpressMiddleware,
} from '@cognipeer/agent-server';

const storage = createMemoryProvider();

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
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
  createMemoryProvider,
  createNextRouteHandlers,
} from '@cognipeer/agent-server';

const storage = createMemoryProvider();

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
});

agentServer.registerCustomAgent('echo', {
  processMessage: async ({ message }) => ({
    content: `Echo: ${message}`,
  }),
});

await storage.connect();

export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

## Full Examples

Explore complete example projects:

- [Express Basic](/examples/express-basic) - Simple Express.js setup
- [Express with PostgreSQL](/examples/express-postgres) - Production-ready Express
- [Next.js App Router](/examples/nextjs-app) - Next.js integration
- [Custom Agent](/examples/custom-agent) - Custom AI backend
- [JWT Authentication](/examples/jwt-auth) - Secure your API

## Example Repository

See the full examples in our GitHub repository:

[github.com/Cognipeer/agent-server-examples](https://github.com/Cognipeer/agent-server-examples)
