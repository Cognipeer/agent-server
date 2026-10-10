/**
 * Core types for agent-server
 */

// ============================================================================
// Message Types
// ============================================================================

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "file"; file: { id: string; name: string; mimeType: string; url?: string } }
  | { type: string; [key: string]: unknown };

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  files?: FileAttachment[];
  /**
   * Assistant messages: `metadata.status` and `metadata.stopReason` say how the turn ended.
   * The API also reports the status as `status` (derived, never stored).
   */
  metadata?: Record<string, unknown>;
  /** How the turn that produced this assistant message ended (API only; see `metadata.stopReason` for why). */
  status?: MessageStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  storageKey?: string;
}

// ============================================================================
// Conversation Types
// ============================================================================

export interface Conversation {
  id: string;
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Where the conversation is in its run lifecycle. Computed by the server for
   * the API (`GET /conversations`, `GET /conversations/:id`); never stored.
   */
  runtime?: ConversationRuntime;
}

/** Why a turn stopped. Stored on the assistant message (`metadata.stopReason`) and in `session.status_idle` events. */
export type StopReason =
  | "end_turn"
  | "requires_action"
  | "cancelled"
  | "max_turns"
  | "limit"
  | "budget_reached"
  | "error";

export type RuntimeStatus = "idle" | "running" | "requires_action" | "budget_paused";

/** The run lifecycle of a conversation, as `GET /conversations` and `GET /conversations/:id` report it. */
export interface ConversationRuntime {
  status: RuntimeStatus;
  /** Why the last turn stopped. Absent while a turn is running. */
  stopReason?: StopReason;
  /** Sequence number of the newest event in the conversation's event log (0 when there is none). */
  lastEventSeq: number;
  /** Actions the conversation is waiting on. */
  pendingActionIds: string[];
  /** The run that is executing now (on this or another node). */
  activeRunId?: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

// ============================================================================
// Request Context Types
// ============================================================================

/**
 * Per-request context. Produced by `config.resolveContext` (or, when that is not
 * configured, built from the token-auth user) and handed to dynamic agent
 * resolvers, agent handlers, every storage provider call and `resolveUserId`.
 */
export interface RequestContext {
  /** The authenticated end user. Takes precedence over token-auth user. */
  user?: AuthUser;
  /** Arbitrary host data (tenant id, scopes, portal id, ...). Never sent to the client. */
  data: Record<string, unknown>;
}

/**
 * Framework-neutral description of an incoming request, passed to
 * `config.resolveContext`.
 */
export interface ContextRequest {
  method: string;
  /** Route path relative to the server base path, e.g. "/conversations/abc/messages". */
  path: string;
  /** Request URL as seen by the adapter (path + query string) when known. */
  url?: string;
  /** Lower-cased header names. */
  headers: Record<string, string | string[] | undefined>;
  /** Parsed `Cookie` header. */
  cookies: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
  /** User authenticated by the token `auth` provider, if any. */
  user?: AuthUser;
  /**
   * Dynamic parameters of the prefix the server is mounted under, e.g.
   * `{ portalKey }` when mounted under `/api/portal/:portalKey` on Fastify.
   */
  mountParams: Record<string, string>;
  /** The framework's native request (Express req, NextRequest, IncomingMessage, FastifyRequest). */
  raw?: unknown;
}

// ============================================================================
// Agent Types
// ============================================================================

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  metadata?: Record<string, unknown>;
  /**
   * Human-in-the-loop features this agent can use. Set by the host; for SDK
   * agents it is derived from the agent instance when cheaply knowable.
   */
  capabilities?: AgentCapabilities;
}

export interface AgentCapabilities {
  /** The agent can pause to ask for approval before running a tool. */
  toolApproval?: boolean;
  /** The agent can pause to ask the user a question. */
  askUser?: boolean;
}

// ============================================================================
// Human-in-the-loop (pending actions)
// ============================================================================

export interface UserQuestionOption {
  label: string;
  value?: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  placeholder?: string;
  required?: boolean;
  options?: UserQuestionOption[];
}

/** Something the agent is waiting on before it can continue. */
export type PendingAction =
  | {
      id: string;
      type: "tool_approval";
      toolName: string;
      toolCallId?: string;
      title?: string;
      summary?: string;
      args?: Record<string, unknown>;
      expiresAt?: string;
    }
  | {
      id: string;
      type: "user_question";
      questions: UserQuestion[];
      allowFreeText?: boolean;
      expiresAt?: string;
    };

