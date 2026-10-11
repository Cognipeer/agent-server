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
   * Storage only: how many times the record was updated (`0` when created). A provider that reports
   * `capabilities().atomicUpdate` bumps it on every update and honours it in `updateConversationIf`.
   * Never sent to clients.
   */
  version?: number;
  /**
   * Storage only: the earliest `expiresAt` among the actions the conversation waits on. The server writes
   * it together with the pause and the sweep finds due conversations with `getConversations({ actionDueBefore })`.
   * Never sent to clients.
   */
  actionDueAt?: Date;
  /**
   * Where the conversation is in its run lifecycle. Computed by the server for
   * the API (`GET /conversations`, `GET /conversations/:id`); never stored.
   */
  runtime?: ConversationRuntime;
  /**
   * The spend limit of the conversation, when it has one (API only; the server keeps it in the
   * conversation's hidden state). `null`: the agent's default was removed.
   */
  budget?: SessionBudget | null;
  /** What the conversation's turns cost so far, in USD (API only; counted when the agent has a `pricing` function). */
  spentUsd?: number;
  /** Tools the person asked not to be asked about again in this conversation (API only). */
  rememberedTools?: string[];
  /**
   * Whether `POST /conversations/:id/continue` has a turn to carry on: the budget cut a turn short in the middle and its
   * state is kept (API only; present where `runtime` is). It stays `true` after the budget is raised or removed - until the
   * turn is continued, or a new message gives it up - and is `false` for a turn that finished its answer before the limit
   * (raising the budget then only reopens the conversation). While the budget is still used up, `continue` answers 402.
   */
  continuable?: boolean;
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
  /**
   * Why the last turn ended in `stopReason: "error"`, when the log says: the code and message of its `session.error`
   * event. A run whose process died is closed as `{ code: "run_interrupted" }` - the conversation then has the
   * person's message and no answer, and this is how a client tells them why. Absent for every other stop.
   */
  error?: RuntimeError;
}

/** What went wrong in the last turn of a conversation (`ConversationRuntime.error`). */
export interface RuntimeError {
  /** `run_interrupted` (the server stopped mid-turn), or the code of the failure (`INTERNAL_ERROR`, a host's own code, ...). */
  code: string;
  message: string;
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
  /**
   * What the agent accepts as attachments. The server fills it from the `files` option (server and
   * agent) for `GET /agents`; whatever the host sets here wins field by field. Clients show the
   * paperclip, the limits and the "this agent cannot read images" warning from it.
   */
  attachments?: AttachmentsCapability;
}

/** `AgentInfo.capabilities.attachments`: what a conversation with the agent can hold. */
export interface AttachmentsCapability {
  /** Files can be attached at all. */
  enabled?: boolean;
  /** Files one conversation may hold. */
  maxFiles?: number;
  /** Largest file, in bytes. */
  maxFileSize?: number;
  /** Accepted MIME types (`image/*` style wildcards); empty means any. */
  allowedMimeTypes?: string[];
  /** The agent's model looks at images; without it an attached image is only mentioned. */
  acceptsImages?: boolean;
  /**
   * How long an uploaded file is kept, in days, counted from the upload (`0`: until its conversation is deleted).
   * Clients show it next to the paperclip ("files are kept for 30 days").
   */
  retentionDays?: number;
}

// ============================================================================
// Human-in-the-loop (pending actions)
// ============================================================================

export interface UserQuestionOption {
  label: string;
  value?: string;
  description?: string;
  /** A code or ASCII preview shown while the option is focused (agent-sdk `UserQuestionOption.preview`). */
  preview?: string;
}

export interface UserQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  placeholder?: string;
  required?: boolean;
  options?: UserQuestionOption[];
}

/**
 * Something the agent is waiting on before it can continue. `expiresAt` (ISO 8601) is when the request
 * lapses: taken from the agent's own entry, else stamped by the server from `hitl.timeoutMinutes`. After it
 * the action answers `410 action_expired` and `hitl.onTimeout` decides what happens (see {@link HitlConfig}).
 */
