# Task System Documentation

## Overview

The Task system provides a comprehensive background job processing framework for the agent-server. Tasks are asynchronous operations that can perform complex processing with agent SDK tools, support file uploads, and notify callback URLs upon completion.

## Key Features

### 1. Background Processing
- Tasks run asynchronously without blocking API responses
- Automatic status tracking: `pending` → `running` → `completed` or `failed`
- Integration with both agent-sdk and custom agent handlers

### 2. Callback System
- HTTP POST notifications to callback URLs when tasks complete
- Payload includes task ID, status, and optional error message
- Non-blocking: callback failures don't affect task execution

### 3. File Support
- Tasks can accept multiple file uploads as input
- The files are checked against the agent's `files` settings (type, size, count; `403 attachments_disabled`, `415`, `400`, `409`) and kept in the conversation the task runs in - owned by the task's user, deleted with the conversation or after `files.retentionDays` - and the agent reads them like the files of a message (see [Files](/guide/file-management)); a task with files has its `conversationId` from the start
- File metadata is included in task results

### 4. Storage Flexibility
- Every storage provider holds tasks (memory, SQLite, PostgreSQL, MongoDB), with the same behaviour - see [Storage Providers](/guide/storage). A task and its conversation are stored together, so a restarted
  server finds them again (a task left `running` by a dead process is failed at the next start).

## API Endpoints

### Create Task
```http
POST /tasks
Content-Type: application/json

{
  "agentId": "your-agent-id",
  "input": "Task input text",
  "files": [
    {
      "name": "file.txt",
      "content": "base64-encoded-content",
      "mimeType": "text/plain"
    }
  ],
  "callbackUrl": "https://your-server.com/callback",
  "metadata": { "custom": "data" }
}
```

**Response**: 201 Created
```json
{
  "task": {
    "id": "task_abc123",
    "agentId": "your-agent-id",
    "status": "pending",
    "input": "Task input text",
    "callbackUrl": "https://your-server.com/callback",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### List Tasks
```http
GET /tasks?agentId=your-agent-id&status=completed&limit=20&offset=0
```

**Query Parameters**:
- `agentId` (optional): Filter by agent ID
- `status` (optional): Filter by status (`pending`, `running`, `completed`, `failed`, `waiting_for_input`, `cancelled`)
- `conversationId` (optional): Filter by the conversation the task runs in
- `limit` (optional): Number of tasks to return (default: 20)
- `offset` (optional): Number of tasks to skip (default: 0)

**Response**: 200 OK
```json
{
  "tasks": [...],
  "total": 100,
  "limit": 20,
  "offset": 0,
  "hasMore": true
}
```

### Get Task Details
```http
GET /tasks/:taskId
```

**Response**: 200 OK
```json
{
  "task": {
    "id": "task_abc123",
    "agentId": "your-agent-id",
    "status": "completed",
    "input": "Task input text",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "completedAt": "2024-01-01T00:00:05.000Z"
  },
  "result": {
    "id": "taskres_xyz789",
    "taskId": "task_abc123",
    "content": "Task result content",
    "usage": {
      "inputTokens": 10,
      "outputTokens": 20,
      "totalTokens": 30
    }
  }
}
```

A task that is `waiting_for_input` on an approval or a question adds `pendingActions` (answer them on the task's conversation, see below); the partial
`result` is what the agent said so far.

### Get Task Status
```http
GET /tasks/:taskId/status
```

**Response**: 200 OK
```json
{
  "taskId": "task_abc123",
  "status": "running",
  "conversationId": "conv_def456",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:02.000Z",
  "startedAt": "2024-01-01T00:00:01.000Z"
}
```

`completedAt` and `error` are added when the task has finished or failed.

### Get Task Result
```http
GET /tasks/:taskId/result
```

**Response**: 200 OK
```json
{
  "result": {
    "id": "taskres_xyz789",
    "taskId": "task_abc123",
    "content": "Task result content",
    "files": [],
    "metadata": {},
    "usage": {
      "inputTokens": 10,
      "outputTokens": 20,
      "totalTokens": 30
    },
    "createdAt": "2024-01-01T00:00:05.000Z"
  }
}
```

### Comments
```http
POST /tasks/:taskId/comments
GET  /tasks/:taskId/comments
```

A comment is the next user message of the task's conversation: the agent sees it together with everything before, and the task is processed again (`pending` -> `running` -> ...).
Comment on a task that has finished or that asked for clarification the old way (see below); a `running` task is `409 task_busy` and one that waits on an approval or a question is `409 action_pending`.

```json
// POST body
{ "content": "Use the production data instead.", "metadata": {} }