/** The human's answer to a {@link PendingAction}. */
export type ActionResolution =
  | {
      type: "tool_approval";
      decision: "allow" | "deny";
      comment?: string;
      approvedArgs?: Record<string, unknown>;
      /** Don't ask again for this tool in this conversation. */
      rememberForSession?: boolean;
    }
  | {
      type: "user_question";
      answers: Record<string, string | string[]>;
      cancelled?: boolean;
    };

export type MessageStatus = "completed" | "requires_action" | "incomplete" | "cancelled";

export interface ResolveActionParams {
  conversationId: string;
  actionId: string;
  resolution: ActionResolution;
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Per-request context resolved by `config.resolveContext` (user + custom data). */
  context?: RequestContext;
  /**
   * Aborted when the run is cancelled (`POST /conversations/:id/cancel`). Stop work and return
   * what you have; a handler that ignores it is abandoned after `runs.cancelGraceMs`.
   */
  signal?: AbortSignal;
}

/**
 * Custom agent handler for non-SDK agents
 */
export interface AgentHandler {
  /**
   * Process a message and return a response
   */
  processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult>;

  /**
   * Optional: continue a turn that paused with `status: "requires_action"`.
   * Returns the continuation like `processMessage` does (it may pause again).
   */
  resolveAction?(params: ResolveActionParams): Promise<ProcessMessageResult>;
}

export interface ProcessMessageParams {
  conversationId: string;
  message: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Per-request context resolved by `config.resolveContext` (user + custom data). */
  context?: RequestContext;
  /**
   * Aborted when the run is cancelled (`POST /conversations/:id/cancel`). Stop work and return
   * what you have; a handler that ignores it is abandoned after `runs.cancelGraceMs`.
   */
  signal?: AbortSignal;
}

export interface ProcessMessageResult {
  content: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Set to `"requires_action"` (with `pendingActions`) to pause the turn. */
  status?: MessageStatus;
  /** Everything the turn is waiting on. Replaces the conversation's pending set. */
  pendingActions?: PendingAction[];
  /**
   * Why the turn stopped, when it was not simply `end_turn` (`max_turns`, `limit`, `budget_reached`).
   * Derived when omitted: `requires_action` for a pause, `end_turn` otherwise.
   */
  stopReason?: StopReason;
}

/**
 * Agent registration - can be SDK agent, custom handler, or AI API provider
 */
export interface AgentRegistration {
  info: AgentInfo;
  // SDK agent instance (optional)
  sdkAgent?: unknown;
  // Custom handler (optional)
  handler?: AgentHandler;
  // Chat Completions API config (optional)
  chatCompletions?: import("./providers/ai/chat-completions.js").ChatCompletionsConfig;
  // Responses API config (optional)
  responsesApi?: import("./providers/ai/responses.js").ResponsesApiConfig;
}

// ============================================================================
// Storage Provider Types
// ============================================================================

/**
 * Storage contract. Every data method receives the optional per-request
 * `RequestContext` as its LAST argument so external stores can scope reads and
 * writes by tenant/user. Implementations that do not need it can simply omit
 * the parameter.
 */
export interface StorageProvider {
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /**
   * Optional: what this provider can hold, so the server can refuse a bad
   * configuration at startup and a pause that would not fit, instead of
   * failing halfway through a write. Providers that omit it are treated as unbounded.
   */
  capabilities?(): StorageCapabilities;

  // Conversations
  createConversation(params: CreateConversationParams, ctx?: RequestContext): Promise<Conversation>;
  getConversation(id: string, ctx?: RequestContext): Promise<Conversation | null>;
  getConversations(params: GetConversationsParams, ctx?: RequestContext): Promise<PaginatedResult<Conversation>>;
  updateConversation(id: string, params: UpdateConversationParams, ctx?: RequestContext): Promise<Conversation>;
  deleteConversation(id: string, ctx?: RequestContext): Promise<void>;

  // Messages
  createMessage(params: CreateMessageParams, ctx?: RequestContext): Promise<Message>;
  getMessages(conversationId: string, params?: GetMessagesParams, ctx?: RequestContext): Promise<PaginatedResult<Message>>;
  getMessage(id: string, ctx?: RequestContext): Promise<Message | null>;
  deleteMessage(id: string, ctx?: RequestContext): Promise<void>;

  // Files
  saveFile(params: SaveFileParams, ctx?: RequestContext): Promise<FileRecord>;
  getFile(id: string, ctx?: RequestContext): Promise<FileRecord | null>;
  getFileContent(id: string, ctx?: RequestContext): Promise<Buffer | null>;
  deleteFile(id: string, ctx?: RequestContext): Promise<void>;

