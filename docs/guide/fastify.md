# Fastify & Node HTTP

## Fastify

```typescript
import Fastify from 'fastify';
import { createAgentServer } from '@cognipeer/agent-server';
import { mountOnFastify } from '@cognipeer/agent-server/fastify';

const app = Fastify();
const server = createAgentServer({ basePath: '/unused', storage, resolveContext });

// Static or parameterised prefix. Params arrive as req.mountParams in resolveContext.
mountOnFastify(app, server, { prefix: '/api/portal/:portalKey', bodyLimit: 15 * 1024 * 1024 });
```

Or register the plugin yourself: `app.register(createFastifyPlugin(server), { prefix })`.

Behaviour:

- Routes are resolved **relative to the prefix**; the server's own `basePath` is not used.
- Fastify has already parsed the JSON body when our route runs - the parsed body is
  used (the request stream is not read again).
- The reply is hijacked and written on the raw response (needed for SSE). Headers set
  by earlier hooks/plugins (request ids, CORS) are copied over.
- Raise `bodyLimit` (Fastify default 1 MiB) if clients upload base64 files. A body over the
  limit is answered in our envelope (`413`, `{ error: { code: "PAYLOAD_TOO_LARGE", message } }`),
  not Fastify's own error shape; every other Fastify error still goes to your error handler.
- `fastify` is an optional peer dependency (>= 4).

## Raw Node HTTP

```typescript
import http from 'node:http';
import { createNodeHandler } from '@cognipeer/agent-server';

const handle = createNodeHandler(server, { basePath: '/api/agents' });

http.createServer(async (req, res) => {
  const handled = await handle(req, res); // false: path is outside basePath, nothing written
  if (!handled) { res.statusCode = 404; res.end(); }
}).listen(3000);
```

`createNodeHandler(server, options)`:

| Option | Default | |
| --- | --- | --- |
| `basePath` | `server.getBasePath()` | prefix to strip; `""` if a router already stripped it |
| `maxBodyBytes` | `limits.maxBodySize`, else ~1.4 x `limits.maxFileSize` | larger bodies answer 413 |

The returned function takes optional per-call overrides `{ path, body, mountParams, raw, error }`
for hosts that did part of the work (this is how the Fastify adapter is built). `error` answers
with that `{ statusCode, code, message }` instead of routing, with the usual CORS headers.

It handles token auth, `resolveContext`, JSON parsing (400 on invalid JSON), CORS
(`config.cors`), SSE with backpressure, and stops consuming the stream when the client disconnects.