// 201
{ "comment": { "id": "comment_...", "taskId": "task_abc123", "role": "user", "content": "...", "createdAt": "..." }, "task": { "id": "task_abc123", "status": "pending" } }

// GET 200
{ "comments": [ { "id": "comment_...", "role": "agent", "content": "Which data?" }, { "role": "user", "content": "Use the production data instead." } ], "total": 2 }
```

`content` is required (`400 INVALID_REQUEST`).

### Cancel a Task
```http
POST /tasks/:taskId/cancel
```

Stops the turn the task is running (the agent sees the abort signal, see [Runs](/guide/runs#cancel)) or cancels the actions it waits on, and sets the
status to `cancelled`. `200` with `{ task }`; `202` while the run is still winding down or runs on another node; `409 task_finished` for a task that has
completed or failed; cancelling a cancelled task is a no-op.

## Tasks run in a conversation

Each task gets a conversation of its own (`task.conversationId`, created when it starts) and runs through the same machinery as a message: the same
[event log](/guide/runs#the-event-log), cancellation, and approvals.

- The task's `input` (and `files`) is the first user message; a **comment** on a finished or waiting task is the next one, in the same conversation, so the agent sees the whole exchange.
- When the agent pauses for a tool approval or a question, the task becomes `waiting_for_input` and `GET /tasks/:id` lists the `pendingActions`. Answer them with
  `POST /conversations/:conversationId/actions/:actionId`; when the turn finishes, the task is `completed` with the result (or `waiting_for_input` again if it pauses again).
  A comment on a task that waits on an action is a `409 action_pending`; a comment on a task that is `running` is a `409 task_busy`.
  A request nobody answers lapses ([`hitl.timeoutMinutes`](/guide/human-in-the-loop#requests-that-lapse)): under `onTimeout: 'deny'` (the default) the agent is told the tool was refused and the task carries on; under `'cancel'` the task ends `cancelled`.
  A task runs in an ordinary conversation, so the agent's [budget](/guide/budgets) applies: a task the budget cuts short fails ("... budget ... was reached"); one that only crossed it completes.
- A custom handler that asks for clarification the old way (`metadata.waitingForInput: true` in its result) still works: the question is added as an agent comment,
  and the next user comment is the answer. Handlers now receive the task's real conversation id (it used to be `task_<id>`), and `metadata.comments` as before.
- Follow a task live with `GET /conversations/:conversationId/events/stream`; list a conversation's tasks with `GET /tasks?conversationId=`.
- The task's conversation is an ordinary conversation of the task's user (`metadata: { source: 'task', taskId }`), so it also shows up in `GET /conversations`; a UI that lists chats can filter on `metadata.source`. It gets no generated title.

Statuses: `pending` -> `running` -> `completed` | `failed` | `cancelled`, or `waiting_for_input` (then `running` again). A task that was `running` when its
server died is set to `failed` ("The server stopped while the task was running") at the next start, see [Recovery](/guide/runs#recovery).

## Callback Notifications

When a task completes, the system sends an HTTP POST request to the callback URL (if provided):

**Callback Payload**:
```json
{
  "taskId": "task_abc123",
  "status": "completed",
  "timestamp": "2024-01-01T00:00:05.000Z"
}
```

**On Failure** (an `error` field is added):
```json
{
  "taskId": "task_abc123",
  "status": "failed",
  "error": "Error message",
  "timestamp": "2024-01-01T00:00:05.000Z"
}
```

## Usage Example

### 1. Register an Agent
```typescript
import { createAgentServer, createInMemoryProvider } from '@cognipeer/agent-server';

const agentServer = createAgentServer({
  basePath: '/api/agents',
  storage: createInMemoryProvider(),
});