  // Tasks
  createTask(params: CreateTaskParams, ctx?: RequestContext): Promise<Task>;
  getTask(id: string, ctx?: RequestContext): Promise<Task | null>;
  getTasks(params: GetTasksParams, ctx?: RequestContext): Promise<PaginatedResult<Task>>;
  updateTask(id: string, params: UpdateTaskParams, ctx?: RequestContext): Promise<Task>;
  deleteTask(id: string, ctx?: RequestContext): Promise<void>;

  // Task Results
  createTaskResult(params: CreateTaskResultParams, ctx?: RequestContext): Promise<TaskResult>;
  getTaskResult(taskId: string, ctx?: RequestContext): Promise<TaskResult | null>;

  /**
   * Optional: the durable per-conversation event log (`capabilities().events`). Without it
   * the server keeps the last `runs.memoryEventLimit` events per conversation in memory:
   * reattach and replay then work on one node and are lost on restart.
   */
  events?: EventStore;

  /**
   * Optional leases (`capabilities().leases`): at most one run per conversation (and one task
   * worker per task) across nodes. Without them the server serialises runs in-process only, which is
   * right for one node and not for several.
   */
  acquireLease?(params: AcquireLeaseParams, ctx?: RequestContext): Promise<AcquireLeaseResult>;
  /** Extends a lease you hold. `null` when it is gone (expired and taken by someone else, or released). */
  renewLease?(params: RenewLeaseParams, ctx?: RequestContext): Promise<Lease | null>;
  /** Releases a lease you hold (no-op for anyone else's). Resolves `true` when it was released. */
  releaseLease?(params: ReleaseLeaseParams, ctx?: RequestContext): Promise<boolean>;
  /** The leases among `keys` that have not expired. */
  getLeases?(keys: string[], ctx?: RequestContext): Promise<Lease[]>;
  /** Asks the holder of a live lease to stop (it sees `cancelRequested` on its next renewal). `false` when there is no live lease. */
  markLeaseCancel?(key: string, ctx?: RequestContext): Promise<boolean>;
  /** Leases past their expiry, oldest first: the residue of a holder that died. */
  listExpiredLeases?(params?: ListExpiredLeasesParams, ctx?: RequestContext): Promise<Lease[]>;
}

// ============================================================================
// Event log and leases
// ============================================================================

/**
 * One entry of a conversation's event log. `type` and `data` follow the Console client wire
 * (snake_case): `user.message`, `session.status_running`, `agent.tool_use`, `agent.tool_result`,
 * `agent.message`, `action.required`, `action.resolved`, `session.usage`, `session.status_idle`,
 * `session.work_done`, `session.error`, `budget.reached`.
 */
export interface ConversationEvent {
  conversationId: string;
  /** 1, 2, 3, ... within the conversation; unique with `conversationId`. */
  seq: number;
  type: string;
  data: Record<string, unknown>;
  /** The run that produced the event (`run_...`); absent for events written outside a run. */
  runId?: string;
  createdAt: Date;
}

export interface NewConversationEvent {
  type: string;
  data?: Record<string, unknown>;
  runId?: string;
}

export interface ListEventsParams {
  /** Only events with a larger `seq` (exclusive). */
  after?: number;
  /** Only events with a smaller `seq` (exclusive). */
  before?: number;
  /** Only these event types. */
  types?: string[];
  /** At most this many (default 100, at most 1000). */
  limit?: number;
  /** `asc` (default): oldest first. `desc`: newest first. */
  order?: "asc" | "desc";
}

export interface EventPage {
  events: ConversationEvent[];
  /** More events match than were returned. */
  hasMore: boolean;
  /** `seq` of the last event returned, or `after` (0 by default) when the page is empty: the cursor for the next page. */
  lastSeq: number;
}

/** What the log knows about a conversation without reading it. */
export interface EventSummary {
  /** `seq` of the newest event (0 when there is none). */
  lastSeq: number;
  /**
   * `data.stop_reason` of the newest `session.status_idle` event; cleared by a later
   * `session.status_running`. So it is the reason the last *finished* turn stopped, and absent while one runs.
   */
  stopReason?: string;
}

/**
 * A durable, append-only event log per conversation. A provider that offers it exposes `events`
 * (and reports `capabilities().events`). `(conversationId, seq)` is unique, `seq` ascends without
 * gaps and keeps ascending after a restart or a `prune`.
 */
export interface EventStore {
  /**
   * Appends events in order and atomically. Resolves the stored events with their `seq`.
   * An unknown conversation is a `NotFoundError`.
   */
  append(conversationId: string, events: NewConversationEvent[], ctx?: RequestContext): Promise<ConversationEvent[]>;
  list(conversationId: string, params?: ListEventsParams, ctx?: RequestContext): Promise<EventPage>;
  /** Per-conversation summary; conversations without events are left out. Optional: the server falls back to `list`. */
  summary?(conversationIds: string[], ctx?: RequestContext): Promise<Record<string, EventSummary>>;
  /** Deletes events created before `before` (the sequence keeps counting). Resolves how many were deleted. */
  prune?(before: Date, ctx?: RequestContext): Promise<number>;
}