export type PendingAction =
  | {
      id: string;
      type: "tool_approval";
      toolName: string;
      toolCallId?: string;
      title?: string;
      /** A one-line description of what approving does (`metadata.summary` of the agent's entry). */
      summary?: string;
      args?: Record<string, unknown>;
      /**
       * JSON Schema of the tool's arguments, when the server knows it (an agent-sdk tool's zod or JSON schema; a host
       * agent can set it itself). A client that lets the person edit `args` validates the edit against it; the server
       * checks `approvedArgs` against the tool's schema either way (`400 invalid_approved_args`).
       */
      argsSchema?: Record<string, unknown>;
      expiresAt?: string;
    }
  | {
      id: string;
      type: "user_question";
      questions: UserQuestion[];
      allowFreeText?: boolean;
      expiresAt?: string;
    };

/**
 * How an action ended, as the snapshot on the paused assistant message (`metadata.pendingActions`) records it:
 * `resolved` (approved, denied or answered - see `resolution`), `cancelled` (nobody answered; a new message or
 * `POST .../cancel` withdrew it) or `expired` (it lapsed under `hitl.onTimeout: "cancel"`).
 */
export type ActionStatus = "pending" | "resolved" | "cancelled" | "expired";

/** One action on the paused assistant message: the action as it was asked, and - once it ended - how. */
export type ActionSnapshot = PendingAction & {
  status: ActionStatus;
  /** What the person (or the timeout) answered. */
  resolution?: ActionResolution;
  /** Who answered: the user id, `system:timeout`, or `system` for a withdrawn request. */
  resolvedBy?: string;
  resolvedAt?: string;
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
  /** Reads a file of this conversation. `null` for any other id or a file that expired. */
  getFileContent?: (fileId: string) => Promise<Buffer | null>;
  /** The text of a file of this conversation, extracted the way the server gives it to an agent (`files.extractText`); `null` when it has none. */
  getFileText?: (fileId: string) => Promise<string | null>;
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
  /** What the person typed. The files are not in it: see `files`, `getFileContent` and `getFileText`. */
  message: string;
  /** The files this message carries (uploaded earlier and attached by id, or sent inline - those are stored first, so every entry has a real id). */
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
  /** Reads a file of this conversation (`files`, or an earlier upload). `null` for any other id or a file that expired. */
  getFileContent?: (fileId: string) => Promise<Buffer | null>;
  /** The text of a file of this conversation, extracted the way the server gives it to an agent (`files.extractText`); `null` when it has none. */
  getFileText?: (fileId: string) => Promise<string | null>;
}

export interface ProcessMessageResult {
  content: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /**
   * What the turn used. `costUsd` (and `model`, to price the tokens with the `pricing` function) lets a
   * handler take part in budgets; without it a handler's turns cost nothing as far as the budget knows.
   */
  usage?: UsageInfo & { model?: string };
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

// ============================================================================
// Host-backed agents
// ============================================================================

/**
 * What a host agent reports while a turn runs (`io.emit`). The server turns each event into the same stored events
 * and `stream.*` frames an agent-sdk agent produces, so clients cannot tell the difference.
 *
 *  - `text`: a chunk of the answer. The chunks are the answer when `content` is left empty.
 *  - `tool_use` / `tool_result`: a tool call started / ended. Pair them by `id`.
 *  - `action_required`: the turn waits on these. Same as returning them as `pendingActions` (the result wins when it
 *    has any); the pause is stored first and announced when the turn ends.
 *  - `usage`: what one model call used. Added up, unless the result carries `usage` of its own.
 *  - `stop`: why the turn stopped, when it is known before the host returns (the result's `stopReason` wins).
 */
export type HostEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; args?: Record<string, unknown> }
  | { type: "tool_result"; id: string; name?: string; result?: unknown; error?: string }
  | { type: "action_required"; actions: PendingAction[] }
  | { type: "usage"; usage: UsageInfo & { model?: string } }
  | { type: "stop"; stopReason: StopReason; detail?: string };

/** The files of the conversation a host agent runs in. Only those: any other id answers `null`. */
export interface HostFiles {
  /** Every file the conversation holds, oldest first. */
  list(): Promise<FileAttachment[]>;
  /** The bytes of a file; `null` for a file that is not this conversation's or has expired. */
  read(fileId: string): Promise<Buffer | null>;
  /** The text of a file, extracted the way the server gives it to an agent (`files.extractText`); `null` when it has none. */
  text(fileId: string): Promise<string | null>;
}

