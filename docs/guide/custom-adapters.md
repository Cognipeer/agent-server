# Custom Adapters

Agent Server is framework-agnostic at the core. Express and Next.js are convenience adapters, not special runtime modes. If your stack uses another HTTP layer, the right approach is to keep `AgentServer` as the business runtime and write a thin adapter around `handleRequest(...)`.

## What the core expects

The runtime does not require a specific web framework. It needs only:

- the HTTP method
- the request path
- query parameters
- an optional request body
- an optional authenticated user

The core entry point is `server.handleRequest(method, path, ctx)`, where `ctx` carries:

- `user`
- `query`
- `body`

The response comes back as a `RouteResult` with:

- `status`
- optional `body`
- optional `headers`
- optional `raw`
- optional `stream`

That split is why adapters stay small. They translate framework request and response objects, but they do not own routing logic, auth policy, or storage behavior.

## What the built-in adapters demonstrate

Use the existing adapters as reference implementations:

- Express adapter: request filtering, auth header lookup, SSE streaming, and plain JSON or HTML responses
- Next.js adapter: App Router handler shape, query parsing, `Response` objects, and streaming via `ReadableStream`

These are the key responsibilities every custom adapter should preserve.

## Minimal adapter flow

Every adapter should follow this order:

1. detect whether the request path belongs to `server.getBasePath()`
2. parse query parameters into a plain object
3. parse request body when the method allows it
4. resolve the authenticated user if your host framework provides one
5. call `server.handleRequest(...)`
6. map `RouteResult` back into the framework response object
7. handle `result.stream` as SSE when present

If you skip that order, the server still may work, but edge cases like excluded auth routes, Swagger HTML, or streaming can break.

## Skeleton example

```ts
async function handleFrameworkRequest(request: FrameworkRequest) {
  const result = await server.handleRequest(
    request.method,
    request.path,
    {
      user: request.user,
      query: request.query,
      body: request.body,
    }
  );

  if (result.stream) {
    return streamSse(result.stream, result.status, result.headers);
  }

  return sendFrameworkResponse({
    status: result.status,
    headers: result.headers,
    body: result.raw ?? result.body,
  });
}
```

## Authentication in custom adapters

There are two valid patterns:

- let the host framework authenticate first and pass `user` into the route context
- forward the raw auth header and let Agent Server run its configured auth provider path

Whichever approach you choose, keep it consistent. Mixing partial framework auth with partial runtime auth is where access bugs usually start.

If you use the Agent Server auth config, preserve:

- `headerName`
- `excludeRoutes`
- the same route path shape relative to `basePath`

## Streaming in custom adapters

If `handleRequest(...)` returns `result.stream`, the adapter must return an SSE response instead of serializing JSON.

At minimum, set headers equivalent to:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

Then write each yielded chunk as-is. Do not repackage the chunks into a different event format, because client integrations and built-in docs already assume the server’s SSE contract.

## Swagger and raw responses

Not every response is JSON. Custom adapters should also preserve:

- HTML responses for Swagger UI
- raw binary responses for file download paths

If you force everything through JSON serialization, `/docs` and file routes will break.

## When to write a custom adapter

Write one when:

- your host framework is neither Express nor Next.js
- you need tighter control over request lifecycle hooks
- you are embedding Agent Server into an existing platform router
- you need framework-specific auth or tracing before the server runtime executes

Do not write one just to slightly restyle an existing integration. Start from Express or Next.js unless you have a real hosting mismatch.

## Where to look next

- [Express.js](/guide/express) for the middleware pattern
- [Next.js](/guide/nextjs) for the App Router handler pattern
- [Client Integration](/guide/client-integration) for frontend-facing request expectations
- [Streaming](/guide/streaming) for the SSE response contract
