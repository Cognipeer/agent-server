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
- Files are processed and stored using the configured storage provider
- File metadata is included in task results

### 4. Storage Flexibility
- Full support across all storage providers:
  - In-Memory (for development/testing)
  - PostgreSQL (production-ready with indexes)
  - MongoDB (NoSQL option with indexes)

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
- `status` (optional): Filter by status (`pending`, `running`, `completed`, `failed`)
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

### Get Task Status
```http
GET /tasks/:taskId/status
```

**Response**: 200 OK
```json
{
  "taskId": "task_abc123",
  "status": "running",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:02.000Z",
  "startedAt": "2024-01-01T00:00:01.000Z"
}
```

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

**On Failure**:
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

**PostgreSQL**:
```sql
CREATE TABLE agent_server_tasks (
  id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  callback_url VARCHAR(2000),
  input TEXT NOT NULL,
  files JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT
);

CREATE TABLE agent_server_task_results (
  id VARCHAR(64) PRIMARY KEY,
  task_id VARCHAR(64) NOT NULL REFERENCES agent_server_tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  files JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  usage JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**MongoDB**:
Collections: `tasks` and `task_results` with appropriate indexes.

### Background Processing Flow

1. Task created → status: `pending`
2. Background processor starts → status: `running`, `startedAt` set
3. Agent processes the task
4. Result saved → status: `completed`, `completedAt` set
5. Callback notification sent (if URL provided)
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

1. **User Isolation**: Tasks are filtered by userId when auth is enabled
2. **Callback URLs**: Validate callback URLs before creating tasks in production
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
