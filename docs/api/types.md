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
  /** Assistant messages: `metadata.status` and `metadata.stopReason` say how and why the turn ended. */
  metadata?: Record<string, unknown>;
  /** API only (derived from `metadata.status`): how the turn that produced an assistant message ended. */
  status?: 'completed' | 'requires_action' | 'incomplete' | 'cancelled';
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
  /** Computed by the API on GET /conversations and GET /conversations/:id; never stored. */
  runtime?: ConversationRuntime;
  /** The spend limit of the conversation (its own, or its agent's default) and what it has spent. See guide/budgets. */
  budget?: SessionBudget | null;
  spentUsd?: number;
  /** Tools the person asked not to be asked about again. */
  rememberedTools?: string[];
  /** Storage only (never sent to clients): bumped by every update; the earliest deadline of the open actions. */
  version?: number;
  actionDueAt?: Date;
}

interface SessionBudget {
  maxCostUsd: number;
  onReach: 'pause' | 'stop';   // pause: the conversation waits and can be continued; stop: it ends
}
```

### ConversationRuntime

```typescript
interface ConversationRuntime {
  status: 'idle' | 'running' | 'requires_action' | 'budget_paused';
  stopReason?: StopReason;      // why the last turn stopped; absent while one runs
  lastEventSeq: number;         // seq of the newest event (0: none)
  pendingActionIds: string[];
  activeRunId?: string;
}

type StopReason = 'end_turn' | 'requires_action' | 'cancelled' | 'max_turns' | 'limit' | 'budget_reached' | 'error';
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
  message: Message;              // the user message
  response: Message;             // the assistant message (status, metadata.stopReason)
  conversationTitle?: string;
  usage?: UsageInfo;             // what this turn used
  status?: 'requires_action' | 'incomplete' | 'cancelled';   // only when the turn did not simply complete
  pendingActions?: PendingAction[];
  warnings?: TurnWarning[];
  stopReason?: StopReason;
  runId?: string;                // the run that executed the turn
  budget?: SessionBudget;        // the conversation's budget and what it has spent, when it has one
  spentUsd?: number;
}

interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;    // included in inputTokens
  costUsd?: number;              // when the agent's models are priced (the server's `pricing`)
}
```

### CancelConversationResponse

```typescript
interface CancelConversationResponse {
  cancelled: boolean;            // false: nothing to cancel
  runId?: string;
  settled: boolean;              // false (HTTP 202): still winding down, or on another node
  cancelledActionIds?: string[];
  stopReason?: StopReason;
  runtime: ConversationRuntime;
}
```

### Event types

```typescript
/** One entry of a conversation's event log (what a storage provider stores). */
interface ConversationEvent {
  conversationId: string;
  seq: number;                   // 1, 2, 3 ... per conversation; unique
  type: string;                  // 'user.message', 'agent.tool_use', 'session.status_idle', ...
  data: Record<string, unknown>; // snake_case
  runId?: string;
  createdAt: Date;
}

/** The same event as GET /conversations/:id/events returns it. */
interface WireEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  run_id?: string;
  created_at: string;
}

interface ListEventsResponse { events: WireEvent[]; hasMore: boolean; lastSeq: number }
```

See [Runs, Cancel & Reattach](../guide/runs#the-event-log) for the types and their data. `EventStore`, `Lease`, `AcquireLeaseParams`,
`AcquireLeaseResult` and the rest are the storage provider's side: [Storage Providers API](./storage).

### CreateConversationRequest

```typescript
interface CreateConversationRequest {
  agentId: string;
  title?: string;
  metadata?: Record<string, unknown>;
  budget?: { maxCostUsd: number; onReach?: 'pause' | 'stop' } | null;
}

