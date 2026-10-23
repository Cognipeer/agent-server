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
  /** API only (derived from `metadata.feedback`): the rating the owner gave an assistant message. */
  feedback?: MessageFeedback;
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
  /**
   * Present with `runtime`. True when a turn the budget cut short in the middle waits for `POST /conversations/:id/continue`:
   * it stays true after the budget is raised or removed, until the turn is continued or a new message gives it up.
   * False for a turn that finished its answer before the limit (a raise only reopens the conversation).
   */
  continuable?: boolean;
  /** The spend limit of the conversation (its own, or its agent's default) and what it has spent. See guide/budgets. */
  budget?: SessionBudget | null;
  spentUsd?: number;
  /** Tools the person asked not to be asked about again. */
  rememberedTools?: string[];
  /** The person pinned the conversation (`PATCH { pinned: true }`, stored as `metadata.pinned`); lists put pinned ones first. */
  pinned?: boolean;
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
  status: 'idle' | 'running' | 'requires_action' | 'budget_paused';   // budget_paused: stopped on the budget, still used up - or cut short and not yet continued
  stopReason?: StopReason;      // why the last turn stopped; absent while one runs
  lastEventSeq: number;         // seq of the newest event (0: none)
  pendingActionIds: string[];
  activeRunId?: string;
  error?: { code: string; message: string };  // why the last turn ended in 'error' (code 'run_interrupted': the server stopped mid-turn)
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

/**
 * The first frame of GET /conversations/:id/events/stream while a run is active on the serving node. Not stored, no `id:` line.
 * `text` is the answer streamed so far; the agent.message.delta frames that follow append to it.
 */
interface MessageSnapshotFrame {
  type: 'agent.message.snapshot';
  data: {
    run_id: string;
    text: string;
    user_message: { id: string; content: string; files: FileAttachment[] } | null;
  };
}
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
  | { id: string; type: 'tool_approval'; toolName: string; toolCallId?: string; title?: string; summary?: string; args?: Record<string, unknown>;
      argsSchema?: Record<string, unknown> /* JSON Schema of the tool's arguments, when known */; expiresAt?: string }
  | { id: string; type: 'user_question'; questions: UserQuestion[]; allowFreeText?: boolean; expiresAt?: string }
  | { id: string; type: 'client_tool'; toolName: string; toolCallId?: string; title?: string; args?: Record<string, unknown>;
      argsSchema?: Record<string, unknown>; timeoutSeconds?: number /* the client's to enforce */;
      requestedAt?: string /* stamped by the server */; expiresAt?: string };

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
  | { type: 'user_question'; answers: Record<string, string | string[]>; cancelled?: boolean }
  | { type: 'client_tool'; output?: unknown; error?: string };   // output: any JSON, at most hitl.clientToolMaxOutputBytes; error: a message the model reads

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
  retentionDays?: number;        // days a file is kept after the upload (0: until its conversation is deleted)
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

### PaginatedResult

What the storage providers' list methods return (`getConversations`, `getMessages`, `getTasks`, `listFiles`).

```typescript
interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
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

### GetConversationsParams

```typescript
interface GetConversationsParams {
  agentId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'updatedAt';   // default createdAt
  order?: 'asc' | 'desc';                // default desc: newest first
  actionDueBefore?: Date;                // only conversations whose earliest open approval lapses by then (the expiry sweep; needs capabilities().actionDeadlines)
  pinnedFirst?: boolean;                 // conversations with metadata.pinned === true first, across pages (needs capabilities().pinnedFirst)
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
  limit?: number;                 // default 100
  offset?: number;
  order?: 'asc' | 'desc';         // chronological order of the page; default asc (oldest first)
  before?: string;                // only messages older than this message id (an unknown id is a NotFoundError)
  after?: string;                 // only messages newer than this message id
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
  metadata?: Record<string, unknown>;
  error?: string;
}
```

### AuthProvider

```typescript
interface AuthProvider {
  validateToken(token: string): Promise<AuthResult>;
  generateToken?(userId: string, metadata?: Record<string, unknown>): Promise<string>;
  revokeToken?(token: string): Promise<void>;
}
```

## Error Types

Every error is an `AgentServerError { message, code, statusCode, details? }`. The HTTP body is `{ "error": { "code", "message", "details" } }` - see [Error Handling](../guide/error-handling)
for every code. The server also throws plain objects of the same shape (`{ statusCode, code, message }`), and treats them alike.

```typescript
class AgentServerError extends Error { constructor(message, code, statusCode = 500, details?) }
class AuthenticationError extends AgentServerError { /* 401 AUTHENTICATION_ERROR */ }
class AuthorizationError extends AgentServerError { /* 403 AUTHORIZATION_ERROR */ }
class NotFoundError extends AgentServerError { constructor(resource: string, id: string) /* 404 NOT_FOUND */ }
class ValidationError extends AgentServerError { constructor(message, details?) /* 400 VALIDATION_ERROR */ }
class StorageLimitError extends AgentServerError { constructor(message, details?) /* 413 STORAGE_LIMIT_EXCEEDED */ }
```

## Host-backed agents

For [`registerHostAgent`](./server#registerhostagent). The guide: [Host-backed agents](../guide/host-agents).

```typescript
interface HostAgentDefinition extends HostAgent {
  info: AgentInfo;                          // id and name
  files?: AgentFilesConfig; hitl?: AgentHitlConfig; budget?: SessionBudget | null; pricing?: PricingFn;
  experience?: AgentExperience; titleGeneration?: TitleGenerationConfig | false;
}