/** A time-limited claim on a key, held by one owner. */
export interface Lease {
  key: string;
  owner: string;
  expiresAt: Date;
  /** What the holder stored with it (`conversationId`, `runId`, ...). */
  data?: Record<string, unknown>;
  /** Someone asked the holder to stop (see `markLeaseCancel`). */
  cancelRequested?: boolean;
}

export interface AcquireLeaseParams {
  /** At most 128 characters. */
  key: string;
  /** Identifies the holder (a node / run); at most 128 characters. */
  owner: string;
  /** Lifetime in milliseconds; the holder renews it while it is alive. */
  ttlMs: number;
  data?: Record<string, unknown>;
}

/**
 * Acquired when the key was free, expired, or already held by `owner`. `takenOver` is the expired
 * lease that was replaced (the residue of a holder that died, whoever it was), if there was one.
 */
export type AcquireLeaseResult =
  | { acquired: true; lease: Lease; takenOver?: Lease }
  | { acquired: false; lease: Lease };

export interface RenewLeaseParams {
  key: string;
  owner: string;
  ttlMs: number;
}

export interface ReleaseLeaseParams {
  key: string;
  owner: string;
}

export interface ListExpiredLeasesParams {
  /** Only keys starting with this. */
  prefix?: string;
  /** Default 100. */
  limit?: number;
}

/** What a storage provider can hold. Returned by `StorageProvider.capabilities()`. */
export interface StorageCapabilities {
  /** Largest single file the provider stores, in bytes. */
  maxFileBytes: number;
  /**
   * Largest conversation `state` the provider stores, as the UTF-8 byte length
   * of its JSON. A pause that would not fit is not taken (see `limits.maxStateBytes`).
   * `Number.MAX_SAFE_INTEGER` when only memory / disk bound it.
   */
  maxStateBytes: number;
  /** Compare-and-set conversation updates (`updateConversationIf`). */
  atomicUpdate: boolean;
  /** A durable per-conversation event log (`events`). */
  events: boolean;
  /** Per-conversation leases (`acquireLease` / `releaseLease`). */
  leases: boolean;
}

export interface CreateConversationParams {
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export interface GetConversationsParams {
  agentId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt";
  order?: "asc" | "desc";
}

export interface UpdateConversationParams {
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export interface CreateMessageParams {
  conversationId: string;
  role: Message["role"];
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
}

export interface GetMessagesParams {
  limit?: number;
  offset?: number;
  /** Chronological order of the page: oldest first (`asc`, default) or newest first. */
  order?: "asc" | "desc";
  /**
   * Only messages strictly older than this message of the conversation.
   * `total` / `hasMore` then describe that older set. Unknown id: `NotFoundError`.
   */
  before?: string;
  /** Only messages strictly newer than this message of the conversation. */
  after?: string;
}

export interface SaveFileParams {
  name: string;
  mimeType: string;
  content: Buffer;
  conversationId?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface FileRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  conversationId?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ============================================================================
// Auth Provider Types
// ============================================================================

export interface AuthProvider {
  /**
   * Validate a token and return user info if valid
   */
  validateToken(token: string): Promise<AuthResult>;

  /**
   * Optional: Generate a token for a user
   */
  generateToken?(userId: string, metadata?: Record<string, unknown>): Promise<string>;

