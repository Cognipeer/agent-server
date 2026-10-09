# Request Context & Dynamic Agents

Embed the server in a multi-tenant host: resolve the caller once per request,
serve a per-request agent list and let storage scope its data. Everything here is
optional - without `resolveContext` and with a plain `agents` array nothing changes.

## resolveContext

```typescript
import { createAgentServer } from '@cognipeer/agent-server';

const server = createAgentServer({
  basePath: '/api/portal',
  storage,
  resolveContext: async (req) => {
    const session = await sessions.get(req.cookies.sid);
    if (!session) return null; // -> 401 AUTHENTICATION_ERROR
    return {
      user: { id: session.userId },
      data: { tenantId: session.tenantId }, // arbitrary host data, never sent to clients
    };
  },
});
```

`req` is a `ContextRequest`:

| Field | Meaning |
| --- | --- |
| `method`, `path` | HTTP method and the route path relative to the server (`/conversations/abc/messages`) |
| `headers` | lower-cased header names |
| `cookies` | parsed `Cookie` header |
| `query`, `body` | parsed query string / JSON body |
| `user` | user from the token `auth` provider, if both are used |
| `mountParams` | params of a dynamic mount prefix (Fastify `/p/:key`, Express `/p/:key/agents`) |
| `raw` | the framework's native request (Express req, `NextRequest`, `IncomingMessage`, `FastifyRequest`) |

Rules:

- It runs for every route except the public Swagger routes. A pre-resolved
  `context` passed to `server.handleRequest`/`handleRoute` skips it.
- Returning `null` answers 401. Throw `{ statusCode: 403, code, message }` to answer
  with another status.
- **The resolved identity is authoritative.** `userId` in a create-conversation body
  or `?userId=` in a list query is ignored; conversations and tasks owned by another
  user (or by anyone, for an anonymous context) answer 403.
- Token auth (`auth.enabled`) still runs first; its user is available as `req.user`
  and is the fallback when the resolver returns no `user`.

## Where the context goes

| Consumer | How |
| --- | --- |
| Dynamic `agents` function | first argument |
| Custom `AgentHandler.processMessage` | `params.context` |
| SDK agent | `agent.invoke(params, { context, ... })` (extra key, ignored by agents that don't read it) |
| `auth.resolveUserId` | `{ headers, query, body, context }` |
| Storage provider | last argument of every data method |
| Anywhere in the request | `getRequestContext()` (AsyncLocalStorage; also valid inside SSE streams) |

## Dynamic agents

```typescript
const server = createAgentServer({
  basePath: '/api',
  storage,
  resolveContext,
  agents: async (ctx) => {
    const rows = await db.agentsFor(ctx.data.tenantId as string);
    return rows.map((row) => ({
      info: { id: row.key, name: row.name, description: row.description },
      sdkAgent: buildAgent(row, ctx), // closures may capture the context
    }));
  },
});
```

- `config.agents` is an array (registered once) or a function (resolved per
  request and memoised for that request).
- Agents added with `registerSDKAgent`/`registerCustomAgent`/... stay available; a
  dynamic registration with the same id wins.
- `GET /agents`, `GET /agents/:id`, `POST /conversations`, sending a message (also
  streaming) and tasks all use the per-request registry. An agent that is not
  served to the request answers **404** - also for an existing conversation whose
  agent is no longer visible.
- Programmatic access: `await server.getAgentsFor(ctx)`, `await server.getAgentFor(id, ctx)`.

## Storage and the context

All `StorageProvider` methods take an optional trailing `ctx?: RequestContext`:

```typescript
getConversation(id: string, ctx?: RequestContext): Promise<Conversation | null>;
getMessages(conversationId: string, params?: GetMessagesParams, ctx?: RequestContext): Promise<...>;
```

See [Custom Storage](./custom-storage.md) for implementing a scoped store.

## Streaming note

If an SDK agent returns its final answer without streaming any text (for example a
tool agent running non-streaming), the server emits it once as a `stream.text`
event (`isFinal: true`) before `stream.done`, so chat UIs never end with an empty
message.
