# Types

Type definitions for `@cognipeer/agent-server`.

## Message Types

### Message

```typescript
interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

### ContentPart

```typescript
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'file'; file: { id: string; name: string; mimeType: string; url?: string } }
  | { type: string; [key: string]: unknown };
```

### ToolCall

```typescript
interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}
```

### FileAttachment

```typescript
interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  storageKey?: string;
}
```

## Conversation Types

### Conversation

```typescript
interface Conversation {
  id: string;
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

### ConversationWithMessages

```typescript
interface ConversationWithMessages extends Conversation {
  messages: Message[];
}
```

## Request/Response Types

### SendMessageRequest

```typescript
interface SendMessageRequest {
  message: string;
  files?: string[]; // File IDs
  streaming?: boolean;
  metadata?: Record<string, unknown>;
}
```

### SendMessageResponse

```typescript
interface SendMessageResponse {
  message: Message;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}
```

### CreateConversationRequest

```typescript
interface CreateConversationRequest {
  agentId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}
```

### CreateConversationResponse

```typescript
interface CreateConversationResponse {
  conversation: Conversation;
}
```

### ListConversationsResponse

```typescript
interface ListConversationsResponse {
  conversations: Conversation[];
  total: number;
  hasMore: boolean;
}
```

### GetConversationResponse

```typescript
interface GetConversationResponse {
  conversation: ConversationWithMessages;
}
```

### ListAgentsResponse

```typescript
interface ListAgentsResponse {
  agents: AgentInfo[];
}
```

### UploadFileRequest

```typescript
interface UploadFileRequest {
  file: File | Buffer;
  name: string;
  mimeType: string;
}
```

### UploadFileResponse

```typescript
interface UploadFileResponse {
  file: FileRecord;
}
```

## Stream Event Types

### StreamStartEvent

```typescript
interface StreamStartEvent {
  type: 'stream.start';
  conversationId: string;
  messageId: string;
  timestamp: number;
}
```

### StreamTextEvent

```typescript
interface StreamTextEvent {
  type: 'stream.text';
  text: string;
  isFinal?: boolean;
  timestamp: number;
}
```

### StreamToolCallEvent

```typescript
interface StreamToolCallEvent {
  type: 'stream.tool_call';
  id: string;
  name: string;
  arguments: string;
  timestamp: number;
}
```

### StreamToolResultEvent

```typescript
interface StreamToolResultEvent {
  type: 'stream.tool_result';
  id: string;
  name: string;
  result: unknown;
  timestamp: number;
}
```

### StreamProgressEvent

```typescript
interface StreamProgressEvent {
  type: 'stream.progress';
  stage: string;
  message?: string;
  percent?: number;
  timestamp: number;
}
```

### StreamErrorEvent

```typescript
interface StreamErrorEvent {
  type: 'stream.error';
  error: string;
  code?: string;
  timestamp: number;
}
```

### StreamDoneEvent

```typescript
interface StreamDoneEvent {
  type: 'stream.done';
  message: Message;
  timestamp: number;
}
```

## Storage Types

### FileRecord

```typescript
interface FileRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}
```

### ListResult

```typescript
interface ListResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}
```

### CreateConversationParams

```typescript
interface CreateConversationParams {
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
}
```

### UpdateConversationParams

```typescript
interface UpdateConversationParams {
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
}
```

### ListConversationsParams

```typescript
interface ListConversationsParams {
  agentId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}
```

### CreateMessageParams

```typescript
interface CreateMessageParams {
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
}
```

### GetMessagesParams

```typescript
interface GetMessagesParams {
  limit?: number;
  before?: Date;
}
```

### SaveFileParams

```typescript
interface SaveFileParams {
  name: string;
  mimeType: string;
  size: number;
  content?: Buffer;
  storageKey?: string;
  metadata?: Record<string, unknown>;
}
```

## Auth Types

### AuthUser

```typescript
interface AuthUser {
  id: string;
  metadata?: Record<string, unknown>;
}
```

### AuthResult

```typescript
interface AuthResult {
  valid: boolean;
  userId?: string;
  error?: string;
}
```

### AuthProvider

```typescript
interface AuthProvider {
  validate(token: string): Promise<AuthResult>;
}
```

## Error Types

### AuthenticationError

```typescript
class AuthenticationError extends Error {
  statusCode = 401;
}
```

### NotFoundError

```typescript
class NotFoundError extends Error {
  statusCode = 404;
}
```

### ValidationError

```typescript
class ValidationError extends Error {
  statusCode = 400;
}
```
