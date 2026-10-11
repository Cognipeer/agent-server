# Architecture

This page is an overview of how `@cognipeer/agent-server` is put together.

## Framework-agnostic core

The `AgentServer` class does all the work: routing, agents, runs, storage calls. Framework adapters only translate an HTTP request into a call to it and its answer back into HTTP.

```typescript
// The core: a request in, a result out
const result = await server.handleRoute('POST', '/conversations/conv_1/messages', {
  query: {}, body: { message: 'Hi' }, headers, user, context,
});
// result: { status, body?, headers?, raw?, stream?, close? }

// Adapters: Express, Next.js, Node http, Fastify
app.use(createExpressMiddleware(server));
export const { GET, POST, PATCH, DELETE, OPTIONS } = createNextRouteHandlers(server);
const handle = createNodeHandler(server);            // (req, res) => Promise<boolean>
app.register(createFastifyPlugin(server), { prefix: '/api/agents' });
```

`server.getRoutes()` lists every route; `generateOpenAPISpec` describes them. The adapters handle what HTTP needs and the core does not know about: the body (JSON, or a file's raw bytes), CORS, token
authentication, SSE with back-pressure, and `result.close()` when a client goes away.

## Module structure

```
@cognipeer/agent-server
├── index.ts              # Public exports
├── server.ts             # AgentServer: routes, registrations, turns, sweeps
├── types.ts              # Public types
├── runs.ts               # A turn as a run: abort, ordered output, the lease keeper
├── events.ts             # The event vocabulary, the in-memory event log
├── hitl.ts               # Approvals and questions: pause detection, resolution, snapshots
├── host.ts               # Host-backed agents: checking what a host reports
├── usage.ts              # Usage, cost and budgets
├── schema.ts             # Checking edited approval arguments against a tool's schema
├── context.ts            # The request context (AsyncLocalStorage)
├── swagger.ts            # OpenAPI generation and the error code catalogue
├── files/                # How a conversation's files reach the agent: config, assembly,
│                         #   text extraction, images, the session_files_* tools
├── adapters/
│   ├── node.ts           # node:http (the base of the others)
│   ├── express.ts        # Express
│   ├── fastify.ts        # Fastify
│   └── next.ts           # Next.js App Router
└── providers/
    ├── auth/token.ts     # Token and (basic) JWT providers
    ├── ai/               # Chat Completions and Responses API clients
    └── storage/
        ├── base.ts       # BaseStorageProvider
        ├── memory.ts     # In memory
        ├── sqlite.ts     # SQLite
        ├── postgres.ts   # PostgreSQL
        └── mongodb.ts    # MongoDB (GridFS for files)
```

## Request handling

### Routes

Routes are declared once when the server is created (`getRoutes()` returns them) and matched in order; `:name` is one path segment and `:name*` takes the rest of the path.
Each request then goes through the same steps:

1. **Context.** `resolveContext(req)` (when configured; `null` is `401`) produces the `RequestContext` - the user and your own data. Without it the context is built from the token user.
2. **Handler.** The route runs with `runWithRequestContext(context, ...)`, so `getRequestContext()` works anywhere below it, including in streams.
3. **Result.** A `RouteResult`: a status and a JSON `body`, raw `bytes` (a download), or a `stream` of SSE frames.
4. **Errors.** Anything thrown becomes `{ error: { code, message, details } }` with the error's `statusCode` (`maskServerErrors` hides the text of everything that is not a 4xx the host authored).
   See [Error Handling](./error-handling.md).

```typescript
interface RouteResult<T = unknown> {
  status: number;
  body?: T;
  headers?: Record<string, string>;
  raw?: Buffer;                                  // for file downloads
  stream?: AsyncGenerator<string, void, unknown>; // SSE frames
  close?: () => void;                             // the adapter calls it when the client leaves
}
```

## Agent registration

Four kinds of agent sit behind the same API:

| Registration | The agent is | Streams | Pauses for approvals | Notes |
| --- | --- | --- | --- | --- |
| `registerSDKAgent` | an agent-sdk object in this process | yes | yes (the server keeps the paused SDK state) | tools, files, budgets as the SDK counts them |
| `registerCustomAgent` | a handler: `processMessage` / `resolveAction` | no (one final chunk) | yes, by returning `pendingActions` | the simplest thing that works |
| `registerHostAgent` | your own backend: `invoke` / `resolveAction` / `cancel` | yes (`emit`) | yes, by returning `pendingActions` | [Host-backed agents](./host-agents.md) |
| `registerChatCompletionsAgent` / `registerResponsesAgent` | an OpenAI-compatible endpoint | yes | no | the server calls the endpoint |

Every registration becomes an `AgentRegistration` (`info` plus the one of `sdkAgent`, `handler`, `host`, `chatCompletions`, `responsesApi`, and the per-agent `files`, `hitl`, `budget`,
`pricing` settings). `config.agents` can also return registrations per request.

## The life of a turn

A message (or the answer to an approval) is a **run** that is independent of the HTTP request that started it:

```
request ──▶ authorize ──▶ take the conversation (in-process slot + storage lease)
                              │          409 conversation_busy if it is taken
                              ▼
                          run.launch ──────────────▶ agent step (SDK / handler / host / HTTP)
   stream subscribers ◀── ordered output ◀──────────        │  text, tool calls, usage
   (the connection)       event log + followers             ▼
                                                      finalize: assistant message, pending actions,
                                                      money (usage, budget), events, stream.done
                              │
                              ▼
                          release the lease
```

- The connection is a *subscriber*: closing it never stops the run. `POST /conversations/:id/cancel` does, by aborting the signal the agent was given.
- One run per conversation, on one node: an in-process slot, and - when the storage provider has leases - a lease any other node respects.
- Everything a run does is written to the conversation's [event log](./runs.md#the-event-log) in order, which is also what followers read to reattach.
- A background sweep recovers runs whose process died, handles approvals that lapsed, prunes old events and purges expired files.

Details: [Runs, Cancel & Reattach](./runs.md), [Approvals & Questions](./human-in-the-loop.md), [Usage & Budgets](./budgets.md), [Files](./file-management.md).

## Storage architecture

The server talks to storage only through the `StorageProvider` interface. A small required core (conversations, messages, files, tasks) is complemented by optional parts the built-in providers all
have, each switched by `capabilities()`:

| Optional part | Without it |
| --- | --- |
| `events` (the durable event log) | a bounded log in memory: reattach works on one node and is lost on restart |
| leases | runs are serialised in-process only: right for one node |
| `updateConversationIf` (compare-and-set) | state writes are plain updates |
| `updateMessage` | a history keeps showing an approval as it was asked |
| `listFiles` / `purgeExpiredFiles` | the per-conversation file limit and retention do nothing |
| action deadlines | lapsed approvals are refused with 410 but not swept |

`BaseStorageProvider` implements the interface on top of a few `_` methods and adds the behaviour every provider shares. All four built-in providers pass one contract suite
(`test/storage/contract.ts`, run against a real database each), so the application behaves the same on all of them. See [Storage Providers](./storage.md) and [Custom Storage](./custom-storage.md).

## Authentication flow

```
Request
   │
   ▼
┌──────────────────┐
│ Token auth       │   auth.enabled: the token is validated by the AuthProvider
│ (adapter)        │   ── invalid / missing ──▶ 401 AUTHENTICATION_ERROR
└──────────────────┘
   │ user
   ▼
┌──────────────────┐
│ resolveContext   │   your own identity: cookie, session, header
│ (core)           │   ── null ──▶ 401 AUTHENTICATION_ERROR
└──────────────────┘
   │ RequestContext { user, data }
   ▼
Route handler  ── a conversation, task or file owned by someone else ──▶ 403 FORBIDDEN
               ── a list that names no user ──▶ 401 identity_required (unless allowAnonymousList)
```

## Streaming

Two kinds of SSE, both plain `data:` JSON (see [Streaming](./streaming.md)):

- the response to `POST .../messages` with `stream: true`: `stream.*` frames for the turn that request started;
- `GET /conversations/:id/events/stream`: the event log, replayed from a cursor and followed live (`id:` and `Last-Event-ID`, a `: ping` every 15 s), for reattaching after a reload and for watching
  a conversation from elsewhere.

## Next Steps

- [Express Integration](/guide/express)
- [Next.js Integration](/guide/nextjs)
- [Storage Providers](/guide/storage)