/** What the server hands a host agent next to its input. */
export interface HostRunIo {
  /** Reports progress. Late events (after the turn ended) are dropped; a malformed one is ignored with a warning. */
  emit(event: HostEvent): void;
  /**
   * Aborted when the run is cancelled (`POST /conversations/:id/cancel`, a deleted conversation, shutdown). Stop work and
   * return what you have; an agent that ignores it is abandoned after `runs.cancelGraceMs`.
   */
  signal: AbortSignal;
  /** The conversation's files. */
  files: HostFiles;
}

/** A user message for a host agent. */
export interface HostInvokeInput {
  conversationId: string;
  /** The run this turn executes as (the `runId` of `session.status_running` events and of the response). */
  runId: string;
  /** What the person typed. The files are not in it: see `files` and `io.files`. */
  message: string;
  /** The conversation so far, oldest first, including this message. Hosts that keep their own transcript ignore it. */
  history: Message[];
  /** The files this message carries (every entry is a stored file with a real id). */
  files: FileAttachment[];
  /** What the request put in `metadata` (a task hands over its comments). */
  metadata?: Record<string, unknown>;
  /** Per-request context resolved by `config.resolveContext` (user + custom data). */
  context: RequestContext;
}

/** The answer to one pending action of a host agent. */
export interface HostResolveInput {
  conversationId: string;
  runId: string;
  actionId: string;
  /** The action as it was asked. */
  action: PendingAction;
  /** The whole answer: the decision, edited arguments, `rememberForSession`, a question's answers. */
  resolution: ActionResolution;
  /** The other actions of the pause that are still open (the host decides what answering this one means for them). */
  pendingActions: PendingAction[];
  /** Who answered: the user id, or `system:timeout` for a request that lapsed under `hitl.onTimeout: "deny"`. */
  actor: string;
  /** Where the answer came from: `api`, or `timeout` (the server answered as a refusal). */
  channel: "api" | "timeout";
  /** The request lapsed and `hitl.onTimeout: "deny"` answered it. */
  expired?: boolean;
  /** What the request put in `metadata`. */
  metadata?: Record<string, unknown>;
  context: RequestContext;
}

/** Why the server tells a host agent to let go of something. */
export type HostCancelReason =
  | "user" // POST /conversations/:id/cancel
  | "remote" // asked through another node
  | "lease_lost" // another node took the conversation over
  | "deleted" // the conversation is being deleted
  | "shutdown" // server.close({ abort: true })
  | "withdrawn" // open requests were withdrawn (a new message under pendingActionPolicy "cancel", or the cancel route)
  | "expired"; // open requests lapsed under hitl.onTimeout: "cancel"

export interface HostCancelInput {
  conversationId: string;
  /** The run that was stopped; absent when the conversation was not running and only its open requests were withdrawn. */
  runId?: string;
  reason: HostCancelReason;
  /** The open requests that were withdrawn (`withdrawn`, `expired`, `deleted`). */
  actions?: PendingAction[];
  context: RequestContext;
}

/**
 * How a host agent's turn ended. The server stores the message, the pending actions, the events and the runtime
 * status itself: the host returns facts, never state.
 */
export interface HostTurnResult {
  /** The answer. May be empty when `text` events carried it (or when the turn only paused). */
  content?: string;
  /** `requires_action` is implied by `pendingActions`; `incomplete` / `cancelled` say the turn did not finish. */
  status?: MessageStatus;
  /** Why the turn stopped (default: `requires_action` for a pause, `end_turn` otherwise). */
  stopReason?: StopReason;
  /**
   * Everything the turn waits on. Replaces the pause: an empty list says nothing is open any more. After an answer
   * (`resolveAction`), the still-open actions returned unchanged and nothing else (no `content`, `usage` or files) only
   * records that answer on the message that asked; open actions left out or changed are withdrawn from it.
   */
  pendingActions?: PendingAction[];
  /** What the turn used; `costUsd` (or `model`, to price it with `pricing`) lets it take part in budgets. */
  usage?: UsageInfo & { model?: string };
  /** Files the answer produced (already stored with `POST /files`). */
  files?: FileAttachment[];
  /** Reported with the turn. A task reads `waitingForInput` from it. */
  metadata?: Record<string, unknown>;
  /** What the agent says about the stop (reported as the `detail` of `session.status_idle`). */
  detail?: string;
}

