# Conversations & Messages

Conversations and messages are the core persistence layer of Agent Server. They sit above raw storage, but below framework adapters and client UX, which makes them the part you need to understand before auth, files, and streaming feel predictable together.

## What the runtime owns

The server exposes a conversation lifecycle with built-in storage calls for:

- creating a conversation
- listing conversations with pagination
- loading a conversation with its message history
- updating title and metadata
- deleting a conversation
- listing messages for a conversation
- sending a new message and persisting both user and assistant turns

This is not just an API surface. The runtime also verifies conversation access, resolves the effective user id, and updates conversation state when an agent backend returns new state.

## Conversation model

At runtime, a conversation stores:

- `id`
- `agentId`
- optional `userId`
- optional `title`
- optional `metadata`
- optional `state`
- `createdAt`
- `updatedAt`

The `state` field matters when you use custom handlers or Responses API chaining. It is the durable place where runtime-specific state can survive between turns.

## Message model

Messages are persisted as a message-first transcript. A message can contain:

- `role`: `user`, `assistant`, `system`, or `tool`
- `content`: either a plain string or structured content parts
- optional `name`
- optional `toolCalls`
- optional `toolCallId`
- optional `files`
- optional `metadata`

That means the transcript can preserve more than just plain text. Tool call details, attachments, and richer content parts can all move through the same storage contract.

## Route surface

These routes make up the main conversation flow:

| Method | Route | What it does |
| --- | --- | --- |
| `GET` | `/conversations` | List conversations with pagination and optional `agentId` or `userId` filters |
| `POST` | `/conversations` | Create a new conversation for an agent |
| `GET` | `/conversations/:conversationId` | Load one conversation together with messages |
| `PATCH` | `/conversations/:conversationId` | Update title or metadata |
| `DELETE` | `/conversations/:conversationId` | Delete a conversation |
| `GET` | `/conversations/:conversationId/messages` | List messages with paging and order |
| `POST` | `/conversations/:conversationId/messages` | Send a message and persist the assistant response |

The OpenAPI schema in the Swagger generator mirrors the same surface, so the docs and Swagger UI stay aligned.

## User identity and access checks

Conversation ownership is not inferred from one source only. The runtime resolves the acting user from:

1. explicit request data such as `userId`
2. authenticated token user info
3. the optional `resolveUserId` callback in auth config

When a conversation already has a `userId`, Agent Server verifies that the current request resolves to the same user before returning or mutating the record.

This is why conversation handling should be treated as its own feature area instead of a side note under auth.

## Sending a message

Sending a message does more than append text:

1. the server validates the request
2. it loads the conversation and verifies access
3. it persists the new user message
4. it loads prior messages as context
5. it routes execution to the registered agent backend
6. it persists the assistant response
7. it updates conversation state or title when needed

If the request includes `stream: true`, the same route switches into SSE streaming mode instead of the standard JSON response path.

## Title generation

If title generation is configured and the conversation is still untitled, the runtime can automatically generate a short title from the first user message. This happens after the first exchange and updates the stored conversation record.

Use this when your client UI needs a readable conversation list without implementing a second naming pipeline.

## Where to look next

- [Authentication](/guide/authentication) for user resolution and token validation
- [Streaming](/guide/streaming) for the `stream: true` response path
- [File Management](/guide/file-management) for file uploads and stored attachments
- [Swagger UI](/guide/swagger) for the generated REST contract
