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

**Response:**

```json
{
  "conversations": [
    {
      "id": "conv_123",
      "agentId": "assistant",
      "userId": "user_456",
      "title": "My Chat",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "total": 42,
  "hasMore": true
}
```

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

Returns conversation with messages.

**Response:**

```json
{
  "conversation": {
    "id": "conv_123",
    "agentId": "assistant",
    "title": "My Chat",
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
        "createdAt": "2025-01-01T00:00:01.000Z"
      }
    ],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:01.000Z"
  }
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

**Response:**

```json
{
  "success": true
}
```

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
  "files": ["file_123"],
  "streaming": false,
  "metadata": {}
}
```

**Response (non-streaming):**

```json
{
  "message": {
    "id": "msg_2",
    "conversationId": "conv_123",
    "role": "assistant",
    "content": "Hello! I'm doing well, thank you for asking. How can I help you today?",
    "createdAt": "2025-01-01T00:00:01.000Z",
    "updatedAt": "2025-01-01T00:00:01.000Z"
  },
  "usage": {
    "inputTokens": 10,
    "outputTokens": 20,
    "totalTokens": 30
  }
}
```

**Response (streaming):**

When `streaming: true`, returns Server-Sent Events:

```
event: stream.start
data: {"conversationId":"conv_123","messageId":"msg_2","timestamp":1234567890}

event: stream.text
data: {"text":"Hello!","timestamp":1234567891}

event: stream.text
data: {"text":" I'm doing well.","timestamp":1234567892}

event: stream.done
data: {"message":{"id":"msg_2","role":"assistant","content":"Hello! I'm doing well."},"timestamp":1234567893}
```

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