/** The behaviour of a host-backed agent: an agent whose work runs in the host's own backend, not in this process. */
export interface HostAgent {
  /** Runs one user message. */
  invoke(input: HostInvokeInput, io: HostRunIo): Promise<HostTurnResult> | HostTurnResult;
  /**
   * Continues a turn that paused with `pendingActions`, once per answered action. What it returns replaces the pause
   * (the actions it still waits on). Without it the agent cannot pause: its actions answer 404.
   */
  resolveAction?(input: HostResolveInput, io: HostRunIo): Promise<HostTurnResult> | HostTurnResult;
  /**
   * Called when the server lets go of something the host may still hold: a run that was cancelled while `invoke` or
   * `resolveAction` was working, or open requests that were withdrawn or lapsed. The `AbortSignal` already stopped the
   * work in this process; this is for backends that run elsewhere. A failure is logged and never fails the request; a hook that
   * does not answer within `runs.cancelGraceMs` is given up on.
   */
  cancel?(input: HostCancelInput): Promise<void> | void;
}

/** `registerHostAgent` takes the agent's description and behaviour, and the same per-agent settings as `AgentRegistration`. */
export interface HostAgentDefinition extends HostAgent, Pick<AgentRegistration, "files" | "hitl" | "budget" | "pricing"> {
  info: AgentInfo;
}

/**
 * Agent registration - can be SDK agent, custom handler, host-backed agent, or AI API provider
 */
export interface AgentRegistration {
  info: AgentInfo;
  // SDK agent instance (optional)
  sdkAgent?: unknown;
  // Custom handler (optional)
  handler?: AgentHandler;
  // Host-backed agent (optional): see `registerHostAgent`
  host?: HostAgent;
  // Chat Completions API config (optional)
  chatCompletions?: import("./providers/ai/chat-completions.js").ChatCompletionsConfig;
  // Responses API config (optional)
  responsesApi?: import("./providers/ai/responses.js").ResponsesApiConfig;
  /** Attachment settings of this agent; each field overrides the server's `files` option. */
  files?: AgentFilesConfig;
  /** Approval and question settings of this agent; each field overrides the server's `hitl` option. */
  hitl?: AgentHitlConfig;
  /**
   * The spend limit new conversations with this agent start with. Overrides the server's `budget`;
   * `null` says this agent has none. Needs a `pricing` function (this agent's or the server's).
   */
  budget?: SessionBudget | null;
  /** Prices the tokens this agent uses (overrides the server's `pricing`). */
  pricing?: PricingFn;
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
  /**
   * Optional (`capabilities().atomicUpdate`): the update only happens when the conversation is still at
   * `ifVersion` (the `version` you read it at); resolves the updated conversation, or `null` when someone
   * else updated it in between (read it again and redo your change). An unknown conversation is a
   * `NotFoundError`. This is what keeps two writers of one conversation's state - two answers to one
   * pause, a sweep and an answer, a budget change and a turn - from overwriting each other.
   */
  updateConversationIf?(
    id: string,
    ifVersion: number,
    params: UpdateConversationParams,
    ctx?: RequestContext
  ): Promise<Conversation | null>;
  deleteConversation(id: string, ctx?: RequestContext): Promise<void>;

  // Messages
  createMessage(params: CreateMessageParams, ctx?: RequestContext): Promise<Message>;
  getMessages(conversationId: string, params?: GetMessagesParams, ctx?: RequestContext): Promise<PaginatedResult<Message>>;
  getMessage(id: string, ctx?: RequestContext): Promise<Message | null>;
  /**
   * Optional: replaces a stored message's `content` and / or `metadata`. The server uses it to record
   * how an action ended on the assistant message that asked for it (`metadata.pendingActions`), so a
   * history shows approved / denied / answered / expired / cancelled; without it the message keeps
   * showing the request as it was asked. An unknown message is a `NotFoundError`.
   */
  updateMessage?(id: string, params: UpdateMessageParams, ctx?: RequestContext): Promise<Message>;
  deleteMessage(id: string, ctx?: RequestContext): Promise<void>;

