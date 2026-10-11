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
  or `?userId=` in a list query is ignored; a single conversation or task owned by another
  user (or by anyone, for an anonymous context) answers 403. The lists are covered in
  [Who may list](#who-may-list).
- Token auth (`auth.enabled`) still runs first; its user is available as `req.user`
  and is the fallback when the resolver returns no `user`.

## Which identity counts

When a request carries more than one idea of who is asking, the server's own wins, in this order:

1. with `resolveContext`: `context.user` (nothing the client sends changes it);
2. the token user (`auth.enabled`), then `auth.resolveUserId`;
3. only when the request carries **no** identity at all (an open demo server, `allowAnonymousList`): the `userId` the client names in a create-conversation body or a list query.

So with token auth, `?userId=other` on a list and `userId: "other"` in a create body are ignored: the token user's own conversations are listed, and a conversation is created for the token user.
Without any identity a client names itself, which is all an anonymous server can offer - do not rely on it to keep users apart.

## Who may list

`GET /conversations` and `GET /tasks` return the records of **one user**: the resolved one. A request that names nobody - no token user, no `context.user`, no `resolveUserId` result and, without
`resolveContext`, no `?userId=` - would list the conversations of everyone, so the server refuses it: **`401 identity_required`**. That includes a context that carries only a tenant
(`{ data: { tenantId } }`, no `user`): resolve a user for every request, even a service user per tenant.

```typescript
createAgentServer({ basePath: '/api', storage, resolveContext }); // lists need resolveContext to return a user
createAgentServer({ basePath: '/api', storage, allowAnonymousList: true }); // a single-user tool or a demo: everybody is the same person
```

`allowAnonymousList: true` lets an anonymous request list everything. Use it only when that is the point of the server.

The built-in storage providers keep every user's data in one namespace: they filter by user, not by tenant. A multi-tenant host either gives each tenant its own database / `tablePrefix`
(a server per tenant), or scopes in its own storage provider using the context (`ctx.data.tenantId`) - see [Custom Storage](./custom-storage.md).

## Where the context goes

| Consumer | How |
| --- | --- |
| Dynamic `agents` function | first argument |
| Custom `AgentHandler.processMessage` | `params.context` |
| Host-backed agent | `input.context` of `invoke` and `resolveAction` ([Host-backed agents](./host-agents.md)) |
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

A turn runs [detached](./runs.md) from the request that started it, but with that request's context: it reaches the agent, the handler, the storage calls the turn makes and
`getRequestContext()` just as before, even after the client has gone away. Work that belongs to no request - the recovery sweep that closes the runs of a dead process
and fails stale tasks, and the pruning of old events - runs with the context `{ data: { system: true } }` and no user. A store scoped by `ctx.user` should let those calls through (or set
`runs.recoverOnStart: false` and `runs.sweepIntervalMs: 0`, and call `server.recoverStaleRuns()` from a context of your own).

## Streaming note

If an SDK agent returns its final answer without streaming any text (for example a
tool agent running non-streaming), the server emits it once as a `stream.text`
event (`isFinal: true`) before `stream.done`, so chat UIs never end with an empty
message.
