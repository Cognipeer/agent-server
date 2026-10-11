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

The list is **one user's**: the token user, `context.user` from `resolveContext`, or - without `resolveContext` - `?userId=`. A request that names nobody would list everyone's conversations and is
refused with `401 identity_required`, unless the server sets `allowAnonymousList` (see [Request Context](../guide/request-context#who-may-list)). With `resolveContext`, `userId` in the query is ignored.

### Create Conversation

```
POST /conversations
```

**Request Body:**

```json
{
  "agentId": "assistant",
  "title": "New Chat",
  "metadata": {},
  "budget": { "maxCostUsd": 2, "onReach": "pause" }
}
```

`budget` is optional: a spend limit for this conversation (`null`: none). Without it the conversation starts with the agent's (`AgentRegistration.budget`, else the server's `budget`). A limit above that default needs
the `authorizeBudget` option (`403 budget_forbidden`); a malformed one is `400 invalid_budget`, an agent that cannot price its calls `400 budget_unavailable`. See [Usage & Budgets](../guide/budgets).

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
  "metadata": { "favorite": true },
  "budget": { "maxCostUsd": 20, "onReach": "pause" }
}
```

Every field is optional. `budget` sets the conversation's spend limit (`null` removes it); lowering it is the owner's to do, raising or removing it goes through the
`authorizeBudget` option (`403 budget_forbidden` without it), and it has to be above what the conversation has spent (`400 invalid_budget`). See [Usage & Budgets](../guide/budgets).

**Response:** the conversation (with its `runtime` when `budget` was changed, so a client sees `budget_paused` become `idle`).

```json
{
  "id": "conv_123",
  "title": "Updated Title",
  "metadata": { "favorite": true },
  "budget": { "maxCostUsd": 20, "onReach": "pause" },
  "spentUsd": 0.42,
  "updatedAt": "2025-01-01T00:00:02.000Z"
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
| limit | number | Max results (default: 100, at most 200) |
| offset | number | Messages to skip (default: 0) |
| order | string | `asc` (default, oldest first) or `desc` |

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
  ],
  "total": 2,
  "limit": 100,
  "offset": 0,
  "hasMore": false
}
```

To page a long conversation by message id (`before` / `after`), use [Get Conversation](#get-conversation).

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

`fileIds` attaches files uploaded earlier into this conversation with `POST /files` (a file that is not this conversation's, or that the caller did not upload, is a 404); `files`
(`[{ name, content: <base64>, mimeType }]`) attaches inline ones, which are stored first. The agent is given the files' contents - see [Files](../guide/file-management).

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

`usage` is what this turn used (`cachedInputTokens` and `costUsd` when known); a conversation with a budget also gets `budget` and `spentUsd` - see [Usage & Budgets](../guide/budgets).

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
| 400 | `VALIDATION_ERROR` | No `message`; malformed `fileIds` / `files`; too many files in the message; a file over the size limit or empty |
| 402 | `budget_reached` | The conversation's [budget](../guide/budgets) is used up (`error.details`: `spentUsd`, `maxCostUsd`, `onReach`); nothing was stored |
| 403 | `attachments_disabled` | The message carries files and the agent takes none |
| 404 | `NOT_FOUND` | Unknown conversation; a `fileIds` entry that is not a file of this conversation (or not the caller's) |
| 409 | `too_many_files` | The files would take the conversation past `files.maxFiles` |
| 415 | `unsupported_file_type` | An inline file of a type the agent does not accept |
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
| 400 | `invalid_approved_args` | `approvedArgs` that the tool's schema does not accept |
| 402 | `budget_reached` | The answer would let the agent run again and the conversation's budget is used up; nothing was recorded |
| 403 | `FORBIDDEN` / `action_forbidden` | Not your conversation / `hitl.authorizeResolve` says no |
| 404 | `NOT_FOUND` | Unknown conversation, or the agent cannot resolve actions |
| 409 | `action_not_pending` | Unknown or already resolved |
| 409 | `conversation_busy` | A message or a continuation is running in the conversation (another answer to the same pause is waited for, up to `hitl.resolveWaitMs`) |
| 410 | `action_expired` | The request lapsed (`expiresAt`); the expiry sweep handles it per `hitl.onTimeout` |

While a conversation has a pending action, `POST /conversations/:id/messages` answers `409 action_pending` (`error.details.pendingActionIds`), unless the server was configured with `pendingActionPolicy: 'cancel'`.

`GET /conversations/:id` includes `pendingActions` (omitted when there are none) so a reloaded UI can render the open request, and the paused message's `metadata.pendingActions` records how each action ended.

### Remembered tools

```
GET    /conversations/:id/remembered-tools
DELETE /conversations/:id/remembered-tools/:tool
```

The tools whose approval the person chose to remember for the conversation (`rememberForSession`), and a way to forget one. Both answer `{ "tools": ["deploy"] }`; `DELETE` is `404` for a tool that is not
remembered. See [Remembered tools](../guide/human-in-the-loop#remembered-tools).

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

### Continue

```
POST /conversations/:id/continue
```

Carries on a turn the conversation's budget stopped, with no new message. Body `{ "stream": true }` is optional. Response: the same as [resolving an action](#resolve-a-pending-action).

| Status | Code | When |
|--------|------|------|
| 402 | `budget_reached` | The budget is still used up: raise it first (`PATCH /conversations/:id`) |
| 409 | `action_pending` | The conversation waits on a person |
| 409 | `nothing_to_continue` | No turn was stopped by the budget (or it was carried on already) |
| 409 | `conversation_busy` | A turn is running |

See [Usage & Budgets](../guide/budgets).

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

Settings, limits and what the agent is given: [Files](../guide/file-management).

### Upload File

```
POST /files
```

Either the file **as itself** - its bytes as the body, its own `Content-Type`:

```
POST /files?name=contract.pdf&conversationId=conv_123
Content-Type: application/pdf