  // Files
  saveFile(params: SaveFileParams, ctx?: RequestContext): Promise<FileRecord>;
  getFile(id: string, ctx?: RequestContext): Promise<FileRecord | null>;
  getFileContent(id: string, ctx?: RequestContext): Promise<Buffer | null>;
  deleteFile(id: string, ctx?: RequestContext): Promise<void>;

  /**
   * Optional (`capabilities().fileIndex`): the files of a conversation, oldest first. Needed for the
   * per-conversation file limit, `GET /conversations/:id/files`, `files.attachNewUploads` and the
   * `session_files_list` tool; without it the server only knows the files that messages carry.
   */
  listFiles?(params: ListFilesParams, ctx?: RequestContext): Promise<PaginatedResult<FileRecord>>;
  /**
   * Optional (`capabilities().fileIndex`): deletes files whose `expiresAt` has passed (record and content),
   * oldest expiry first, at most `limit` (default 500). Resolves how many it deleted.
   */
  purgeExpiredFiles?(params: PurgeExpiredFilesParams, ctx?: RequestContext): Promise<number>;

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
  /** Compare-and-set conversation updates (`updateConversationIf`, `Conversation.version`). */
  atomicUpdate: boolean;
  /**
   * `getConversations({ actionDueBefore })` finds the conversations whose pending actions are due
   * (`Conversation.actionDueAt`). Without it the server cannot sweep expired actions by itself: they are
   * still refused with `410 action_expired`, and `server.expirePendingActions({ conversationId })` handles one on demand.
   */
  actionDeadlines?: boolean;
  /** A durable per-conversation event log (`events`). */
  events: boolean;
  /** Per-conversation leases (`acquireLease` / `releaseLease`). */
  leases: boolean;
  /** Per-conversation file listing and expiry purge (`listFiles` / `purgeExpiredFiles`). Absent: `false`. */
  fileIndex?: boolean;
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
  /**
   * Only conversations whose `actionDueAt` is at or before this moment, earliest first (`orderBy` /
   * `order` are ignored). Needs `capabilities().actionDeadlines`.
   */
  actionDueBefore?: Date;
}

export interface UpdateConversationParams {
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
  /** When the earliest open action lapses; `null` clears it. */
  actionDueAt?: Date | null;
}

export interface UpdateMessageParams {
  content?: string | ContentPart[];
  /** Replaces the message's metadata. */
  metadata?: Record<string, unknown>;
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
  /** Who uploaded it. The file routes only show a file to its owner. */
  userId?: string;
  /** The agent of the conversation the file was uploaded to. */
  agentId?: string;
  /** After this the file is deleted by the retention sweep (see `purgeExpiredFiles`). */
  expiresAt?: Date;
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
  /** Who uploaded it (absent for files saved without an identity). */
  userId?: string;
  agentId?: string;
  /** When the retention sweep deletes it (absent: never). */
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface ListFilesParams {
  conversationId: string;
  /** Default 100. */
  limit?: number;
  offset?: number;
  /** `asc` (default): oldest first. */
  order?: "asc" | "desc";
}

export interface PurgeExpiredFilesParams {
  /** Files that expire at or before this moment. */
  before: Date;
  /** At most this many per call (default 500). */
  limit?: number;
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
  /**
   * How long to wait for the title, in milliseconds (default 10000). The turn holds its conversation while it waits, so a slow
   * endpoint must not hold it for long; a title that did not arrive in time is skipped. Cancelling the turn also stops the wait.
   */
  timeoutMs?: number;
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
   * Reserved for a separate file store. Not used yet: files are kept by `storage` (the built-in providers hold them
   * next to the conversations; a custom provider implements `saveFile` / `getFileContent`).
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

  /**
   * Files attached to conversations: limits, how an agent gets to read them, images, retention.
   * Every agent can override each field with `AgentRegistration.files`. Every value has a default.
   */
  files?: FilesConfig;

  /**
   * Approvals and questions: how long a request waits, what happens when it lapses, who may answer, how edited
   * arguments are checked. Every agent can override the timeouts with `AgentRegistration.hitl`. Every value has a default.
   */
  hitl?: HitlConfig;

  /**
   * The spend limit new conversations start with, for every agent that does not say otherwise
   * (`AgentRegistration.budget`). Needs `pricing`. Absent: conversations have no limit unless one is set on them.
   */
  budget?: SessionBudget;

