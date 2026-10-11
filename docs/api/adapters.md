# Adapters

Framework adapters for integrating the agent server.

## Express Adapter

### createExpressMiddleware

Creates Express middleware from an agent server.

```typescript
import { createExpressMiddleware } from '@cognipeer/agent-server';

const middleware = createExpressMiddleware(agentServer);
app.use(middleware);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| agentServer | `AgentServer` | The agent server instance |

#### Returns

`RequestHandler` - Express middleware function.

#### Example

```typescript
import express from 'express';
import { createAgentServer, createExpressMiddleware } from '@cognipeer/agent-server';

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
});

const app = express();
app.use(express.json());
app.use(createExpressMiddleware(agentServer));

app.listen(3000);
```

### How It Works

The Express adapter:

1. Extracts path, method, query, body from Express request
2. Extracts auth token from headers
3. Validates token with auth provider
4. Calls `agentServer.handleRequest()`
5. Translates `RouteResult` to Express response
6. Handles SSE streaming for stream responses

### Streaming Support

For streaming responses, the adapter sets up SSE:

```typescript
// The adapter handles this automatically
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');

for await (const chunk of result.stream) {
  res.write(chunk);
}
res.end();
```

## Next.js Adapter

### createNextRouteHandlers

Creates Next.js App Router handlers.

```typescript
import { createNextRouteHandlers } from '@cognipeer/agent-server';

export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| agentServer | `AgentServer` | The agent server instance |

#### Returns

```typescript
interface NextRouteHandlers {
  GET: (request: Request, context: { params: any }) => Promise<Response>;
  POST: (request: Request, context: { params: any }) => Promise<Response>;
  PATCH: (request: Request, context: { params: any }) => Promise<Response>;
  DELETE: (request: Request, context: { params: any }) => Promise<Response>;
  OPTIONS: (request: Request, context: { params: any }) => Promise<Response>;
}
```

#### Example

```typescript
// app/api/agents/[...path]/route.ts
import { createAgentServer, createNextRouteHandlers } from '@cognipeer/agent-server';

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage,
});

await storage.connect();

export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(agentServer);
```

### Route Pattern

Use a catch-all route pattern:

```
app/api/agents/[...path]/route.ts
```

This catches all routes under `/api/agents/*`.

### Streaming Support

The Next.js adapter uses `ReadableStream` for SSE:

```typescript
return new Response(
  new ReadableStream({
    async start(controller) {
      for await (const chunk of result.stream) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  }),
  {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  }
);
```

## Custom Adapter

Create your own adapter for other frameworks:

```typescript
import type { AgentServer } from '@cognipeer/agent-server';

function createCustomAdapter(agentServer: AgentServer) {
  return async function handleRequest(req: CustomRequest, res: CustomResponse) {
    // 1. Extract request info
    const method = req.method;
    const path = req.path;                 // handleRequest strips the base path itself

    // 2. Authenticate (a no-op returning null when token auth is off)
    let user;
    try {
      user = (await agentServer.authenticate(extractToken(req.headers))) ?? undefined;
    } catch (error) {
      const { statusCode = 401, code = 'AUTHENTICATION_ERROR', message } = error as { statusCode?: number; code?: string; message?: string };
      return res.status(statusCode).json({ error: { code, message } });
    }

    // 3. Handle the request
    const result = await agentServer.handleRequest(method, path, {
      query: req.query,
      body: req.body,       // a file uploaded as itself: pass its bytes as a Buffer
      headers: req.headers,
      user,
    });

    // 4. Send the response
    if (result.stream) {
      // Server-Sent Events: stop reading when the client goes away (the run it was watching goes on)
      res.setHeader('Content-Type', 'text/event-stream');
      res.on('close', () => result.close?.());
      for await (const chunk of result.stream) {
        res.write(chunk);
      }
      res.end();
    } else if (result.raw) {
      // Binary response
      res.setHeader('Content-Type', result.headers?.['Content-Type'] || 'application/octet-stream');
      res.send(result.raw);
    } else {
      // JSON response
      res.status(result.status).json(result.body);
    }
  };
}

function extractToken(headers: Record<string, string>): string | undefined {
  const auth = headers.authorization || headers.Authorization;
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return undefined;
}
```

**File uploads.** `POST /files` takes the file either as JSON (a parsed object body) or as itself: its bytes as the body, its own `Content-Type` and
`?name=&conversationId=` in the query. For the second form pass the bytes - a `Buffer` - as `body`; `isRawUploadRequest(method, routePath, contentType)`
(exported) tells which form a request is (`true`: a `POST` to `/files` whose `Content-Type` is not JSON). Limit the body yourself:
`server.maxUploadBytes()` is the largest file any agent accepts. See [Files](../guide/file-management.md#uploading).

## Node HTTP Adapter

```typescript
import { createNodeHandler } from '@cognipeer/agent-server'; // or '@cognipeer/agent-server/node'

const handle = createNodeHandler(server, { basePath: '/api', maxBodyBytes: 15_000_000 });
// (req: IncomingMessage, res: ServerResponse, overrides?: { path, body, mountParams, raw, error }) => Promise<boolean>
```

See the [Fastify & Node HTTP guide](../guide/fastify.md).

## Fastify Adapter

```typescript
import { mountOnFastify, createFastifyPlugin } from '@cognipeer/agent-server/fastify';

mountOnFastify(app, server, { prefix: '/api/portal/:portalKey', bodyLimit });
app.register(createFastifyPlugin(server, { maxBodyBytes }), { prefix: '/api' });
```

## Hono Example

```typescript
import { Hono } from 'hono';
import { createAgentServer } from '@cognipeer/agent-server';

const app = new Hono();
const agentServer = createAgentServer({ basePath: '/api', storage });

app.all('/api/*', async (c) => {
  const path = c.req.path.replace('/api', '');
  
  const context = {
    params: {},
    query: Object.fromEntries(new URL(c.req.url).searchParams),
    body: await c.req.json().catch(() => undefined),
  };
  
  const result = await agentServer.handleRequest(
    c.req.method,
    path,
    context
  );
  
  if (result.stream) {
    return new Response(
      new ReadableStream({
        async start(controller) {
          for await (const chunk of result.stream) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  }
  
  return c.json(result.body, result.status);
});

export default app;
```
