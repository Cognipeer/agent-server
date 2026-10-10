# REST Endpoints

Complete API endpoint reference.

## Base URL

All endpoints are relative to the configured `basePath`:

```
{basePath}/{endpoint}
```

For example, if `basePath` is `/api/agents`:
- List agents: `GET /api/agents/agents`
- Create conversation: `POST /api/agents/conversations`

## Agents

### List Agents

```
GET /agents
```

Returns all registered agents.

**Response:**

```json
{
  "agents": [
    {
      "id": "assistant",
      "name": "AI Assistant",
      "description": "A helpful AI assistant",
      "version": "1.0.0"
    }
  ]
}
```

### Get Agent

```
GET /agents/:agentId
```

Returns details for a specific agent.

**Response:**

```json
{
  "id": "assistant",
  "name": "AI Assistant",
  "description": "A helpful AI assistant",
  "version": "1.0.0",
  "metadata": {}
}
```

## Conversations

### List Conversations

```
GET /conversations
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| agentId | string | Filter by agent ID |
| userId | string | Filter by user ID |
| limit | number | Max results (default: 20) |
| offset | number | Pagination offset (default: 0) |
| orderBy | string | `createdAt` (default) or `updatedAt` (last activity) |
| order | string | `desc` (default, newest first) or `asc` |

**Response:**

```json
{
  "conversations": [
    {
      "id": "conv_123",
      "agentId": "assistant",
      "userId": "user_456",
      "title": "My Chat",
      "runtime": { "status": "idle", "stopReason": "end_turn", "lastEventSeq": 5, "pendingActionIds": [] },
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "total": 42,
  "hasMore": true
}
```

`runtime` says whether the conversation is running, waiting for a human or idle, and why its last turn stopped - see [Runs, Cancel & Reattach](../guide/runs).

### Create Conversation

```
POST /conversations
```

**Request Body:**

```json
{
  "agentId": "assistant",
  "title": "New Chat",
  "metadata": {}
}
```

**Response:**

```json
{
  "conversation": {
    "id": "conv_123",
    "agentId": "assistant",
    "userId": "user_456",
    "title": "New Chat",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
}
```

### Get Conversation

```
GET /conversations/:id
```

Returns the conversation and one page of its messages: the **newest** `limit` messages, oldest first within the page.

**Query Parameters:**

| Name | Description |
| --- | --- |
| `limit` | Messages per page (default 100, at most 200; `limits.messagePageSize` / `limits.maxPageSize`) |
| `before` | Only messages older than this message id (use the id of the first message you have to page back) |
| `after` | Only messages newer than this message id |
| `order` | `asc` (default) or `desc`, the order of the returned page |

`before` and `after` together are a 400; an id that is not a message of this conversation is a 404.

**Response:**

```json
{
  "conversation": {
    "id": "conv_123",
    "agentId": "assistant",
    "title": "My Chat",
    "runtime": { "status": "idle", "stopReason": "end_turn", "lastEventSeq": 5, "pendingActionIds": [] },
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:01.000Z"
  },
  "messages": [
    {
      "id": "msg_1",
      "role": "user",
      "content": "Hello!",
      "createdAt": "2025-01-01T00:00:00.000Z"
    },
    {
      "id": "msg_2",
      "role": "assistant",
      "content": "Hi there! How can I help?",
      "status": "completed",
      "metadata": { "status": "completed", "stopReason": "end_turn" },
      "createdAt": "2025-01-01T00:00:01.000Z"
    }
  ],
  "messagesPage": { "limit": 100, "order": "asc", "hasMoreBefore": false, "hasMoreAfter": false }
}
```

### Update Conversation

```
PATCH /conversations/:id
```

**Request Body:**

```json
{
  "title": "Updated Title",
  "metadata": { "favorite": true }
}
```

**Response:**

```json
{
  "conversation": {
    "id": "conv_123",
    "title": "Updated Title",
    "metadata": { "favorite": true },
    "updatedAt": "2025-01-01T00:00:02.000Z"
  }
}
```

### Delete Conversation

```
DELETE /conversations/:id
```

Deletes the conversation, its messages, files and event log. A turn that is running is cancelled first (`409 conversation_busy` if it runs on another node).

**Response:** `204`, no body.

## Messages

### List Messages

```
GET /conversations/:id/messages
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| limit | number | Max results (default: 100) |
| before | string | ISO date - get messages before this time |

**Response:**

```json
{
  "messages": [
    {
      "id": "msg_1",
      "conversationId": "conv_123",
      "role": "user",
      "content": "Hello!",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

### Send Message

```
POST /conversations/:id/messages
```

**Request Body:**

```json
{
  "message": "Hello, how are you?",
  "fileIds": ["file_123"],
  "stream": false,
  "metadata": {}
}
```

`fileIds` attaches files uploaded earlier with `POST /files` (`conversationId` set); `files` (`[{ name, content: <base64>, mimeType }]`) attaches inline ones.

**Response (`stream: false`):** the turn runs to its end and the response is the user message, the assistant message and how the turn ended.

```json
{
  "message": { "id": "msg_1", "conversationId": "conv_123", "role": "user", "content": "Hello, how are you?" },
  "response": {
    "id": "msg_2",
    "conversationId": "conv_123",
    "role": "assistant",
    "content": "Hello! I'm doing well, thank you for asking. How can I help you today?",
    "status": "completed",
    "metadata": { "status": "completed", "stopReason": "end_turn" }
  },
  "usage": { "inputTokens": 10, "outputTokens": 20, "totalTokens": 30 },
  "stopReason": "end_turn",
  "runId": "run_x1"
}
```

`status` (a top-level field of the response) appears only when the turn did not simply complete: `requires_action` (with `pendingActions`), `cancelled`
or `incomplete`. `stopReason` is `end_turn`, `requires_action`, `cancelled`, `max_turns`, `limit`, `budget_reached` or `error`. `runId` is the run that
executed the turn; its [events](#events) carry it as `run_id`.

**Response (`stream: true`):** Server-Sent Events, see [Streaming](../guide/streaming):

```
data: {"type":"stream.start","conversationId":"conv_123","messageId":"msg_1","timestamp":1234567890,"seq":2}

data: {"type":"stream.text","text":"Hello!","isFinal":false,"timestamp":1234567891,"seq":2}

data: {"type":"stream.done","conversationId":"conv_123","messageId":"msg_2","content":"Hello!","stopReason":"end_turn","runId":"run_x1","timestamp":1234567893,"seq":5}
```

The turn runs detached from the connection: closing it does not stop it.

| Status | Code | When |
|--------|------|------|
| 400 | `VALIDATION_ERROR` | No `message`; malformed `fileIds`; too many files |
| 404 | `NOT_FOUND` | Unknown conversation; a `fileIds` entry that is not a file of this conversation |
| 409 | `action_pending` | The conversation waits on a pending action (`error.details.pendingActionIds`) |
| 409 | `conversation_busy` | A turn is already running in the conversation (`error.details.activeRunId`) |

### Resolve a Pending Action

```
POST /conversations/:id/actions/:actionId
```

Answers a tool approval or a question the agent paused on (see [Approvals & Questions](../guide/human-in-the-loop)) and continues the turn.

**Request Body:**

```json
{
  "resolution": { "type": "tool_approval", "decision": "allow", "rememberForSession": true },
  "stream": false
}
```

or `{ "resolution": { "type": "user_question", "answers": { "Which env?": "Production" } } }`.

**Response:** same shape as a message response, without the user `message` (`{ response, usage?, status?, pendingActions? }`). With `"stream": true` the response is the usual SSE sequence, starting with `stream.start` and `stream.action_resolved`.

| Status | Code | When |
|--------|------|------|
| 400 | `VALIDATION_ERROR` | Malformed resolution, wrong type for the action, invalid answers |
| 404 | `NOT_FOUND` | Unknown conversation, or the agent cannot resolve actions |
| 409 | `action_not_pending` | Unknown or already resolved |
| 409 | `conversation_busy` | A turn is running in the conversation, including another answer to the same pause |

While a conversation has a pending action, `POST /conversations/:id/messages` answers `409 action_pending` (`error.details.pendingActionIds`), unless the server was configured with `pendingActionPolicy: 'cancel'`.

`GET /conversations/:id` includes `pendingActions` (omitted when there are none) so a reloaded UI can render the open request.

## Runs

A turn runs as a run, independent of the request that started it. See [Runs, Cancel & Reattach](../guide/runs).

### Cancel

```
POST /conversations/:id/cancel
```

Aborts the turn that is running, or cancels the actions a paused conversation waits on. No body.

**Response:** `200` (`202` when the run is still winding down, or runs on another node: `settled: false`)

```json
{
  "cancelled": true,
  "runId": "run_x1",
  "settled": true,
  "cancelledActionIds": [],
  "stopReason": "cancelled",
  "runtime": { "status": "idle", "stopReason": "cancelled", "lastEventSeq": 14, "pendingActionIds": [] }
}
```

`cancelled: false` when there was nothing to cancel. `404` for an unknown conversation, `403` for somebody else's.

### Events

```
GET /conversations/:id/events
```

The conversation's event log, oldest first.

| Parameter | Description |
|-----------|-------------|
| `after` | Only events with a larger `seq` (default 0). A non-integer is a `400`. |
| `types` | Comma-separated event types to keep |
| `limit` | Events per page (default 100, at most 1000; `runs.eventPageSize` / `runs.maxEventPageSize`) |

```json
{
  "events": [
    { "seq": 7, "type": "agent.message", "data": { "content": "Hi!", "message_id": "msg_2", "stop_reason": "end_turn" }, "run_id": "run_x1", "created_at": "2026-10-11T10:00:03.120Z" }
  ],
  "hasMore": false,
  "lastSeq": 7
}
```

`lastSeq` is the `seq` of the last event returned (or `after` for an empty page): pass it as `after` to read on. The event types and their `data` are listed in
[Runs, Cancel & Reattach](../guide/runs#the-event-log).

### Event stream

```
GET /conversations/:id/events/stream
```

Server-Sent Events: replays the events after `?after=` (or the `Last-Event-ID` header, which wins), then follows the conversation. Frames are
`id: <seq>`, `event: <type>`, `data: <the event as above>`; `agent.message.delta` frames (no `id`) carry the model's text of a streamed turn; `: ping` every 15 s.
`types` filters as above. A closed connection never affects a run.

## Files

### Upload File

```
POST /files
```

**Content-Type:** `multipart/form-data`

**Form Fields:**

| Field | Type | Description |
|-------|------|-------------|
| file | File | The file to upload |

**Response:**

```json
{
  "file": {
    "id": "file_123",
    "name": "document.pdf",
    "mimeType": "application/pdf",
    "size": 12345,
    "url": "/api/agents/files/file_123/content",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

### Get File Metadata

```
GET /files/:fileId
```

**Response:**

```json
{
  "id": "file_123",
  "name": "document.pdf",
  "mimeType": "application/pdf",
  "size": 12345,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Download File

```
GET /files/:fileId/content
```

Returns the file content with appropriate `Content-Type` header.

### Delete File

```
DELETE /files/:fileId
```

**Response:**

```json
{
  "success": true
}
```

## Documentation

### Swagger UI

```
GET /docs
```

Returns the Swagger UI HTML page.

### OpenAPI Spec

```
GET /docs/openapi.json
```

Returns the OpenAPI 3.0 specification.

## Error Responses

### 400 Bad Request

```json
{
  "error": "Invalid request body",
  "code": "VALIDATION_ERROR"
}
```

### 401 Unauthorized

```json
{
  "error": "Authentication required",
  "code": "AUTH_REQUIRED"
}
```

### 404 Not Found

```json
{
  "error": "Conversation not found",
  "code": "NOT_FOUND"
}
```

### 500 Internal Server Error

```json
{
  "error": "Internal server error",
  "code": "SERVER_ERROR"
}
```