  /**
   * Optional: Revoke a token
   */
  revokeToken?(token: string): Promise<void>;
}

export interface AuthResult {
  valid: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface AuthUser {
  id: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// File Storage Provider Types
// ============================================================================

export interface FileStorageProvider {
  /**
   * Save file content and return storage key
   */
  save(params: { name: string; content: Buffer; mimeType: string }): Promise<{ key: string; url?: string }>;

  /**
   * Get file content by storage key
   */
  get(key: string): Promise<Buffer | null>;

  /**
   * Delete file by storage key
   */
  delete(key: string): Promise<void>;

  /**
   * Get public URL for file (if supported)
   */
  getUrl?(key: string): Promise<string | null>;
}

// ============================================================================
// Server Configuration Types
// ============================================================================

/**
 * Configuration for LLM-based automatic conversation title generation.
 * Uses any OpenAI-compatible endpoint (e.g. OpenAI, Ollama, local models).
 */
export interface TitleGenerationConfig {
  /** Base URL of the OpenAI-compatible API (e.g. "https://api.openai.com") */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Model to use for title generation (e.g. "gpt-4o-mini") */
  model: string;
  /** Custom path override (default: "/v1/chat/completions") */
  path?: string;
}

export interface AgentServerConfig {
  /**
   * Base path for all API routes (e.g., "/api/agents")
   */
  basePath: string;

  /**
   * Storage provider instance
   */
  storage: StorageProvider;

  /**
   * Resolve the per-request context (user + arbitrary data), e.g. from a session
   * cookie. Returning `null` rejects the request with 401. When set, the
   * resolved user is authoritative: client-supplied `userId` query/body values
   * are ignored and conversations owned by another user are not accessible.
   * Public swagger routes are not subject to it.
   */
  resolveContext?: (req: ContextRequest) => Promise<RequestContext | null> | RequestContext | null;

  /**
   * Agents served by this instance. An array is registered once; a function is
   * resolved for every request (so the list can depend on the user/tenant).
   * Agents registered through `registerSDKAgent` & co. are always included;
   * a dynamic agent with the same id wins.
   */
  agents?: AgentRegistration[] | ((ctx: RequestContext) => AgentRegistration[] | Promise<AgentRegistration[]>);

  /**
   * Auto-generate conversation titles using an LLM after the first message.
   * If not set, titles will not be auto-generated.
   */
  titleGeneration?: TitleGenerationConfig;

  /**
   * Optional file storage provider (defaults to database storage)
   */
  fileStorage?: FileStorageProvider;

  /**
   * Authentication configuration
   */
  auth?: AuthConfig;

  /**
   * Swagger/OpenAPI configuration
   */
  swagger?: SwaggerConfig;

  /**
   * CORS configuration
   */
  cors?: CorsConfig;

  /**
   * Request limits
   */
  limits?: RequestLimits;

  /**
   * Keep internal error text away from the client. When true, only errors the
   * host authored for the caller show their message - an explicit 4xx
   * `statusCode`, or `expose: true` for a deliberate 5xx; every other failure - a driver error, a bug, a 5xx -
   * answers with a generic message in both the HTTP body and the SSE
   * `stream.error` event, and the original is logged server-side. Default false.
   * Turn it on whenever the audience is not the operator.
   */
  maskServerErrors?: boolean;

  /**
   * What happens when a message arrives while the conversation is waiting on a
   * pending action (tool approval / question). `"reject"` (default) answers
   * 409 `action_pending`; `"cancel"` cancels the pending actions and processes
   * the message normally.
   */
  pendingActionPolicy?: "reject" | "cancel";

  /**
   * Honour `rememberForSession` on tool approvals (default true). The memory is
   * by tool NAME: once remembered, later calls of that tool in the conversation
   * skip the approval regardless of arguments. Tools whose `needsApproval` is a
   * per-call predicate are never remembered. Set false to always ask.
   */
  allowRememberApproval?: boolean;

  /**
   * How runs are leased, cancelled, followed and recovered. Every value has a default.
   */
  runs?: RunsConfig;
}

/**
 * A turn (a message or a resolved action) runs detached from the HTTP request that started it: a
 * client that goes away does not stop it, `POST /conversations/:id/cancel` does. These settings
 * shape that machinery.
 */
export interface RunsConfig {
  /** Names this server instance in leases. Default: a random id per process. */
  nodeId?: string;
  /**
   * How long a conversation lease lives without being renewed (default 60 000). A run whose node dies
   * frees its conversation after this long and is then closed as interrupted.
   */
  leaseTtlMs?: number;
  /** How long a cancelled run may take to wind down before it is abandoned (default 5 000). */
  cancelGraceMs?: number;
  /** How long `POST /conversations/:id/cancel` waits for the run to wind down before answering 202 (default 5 000). */
  cancelWaitMs?: number;
  /** Interval of the `: ping` comment on `GET /conversations/:id/events/stream` (default 15 000). */
  pingIntervalMs?: number;
  /** How often a follower reads the event log for events written by another node (default 1 000). */
  followPollMs?: number;
  /** Longest an `events/stream` connection stays open (default 3 600 000, one hour). The client reconnects with `Last-Event-ID`. */
  maxStreamMs?: number;
  /** Events per page of `GET /conversations/:id/events` when no `limit` is given (default 100). */
  eventPageSize?: number;
  /** Largest `limit` of `GET /conversations/:id/events` (default 1 000). */
  maxEventPageSize?: number;
  /** Largest `data` of one event in bytes; bigger ones are cut and carry `_truncated: true` (default 16 384). */
  maxEventDataBytes?: number;
  /** Events kept per conversation by the in-memory log used when the storage provider has no `events` (default 2 000). */
  memoryEventLimit?: number;
  /** Delete events older than this many days with the periodic sweep; 0 keeps them for good (default 30). */
  eventRetentionDays?: number;
  /**
   * Interval of the sweep that closes runs whose node died, fails tasks that were running, and
   * prunes old events (default 60 000). 0 turns the periodic sweep off (recovery still runs once at the
   * first request, and `server.recoverStaleRuns()` runs it on demand).
   */
  sweepIntervalMs?: number;
  /**
   * Run the recovery once at the first request (default true): close the runs and fail the tasks that an
   * earlier process left behind. Turn it off when the storage provider cannot answer for the whole
   * store (a provider scoped to the current user), and call `server.recoverStaleRuns()` yourself.
   */
  recoverOnStart?: boolean;
  /**
   * Without storage leases the server cannot tell a dead run from one on another node. `true`
   * (default) assumes it is the only node, so a task left `running` by an earlier process is failed
   * at startup; set `false` on a multi-node deployment whose storage provider has no leases.
   */
  assumeSingleNode?: boolean;
}

export interface AuthConfig {
  /**
   * Enable/disable authentication
   */
  enabled: boolean;

  /**
   * Auth provider instance
   */
  provider?: AuthProvider;

  /**
   * Custom function to resolve userId from request context
   * Used when auth is disabled or to override token-based userId
   */
  resolveUserId?: (ctx: {
    headers?: Record<string, string | string[] | undefined>;
    query?: Record<string, unknown>;
    body?: unknown;
    /** Per-request context (see `AgentServerConfig.resolveContext`). */
    context?: RequestContext;
  }) => string | undefined | Promise<string | undefined>;

  /**
   * Header name for token (default: "Authorization")
   */
  headerName?: string;

  /**
   * Token prefix (default: "Bearer ")
   */
  tokenPrefix?: string;

  /**
   * Routes to exclude from auth
   */
  excludeRoutes?: string[];
}

export interface SwaggerConfig {
  /**
   * Enable/disable Swagger UI
   */
  enabled: boolean;

  /**
   * Path for Swagger UI (default: "/docs")
   */
  path?: string;

  /**
   * API title
   */
  title?: string;

  /**
   * API version
   */
  version?: string;

  /**
   * API description
   */
  description?: string;
}

export interface CorsConfig {
  /**
   * Enable/disable CORS
   */
  enabled: boolean;

  /**
   * Allowed origins
   */
  origins?: string[];

  /**
   * Allowed methods
   */
  methods?: string[];

  /**
   * Allowed headers
   */
  headers?: string[];
}

export interface RequestLimits {
  /**
   * Maximum file upload size in bytes (default: 10MB)
   */
  maxFileSize?: number;

  /**
   * Maximum request body size in bytes (default: 1MB)
   */
  maxBodySize?: number;

  /**
   * Maximum number of files per request (default: 10)
   */
  maxFiles?: number;

  /**
   * Largest conversation state, in JSON bytes, that a turn may persist when it
   * pauses for a human. When the state would not fit (this value, or the
   * storage provider's own `capabilities().maxStateBytes`, whichever is
   * smaller) the turn is NOT paused: it finishes and the assistant message
   * carries a `pause_state_too_large` warning. Default: the provider's limit
   * (12 MiB on MongoDB, effectively unbounded elsewhere).
   */
  maxStateBytes?: number;

  /**
   * Page size of the message endpoints (`GET /conversations/:id` and
   * `.../messages`) when the client sends no `limit` (default: 100).
   */
  messagePageSize?: number;

  /**
   * Largest `limit` a client may ask for on any list endpoint (default: 200).
   * Also the size of the pages the server reads when it loads a whole
   * conversation for the agent.
   */
  maxPageSize?: number;
}

// ============================================================================
// Request/Response Types
// ============================================================================

export interface SendMessageRequest {
  message: string;
  files?: Array<{
    name: string;
    content: string; // base64
    mimeType: string;
  }>;
  /**
   * Files uploaded earlier with `POST /files` (`conversationId` set to this
   * conversation) that this message attaches. Each id must resolve through
   * `storage.getFile`; the user message carries the stored records. Capped by
   * `limits.maxFiles` (default 10).
   */
  fileIds?: string[];
  metadata?: Record<string, unknown>;
  /**
   * Enable streaming response via Server-Sent Events (SSE)
   */
  stream?: boolean;
}

export interface SendMessageResponse {
  message: Message;
  response: Message;
  /** Auto-generated conversation title (only present on the first message) */
  conversationTitle?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Present (as `"requires_action"`) when the turn paused for a human. */
  status?: MessageStatus;
  pendingActions?: PendingAction[];
  /** Things worth knowing about a turn that still completed (see {@link TurnWarning}). */
  warnings?: TurnWarning[];
  /** Why the turn stopped. */
  stopReason?: StopReason;
  /** The run that executed the turn; its events carry it as `run_id`. */
  runId?: string;
}

/**
 * Something the client should know about a turn that completed anyway. Also stored on the
 * assistant message as `metadata.warnings`. Codes: `pause_state_too_large` - the turn needed a
 * human but its state did not fit the store (`limits.maxStateBytes`), so it was not paused.
 */
export interface TurnWarning {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface ResolveActionRequest {
  resolution: ActionResolution;
  /** Stream the continuation as SSE, like `POST .../messages` with `stream: true`. */
  stream?: boolean;
  /** Passed to a custom handler's `resolveAction` (ignored for SDK agents). */
  metadata?: Record<string, unknown>;
}

/** Like {@link SendMessageResponse}, but a resolve adds no user message. */
export type ResolveActionResponse = Omit<SendMessageResponse, "message">;

// ============================================================================
// Stream Event Types (SSE)
// ============================================================================

/**
 * Base stream event
 */
export interface StreamEventBase {
  type: string;
  timestamp: number;
  /**
   * The event-log cursor at this frame: the `seq` of the stored event the frame reports, or of the
   * newest one before it for frames that are not stored (text chunks). A client that loses the
   * connection resumes with `GET /conversations/:id/events/stream?after=<seq>`.
   */
  seq?: number;
}

/**
 * Stream started event
 */
export interface StreamStartEvent extends StreamEventBase {
  type: "stream.start";
  conversationId: string;
  messageId: string;
}

/**
 * Text chunk event - partial response text
 */
export interface StreamTextEvent extends StreamEventBase {
  type: "stream.text";
  text: string;
  isFinal?: boolean;
}

/**
 * Tool call event - agent is calling a tool
 */
export interface StreamToolCallEvent extends StreamEventBase {
  type: "stream.tool_call";
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

/**
 * Tool result event - tool execution completed
 */
export interface StreamToolResultEvent extends StreamEventBase {
  type: "stream.tool_result";
  toolName: string;
  toolCallId: string;
  result: unknown;
}

/**
 * Progress event - status update
 */
export interface StreamProgressEvent extends StreamEventBase {
  type: "stream.progress";
  stage?: string;
  message?: string;
  percent?: number;
}

/**
 * Error event - an error occurred
 */
export interface StreamErrorEvent extends StreamEventBase {
  type: "stream.error";
  error: string;
  code?: string;
}

/**
 * Stream completed event
 */
export interface StreamDoneEvent extends StreamEventBase {
  type: "stream.done";
  conversationId: string;
  messageId: string;
  content: string;
  /** Auto-generated conversation title (only present on the first message) */
  title?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Only set when the turn did not simply complete (e.g. `"requires_action"`). */
  status?: MessageStatus;
  pendingActions?: PendingAction[];
  warnings?: TurnWarning[];
  stopReason?: StopReason;
  runId?: string;
}

/**
 * The agent paused and is waiting on a human
 */
export interface StreamActionRequiredEvent extends StreamEventBase {
  type: "stream.action_required";
  conversationId: string;
  /** The assistant message the actions belong to. */
  messageId: string;
  actions: PendingAction[];
}

/**
 * A pending action was resolved
 */
export interface StreamActionResolvedEvent extends StreamEventBase {
  type: "stream.action_resolved";
  conversationId: string;
  actionId: string;
  resolution: {
    type: ActionResolution["type"];
    decision?: "allow" | "deny";
    cancelled?: boolean;
  };
}

/**
 * All stream event types
 */
export type StreamEvent =
  | StreamStartEvent
  | StreamTextEvent
  | StreamToolCallEvent
  | StreamToolResultEvent
  | StreamProgressEvent
  | StreamErrorEvent
  | StreamActionRequiredEvent
  | StreamActionResolvedEvent
  | StreamDoneEvent;

export interface ListAgentsResponse {
  agents: AgentInfo[];
}

export interface ListConversationsResponse {
  conversations: Array<Conversation & { agentName?: string }>;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Where a page of `GET /conversations/:id` messages sits in the conversation. */
export interface MessagesPage {
  limit: number;
  order: "asc" | "desc";
  /** Older messages exist than the oldest one returned. */
  hasMoreBefore: boolean;
  /** Newer messages exist than the newest one returned. */
  hasMoreAfter: boolean;
}

/** `GET /conversations/:id/events`: one page of the event log, oldest first. */
export interface ListEventsResponse {
  events: WireEvent[];
  hasMore: boolean;
  /** Pass it as `after` to read the next page. */
  lastSeq: number;
}

/** A logged event as the API returns it (Console client wire: `run_id`, `created_at`). */
export interface WireEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  run_id?: string;
  created_at: string;
}

/** `POST /conversations/:id/cancel` */
export interface CancelConversationResponse {
  /** A run was running, or actions were open, and they were cancelled. `false`: there was nothing to cancel. */
  cancelled: boolean;
  /** The run that was cancelled (also when it is still winding down). */
  runId?: string;
  /** The run has finished winding down (`false` with a 202: it is still stopping or runs on another node). */
  settled: boolean;
  /** Actions that were open and are now cancelled. */
  cancelledActionIds?: string[];
  stopReason?: StopReason;
  runtime: ConversationRuntime;
}

export interface GetConversationResponse {
  conversation: Conversation;
  /**
   * One page of the history, always chronological per `messagesPage.order`.
   * Without `before` / `after` it is the NEWEST `limit` messages.
   */
  messages: Message[];
  messagesPage?: MessagesPage;
  /** Actions the conversation is waiting on (omitted when there are none). */
  pendingActions?: PendingAction[];
}

export interface CreateConversationRequest {
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationResponse {
  conversation: Conversation;
}

export interface UploadFileRequest {
  file: {
    name: string;
    content: string; // base64
    mimeType: string;
  };
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface UploadFileResponse {
  file: FileRecord;
}

// ============================================================================
// Error Types
// ============================================================================

export class AgentServerError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AgentServerError";
  }
}

export class NotFoundError extends AgentServerError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
  }
}

export class ValidationError extends AgentServerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, details);
  }
}

/** A write the storage provider cannot hold (file or conversation state too large). Answers 413. */
export class StorageLimitError extends AgentServerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "STORAGE_LIMIT_EXCEEDED", 413, details);
    this.name = "StorageLimitError";
  }
}