  /**
   * What a token costs, by model name; turns the usage of a turn into `costUsd` and a conversation's
   * `spentUsd`. `AgentRegistration.pricing` overrides it for one agent. Without any pricing, nothing is
   * priced and budgets cannot be used. See {@link costEstimatorFromPricing} to give agent-sdk the same
   * prices, so its own `limits.maxCostUsd` can stop a turn in the middle.
   */
  pricing?: PricingFn;

  /**
   * Decides whether a conversation's budget may be raised or removed (lowering it is always allowed to the
   * conversation's owner). Default: deny - nobody but the host's code can lift a limit.
   */
  authorizeBudget?: (ctx: RequestContext, change: BudgetChange) => boolean | Promise<boolean>;

  /**
   * Whether `GET /conversations` and `GET /tasks` may answer a request that has no resolved user (no token user,
   * no `context.user`, no `userId` the server trusts) - which lists the conversations of EVERYONE. Default `false`:
   * such a request is refused with 401 `identity_required`. Turn it on only for a server that is single-user by design
   * (a local tool, a demo). The built-in storage providers hold every user's data in one namespace; they do not
   * separate tenants, so a multi-tenant host resolves a user (`resolveContext`) for every request.
   */
  allowAnonymousList?: boolean;
}

/** Approval and question settings. */
export interface HitlConfig {
  /**
   * Minutes a request waits for an answer before `onTimeout` applies (default 1440, one day; `0`: never).
   * A request that comes with its own `expiresAt` (from the agent) keeps it.
   */
  timeoutMinutes?: number;
  /**
   * What happens to a request nobody answered in time: `"deny"` (default) answers it as a refusal (a question
   * as skipped) and - once nothing else is open - lets the agent carry on, as a run of its own; `"cancel"` drops
   * the request and ends the turn (`stopReason: "cancelled"`).
   */
  onTimeout?: "deny" | "cancel";
  /**
   * Who may answer a request. Default: the conversation's owner (the rule that guards every conversation route).
   * When set, this decides for everyone - the owner too - and the owner check is not applied to the
   * resolve route, so an approver who does not own the conversation can answer. Answer `false` for 403 `action_forbidden`.
   */
  authorizeResolve?: (
    ctx: RequestContext,
    input: { conversation: Conversation; action: PendingAction }
  ) => boolean | Promise<boolean>;
  /**
   * Check `approvedArgs` against the tool's schema (a zod schema or a JSON Schema on the agent-sdk tool) before
   * the tool runs; a bad edit is 400 `invalid_approved_args`. Default true.
   */
  validateApprovedArgs?: boolean;
  /**
   * An answer that arrives while another answer to the same conversation is being recorded waits this long
   * (milliseconds) for it instead of failing with 409 `conversation_busy` (default 3000). Answers to the several
   * actions of one pause can therefore be sent at the same time.
   */
  resolveWaitMs?: number;
}

/** The per-agent form of {@link HitlConfig}: the settings that make sense for one agent. */
export type AgentHitlConfig = Pick<HitlConfig, "timeoutMinutes" | "onTimeout" | "validateApprovedArgs">;

/** A spend limit. */
export interface SessionBudget {
  /** Largest total cost of the conversation's turns, in USD. */
  maxCostUsd: number;
  /**
   * What reaching it does: `"pause"` (default): the conversation waits - raise the budget and `POST .../continue`
   * carries the stopped turn on; `"stop"`: it ends, and every further message is refused.
   */
  onReach: "pause" | "stop";
}

/** What a token costs, in USD. */
export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  /** Price of an input token that was served from the provider's cache (default: `inputPerToken`). */
  cachedInputPerToken?: number;
}

/** Looks a model up by the name agent-sdk reports it under. `undefined`: this model is not priced. */
export type PricingFn = (model: string) => ModelPricing | undefined;

/** A change to a conversation's budget, as `authorizeBudget` sees it. */
export interface BudgetChange {
  /** The conversation (absent when a conversation is being created with a budget of its own). */
  conversation?: Conversation;
  current: SessionBudget | null;
  requested: SessionBudget | null;
  spentUsd: number;
}

/**
 * What a turn used. SDK agents report their usage cumulatively and per model; the server turns it into
 * these totals for the turn alone (a resumed turn counts only what it used after the resume).
 */