<the bytes>
```

| Query | |
|-------|--|
| `name` | the file's name (required) |
| `conversationId` | the conversation the file is for. Without it the file belongs to no conversation and cannot be attached to a message |
| `mimeType` | overrides the `Content-Type` header |

or **JSON** (a request without a `Content-Type` is read as JSON):

```json
{ "file": { "name": "contract.pdf", "content": "<base64>", "mimeType": "application/pdf" }, "conversationId": "conv_123", "metadata": {} }
```

**Response `201`:**

```json
{
  "file": {
    "id": "file_123",
    "name": "contract.pdf",
    "mimeType": "application/pdf",
    "size": 12345,
    "storageKey": "...",
    "conversationId": "conv_123",
    "userId": "user_1",
    "agentId": "contracts",
    "expiresAt": "2025-01-31T00:00:00.000Z",
    "metadata": {},
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

| Status | Code | When |
|--------|------|------|
| 400 | `VALIDATION_ERROR` | No file or name; an empty file (`File is empty`); over the size limit (`error.details.reason: "file_too_large"`) |
| 403 | `attachments_disabled` | The conversation's agent takes no files |
| 403 | `FORBIDDEN` | The conversation is not the caller's |
| 404 | `NOT_FOUND` | Unknown conversation |
| 409 | `too_many_files` | The conversation already holds `files.maxFiles` files |
| 413 | `PAYLOAD_TOO_LARGE` | The body is over the adapter's limit |
| 415 | `unsupported_file_type` | The agent's `allowedMimeTypes` does not include the type |

### List a Conversation's Files

```
GET /conversations/:id/files?limit=&offset=
```

```json
{ "files": [ { "id": "file_123", "name": "contract.pdf" } ], "total": 1, "limit": 100, "offset": 0, "hasMore": false, "maxFiles": 10 }
```

Oldest first. `maxFiles` is what the conversation may hold.

### Get File Metadata

```
GET /files/:fileId
```

The record, as in the upload response. `404` for a file that does not exist, that the caller did not upload, or whose conversation the caller cannot open.

### Download File

```
GET /files/:fileId/content?disposition=attachment|inline
```

Returns the bytes with the file's `Content-Type` (sanitised), `Content-Disposition: attachment; filename="..."`, `X-Content-Type-Options: nosniff` and
`Cache-Control: private, no-store`. `disposition=inline` shows a picture, PDF or plain text in place; HTML, SVG and other active types are always downloads.

### Delete File

```
DELETE /files/:fileId
```

`204`. Files also go with their conversation and when `files.retentionDays` have passed.

## Tasks

Background jobs, each run in a conversation of its own. See [Tasks](../tasks).

### Create Task

```
POST /tasks
```

```json
{ "agentId": "assistant", "input": "Summarise the attached report", "files": [{ "name": "report.txt", "content": "<base64>", "mimeType": "text/plain" }], "callbackUrl": "https://example.com/hook", "metadata": {} }
```

`201 { task }` with `status: "pending"`; the work starts at once. `400` without `agentId` or `input` (or for a bad file), `404` for an unknown agent, and the file errors of [Upload File](#upload-file).

### List Tasks

```
GET /tasks?agentId=&status=&conversationId=&limit=&offset=
```

One user's tasks (the same identity rule as [List Conversations](#list-conversations): `401 identity_required` for a request that names nobody). `status` is `pending`, `running`, `completed`,
`failed`, `waiting_for_input` or `cancelled`. Response: `{ tasks, total, limit, offset, hasMore }`.

### Get Task

```
GET /tasks/:id
GET /tasks/:id/status
GET /tasks/:id/result
```

`GET /tasks/:id` is `{ task, result?, pendingActions? }` (`pendingActions` while the task waits on an approval or a question; answer them on the task's conversation). `/status` is
`{ taskId, status, conversationId, createdAt, updatedAt, startedAt?, completedAt?, error? }` and `/result` is `{ result }`, `404` until the task has one.

### Cancel Task

```
POST /tasks/:id/cancel
```

`200 { task }` (`202` while the run is winding down), `409 task_finished` for a task that completed or failed.

### Comments

```
POST /tasks/:id/comments      { "content": "...", "metadata": {} }
GET  /tasks/:id/comments
```

`POST` answers `201 { comment, task }` and runs the task again; `409 task_busy` while it runs, `409 action_pending` while it waits on an approval. `GET` is `{ comments, total }`.

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

Every error has one shape, and a `code` to switch on (the full list is in [Error Handling](../guide/error-handling)):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "message is required", "details": {} } }
```

| Status | Code | When |
|--------|------|------|
| 400 | `VALIDATION_ERROR` | The request is malformed |
| 401 | `AUTHENTICATION_ERROR` | Missing or invalid credentials |
| 401 | `identity_required` | A list request that names no user |
| 403 | `FORBIDDEN` | The conversation, task or file is somebody else's |
| 404 | `NOT_FOUND` | It does not exist (or is not yours) |
| 409 | `conversation_busy`, `action_pending`, ... | The state does not allow it right now |
| 500 | `INTERNAL_ERROR` | Anything unexpected |
