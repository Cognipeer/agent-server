# Embedding & limits

A chat can live in a page that is not yours to control: an intranet, a SaaS product, a help centre. This page is about the three things such a deployment needs from the server - **per-request bearer authentication** (no cookies), **rate limits** and an **audit trail** - and the browser details around them.
The server itself is the same; the host application decides who a request belongs to.

## Bearer auth with `resolveContext`

A page embedded in a third-party frame cannot count on cookies: browsers partition or block third-party cookies (Safari and Firefox by default, Chrome increasingly). So an embedded chat sends **a token in the `Authorization` header of every request**, and the server asks the host's own backend what the token means.
`resolveContext` already gets everything it needs: the lower-cased `headers` (including `authorization`), the `mountParams` of a parameterised prefix, and the query and body. Return `null` and the request is a `401`.

```typescript
const sessions = new SessionStore();   // yours: opaque ids, an HMAC, a JWT you verify - whatever you mint for the signed-in person

createAgentServer({
  basePath: '/api/chat',
  storage,
  resolveContext: async (req) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const session = token ? await sessions.lookup(token, { portal: req.mountParams.portalKey }) : undefined;
    return session ? { user: { id: session.userId }, data: { portal: session.portal, tenant: session.tenant } } : null;
  },
});
```

What makes this safe:

- **Every request is authenticated, not only the first.** There is no server-side login state to steal: revoke the token in your store and the next request is a `401`, in the middle of a conversation. A refreshed token for the same person picks the conversation up where it was, because conversations belong to the *user id* you return.
- **The user you return is authoritative.** With `resolveContext` the server ignores any `userId` a client sends and shows a conversation only to the user that owns it (403 for anyone else, and a list that holds only one's own).
- **A token is bound to what you say it is bound to.** The sample above passes the portal from the URL (`/api/chat/:portalKey` on Fastify; see [Fastify & Node](./fastify.md)) so a token for one portal is a `401` on another. Bind the origin the same way if you want: the `Origin` header is in `req.headers` too.
- **Keep tokens out of URLs.** They are sent in a header, so they do not reach access logs or `Referer`. A token that has to travel from the page that holds the person's identity to the chat iframe should go through `postMessage`, never through the iframe's `src`.

### CORS for a chat on another origin

```typescript
createAgentServer({
  basePath: '/api/chat',
  storage,
  cors: { enabled: true, origins: ['https://intranet.example.com'] },   // exact origins; "*" is for public, token-less servers only
  resolveContext,
});
```

A bearer token needs no credentials mode, so the server never sends `Access-Control-Allow-Credentials`. The preflight allows `Content-Type`, `Authorization` and `Last-Event-ID`, and the answers **expose** `Retry-After`, `Content-Disposition` and `Content-Length`
so the page can honour a `429` and name a downloaded file. A reply to an origin that is not on the list carries no CORS headers at all.

### Streams

Use `fetch` with a streaming body reader (see [Streaming](./streaming.md#using-fetch)), not `EventSource`: `EventSource` cannot set an `Authorization` header. `GET /conversations/:id/events/stream?after=<seq>` works the same way, and a reconnect resends the token.

## Limits

The server implements no rate limit of its own - what is right (per person, per portal, per plan) is the host's to decide. It gives you one hook, asked **before** the server does any work that costs something:

```typescript
createAgentServer({
  basePath: '/api/chat',
  storage,
  rateLimit: async (ctx, request) => {
    // request: { operation, conversationId?, agentId?, userId?, streaming? }
    //   operation: 'conversation.create' | 'message.send' | 'message.regenerate' | 'message.edit' | 'action.resolve' | 'turn.continue'
    //            | 'file.upload' | 'conversation.export' | 'message.feedback' | 'conversation.bulk_delete'
    const limit = limitsFor(ctx.data.portal);
    if (request.operation.startsWith('message.') && !(await bucket.take(request.userId!, limit.messagesPerMinute))) {
      return { allowed: false, retryAfterSeconds: 20, message: 'You are sending messages too fast.' };
    }
    return undefined;   // go ahead
  },
});
```

| Answer | |
| --- | --- |
| nothing / `true` | Go ahead |
| `false`, or `{ allowed: false, retryAfterSeconds?, message? }` | `429 rate_limited` with a `Retry-After` header and `error.details.retryAfterSeconds` |
| `{ release }` | Go ahead, and call `release()` once when the operation is **over** |

`release` is what makes "at most N streams at once" a few lines: for a turn it is called when the **run** has finished - not when the HTTP connection closes, because a run goes on without its client - and also when the request fails after being admitted.

```typescript
const open = new Map<string, number>();
rateLimit: (ctx, { operation, userId }) => {
  if (operation !== 'message.send' && operation !== 'message.regenerate' && operation !== 'message.edit') return;
  if ((open.get(userId!) ?? 0) >= 2) return { allowed: false, retryAfterSeconds: 5 };
  open.set(userId!, (open.get(userId!) ?? 0) + 1);
  return { release: () => open.set(userId!, open.get(userId!)! - 1) };
}
```

The size limits (`limits.maxFileSize`, `files.maxFiles`, `limits.maxBulkDelete`, the [budget](./budgets.md) of a conversation) stay where they were. A cap on how many conversations a person may keep is yours to enforce in the `conversation.create` check, by counting through your storage.

## Audit

`audit(ctx, entry)` is called after an action **succeeded**; a failure of the hook is logged and never fails the request.

```typescript
createAgentServer({
  basePath: '/api/chat',
  storage,
  audit: (ctx, entry) => siem.write({ tenant: ctx.data.tenant, ...entry }),
});
// entry: { action, conversationId?, agentId?, userId?, messageId?, details?, at }
```

| `action` | `details` |
| --- | --- |
| `conversation.export` | `format`, `includeTools`, `messages` |
| `conversation.delete` | |
| `conversation.bulk_delete` | `requested`, `deleted` |
| `conversation.pin` / `conversation.unpin` | |
| `message.regenerate` / `message.edit` | `removedMessages` |
| `message.feedback` | `rating`, `reasons?` |

Who exported which conversation, in which format, is the one an operator is usually asked for. Message content is never in the entry.

## Next Steps

- [Chat experience](./chat-experience.md) - the routes these hooks guard
- [Request Context & Dynamic Agents](./request-context.md) - `resolveContext` in depth
- [Authentication](./authentication.md)