export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Input tokens the provider served from its cache (included in `inputTokens`). */
  cachedInputTokens?: number;
  /** What the turn cost, in USD, when the agent's models are priced (`pricing`). */
  costUsd?: number;
}

/** What an extractor is told about a file. */
export type ExtractTextFile = Pick<FileAttachment, "id" | "name" | "mimeType" | "size">;

/**
 * Attachment settings. `AgentServerConfig.files` sets them for every agent; `AgentRegistration.files`
 * (and the `options.files` of the `register*Agent` methods) overrides single fields for one agent.
 */
export interface FilesConfig {
  /**
   * Whether files can be attached. Default `true` (the upload route has always been open); set it to
   * `false` on an agent to refuse uploads to its conversations (403 `attachments_disabled`).
   */
  enabled?: boolean;
  /** Files one conversation may hold (default 10). Past it an upload is `409 too_many_files`. */
  maxFiles?: number;
  /**
   * Largest file in bytes. Default `limits.maxFileSize`, else 10 MiB; never more than the storage
   * provider can hold. An agent may ask for more than the server default, up to the provider's limit
   * (the HTTP body limit of your adapter must allow it too).
   */
  maxFileSize?: number;
  /** MIME types an upload may have; `image/*` style wildcards. Empty or absent: any. Past it: `415 unsupported_file_type`. */
  allowedMimeTypes?: string[];
  /**
   * Estimated tokens (characters / 4) up to which the text of ALL the documents one message carries goes
   * into the turn. Over it the agent is told to read them in pages with `session_files_list` /
   * `session_files_read` (SDK agents that have those tools; any other agent gets the start of the
   * documents, cut at this size, and a `file_truncated` warning). Default 30 000.
   */
  inlineMaxTokens?: number;
  /** Characters per page of `session_files_read` (default 20 000). */
  readPageChars?: number;
  /** Days a file is kept after it was uploaded; the retention sweep deletes it then. `0` keeps files for good. Default 30. */
  retentionDays?: number;
  /**
   * The agent's model looks at images. Default `false`: an attached image is then only mentioned to the
   * agent (and `capabilities.attachments.acceptsImages` is `false`, so clients can warn).
   */
  vision?: boolean;
  /**
   * Files uploaded to a conversation that no message has carried yet ride along with its next message,
   * as if they had been listed in `fileIds`. Default `false`: only `fileIds` and inline `files` count.
   */
  attachNewUploads?: boolean;
  /** Images one model request carries at most; when there are more, the newest are kept and an older one is only named (default 6). */
  maxImages?: number;
  /** Image bytes (before base64) one model request carries at most (default 12 000 000). */
  maxImageBytes?: number;
  /**
   * How many EARLIER image-carrying messages keep their images in front of the model, besides the one
   * being answered (default 2). An older image is only named, and `session_files_view_image` shows it again.
   */
  carryRecentImages?: number;
  /**
   * Turns a file into text for the agent. Return the text, `undefined` to let the default extractor
   * have it, or `null` when the file has no text. The default reads `text/*`, JSON, XML and the like
   * as UTF-8 and - when `@cognipeer/to-markdown` is installed - converts PDF, Word, Excel and PowerPoint files.
   */
  extractText?: (
    file: ExtractTextFile,
    bytes: Buffer
  ) => Promise<string | null | undefined> | string | null | undefined;
  /**
   * Bytes of extracted text kept in memory so a file is not converted again for every page or turn
   * (default 33 554 432, 32 MiB; 0 turns the cache off). Server-wide.
   */
  extractCacheBytes?: number;
  /**
   * How often the sweep deletes files past their `expiresAt`, in milliseconds (default 3 600 000, one hour;
   * 0 turns the periodic purge off). With storage leases only one node purges at a time. Server-wide.
   */
  purgeIntervalMs?: number;
}