interface UpdateConversationRequest {            // PATCH /conversations/:id
  title?: string;
  metadata?: Record<string, unknown>;
  budget?: { maxCostUsd: number; onReach?: 'pause' | 'stop' } | null;   // null removes it; raising needs authorizeBudget
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

The JSON form of `POST /files` (the file can also be sent as its own bytes: [Files](../guide/file-management#uploading)).

```typescript
interface UploadFileRequest {
  file: { name: string; content: string /* base64 */; mimeType: string };
  conversationId?: string;
  metadata?: Record<string, unknown>;
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

### PendingAction

```typescript
type PendingAction =
  | { id: string; type: 'tool_approval'; toolName: string; toolCallId?: string; title?: string; summary?: string; args?: Record<string, unknown>; expiresAt?: string }
  | { id: string; type: 'user_question'; questions: UserQuestion[]; allowFreeText?: boolean; expiresAt?: string };

interface UserQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ label: string; value?: string; description?: string; preview?: string }>;
}

/** An action on the paused message (metadata.pendingActions): as it was asked, and how it ended. */
type ActionSnapshot = PendingAction & {
  status: 'pending' | 'resolved' | 'cancelled' | 'expired';
  resolution?: ActionResolution;
  resolvedBy?: string;           // a user id, 'system:timeout' or 'system'
  resolvedAt?: string;
};
```

### ActionResolution

```typescript
type ActionResolution =
  | { type: 'tool_approval'; decision: 'allow' | 'deny'; comment?: string; approvedArgs?: Record<string, unknown>; rememberForSession?: boolean }
  | { type: 'user_question'; answers: Record<string, string | string[]>; cancelled?: boolean };

type MessageStatus = 'completed' | 'requires_action' | 'incomplete' | 'cancelled';
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
  storageKey: string;
  conversationId?: string;
  messageId?: string;
  userId?: string;       // who uploaded it
  agentId?: string;
  expiresAt?: Date;      // when the retention sweep deletes it
  metadata?: Record<string, unknown>;
  createdAt: Date;
}
```

### FilesConfig / AgentFilesConfig

`AgentServerConfig.files` and the `files` of a registration; every field is optional. See [Files](../guide/file-management#settings) for what each does and its default.

```typescript
interface FilesConfig {
  enabled?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  allowedMimeTypes?: string[];
  inlineMaxTokens?: number;
  readPageChars?: number;
  retentionDays?: number;
  vision?: boolean;
  attachNewUploads?: boolean;
  maxImages?: number;
  maxImageBytes?: number;
  carryRecentImages?: number;
  extractText?: (file: { id: string; name: string; mimeType: string; size: number }, bytes: Buffer) =>
    Promise<string | null | undefined> | string | null | undefined;
  extractCacheBytes?: number;   // server only
  purgeIntervalMs?: number;     // server only
}
type AgentFilesConfig = Omit<FilesConfig, 'extractCacheBytes' | 'purgeIntervalMs'>;
```

### AttachmentsCapability

`AgentInfo.capabilities.attachments`: what a conversation with the agent accepts.

```typescript
interface AttachmentsCapability {
  enabled?: boolean;
  maxFiles?: number;
  maxFileSize?: number;          // bytes
  allowedMimeTypes?: string[];   // empty = any
  acceptsImages?: boolean;
}
```

### ListFilesResponse

```typescript
interface ListFilesResponse {
  files: FileRecord[];   // oldest first
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  maxFiles: number;      // what the conversation may hold
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
  actionDueAt?: Date | null;     // when the earliest open approval lapses; null clears it
}

interface UpdateMessageParams {
  content?: string | ContentPart[];
  metadata?: Record<string, unknown>;   // replaces the message's metadata
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
  content: Buffer;
  conversationId?: string;
  messageId?: string;
  userId?: string;
  agentId?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}
```

### ListFilesParams / PurgeExpiredFilesParams

```typescript
interface ListFilesParams { conversationId: string; limit?: number; offset?: number; order?: 'asc' | 'desc' }
interface PurgeExpiredFilesParams { before: Date; limit?: number }
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