export class AuthenticationError extends AgentServerError {
  constructor(message: string = "Authentication required") {
    super(message, "AUTHENTICATION_ERROR", 401);
  }
}

export class AuthorizationError extends AgentServerError {
  constructor(message: string = "Access denied") {
    super(message, "AUTHORIZATION_ERROR", 403);
  }
}

// ============================================================================
// Task Types
// ============================================================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "waiting_for_input" | "cancelled";

export interface TaskComment {
  id: string;
  taskId: string;
  role: "agent" | "user";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface Task {
  id: string;
  agentId: string;
  userId?: string;
  /**
   * The conversation the task runs in. Its events, approvals and cancellation work like any
   * conversation's; when the agent pauses, the task is `waiting_for_input` and the actions are
   * answered on the conversation.
   */
  conversationId?: string;
  status: TaskStatus;
  callbackUrl?: string;
  input: string;
  files?: FileAttachment[];
  comments?: TaskComment[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface TaskResult {
  id: string;
  taskId: string;
  content: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  createdAt: Date;
}

export interface CreateTaskParams {
  agentId: string;
  userId?: string;
  conversationId?: string;
  input: string;
  files?: FileAttachment[];
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface GetTasksParams {
  agentId?: string;
  userId?: string;
  conversationId?: string;
  status?: TaskStatus;
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt";
  order?: "asc" | "desc";
}

export interface UpdateTaskParams {
  status?: TaskStatus;
  conversationId?: string;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  metadata?: Record<string, unknown>;
  comments?: TaskComment[];
}

export interface AddTaskCommentParams {
  taskId: string;
  role: "agent" | "user";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskResultParams {
  taskId: string;
  content: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

// ============================================================================
// Task Request/Response Types
// ============================================================================

export interface CreateTaskRequest {
  agentId: string;
  input: string;
  files?: Array<{
    name: string;
    content: string; // base64
    mimeType: string;
  }>;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskResponse {
  task: Task;
}

export interface ListTasksResponse {
  tasks: Task[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface GetTaskResponse {
  task: Task;
  result?: TaskResult;
  /** Present while the task is `waiting_for_input` on actions of its conversation. */
  pendingActions?: PendingAction[];
}

export interface GetTaskStatusResponse {
  taskId: string;
  status: TaskStatus;
  conversationId?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface GetTaskResultResponse {
  result: TaskResult;
}

export interface AddTaskCommentRequest {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AddTaskCommentResponse {
  comment: TaskComment;
  task: Task;
}

export interface GetTaskCommentsResponse {
  comments: TaskComment[];
  total: number;
}