/** The per-agent form of {@link FilesConfig}: the fields that make sense for one agent. */
export type AgentFilesConfig = Omit<FilesConfig, "extractCacheBytes" | "purgeIntervalMs">;

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
   * Maximum number of files one message attaches (`fileIds` plus inline `files`; default: 10).
   * The number a conversation may hold is `files.maxFiles`.
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
  /**
   * Files sent with the message, base64. They are stored (in this conversation, owned by the
   * sender, under the same limits as an upload) before the turn runs, and then count exactly like
   * `fileIds`: `files` of the user message carries their real ids.
   */
  files?: Array<{
    name: string;
    content: string; // base64
    mimeType: string;
  }>;
  /**
   * Files uploaded earlier with `POST /files` (`conversationId` set to this conversation) that this
   * message attaches. Each id must be a file of this conversation that the caller uploaded (404
   * otherwise); the user message carries the stored records, and the agent gets the files'
   * contents (see `files` in the server config). Capped by `limits.maxFiles` (default 10).
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
  usage?: UsageInfo;
  /** Present (as `"requires_action"`) when the turn paused for a human. */
  status?: MessageStatus;
  pendingActions?: PendingAction[];
  /** Things worth knowing about a turn that still completed (see {@link TurnWarning}). */
  warnings?: TurnWarning[];
  /** Why the turn stopped. */
  stopReason?: StopReason;
  /** The run that executed the turn; its events carry it as `run_id`. */
  runId?: string;
  /** The conversation's budget and what it has spent, when it has a budget. */
  budget?: SessionBudget;
  spentUsd?: number;
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
  usage?: UsageInfo;
  /** Only set when the turn did not simply complete (e.g. `"requires_action"`). */
  status?: MessageStatus;
  pendingActions?: PendingAction[];
  warnings?: TurnWarning[];
  stopReason?: StopReason;
  runId?: string;
  budget?: SessionBudget;
  spentUsd?: number;
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
    /** The request lapsed and `hitl.onTimeout` answered it. */
    expired?: boolean;
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

/**
 * The first frame of `GET /conversations/:id/events/stream` when a run is active on the node that serves the stream. Not a stored
 * event: it has no `id:` line and no `seq`, and it is sent once, before anything else. It is what a client that joins mid-run
 * (a reload, a second window) seeds its view from - the user's message when the stored history may not have it yet, and the
 * answer as far as it has been streamed - and the `agent.message.delta` frames that follow append to `text`.
 */
export interface MessageSnapshotFrame {
  type: "agent.message.snapshot";
  data: {
    /** The run that is going. */
    run_id: string;
    /** The model text this run has streamed so far (`""` before the first token). */
    text: string;
    /** The message the run is answering, once it is stored; `null` for a run that answers an action or continues, and before the message is stored. */
    user_message: { id: string; content: string; files: FileAttachment[] } | null;
  };
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
  /**
   * A spend limit for this conversation. Without one it starts with the agent's (`AgentRegistration.budget`,
   * else the server's `budget`). A limit above the default is refused (403 `budget_forbidden`) unless
   * `authorizeBudget` allows it.
   */
  budget?: { maxCostUsd: number; onReach?: "pause" | "stop" };
}

/** `PATCH /conversations/:id`. */
export interface UpdateConversationRequest {
  title?: string;
  metadata?: Record<string, unknown>;
  /**
   * Sets the conversation's spend limit; `null` removes it. Lowering it is the owner's to do; raising or removing
   * it goes through `authorizeBudget` (403 `budget_forbidden` when it is not set). The new limit must be above what
   * the conversation has spent (400 `invalid_budget`).
   */
  budget?: { maxCostUsd: number; onReach?: "pause" | "stop" } | null;
}

/** `POST /conversations/:id/continue`. */
export interface ContinueConversationRequest {
  /** Stream the continuation as SSE, like `POST .../messages` with `stream: true`. */
  stream?: boolean;
}

/** `GET /conversations/:id/remembered-tools` and the answer of `DELETE .../remembered-tools/:tool`. */
export interface RememberedToolsResponse {
  tools: string[];
}

export interface CreateConversationResponse {
  conversation: Conversation;
}

/**
 * `POST /files` takes either this JSON body or the file's raw bytes with the file's own `Content-Type`
 * and `?name=<file name>&conversationId=<id>` (and optionally `&mimeType=` to override the header).
 */
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

/** `GET /conversations/:id/files`: the files the conversation holds, oldest first. */
export interface ListFilesResponse {
  files: FileRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** What the conversation may hold (`files.maxFiles` of its agent). */
  maxFiles: number;
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

