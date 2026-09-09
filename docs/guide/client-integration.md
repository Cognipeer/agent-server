# Client Integration

Client integration is the layer where your frontend, mobile app, or SDK consumer meets the Agent Server REST surface. This deserves its own guide because the main runtime questions are not about storage internals. They are about which routes to call, how to pass identity, when to stream, and how to keep conversation state coherent in the UI.

## What the client usually needs

Most product integrations end up needing four flows:

1. list or create conversations
2. load a conversation with its existing messages
3. send a new message, optionally with files
4. stream the assistant response when low-latency UX matters

If you model those four flows cleanly, the rest of the client work becomes much simpler.

## Recommended request flow

Use this sequence for a normal chat-style product integration:

1. call `GET /conversations` to load the user’s recent sessions
2. call `POST /conversations` when the user starts a new thread
3. call `GET /conversations/:conversationId` to hydrate the message list
4. call `POST /conversations/:conversationId/messages` for each new turn
5. call `GET /conversations/:conversationId/messages` when you need pagination or a sync refresh

This keeps the client aligned with the runtime’s own conversation model instead of inventing a second local thread abstraction.

## Identity and auth headers

From the client’s point of view, identity can come from:

- an `Authorization` header handled by the server auth provider
- framework-owned session logic that ultimately resolves a user id
- explicit request fields like `userId`, when your deployment intentionally allows that

If the server is enforcing authenticated conversation ownership, treat the auth header as part of every conversation and message request, not only the send-message call.

## Sending messages

The main message route accepts:

- `message`
- optional `files`
- optional `metadata`
- optional `stream`

Standard JSON mode returns the persisted user message and the persisted assistant response in one payload. Use this when:

- your UI is simple
- low latency is not critical
- you want the easiest integration path first

## Streaming mode

If the client sends `stream: true`, the same route switches to SSE output.

Use streaming when:

- you want partial text to appear while the response is generated
- your UI needs to surface tool activity or progress
- the server may take long enough that a single blocking response feels broken

The event stream can emit:

- `stream.start`
- `stream.text`
- `stream.tool_call`
- `stream.tool_result`
- `stream.progress`
- `stream.error`
- `stream.done`

Design your client event handling around that contract instead of assuming text-only chunks.

## File-aware clients

Files can enter the system in two ways:

- as attachments on `POST /conversations/:conversationId/messages`
- through the dedicated file routes under `/files`

For product UIs, the first path is usually the better starting point because it keeps the message turn and attachment lifecycle together.

Use the direct file routes when:

- you need separate upload workflows
- files must exist before a message is sent
- you need metadata lookup or download endpoints independently of a message composer

## Swagger as an integration tool

When Swagger is enabled, it is not just for backend developers. It is useful for frontend teams too:

- inspect exact payload shapes
- verify whether auth is required on a route
- test conversation and file flows before writing a dedicated client
- compare docs claims against the generated runtime contract

This shortens integration loops and catches drift earlier.

## Good client defaults

If you are building a new client against Agent Server, start with these defaults:

- create the conversation explicitly before the first send
- keep the server’s `conversationId` as the canonical thread id
- prefer JSON mode first, then move to SSE once the base flow is stable
- treat auth headers as part of every request, not just writes
- let the server own transcript persistence instead of duplicating message state rules on the client

## Where to look next

- [Conversations & Messages](/guide/conversations-messages) for the lifecycle under the hood
- [Streaming](/guide/streaming) for SSE event handling
- [File Management](/guide/file-management) for upload and download paths
- [Swagger UI](/guide/swagger) for runtime contract inspection