// Register a custom agent
agentServer.registerCustomAgent('my-processor', {
  processMessage: async ({ message, files }) => {
    // Process the task
    const result = await processData(message, files);
    
    return {
      content: result,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    };
  },
}, {
  name: 'My Processor',
  description: 'Custom task processor',
});
```

### 2. Create and Track a Task
```typescript
// Create task
const createResponse = await fetch('http://localhost:3000/api/agents/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agentId: 'my-processor',
    input: 'Process this data',
    callbackUrl: 'http://localhost:3001/callback'
  })
});

const { task } = await createResponse.json();
console.log('Task created:', task.id);

// Check status
const statusResponse = await fetch(`http://localhost:3000/api/agents/tasks/${task.id}/status`);
const status = await statusResponse.json();
console.log('Task status:', status.status);

// Get result (when completed)
const resultResponse = await fetch(`http://localhost:3000/api/agents/tasks/${task.id}/result`);
const result = await resultResponse.json();
console.log('Task result:', result.result.content);
```

## Implementation Details

### Storage Schema

Tasks are stored by the storage provider; the tables and collections, with their indexes, are listed in [Storage Providers](/guide/storage). A task holds `agentId`, `userId`,
`conversationId`, `status`, `callbackUrl`, `input`, `files`, `comments`, `metadata`, its times and `error`; it has at most one result (`content`, `files`, `metadata`, `usage`) - a second
result replaces the first (the `waiting_for_input` cycle writes a partial result, then the final one).

### Background Processing Flow

1. Task created → status: `pending`
2. Background processor starts → status: `running`, `startedAt` set; a conversation is created for the task (`conversationId`)
3. The agent processes the input as a turn of that conversation
4. Result saved → status: `completed`, `completedAt` set (or `waiting_for_input` with the partial result and `pendingActions`, or `cancelled`)
5. Callback notification sent (if URL provided; `status` is `completed`, `failed`, `waiting_for_input` or `cancelled`)
6. On error → status: `failed`, `error` message saved

## Best Practices

### 1. Use Callbacks for Long-Running Tasks
```typescript
// Good: Use callback for async notification
{
  agentId: 'processor',
  input: 'Long task',
  callbackUrl: 'https://myapp.com/webhook'
}

// Poll for status only when necessary
```

### 2. Handle Callback Failures Gracefully
```typescript
app.post('/webhook', (req, res) => {
  const { taskId, status } = req.body;
  
  // Process callback
  processTaskCompletion(taskId, status);
  
  // Always respond quickly
  res.status(200).json({ received: true });
});
```

### 3. Use Metadata for Context
```typescript
{
  agentId: 'processor',
  input: 'Task data',
  metadata: {
    userId: 'user123',
    priority: 'high',
    tags: ['urgent', 'customer']
  }
}
```

### 4. Monitor Task Status
```typescript
// Periodic status check
const checkStatus = async (taskId) => {
  const res = await fetch(`/api/agents/tasks/${taskId}/status`);
  const { status } = await res.json();
  
  if (status === 'completed') {
    // Get result
    const result = await getTaskResult(taskId);
    handleResult(result);
  } else if (status === 'failed') {
    // Handle error
    handleError(taskId);
  }
  
  return status;
};
```

## Security Considerations

1. **User Isolation**: A task belongs to the user who created it; another user gets 403. `GET /tasks` lists one user's tasks and needs a resolved user (`401 identity_required` otherwise, unless `allowAnonymousList` is set, see [Request Context](/guide/request-context#who-may-list))
2. **Callback URLs**: The server POSTs to whatever `callbackUrl` a task names, from the server's network. Validate it (https, an allow-list of hosts, no private addresses) before a task is created in production
3. **Input Validation**: Always validate task input before processing
4. **Rate Limiting**: Consider implementing rate limits for task creation
5. **File Size Limits**: Use the `limits.maxFileSize` configuration

## Demo Example

See `examples/tasks-demo.ts` for a complete working example with:
- Custom task processors
- File handling
- Callback server
- All API endpoints

Run it with:
```bash
npx tsx examples/tasks-demo.ts
```

## Swagger Documentation

All Task endpoints are documented in Swagger UI at `/api/agents/docs` (when enabled).