interface HostInvokeInput {
  conversationId: string;
  runId: string;                            // the run this turn executes as
  message: string;                          // what the person typed
  mode?: 'regenerate' | 'edit';             // absent for a new message
  fromMessageId?: string;                   // the message the regenerate / edit request named
  history: Message[];                       // the conversation so far, including this message (already cut back for a regenerate / edit)
  files: FileAttachment[];                  // the files this message carries (stored; real ids)
  metadata?: Record<string, unknown>;
  context: RequestContext;
}

interface HostResolveInput {
  conversationId: string;
  runId: string;
  actionId: string;
  action: PendingAction;                    // as it was asked
  resolution: ActionResolution;             // the whole answer: decision, approvedArgs, rememberForSession, answers
  pendingActions: PendingAction[];          // the other actions of the pause that are still open
  actor: string;                            // the user id, or 'system:timeout'
  channel: 'api' | 'timeout';
  expired?: boolean;                        // the request lapsed and hitl.onTimeout 'deny' answered it
  metadata?: Record<string, unknown>;
  context: RequestContext;
}

interface HostRunIo {
  emit(event: HostEvent): void;
  signal: AbortSignal;
  files: HostFiles;                         // { list(), read(fileId), text(fileId) }: the conversation's files only
}

type HostEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; args?: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name?: string; result?: unknown; error?: string }
  | { type: 'action_required'; actions: PendingAction[] }
  | { type: 'usage'; usage: UsageInfo & { model?: string } }
  | { type: 'stop'; stopReason: StopReason; detail?: string }
  | { type: 'plan'; plan: PlanSnapshot }                       // -> agent.plan + stream.plan
  | { type: 'compaction'; id?: string; phase?: 'start' | 'done' | 'skipped' }; // -> agent.compaction (done) + stream.compaction

interface PlanSnapshot {
  version?: number;
  operation?: 'write' | 'update';           // the agent wrote the plan out / changed it; left out when it does not say
  steps: Array<{ id?: string | number; title: string; status: 'not-started' | 'in-progress' | 'completed' | 'blocked' }>;
}

interface HostTurnResult {
  content?: string;                         // empty: the streamed text is the answer
  status?: MessageStatus;
  stopReason?: StopReason;
  pendingActions?: PendingAction[];         // replaces the pause; [] says nothing is open any more; the open ones unchanged (and nothing else) just record an answer
  usage?: UsageInfo & { model?: string };   // replaces the emitted usage
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
  detail?: string;
}

interface HostCancelInput {
  conversationId: string;
  runId?: string;                           // absent when only open requests were withdrawn
  reason: 'user' | 'remote' | 'lease_lost' | 'deleted' | 'shutdown' | 'withdrawn' | 'expired';
  actions?: PendingAction[];
  context: RequestContext;
}

interface FeedbackEvent {                   // HostAgent.feedback(event) and FeedbackConfig.onFeedback(ctx, event)
  conversationId: string;
  messageId: string;                        // the rated answer
  messageIndex: number;                     // its 0-based position in the transcript
  agentId: string;
  userId?: string;
  rating: 'up' | 'down' | null;             // null: withdrawn
  reasons: string[];
  comment?: string;
  previous?: MessageFeedback;               // the rating this one replaced
  createdAt: string; updatedAt: string;     // ISO 8601
  message: Message;                         // the answer
  question?: Message;                       // the user message it answered
  context: RequestContext;
}
```

## Chat experience

For [Chat experience](../guide/chat-experience) and [Embedding & limits](../guide/embedding).

```typescript
interface AgentExperience {
  welcome?: string;                         // Markdown, at most 4000 characters
  starters?: ConversationStarter[];         // at most 6
  messageActions?: { copy?: boolean; regenerate?: boolean; edit?: boolean };
  history?: { rename?: boolean; pin?: boolean; bulkDelete?: boolean };
  feedback?: { enabled?: boolean; comments?: boolean; reasons?: string[] };
  export?: { enabled?: boolean; includeTools?: boolean };
}
interface ConversationStarter { text: string; label?: string; autoSend?: boolean }

/** What AgentInfo.metadata.experience holds: every switch resolved. */
interface ResolvedExperience {
  messageActions: { copy: boolean; regenerate: boolean; edit: boolean };
  history: { rename: boolean; pin: boolean; bulkDelete: boolean };
  feedback: { enabled: boolean; comments: boolean; reasons: string[]; maxCommentLength: number };
  export: { enabled: boolean; includeTools: boolean; formats: string[] };   // formats: md, json, html (+ pdf when there is a renderer)
  titles: boolean;
}

interface MessageFeedback { rating: 'up' | 'down'; reasons?: string[]; comment?: string; userId?: string; createdAt: string; updatedAt: string }

interface TitleGenerationConfig {
  baseUrl?: string; apiKey?: string; model?: string; path?: string; timeoutMs?: number;   // an OpenAI-compatible endpoint...
  generate?: (input: TitleInput) => Promise<string | TitleResult | null | undefined> | string | TitleResult | null | undefined;  // ...or your own
  maxWords?: number;                        // default 6
  includeAnswer?: boolean;                  // default true
  instructions?: string;
}
interface TitleInput { conversation: Conversation; agent: AgentInfo; user: string; assistant?: string; maxWords: number; context: RequestContext; signal: AbortSignal }
interface TitleResult { title: string; usage?: UsageInfo; model?: string }

type RateLimitOperation = 'conversation.create' | 'message.send' | 'message.regenerate' | 'message.edit' | 'action.resolve'
  | 'turn.continue' | 'file.upload' | 'conversation.export' | 'message.feedback' | 'conversation.bulk_delete';
interface RateLimitRequest { operation: RateLimitOperation; conversationId?: string; agentId?: string; userId?: string; streaming?: boolean }
type RateLimitDecision = void | boolean | { allowed?: boolean; retryAfterSeconds?: number; message?: string; release?: () => void };

interface AuditEntry {
  action: 'conversation.export' | 'conversation.delete' | 'conversation.bulk_delete' | 'conversation.pin' | 'conversation.unpin'
    | 'message.regenerate' | 'message.edit' | 'message.feedback';
  conversationId?: string; agentId?: string; userId?: string; messageId?: string;
  details?: Record<string, unknown>; at: Date;
}

interface FeedbackConfig { enabled?: boolean; reasons?: string[]; maxCommentLength?: number; onFeedback?: (ctx: RequestContext, event: FeedbackEvent) => void | Promise<void> }
interface ExportConfig {
  enabled?: boolean; includeTools?: boolean; maxMessages?: number;
  labels?: Record<string, Partial<ExportLabels>>;
  renderPdf?: (input: { html: string; conversation: Conversation; context: RequestContext }) => Promise<Buffer | Uint8Array> | Buffer | Uint8Array;
}

// Requests
interface RegenerateMessageRequest { stream?: boolean; metadata?: Record<string, unknown> }
interface EditMessageRequest { content?: string; message?: string; fileIds?: string[]; files?: Array<{ name: string; content: string; mimeType: string }>; metadata?: Record<string, unknown>; stream?: boolean }
interface FeedbackRequest { rating: 'up' | 'down' | null; reasons?: string[]; comment?: string }
interface FeedbackResponse { feedback: MessageFeedback | null; messageId: string }
interface BulkDeleteRequest { ids: string[] }
interface BulkDeleteResponse { results: Array<{ id: string; status: 'deleted' | 'not_found' | 'busy' | 'error'; message?: string }>; deleted: number }
```
