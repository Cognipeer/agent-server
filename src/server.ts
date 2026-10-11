/**
 * Agent Server Core
 *
 * Framework-agnostic core that handles routing and business logic.
 * Adapters (Express, Next.js, etc.) translate HTTP requests to this interface.
 */

import type {
  AgentServerConfig,
  AgentRegistration,
  ContextRequest,
  RequestContext,
  AgentInfo,
  AuthUser,
  Conversation,
  FileAttachment,
  Message,
  FileRecord,
  Task,
  TaskComment,
  SendMessageRequest,
  SendMessageResponse,
  CreateConversationRequest,
  CreateConversationResponse,
  ListAgentsResponse,
  ListConversationsResponse,
  GetConversationResponse,
  UploadFileRequest,
  UploadFileResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  ListTasksResponse,
  GetTaskResponse,
  GetTaskStatusResponse,
  GetTaskResultResponse,
  AddTaskCommentRequest,
  AddTaskCommentResponse,
  GetTaskCommentsResponse,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  StreamStartEvent,
  StreamTextEvent,
  StreamToolCallEvent,
  StreamToolResultEvent,
  StreamProgressEvent,
  StreamErrorEvent,
  StreamDoneEvent,
  StreamActionRequiredEvent,
  StreamActionResolvedEvent,
  PendingAction,
  ActionResolution,
  MessageStatus,
  ProcessMessageResult,
  ResolveActionRequest,
  ResolveActionResponse,
  AgentCapabilities,
  BudgetChange,
  TurnWarning,
  MessagesPage,
  StopReason,
  ConversationRuntime,
  RuntimeError,
  RunsConfig,
  EventStore,
  EventSummary,
  Lease,
  ListEventsResponse,
  CancelConversationResponse,
  NewConversationEvent,
  TaskStatus,
  ListFilesResponse,
  AgentFilesConfig,
  ProcessMessageParams,
  ContentPart,
  AgentHitlConfig,
  PricingFn,
  SessionBudget,
  UsageInfo,
  UpdateConversationParams,
  UpdateConversationRequest,
  ContinueConversationRequest,
  RememberedToolsResponse,
  HostAgent,
  HostAgentDefinition,
  HostCancelInput,
  HostCancelReason,
  HostFiles,
  HostRunIo,
} from "./types.js";
import {
  BUDGET_STATE_KEY,
  HITL_STATE_KEY,
  applySdkResolution,
  earliestDeadline,
  isExpired,
  jsonSafe,
  openSnapshot,
  portableState,
  publicState,
  readBudget,
  readHitl,
  runSdkTurn,
  settleSnapshot,
  stampDeadlines,
  supportsSdkPause,
  withHiddenStores,
  writeBudget,
  writeHitl,
  type BudgetStore,
  type HitlSdkAgent,
  type HitlStore,
  type SettledAction,
} from "./hitl.js";
import {
  budgetChangeKind,
  budgetWire,
  isCostLimitDetail,
  ledgerCostUsd,
  normalizeUsage,
  parseBudget,
  roundUsd,
  snapshotLedger,
} from "./usage.js";
import { findToolSchema, toJsonSchema, validateAgainstSchema } from "./schema.js";
import { hostAgentRegistration, readHostEvent, readHostResult, type HostCollected } from "./host.js";
import { generateOpenAPISpec, generateSwaggerHTML } from "./swagger.js";
import {
  invokeChatCompletions,
  streamChatCompletions,
  type ChatCompletionsConfig,
} from "./providers/ai/chat-completions.js";
import {
  invokeResponsesApi,
  streamResponsesApi,
  type ResponsesApiConfig,
} from "./providers/ai/responses.js";
import { bindStreamToContext, normalizeHeaders, parseCookies, runWithRequestContext } from "./context.js";
import { EVENT_TYPES, MemoryEventLog, actionRequiredData, clampLimit, snapshotFrame, wireEvent } from "./events.js";
import {
  ActiveRun,
  EventBus,
  LeaseKeeper,
  type BusItem,
  type RunItem,
  type RunKind,
  type RunTrigger,
  type TurnOutcome,
} from "./runs.js";
import {
  FILES_DEFAULTS,
  SESSION_FILES_READ_TOOL,
  SESSION_FILES_VIEW_IMAGE_TOOL,
  attachmentsCapability,
  contentDispositionHeader,
  fileDisposition,
  isFormContentType,
  isMimeAllowed,
  isVisionImageMime,
  isWellFormedMime,
  resolveFilesConfig,
  resolveUploadMimeType,
  type FileDisposition,
  type ResolvedFilesConfig,
} from "./files/config.js";
import { assembleHistory, buildUserTurnContent, type AssembledAttachments, type AttachmentSource } from "./files/assemble.js";
import { createTextExtractor, type TextExtractor } from "./files/extract.js";
import {
  dehydrateImages,
  hasImageReferences,
  isSessionImageModel,
  resolveImageReferences,
  type ImageFormat,
  type ImageSource,
} from "./files/images.js";
import { runWithTurnFiles, type TurnFiles } from "./files/turn.js";
import { isDeepStrictEqual } from "node:util";
import { nanoid } from "nanoid";

/** Largest file the upload route accepts when `limits.maxFileSize` is not set (capped by the storage provider). */
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_MESSAGE_PAGE_SIZE = 100;

/** Shown when a turn could not pause and the model had said nothing yet. */
const PAUSE_NOT_STORED_NOTICE =
  "This step needed your approval, but the conversation is too large to pause. It was not carried out.";

/**
 * Helper to safely extract tool event properties with fallbacks
 * Follows DRY and KISS principles
 */
function extractToolEventProps(event: any): {
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
} {
  return {
    toolName: event.name || event.toolName || "Unknown Tool",
    toolCallId: event.id || event.toolCallId || "",
    args: event.args || {},
  };
}

/**
 * Maps stored messages to the agent-sdk message shape (tool calls preserved). A user message that carries
 * files becomes the turn the model is given: its text plus what the files add (see files/assemble.ts).
 */
function toSdkMessages(data: Message[], assembled?: Map<string, AssembledAttachments>) {
  return data
    // A turn that paused or was stopped before it said anything leaves an empty assistant message behind.
    .filter((m) => !(m.role === "assistant" && m.content === "" && (m.metadata?.requiresAction === true || m.metadata?.status === "cancelled" || m.metadata?.status === "incomplete")))
    .map((m) => {
      const attached = m.role === "user" && typeof m.content === "string" ? assembled?.get(m.id) : undefined;
      return {
        role: m.role,
        content: attached ? buildUserTurnContent(m.content as string, attached) : m.content,
        // Preserve tool call information for proper LLM message history
        ...(m.toolCalls && m.toolCalls.length > 0 && {
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments }
          }))
        }),
        ...(m.toolCallId && { tool_call_id: m.toolCallId }),
        ...(m.name && { name: m.name }),
      };
    });
}

/**
 * Turns agent-sdk callbacks into run output: events for the log, text for followers and - for the
 * connection that started the run - the legacy `stream.*` frames.
 * The SDK emits tool_call events at multiple phases:
 *   phase "start"   -> tool execution is beginning
 *   phase "success" -> tool execution completed with result
 *   phase "error"   -> tool execution failed
 *   phase "skipped" -> tool was skipped (limit reached)
 * Only "start" becomes a tool call; "success"/"error" become a tool result.
 */
function createSdkBridge(run: ActiveRun, partial: { text: string }) {
  const startedAt = new Map<string, number>();

  const toolResult = (props: { toolName: string; toolCallId: string }, result: unknown, error?: string) => {
    const began = startedAt.get(props.toolCallId);
    startedAt.delete(props.toolCallId);
    run.emit({
      events: [
        {
          type: EVENT_TYPES.toolResult,
          data: {
            tool_call_id: props.toolCallId,
            name: props.toolName,
            ok: error === undefined,
            ...(began !== undefined ? { duration_ms: Date.now() - began } : {}),
            ...(error !== undefined ? { error } : {}),
          },
        },
      ],
      frame: (seq) => ({
        type: "stream.tool_result",
        timestamp: Date.now(),
        toolName: props.toolName,
        toolCallId: props.toolCallId,
        result: error === undefined ? result : { error },
        seq,
      } satisfies StreamToolResultEvent),
    });
  };

  const bridge = {
    streamedAnyText: false,
    finalChunkText: "",
    onStream: (chunk: { text: string; isFinal?: boolean }) => {
      // Agent SDK emits a final full-text chunk (isFinal:true). Don't
      // forward it as stream.text (it would duplicate the streamed
      // text) - but remember it: an agent that never streamed
      // (tool agents run non-streaming) only delivers the answer here.
      if (chunk.isFinal) {
        bridge.finalChunkText = chunk.text;
        return;
      }
      bridge.streamedAnyText = bridge.streamedAnyText || chunk.text.length > 0;
      partial.text += chunk.text;
      run.emit({
        delta: chunk.text,
        frame: (seq) => ({
          type: "stream.text",
          timestamp: Date.now(),
          text: chunk.text,
          isFinal: false,
          seq,
        } satisfies StreamTextEvent),
      });
    },
    onEvent: (event: { type: string; [key: string]: unknown }) => {
      if (event.type === "tool_call") {
        const phase = (event as { phase?: string }).phase;
        const props = extractToolEventProps(event);

        if (phase === "success" || phase === "error") {
          // Tool finished - emit as tool_result
          toolResult(
            props,
            (event as { result?: unknown }).result,
            phase === "success"
              ? undefined
              : ((event as { error?: { message?: string } }).error)?.message || "Tool execution failed"
          );
        } else if (!phase || phase === "start") {
          // Tool starting - emit as tool_call
          startedAt.set(props.toolCallId, Date.now());
          run.emit({
            events: [
              {
                type: EVENT_TYPES.toolUse,
                data: { tool_call_id: props.toolCallId, name: props.toolName, args: props.args ?? {} },
              },
            ],
            frame: (seq) => ({
              type: "stream.tool_call",
              timestamp: Date.now(),
              toolName: props.toolName,
              toolCallId: props.toolCallId,
              args: props.args as Record<string, unknown>,
              seq,
            } satisfies StreamToolCallEvent),
          });
        }
        // phase "skipped" -> do not emit (already at tool limit)
      } else if (event.type === "tool_result") {
        toolResult(extractToolEventProps(event), event.result);
      }
    },
  };
  return bridge;
}

/** Status follows the actions: pending actions imply requires_action; a bare requires_action is dropped. */
function normalizeTurnStatus(status: MessageStatus | undefined, pending: PendingAction[]): MessageStatus | undefined {
  if (pending.length > 0) return "requires_action";
  return status === "requires_action" ? undefined : status;
}

/** Everything `executeResolve` needs, gathered (and validated) by `handleResolveAction`. */
interface ResolveRun {
  ctx: RouteContext;
  conversation: Conversation;
  agent: AgentRegistration;
  store: HitlStore;
  action: PendingAction;
  resolution: ActionResolution;
  /** SDK state with the decision applied (SDK agents only). */
  nextSdkState?: unknown;
  metadata?: Record<string, unknown>;
  /** Who gave the answer (`system:timeout` for a request that lapsed). */
  actor: string;
  /** Where it came from: `api`, or `timeout` for the sweep. */
  channel: "api" | "timeout";
  /** The answer replaced the person's arguments with their own. */
  edited: boolean;
  /** The request lapsed and `onTimeout: "deny"` answered it. */
  expired?: boolean;
}

/** What the agent produced in one step of a turn, before it is persisted. */
interface AgentStep {
  content: string;
  files?: Message["files"];
  usage?: UsageInfo;
  /** What the step waits on (never set for a cancelled step). */
  pending: PendingAction[];
  sdkState?: unknown;
  /** State a custom handler wrote this step. */
  handlerState?: Record<string, unknown>;
  handlerMetadata?: Record<string, unknown>;
  /** Keys to put on the conversation's visible state (the Responses API's `lastResponseId`). */
  statePatch?: Record<string, unknown>;
  /** The run was cancelled while the step ran. */
  cancelled: boolean;
  /** The agent stopped at one of its limits. */
  limited?: boolean;
  /** The conversation's budget - not the agent's own per-turn limit - stopped the step in the middle. */
  budgetBreach?: boolean;
  /** The agent-sdk state to carry on from after a budget stop (`POST .../continue`). */
  budgetState?: unknown;
  /** What the agent said about it (reported as the `detail` of `session.status_idle`). */
  detail?: string;
  /** Why the step stopped, when the agent said so (a custom handler's `stopReason`). */
  stopReason?: StopReason;
  /** What a custom handler reported as `status` ("incomplete" without a reason becomes a `limit`). */
  handlerStatus?: MessageStatus;
  /** Things worth knowing about the files of the turn (see {@link TurnWarning}). */
  warnings?: TurnWarning[];
}

const cancelledStep = (content: string): AgentStep => ({ content, pending: [], cancelled: true });

/** The same request, whatever deadline the server stamped on it. */
const sameRequest = (a: PendingAction, b: PendingAction): boolean => {
  const { expiresAt: _a, ...left } = a;
  const { expiresAt: _b, ...right } = b;
  return isDeepStrictEqual(left, right);
};

/**
 * A step that says nothing but "I still wait on the rest": no answer, files, usage or stop of its own, and exactly the
 * open requests of the pause, unchanged. Such an answer is only recorded; it does not start a new message.
 */
function stillWaiting(step: AgentStep, remaining: PendingAction[]): boolean {
  if (step.cancelled || step.content !== "" || step.files?.length || step.usage || step.warnings?.length) return false;
  if (step.stopReason !== undefined && step.stopReason !== "requires_action") return false;
  if (remaining.length === 0 || step.pending.length !== remaining.length) return false;
  return remaining.every((old) => step.pending.some((p) => p.id === old.id && sameRequest(p, old)));
}

/** What a turn needs to know about money (see `planTurnBudget`). */
interface TurnBudget {
  pricing?: PricingFn;
  /** The conversation's budget; null when it has none. */
  budget: SessionBudget | null;
  /** What the conversation had spent when the turn started. */
  spentBefore: number;
  /** The cap given to agent-sdk, and whether it is the budget's (not the agent's own per-turn limit). */
  limit?: { maxCostUsd: number; sessionBinds: boolean };
}

/** The message status that goes with a stop reason. */
function statusForStop(stopReason: StopReason): MessageStatus {
  switch (stopReason) {
    case "end_turn":
      return "completed";
    case "requires_action":
      return "requires_action";
    case "cancelled":
      return "cancelled";
    default:
      return "incomplete";
  }
}

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

const conversationLeaseKey = (conversationId: string) => `conv:${conversationId}`;

/** A file that came with a request and is not stored yet. */
interface IncomingFile {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

/** The files a message attaches, checked against the agent's settings. */
interface PreparedAttachments {
  /** Stored files, attached by id. */
  refs: FileAttachment[];
  /** Files sent inline: stored when the turn starts. */
  inline: IncomingFile[];
  cfg: ResolvedFilesConfig;
}

/**
 * The content of a stored message as a model API takes it: a user message with files is the turn the files make
 * (text plus what they add); anything else is passed as it was stored - text, or parts for a message that has them.
 */
function modelContent(message: Message, attached: Map<string, AssembledAttachments>): string | ContentPart[] {
  const assembled = message.role === "user" && typeof message.content === "string" ? attached.get(message.id) : undefined;
  return assembled ? (buildUserTurnContent(message.content as string, assembled) as ContentPart[] | string) : message.content;
}

const attachmentOf = (record: FileRecord): FileAttachment => ({
  id: record.id,
  name: record.name,
  mimeType: record.mimeType,
  size: record.size,
});

const uniqueAttachments = (files: FileAttachment[]): FileAttachment[] => [
  ...new Map(files.map((file) => [file.id, file])).values(),
];

/** What an extractor is told about a stored file. */
const extractInfo = (record: FileRecord) => ({ id: record.id, name: record.name, mimeType: record.mimeType, size: record.size });

/** What the `register*Agent` methods take besides the agent itself. */
export interface AgentRegistrationOptions {
  /** Attachment settings of this agent; each field overrides the server's `files` option. */
  files?: AgentFilesConfig;
  /** Approval and question settings of this agent; each field overrides the server's `hitl` option. */
  hitl?: AgentHitlConfig;
  /** The spend limit new conversations with this agent start with (`null`: none, whatever the server says). Needs pricing. */
  budget?: SessionBudget | null;
  /** Prices the tokens this agent uses (overrides the server's `pricing`). */
  pricing?: PricingFn;
}

/** The fields of {@link AgentRegistrationOptions} as an {@link AgentRegistration} holds them. */
function registrationExtras(options?: AgentRegistrationOptions): Partial<AgentRegistration> {
  return {
    ...(options?.files && { files: options.files }),
    ...(options?.hitl && { hitl: options.hitl }),
    ...(options?.budget !== undefined && { budget: options.budget }),
    ...(options?.pricing && { pricing: options.pricing }),
  };
}

export interface RouteContext {
  user?: AuthUser;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
  /** Request headers (any casing) - given to `resolveContext` / `resolveUserId`. */
  headers?: Record<string, string | string[] | undefined>;
  /** URL (path + query) as seen by the adapter. */
  url?: string;
  /** Params of the dynamic prefix the server is mounted under (e.g. Fastify `/p/:key`). */
  mountParams?: Record<string, string>;
  /** The framework's native request object. */
  raw?: unknown;
  /**
   * Per-request context. Pass a pre-resolved one to skip `config.resolveContext`;
   * inside route handlers it is always set.
   */
  context?: RequestContext;
}

/** What adapters hand to `handleRequest` / `handleRoute`. */
export type RouteRequest = Omit<RouteContext, "params">;

export interface RouteResult<T = unknown> {
  status: number;
  body?: T;
  headers?: Record<string, string>;
  raw?: Buffer;
  /**
   * SSE stream generator for streaming responses
   */
  stream?: AsyncGenerator<string, void, unknown>;
  /**
   * Adapters call it when the client of a `stream` goes away, so the stream ends at once instead of
   * at its next frame (a follower may have nothing to say for a long time). A connection that goes away
   * never stops the run it was watching.
   */
  close?: () => void;
}

type RouteHandler<T = unknown> = (ctx: RouteContext) => Promise<RouteResult<T>>;

interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path as it was declared (`/conversations/:conversationId`), relative to the base path. */
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  /** Public routes (swagger docs) skip `resolveContext`. */
  public?: boolean;
}

/** Page size is capped and offset floored, so a hostile query string never reaches the storage layer raw. */
const DEFAULT_MAX_PAGE_SIZE = 200;
function parsePaging(
  query: Record<string, unknown>,
  defaultLimit: number,
  maxLimit = DEFAULT_MAX_PAGE_SIZE
): { limit: number; offset: number } {
  const limit = parseInt(String(query.limit ?? ""), 10);
  const offset = parseInt(String(query.offset ?? ""), 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, maxLimit) : Math.min(defaultLimit, maxLimit),
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

/** A message as the API returns it: assistant messages also report how their turn ended as `status`. */
function publicMessage<T extends Message>(message: T): T {
  if (message.role !== "assistant") return message;
  const status =
    (message.metadata?.status as MessageStatus | undefined) ??
    (message.metadata?.requiresAction === true ? "requires_action" : "completed");
  return { ...message, status };
}

export class AgentServer {
  private config: AgentServerConfig;
  private agents: Map<string, AgentRegistration> = new Map();
  private routes: Route[] = [];
  private basePath: string;
  /** Per-request memo of the resolved dynamic agent registry. */
  private dynamicAgentCache = new WeakMap<RequestContext, Promise<Map<string, AgentRegistration>>>();

  /** The runs executing on this node, by conversation. At most one per conversation. */
  private runs = new Map<string, ActiveRun>();
  private bus = new EventBus();
  /** Names this server instance in leases. */
  private nodeId: string;
  private runCfg: Required<Omit<RunsConfig, "nodeId">>;
  /** Bounded in-memory log, used when the storage provider has no durable one. */
  private fallbackEvents?: MemoryEventLog;
  private maintenanceStarted = false;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private lastPrune = 0;
  private sweepWarned = false;
  private closed = false;
  private snapshotWarned = false;
  private sweeping = false;
  private startedAt = Date.now();
  /** Turns files into text for agents; keeps what it read so a file is not converted again for every page. */
  private extractor: TextExtractor;
  private lastFilePurge = 0;

  constructor(config: AgentServerConfig) {
    this.config = config;
    this.basePath = config.basePath.replace(/\/$/, "");
    if (Array.isArray(config.agents)) {
      for (const registration of config.agents) this.addAgent(registration.info.id, registration);
    }
    this.validateBudgets();
    // Token auth that is switched on but has nobody to check tokens would let every request in
    if (config.auth?.enabled && !config.auth.provider) {
      throw new Error(
        "auth.enabled needs auth.provider (an AuthProvider that validates tokens). To name the user some other way, set auth.enabled to false and use auth.resolveUserId or resolveContext."
      );
    }
    const runs = config.runs ?? {};
    const positive = (value: number | undefined, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    this.nodeId = runs.nodeId || `node_${nanoid(10)}`;
    this.runCfg = {
      leaseTtlMs: positive(runs.leaseTtlMs, 60_000),
      cancelGraceMs: positive(runs.cancelGraceMs, 5_000),
      cancelWaitMs: positive(runs.cancelWaitMs, 5_000),
      pingIntervalMs: positive(runs.pingIntervalMs, 15_000),
      followPollMs: positive(runs.followPollMs, 1_000),
      maxStreamMs: positive(runs.maxStreamMs, 3_600_000),
      eventPageSize: positive(runs.eventPageSize, 100),
      maxEventPageSize: positive(runs.maxEventPageSize, 1_000),
      maxEventDataBytes: positive(runs.maxEventDataBytes, 16_384),
      memoryEventLimit: positive(runs.memoryEventLimit, 2_000),
      eventRetentionDays: typeof runs.eventRetentionDays === "number" && runs.eventRetentionDays >= 0 ? runs.eventRetentionDays : 30,
      sweepIntervalMs: typeof runs.sweepIntervalMs === "number" && runs.sweepIntervalMs >= 0 ? runs.sweepIntervalMs : 60_000,
      recoverOnStart: runs.recoverOnStart !== false,
      assumeSingleNode: runs.assumeSingleNode !== false,
    };
    this.extractor = createTextExtractor(
      typeof config.files?.extractCacheBytes === "number" && config.files.extractCacheBytes >= 0
        ? config.files.extractCacheBytes
        : FILES_DEFAULTS.extractCacheBytes
    );
    this.validateStorageLimits();
    this.setupRoutes();
  }

  // ============================================================================
  // Limits that depend on the storage provider
  // ============================================================================

  private get maxPageSize(): number {
    const configured = this.config.limits?.maxPageSize;
    return configured && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_PAGE_SIZE;
  }

  private get messagePageSize(): number {
    const configured = this.config.limits?.messagePageSize;
    return configured && configured > 0 ? Math.floor(configured) : DEFAULT_MESSAGE_PAGE_SIZE;
  }

  /** Largest accepted upload: `limits.maxFileSize`, else 10 MiB capped by what the storage provider can hold. */
  private get maxFileSize(): number {
    const configured = this.config.limits?.maxFileSize;
    if (configured) return configured;
    return Math.min(DEFAULT_MAX_FILE_SIZE, this.config.storage.capabilities?.().maxFileBytes ?? DEFAULT_MAX_FILE_SIZE);
  }

  /** Largest conversation state a pause may store: the tighter of `limits.maxStateBytes` and the provider's own. */
  private get maxStateBytes(): number {
    const provider = this.config.storage.capabilities?.().maxStateBytes ?? Number.MAX_SAFE_INTEGER;
    return Math.min(provider, this.config.limits?.maxStateBytes ?? Number.MAX_SAFE_INTEGER);
  }

  /** A limit the operator set above what the storage provider can hold is a configuration error, found at startup. */
  private validateStorageLimits(): void {
    const capabilities = this.config.storage.capabilities?.();
    if (!capabilities) return;
    const { maxFileSize, maxStateBytes } = this.config.limits ?? {};
    if (maxFileSize && maxFileSize > capabilities.maxFileBytes) {
      throw new Error(
        `limits.maxFileSize (${maxFileSize} bytes) is larger than the ${capabilities.maxFileBytes} bytes this storage provider can hold`
      );
    }
    const filesMaxFileSize = this.config.files?.maxFileSize;
    if (filesMaxFileSize && filesMaxFileSize > capabilities.maxFileBytes) {
      throw new Error(
        `files.maxFileSize (${filesMaxFileSize} bytes) is larger than the ${capabilities.maxFileBytes} bytes this storage provider can hold`
      );
    }
    if (maxStateBytes && maxStateBytes > capabilities.maxStateBytes) {
      throw new Error(
        `limits.maxStateBytes (${maxStateBytes} bytes) is larger than the ${capabilities.maxStateBytes} bytes this storage provider can hold`
      );
    }
  }

  // ============================================================================
  // Approvals, budgets: settings
  // ============================================================================

  /** Registers an agent, refusing a budget that nothing can price. */
  private addAgent(id: string, registration: AgentRegistration): void {
    this.assertBudgetUsable(registration);
    this.agents.set(id, registration);
  }

  private assertBudgetUsable(registration: AgentRegistration): void {
    const budget = registration.budget;
    if (budget) {
      const parsed = parseBudget(budget, `agent "${registration.info.id}" budget`);
      if (!parsed.ok) throw new Error(parsed.message);
      if (!this.pricingFor(registration)) {
        throw new Error(`Agent "${registration.info.id}" has a budget but no pricing: set AgentRegistration.pricing or the server's pricing option`);
      }
    }
  }

  /** Called once the server's own settings are known: a server-wide budget needs server-wide pricing. */
  private validateBudgets(): void {
    if (this.config.budget) {
      const parsed = parseBudget(this.config.budget, "budget");
      if (!parsed.ok) throw new Error(parsed.message);
      if (!this.config.pricing) {
        throw new Error("The server has a budget but no pricing: set the pricing option (model name -> price per token)");
      }
    }
  }

  /** The approval settings of one agent: the agent's own, else the server's, else the defaults. */
  private hitlFor(agent?: Pick<AgentRegistration, "hitl">): { timeoutMinutes: number; onTimeout: "deny" | "cancel"; validateApprovedArgs: boolean } {
    const server = this.config.hitl ?? {};
    const own = agent?.hitl ?? {};
    const minutes = own.timeoutMinutes ?? server.timeoutMinutes;
    return {
      timeoutMinutes: typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? minutes : 1440,
      onTimeout: (own.onTimeout ?? server.onTimeout) === "cancel" ? "cancel" : "deny",
      validateApprovedArgs: (own.validateApprovedArgs ?? server.validateApprovedArgs) !== false,
    };
  }

  private get resolveWaitMs(): number {
    const wait = this.config.hitl?.resolveWaitMs;
    return typeof wait === "number" && Number.isFinite(wait) && wait >= 0 ? wait : 3000;
  }

  private pricingFor(agent?: Pick<AgentRegistration, "pricing">): PricingFn | undefined {
    return agent?.pricing ?? this.config.pricing;
  }

  /** The spend limit new conversations with this agent start with. */
  private agentBudget(agent?: Pick<AgentRegistration, "budget">): SessionBudget | null {
    const configured = agent?.budget !== undefined ? agent.budget : this.config.budget ?? null;
    if (!configured) return null;
    const parsed = parseBudget(configured);
    return parsed.ok ? parsed.budget : null;
  }

  /** The conversation's budget in effect: its own (`null`: removed), else its agent's default. */
  private effectiveBudget(conversation: Pick<Conversation, "state">, agent?: Pick<AgentRegistration, "budget">): SessionBudget | null {
    const stored = readBudget(conversation.state);
    if (stored && stored.budget !== undefined) {
      if (stored.budget === null) return null;
      const parsed = parseBudget(stored.budget);
      return parsed.ok ? parsed.budget : null;
    }
    return this.agentBudget(agent);
  }

  private spentOf(conversation: Pick<Conversation, "state">): number {
    const spent = readBudget(conversation.state)?.spentUsd;
    return typeof spent === "number" && Number.isFinite(spent) && spent > 0 ? spent : 0;
  }

  private budgetReachedError(spentUsd: number, budget: SessionBudget) {
    return {
      statusCode: 402,
      code: "budget_reached",
      message: `The budget of this conversation is used up ($${spentUsd.toFixed(4)} of $${budget.maxCostUsd}). Raise it to carry on.`,
      details: { spentUsd, maxCostUsd: budget.maxCostUsd, onReach: budget.onReach },
    };
  }

  /**
   * What a turn that starts now needs to know about money: the prices, the conversation's budget and what it has
   * spent, and the cap to give agent-sdk so it stops in the middle of the turn. Throws 402 `budget_reached` when
   * nothing is left: the model is not called. `carried` is the usage ledger of the state a resumed turn carries on from
   * (its cost counts against agent-sdk's own cap, but is already in `spentUsd`).
   */
  private planTurnBudget(conversation: Pick<Conversation, "state">, agent: AgentRegistration, carried?: unknown): TurnBudget {
    const pricing = this.pricingFor(agent);
    const budget = this.effectiveBudget(conversation, agent);
    const spentBefore = this.spentOf(conversation);
    if (!budget) return { pricing, budget: null, spentBefore };
    if (!pricing) {
      throw {
        statusCode: 500,
        code: "budget_misconfigured",
        message: `Agent "${agent.info.id}" has a budget but no pricing, so it cannot be enforced`,
      };
    }
    const remaining = roundUsd(budget.maxCostUsd - spentBefore);
    if (remaining <= 0) throw this.budgetReachedError(spentBefore, budget);
    const own = (agent.sdkAgent as { __runtime?: { limits?: { maxCostUsd?: unknown } } } | undefined)?.__runtime?.limits?.maxCostUsd;
    const perTurn = typeof own === "number" && own > 0 ? own : undefined;
    // agent-sdk compares the cost of the whole ledger of the state it runs on with the cap
    const sessionCap = remaining + ledgerCostUsd(carried, pricing);
    const sessionBinds = perTurn === undefined || sessionCap <= perTurn;
    return { pricing, budget, spentBefore, limit: { maxCostUsd: sessionBinds ? sessionCap : perTurn!, sessionBinds } };
  }

  // ============================================================================
  // Files: settings and who may see what
  // ============================================================================

  /** The attachment settings of one agent (or of the server, for an upload that names no conversation). */
  private filesConfigFor(agent?: Pick<AgentRegistration, "files">): ResolvedFilesConfig {
    return resolveFilesConfig(this.config.files, agent?.files, {
      defaultMaxFileSize: this.maxFileSize,
      providerMaxFileBytes: this.config.storage.capabilities?.().maxFileBytes ?? Number.MAX_SAFE_INTEGER,
    });
  }

  /**
   * The largest upload any agent of this server accepts, in bytes: what an HTTP adapter has to let through
   * (`files.maxFileSize` of an agent registered after this call is not known yet).
   */
  maxUploadBytes(): number {
    let largest = this.filesConfigFor(undefined).maxFileSize;
    for (const registration of this.agents.values()) largest = Math.max(largest, this.filesConfigFor(registration).maxFileSize);
    return largest;
  }

  /**
   * The file listing / expiry queries the built-in providers have; a custom provider may not. A provider that
   * reports its capabilities has to say `fileIndex: true` (a `BaseStorageProvider` subclass always has the
   * methods, and only the hooks make them work); one that reports none is judged by the methods it has.
   */
  private get filesIndexed(): boolean {
    const provider = this.config.storage;
    if (typeof provider.listFiles !== "function" || typeof provider.purgeExpiredFiles !== "function") return false;
    const capabilities = provider.capabilities?.();
    return capabilities === undefined ? true : capabilities.fileIndex === true;
  }

  /** The names of the tools an agent-sdk agent was built with; undefined when the instance does not say. */
  private sdkToolNames(agent: AgentRegistration): Set<string> | undefined {
    const tools = (agent.sdkAgent as { __runtime?: { tools?: Array<{ name?: unknown }> } } | undefined)?.__runtime?.tools;
    if (!Array.isArray(tools)) return undefined;
    return new Set(tools.map((tool) => tool?.name).filter((name): name is string => typeof name === "string"));
  }

  /** Whether the agent can read a document in pages (it has `session_files_read`, or does not say what it has). */
  private agentCanPage(agent: AgentRegistration): boolean {
    if (!agent.sdkAgent) return false;
    const names = this.sdkToolNames(agent);
    return names ? names.has(SESSION_FILES_READ_TOOL) : true;
  }

  /** Whether notes may send the model to `session_files_view_image`: the tool is there and the model's calls resolve images. */
  private agentCanViewImages(agent: AgentRegistration, cfg: ResolvedFilesConfig): boolean {
    if (!agent.sdkAgent || !cfg.vision) return false;
    const names = this.sdkToolNames(agent);
    const model = (agent.sdkAgent as { __runtime?: { model?: unknown } }).__runtime?.model;
    return !!names?.has(SESSION_FILES_VIEW_IMAGE_TOOL) && isSessionImageModel(model);
  }

  /** `AgentInfo` as the API shows it: `capabilities.attachments` from the files settings (what the host set wins). */
  private publicInfo(registration: AgentRegistration): AgentInfo {
    const cfg = this.filesConfigFor(registration);
    const own = registration.info.capabilities?.attachments ?? {};
    const set = Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined));
    const attachments = { ...attachmentsCapability(cfg), ...set };
    // The keys the first chat-ui read from `metadata`; whatever the host put there wins
    const legacy: Record<string, unknown> = {
      enableFileUpload: attachments.enabled,
      maxFileSize: attachments.maxFileSize,
      maxFiles: attachments.maxFiles,
      ...(attachments.allowedMimeTypes?.length ? { allowedFileTypes: attachments.allowedMimeTypes } : {}),
      acceptsImages: attachments.acceptsImages,
    };
    return {
      ...registration.info,
      capabilities: { ...registration.info.capabilities, attachments },
      metadata: { ...legacy, ...registration.info.metadata },
    };
  }

  /** The current caller is `ownerId` (same rule as for conversations: strict with `resolveContext`, lenient when no identity is known). */
  private async isOwner(ownerId: string, ctx: RouteContext): Promise<boolean> {
    const current = ctx.user?.id || (await this.resolveUserId(ctx));
    return this.config.resolveContext ? current === ownerId : !current || current === ownerId;
  }

  /**
   * Whether the caller may see a file: its uploader, in a conversation they may open. A file nobody uploaded
   * (stored by the host without an identity) follows its conversation; one with neither is only reachable
   * when the server does not enforce identities. The routes answer 404 for a file that fails this.
   */
  private async fileVisible(file: FileRecord, ctx: RouteContext, known?: Conversation): Promise<boolean> {
    if (file.userId !== undefined && !(await this.isOwner(file.userId, ctx))) return false;
    if (file.conversationId) {
      const conversation =
        known?.id === file.conversationId ? known : await this.config.storage.getConversation(file.conversationId, ctx.context);
      if (!conversation) return false;
      try {
        await this.verifyConversationAccess(conversation, ctx);
      } catch {
        return false;
      }
      return true;
    }
    return file.userId !== undefined || !this.config.resolveContext;
  }

  private fileNotFound(id: string): NotFoundError {
    return { statusCode: 404, code: "NOT_FOUND", message: `File not found: ${id}` } as unknown as NotFoundError;
  }

  /**
   * The whole conversation, oldest first, for the agent. Read in pages: a storage
   * provider answers at most one page per call (100 by default), and an agent
   * that only saw the first page would never see the newest messages.
   */
  private async loadHistory(conversationId: string, rc?: RequestContext): Promise<Message[]> {
    const history: Message[] = [];
    const pageSize = this.maxPageSize;
    for (let offset = 0; ; ) {
      const page = await this.config.storage.getMessages(conversationId, { order: "asc", limit: pageSize, offset }, rc);
      history.push(...page.data);
      offset += page.data.length;
      // `total` guards a custom store that ignores `offset` (and would otherwise answer page one forever)
      if (!page.hasMore || page.data.length === 0 || history.length >= page.total) return history;
    }
  }

  // ============================================================================
  // User ID Resolution
  // ============================================================================

  /**
   * Resolve userId from context using:
   * 1. ctx.user (from token auth)
   * 2. resolveUserId callback (custom resolver)
   */
  private async resolveUserId(ctx: RouteContext): Promise<string | undefined> {
    // Try token-based user first
    if (ctx.user?.id) {
      return ctx.user.id;
    }

    // Try custom resolver from config
    if (this.config.auth?.resolveUserId) {
      return await this.config.auth.resolveUserId({
        headers: ctx.headers,
        query: ctx.query,
        body: ctx.body,
        context: ctx.context,
      });
    }

    return undefined;
  }

  /**
   * Owner to stamp on / filter by. An identity the server established is authoritative and a client-supplied id is
   * ignored (otherwise any caller could list or create data as someone else by passing `userId`):
   *   1. with `resolveContext`: the resolved `context.user`
   *   2. otherwise the token user, then `auth.resolveUserId`
   *   3. only when the request carries no identity at all (an open demo server) the id the client named
   */
  private async effectiveUserId(ctx: RouteContext, requested?: string): Promise<string | undefined> {
    if (this.config.resolveContext) return ctx.context?.user?.id;
    const known = ctx.user?.id || (await this.resolveUserId(ctx));
    if (known) return known;
    return typeof requested === "string" && requested ? requested : undefined;
  }

  /**
   * Whose records a list request may return. A request with no resolved user would list the data of EVERYONE, so it is
   * refused (401 `identity_required`) unless the host said the server is single-user by design (`allowAnonymousList`).
   */
  private async listOwner(ctx: RouteContext, requested?: string): Promise<string | undefined> {
    const userId = (await this.effectiveUserId(ctx, requested)) || undefined;
    if (userId === undefined && !this.config.allowAnonymousList) {
      throw {
        statusCode: 401,
        code: "identity_required",
        message:
          "Listing needs to know who is asking: sign in. (Operators: resolve a user for the request, or set allowAnonymousList on a single-user server.)",
      };
    }
    return userId;
  }

  /**
   * Verify that the current user has access to the conversation
   */
  private async verifyConversationAccess(
    conversation: Conversation,
    ctx: RouteContext
  ): Promise<void> {
    // Trusted-identity mode is fail-closed: a conversation that carries no owner
    // would otherwise be open to every authenticated caller of the mount.
    if (this.config.resolveContext && !conversation.userId) {
      throw {
        statusCode: 403,
        code: "FORBIDDEN",
        message: "You do not have access to this conversation",
      };
    }
    // If conversation has a userId, verify the current user matches
    if (conversation.userId) {
      const currentUserId = ctx.user?.id || await this.resolveUserId(ctx);
      // Trusted-identity mode: an anonymous caller never owns an owned conversation.
      const mismatch = this.config.resolveContext
        ? currentUserId !== conversation.userId
        : !!currentUserId && conversation.userId !== currentUserId;
      if (mismatch) {
        throw {
          statusCode: 403,
          code: "FORBIDDEN",
          message: "You do not have access to this conversation",
        };
      }
    }
  }

  private async verifyTaskAccess(task: Task, ctx: RouteContext): Promise<void> {
    if (!task.userId) {
      if (this.config.resolveContext) {
        throw { statusCode: 403, code: "FORBIDDEN", message: "You do not have access to this task" };
      }
      return;
    }
    const currentUserId = ctx.user?.id || await this.resolveUserId(ctx);
    const mismatch = this.config.resolveContext
      ? currentUserId !== task.userId
      : !!currentUserId && task.userId !== currentUserId;
    if (mismatch) {
      throw {
        statusCode: 403,
        code: "FORBIDDEN",
        message: "You do not have access to this task",
      };
    }
  }

  /**
   * Auto-generate a short conversation title from the first user message
   * using the configured OpenAI-compatible provider. Returns undefined if
   * titleGeneration is not configured or the call fails.
   */
  private async generateTitle(userMessage: string, signal?: AbortSignal): Promise<string | undefined> {
    const cfg = this.config.titleGeneration;
    if (!cfg) return undefined;
    // The call is bounded: it gives up after `timeoutMs` and when the run is cancelled (the turn holds the conversation while it waits)
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : 10_000);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const path = cfg.path ?? "/v1/chat/completions";
      const prompt =
        `Generate a conversation title for the following message using a maximum of 3-4 words. ` +
        `The title must be in the same language as the message. ` +
        `Return only the exact title — no quotes, no extra text.\n\n${userMessage}`;
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.5,
          max_tokens: 20,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) return undefined;
      // Strip surrounding quotes if the model wraps the title
      return raw.replace(/^["""''']|["""''']$/g, "").trim() || undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  // ============================================================================
  // Agent Registration
  // ============================================================================

  /**
   * Register an agent-sdk agent
   */
  registerSDKAgent(
    id: string,
    agent: unknown,
    info?: Partial<Omit<AgentInfo, "id">>,
    options?: AgentRegistrationOptions
  ): void {
    // Extract info from agent if possible
    const agentAny = agent as {
      __runtime?: {
        name?: string;
        version?: string;
        tools?: Array<{ needsApproval?: unknown }>;
        humanInTheLoop?: { askUser?: unknown };
      };
    };
    const name =
      info?.name || agentAny.__runtime?.name || id;
    const version = info?.version || agentAny.__runtime?.version;

    // Derive what the agent can pause for, when the instance tells us cheaply.
    let capabilities: AgentCapabilities | undefined = info?.capabilities;
    if (!capabilities && supportsSdkPause(agent)) {
      const runtime = agentAny.__runtime;
      const toolApproval = Array.isArray(runtime?.tools) && runtime!.tools!.some((t) => !!t?.needsApproval);
      const askUser = !!runtime?.humanInTheLoop?.askUser;
      if (toolApproval || askUser) {
        capabilities = { ...(toolApproval && { toolApproval }), ...(askUser && { askUser }) };
      }
    }

    this.addAgent(id, {
      info: {
        id,
        name,
        version,
        description: info?.description,
        metadata: info?.metadata,
        ...(capabilities && { capabilities }),
      },
      sdkAgent: agent,
      ...registrationExtras(options),
    });
  }

  /**
   * Register a custom agent handler
   */
  registerCustomAgent(
    id: string,
    handler: AgentRegistration["handler"],
    info: Omit<AgentInfo, "id">,
    options?: AgentRegistrationOptions
  ): void {
    this.addAgent(id, {
      info: { id, ...info },
      handler,
      ...registrationExtras(options),
    });
  }

  /**
   * Register a host-backed agent: an agent whose work runs in the host's own backend. `invoke` gets the message and
   * `{ emit, signal, files }`: it reports progress with typed events (text, tool use / result, usage) and returns a
   * typed result (`content`, `status`, `stopReason`, `pendingActions`, `usage`). The server stores the messages, the
   * pending actions, the events and the runtime status itself - the host fakes no agent state and writes none of the
   * server's. `resolveAction` continues a turn that paused; `cancel` hears about runs and open requests the server lets
   * go of. Hosts that resolve their agents per request return `hostAgentRegistration(definition)` from `config.agents`.
   *
   * @example
   * ```ts
   * server.registerHostAgent({
   *   info: { id: 'support', name: 'Support' },
   *   async invoke({ message }, { emit, signal }) {
   *     for await (const chunk of backend.stream(message, { signal })) emit({ type: 'text', text: chunk });
   *     return { content: '' };
   *   },
   * });
   * ```
   */
  registerHostAgent(definition: HostAgentDefinition): void {
    const registration = hostAgentRegistration(definition);
    this.addAgent(registration.info.id, registration);
  }

  /**
   * Register a Chat Completions API agent.
   * Works with any OpenAI-compatible endpoint (OpenAI, Azure, etc.)
   *
   * @example
   * ```ts
   * server.registerChatCompletionsAgent('my-gpt', {
   *   baseUrl: 'https://api.openai.com',
   *   apiKey: process.env.OPENAI_API_KEY!,
   *   model: 'gpt-4o',
   *   systemPrompt: 'You are a helpful assistant.',
   * }, {
   *   name: 'GPT-4o Agent',
   *   description: 'OpenAI GPT-4o powered agent',
   * });
   * ```
   */
  registerChatCompletionsAgent(
    id: string,
    config: ChatCompletionsConfig,
    info: Omit<AgentInfo, "id">,
    options?: AgentRegistrationOptions
  ): void {
    this.addAgent(id, {
      info: { id, ...info },
      chatCompletions: config,
      ...registrationExtras(options),
    });
  }

  /**
   * Register an OpenAI Responses API agent.
   * Works with the new OpenAI Responses API endpoint.
   *
   * @example
   * ```ts
   * server.registerResponsesAgent('my-responses', {
   *   baseUrl: 'https://api.openai.com',
   *   apiKey: process.env.OPENAI_API_KEY!,
   *   model: 'gpt-4o',
   *   instructions: 'You are a helpful assistant.',
   *   tools: [{ type: 'web_search_preview' }],
   * }, {
   *   name: 'GPT-4o Responses Agent',
   *   description: 'OpenAI Responses API powered agent with web search',
   * });
   * ```
   */
  registerResponsesAgent(
    id: string,
    config: ResponsesApiConfig,
    info: Omit<AgentInfo, "id">,
    options?: AgentRegistrationOptions
  ): void {
    this.addAgent(id, {
      info: { id, ...info },
      responsesApi: config,
      ...registrationExtras(options),
    });
  }

  /**
   * Get all statically registered agents (does not include dynamic agents -
   * use `getAgentsFor` for the per-request list)
   */
  getAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map((reg) => this.publicInfo(reg));
  }

  /**
   * Get a statically registered agent by ID
   */
  getAgent(id: string): AgentRegistration | undefined {
    return this.agents.get(id);
  }

  /**
   * Agent registry for one request: static registrations plus the result of
   * `config.agents(ctx)` when that is a function (dynamic ids win). Memoised per
   * context object so list/create/send in one request resolve it once.
   */
  private resolveRegistry(rc: RequestContext): Promise<Map<string, AgentRegistration>> {
    const source = this.config.agents;
    if (typeof source !== "function") return Promise.resolve(this.agents);
    let pending = this.dynamicAgentCache.get(rc);
    if (!pending) {
      pending = Promise.resolve(source(rc)).then((dynamic) => {
        const merged = new Map(this.agents);
        for (const registration of dynamic ?? []) merged.set(registration.info.id, registration);
        return merged;
      });
      this.dynamicAgentCache.set(rc, pending);
      // A failed resolution must not poison later calls with the same context.
      pending.catch(() => this.dynamicAgentCache.delete(rc));
    }
    return pending;
  }

  /** Agents visible to a request context (static + dynamic). */
  async getAgentsFor(rc: RequestContext = { data: {} }): Promise<AgentInfo[]> {
    return Array.from((await this.resolveRegistry(rc)).values()).map((reg) => this.publicInfo(reg));
  }

  /** Look an agent up for a request context (static + dynamic). */
  async getAgentFor(id: string, rc: RequestContext = { data: {} }): Promise<AgentRegistration | undefined> {
    return (await this.resolveRegistry(rc)).get(id);
  }

  // ============================================================================
  // Route Setup
  // ============================================================================

  private setupRoutes(): void {
    // Swagger routes
    if (this.config.swagger?.enabled) {
      const docsPath = this.config.swagger.path || "/docs";

      this.addRoute("GET", docsPath, async () => ({
        status: 200,
        body: generateSwaggerHTML(
          `${this.basePath}${docsPath}/openapi.json`,
          this.config.swagger?.title || "Agent Server API"
        ),
        headers: { "Content-Type": "text/html" },
      }), true);

      this.addRoute("GET", `${docsPath}/openapi.json`, async () => ({
        status: 200,
        body: generateOpenAPISpec(this.config, this.getAgents()),
        headers: { "Content-Type": "application/json" },
      }), true);
    }

    // Agent routes
    this.addRoute("GET", "/agents", this.handleListAgents.bind(this));
    this.addRoute("GET", "/agents/:agentId", this.handleGetAgent.bind(this));

    // Conversation routes
    this.addRoute("GET", "/conversations", this.handleListConversations.bind(this));
    this.addRoute("POST", "/conversations", this.handleCreateConversation.bind(this));
    this.addRoute(
      "GET",
      "/conversations/:conversationId",
      this.handleGetConversation.bind(this)
    );
    this.addRoute(
      "PATCH",
      "/conversations/:conversationId",
      this.handleUpdateConversation.bind(this)
    );
    this.addRoute(
      "DELETE",
      "/conversations/:conversationId",
      this.handleDeleteConversation.bind(this)
    );

    // Message routes
    this.addRoute(
      "GET",
      "/conversations/:conversationId/messages",
      this.handleListMessages.bind(this)
    );
    this.addRoute(
      "POST",
      "/conversations/:conversationId/messages",
      this.handleSendMessage.bind(this)
    );

    // Human-in-the-loop: answer a pending action (tool approval / question)
    this.addRoute(
      "POST",
      "/conversations/:conversationId/actions/:actionId",
      this.handleResolveAction.bind(this)
    );

    // Carry a turn the budget stopped on, and what was approved "for the session"
    this.addRoute("POST", "/conversations/:conversationId/continue", this.handleContinue.bind(this));
    this.addRoute("GET", "/conversations/:conversationId/remembered-tools", this.handleListRememberedTools.bind(this));
    this.addRoute("DELETE", "/conversations/:conversationId/remembered-tools/:tool*", this.handleRevokeRememberedTool.bind(this));

    // Runs: stop a turn, read and follow what happened in a conversation
    this.addRoute("POST", "/conversations/:conversationId/cancel", this.handleCancel.bind(this));
    this.addRoute("GET", "/conversations/:conversationId/events", this.handleListEvents.bind(this));
    this.addRoute("GET", "/conversations/:conversationId/events/stream", this.handleEventsStream.bind(this));

    // File routes
    this.addRoute("GET", "/conversations/:conversationId/files", this.handleListFiles.bind(this));
    this.addRoute("POST", "/files", this.handleUploadFile.bind(this));
    this.addRoute("GET", "/files/:fileId", this.handleGetFile.bind(this));
    this.addRoute("DELETE", "/files/:fileId", this.handleDeleteFile.bind(this));
    this.addRoute(
      "GET",
      "/files/:fileId/content",
      this.handleDownloadFile.bind(this)
    );

    // Task routes
    this.addRoute("POST", "/tasks", this.handleCreateTask.bind(this));
    this.addRoute("GET", "/tasks", this.handleListTasks.bind(this));
    this.addRoute("GET", "/tasks/:taskId", this.handleGetTask.bind(this));
    this.addRoute("GET", "/tasks/:taskId/status", this.handleGetTaskStatus.bind(this));
    this.addRoute("GET", "/tasks/:taskId/result", this.handleGetTaskResult.bind(this));
    this.addRoute("POST", "/tasks/:taskId/cancel", this.handleCancelTask.bind(this));
    this.addRoute("POST", "/tasks/:taskId/comments", this.handleAddTaskComment.bind(this));
    this.addRoute("GET", "/tasks/:taskId/comments", this.handleGetTaskComments.bind(this));
  }

  private addRoute(
    method: Route["method"],
    path: string,
    handler: RouteHandler,
    isPublic = false
  ): void {
    const paramNames: string[] = [];
    // `:name` is one path segment; `:name*` takes the rest of the path (a name that may itself hold a slash)
    const patternStr = path.replace(/:([^/]+)/g, (_, name: string) => {
      const rest = name.endsWith("*");
      paramNames.push(rest ? name.slice(0, -1) : name);
      return rest ? "(.+)" : "([^/]+)";
    });
    const pattern = new RegExp(`^${patternStr}$`);

    this.routes.push({ method, path, pattern, paramNames, handler, public: isPublic });
  }

  // ============================================================================
  // Request Handling
  // ============================================================================

  /**
   * Handle an incoming request. `path` may include the server base path, which
   * is stripped before routing.
   */
  async handleRequest(
    method: string,
    path: string,
    ctx: RouteRequest
  ): Promise<RouteResult> {
    // Remove base path prefix
    let routePath = path;
    if (path.startsWith(this.basePath)) {
      routePath = path.slice(this.basePath.length) || "/";
    }
    return this.dispatch(method, routePath, path, ctx);
  }

  /**
   * Handle a request whose path is already relative to the server (no base path
   * to strip). Used by adapters that mount under a dynamic prefix.
   */
  async handleRoute(
    method: string,
    routePath: string,
    ctx: RouteRequest
  ): Promise<RouteResult> {
    return this.dispatch(method, routePath || "/", routePath || "/", ctx);
  }

  private async dispatch(
    method: string,
    routePath: string,
    displayPath: string,
    ctx: RouteRequest
  ): Promise<RouteResult> {
    // Find matching route
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;

      const match = routePath.match(route.pattern);
      if (!match) continue;

      // Extract params
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });

      try {
        this.ensureMaintenance();
        const routeCtx = await this.buildRouteContext(method, routePath, route, ctx, params);
        const rc = routeCtx.context!;
        const result = await runWithRequestContext(rc, () => route.handler(routeCtx));
        if (result.stream) result.stream = bindStreamToContext(result.stream, rc);
        return result;
      } catch (error) {
        return this.handleError(error);
      }
    }

    // No route found
    return {
      status: 404,
      body: {
        error: {
          code: "NOT_FOUND",
          message: `Route not found: ${method} ${displayPath}`,
        },
      },
    };
  }

  /**
   * Resolve the request context: a pre-resolved one wins, then
   * `config.resolveContext` (null -> 401), then a context derived from the
   * token-auth user.
   */
  private async buildRouteContext(
    method: string,
    routePath: string,
    route: Route,
    ctx: RouteRequest,
    params: Record<string, string>
  ): Promise<RouteContext> {
    let rc: RequestContext | undefined = ctx.context;

    if (!rc && this.config.resolveContext && !route.public) {
      const headers = normalizeHeaders(ctx.headers);
      const request: ContextRequest = {
        method: method.toUpperCase(),
        path: routePath,
        url: ctx.url,
        headers,
        cookies: parseCookies(headers.cookie),
        query: ctx.query,
        body: ctx.body,
        user: ctx.user,
        mountParams: ctx.mountParams ?? {},
        raw: ctx.raw,
      };
      const resolved = await this.config.resolveContext(request);
      if (!resolved) {
        throw {
          statusCode: 401,
          code: "AUTHENTICATION_ERROR",
          message: "Authentication required",
        };
      }
      rc = { ...resolved, data: resolved.data ?? {} };
    }

    if (!rc) rc = { user: ctx.user, data: {} };
    return { ...ctx, params, user: rc.user ?? ctx.user, context: rc };
  }

  /**
   * Whether an error's message may reach the client. Without `maskServerErrors`
   * everything does (backwards compatible). With it, only errors the host wrote
   * for the caller do: an explicit 4xx `statusCode`, or `expose: true` (the
   * `http-errors` convention, for deliberate 5xx such as "assistant unavailable").
   * Anything else (driver errors, bugs) is replaced by a generic message and only logged.
   */
  private isExposedError(err: { statusCode?: number; expose?: boolean } | null | undefined): boolean {
    if (!this.config.maskServerErrors) return true;
    if (err?.expose === true) return true;
    const status = err?.statusCode;
    return typeof status === "number" && status >= 400 && status < 500;
  }

  private handleError(error: unknown): RouteResult {
    const err = error as {
      statusCode?: number;
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    } | null;

    // Errors are thrown both as Error instances and as plain
    // `{ statusCode, code, message }` objects; treat both as HTTP errors.
    if (err && typeof err === "object" && (error instanceof Error || typeof err.statusCode === "number")) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error("[AgentServer] Error:", error);
      const exposed = this.isExposedError(err);
      return {
        status,
        body: {
          error: {
            code: exposed ? err.code || "INTERNAL_ERROR" : "INTERNAL_ERROR",
            message: exposed
              ? err.message || "An unexpected error occurred"
              : "An unexpected error occurred",
            details: exposed ? err.details : undefined,
          },
        },
      };
    }

    console.error("[AgentServer] Error:", error);
    return {
      status: 500,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      },
    };
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  async authenticate(token: string | undefined): Promise<AuthUser | null> {
    if (!this.config.auth?.enabled) {
      return null;
    }

    if (!this.config.auth.provider) {
      return null;
    }

    if (!token) {
      throw {
        statusCode: 401,
        code: "AUTHENTICATION_ERROR",
        message: "Authentication required",
      } as AuthenticationError;
    }

    // Remove token prefix if present
    const prefix = this.config.auth.tokenPrefix || "Bearer ";
    const cleanToken = token.startsWith(prefix) ? token.slice(prefix.length) : token;

    const result = await this.config.auth.provider.validateToken(cleanToken);

    if (!result.valid) {
      throw {
        statusCode: 401,
        code: "AUTHENTICATION_ERROR",
        message: result.error || "Invalid token",
      } as AuthenticationError;
    }

    return {
      id: result.userId!,
      metadata: result.metadata,
    };
  }

  // ============================================================================
  // Route Handlers
  // ============================================================================

  private async handleListAgents(ctx: RouteContext): Promise<RouteResult<ListAgentsResponse>> {
    return {
      status: 200,
      body: { agents: await this.getAgentsFor(ctx.context) },
    };
  }

  private async handleGetAgent(ctx: RouteContext): Promise<RouteResult> {
    const { agentId } = ctx.params;
    const agent = await this.getAgentFor(agentId, ctx.context);

    if (!agent) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Agent not found: ${agentId}`,
      } as NotFoundError;
    }

    return {
      status: 200,
      body: this.publicInfo(agent),
    };
  }

  private async handleListConversations(
    ctx: RouteContext
  ): Promise<RouteResult<ListConversationsResponse>> {
    const agentId = ctx.query.agentId as string | undefined;
    const userId = ctx.query.userId as string | undefined;
    const { limit, offset } = parsePaging(ctx.query, 20, this.maxPageSize);

    // Resolve userId: from query param, ctx.user (token), or resolveUserId callback
    const resolvedUserId = await this.listOwner(ctx, userId);
    const registry = await this.resolveRegistry(ctx.context!);

    // Newest created first by default; `orderBy=updatedAt` lists by last activity, `order=asc` reverses
    const orderBy = ctx.query.orderBy === "updatedAt" ? "updatedAt" : "createdAt";
    const order = ctx.query.order === "asc" ? "asc" : "desc";

    const result = await this.config.storage.getConversations({
      agentId,
      userId: resolvedUserId,
      limit,
      offset,
      orderBy,
      order,
    }, ctx.context);

    const runtimes = await this.runtimesFor(result.data, ctx.context);

    return {
      status: 200,
      body: {
        conversations: result.data.map((conv) => ({
          ...this.publicConversation(conv, runtimes.get(conv.id), registry.get(conv.agentId)),
          agentName: registry.get(conv.agentId)?.info.name,
        })),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    };
  }

  private async handleCreateConversation(
    ctx: RouteContext
  ): Promise<RouteResult<CreateConversationResponse>> {
    const body = ctx.body as CreateConversationRequest;

    if (!body?.agentId) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "agentId is required",
      } as ValidationError;
    }

    // Check if agent exists
    const agent = await this.getAgentFor(body.agentId, ctx.context);
    if (!agent) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Agent not found: ${body.agentId}`,
      } as NotFoundError;
    }

    // Resolve userId: from body, ctx.user (token), or resolveUserId callback
    const userId = await this.effectiveUserId(ctx, body.userId);

    // A budget of its own: lower than the agent's default is the caller's to ask for, higher needs `authorizeBudget`
    let state: Record<string, unknown> | undefined;
    if (body.budget !== undefined) {
      const requested = this.parseBudgetRequest(body.budget, agent);
      await this.checkBudgetChange(ctx, { current: this.agentBudget(agent), requested, spentUsd: 0 });
      state = writeBudget(undefined, { budget: requested });
    }

    const conversation = await this.config.storage.createConversation({
      agentId: body.agentId,
      userId,
      title: body.title,
      metadata: this.clientMetadata(body.metadata),
      ...(state && { state }),
    }, ctx.context);

    return {
      status: 201,
      body: { conversation: this.publicConversation(conversation, undefined, agent) },
    };
  }

  /**
   * A budget as a request spells it: 400 `invalid_budget` when it is not one, 400 `budget_unavailable` when the
   * agent cannot price its calls (a budget nothing can count against is refused, never ignored). `null` removes it.
   */
  private parseBudgetRequest(value: unknown, agent: AgentRegistration | undefined): SessionBudget | null {
    if (value === null) return null;
    const parsed = parseBudget(value);
    if (!parsed.ok) throw { statusCode: 400, code: "invalid_budget", message: parsed.message };
    if (!this.pricingFor(agent)) {
      throw {
        statusCode: 400,
        code: "budget_unavailable",
        message: "This agent has no pricing, so its cost cannot be counted and a budget cannot be enforced",
      };
    }
    return parsed.budget;
  }

  /** Lowering a budget is the conversation owner's to do; raising or removing one needs `authorizeBudget` (403 `budget_forbidden`). */
  private async checkBudgetChange(ctx: RouteContext, change: BudgetChange): Promise<void> {
    if (budgetChangeKind(change.current, change.requested) !== "raise") return;
    const allowed = this.config.authorizeBudget ? await this.config.authorizeBudget(ctx.context!, change) : false;
    if (!allowed) {
      throw {
        statusCode: 403,
        code: "budget_forbidden",
        message: "A budget can be lowered by the conversation's owner; raising or removing it is not allowed",
      };
    }
  }

  private async handleGetConversation(
    ctx: RouteContext
  ): Promise<RouteResult<GetConversationResponse>> {
    const { conversationId } = ctx.params;

    const conversation = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!conversation) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Conversation not found: ${conversationId}`,
      } as NotFoundError;
    }

    // Verify user has access to this conversation
    await this.verifyConversationAccess(conversation, ctx);

    const { messages, page } = await this.loadMessagesPage(conversationId, ctx);
    const pendingActions = readHitl(conversation.state)?.pending?.actions;
    const runtime = (await this.runtimesFor([conversation], ctx.context)).get(conversation.id);
    const agent = await this.getAgentFor(conversation.agentId, ctx.context);

    return {
      status: 200,
      body: {
        conversation: this.publicConversation(conversation, runtime, agent),
        messages: messages.map(publicMessage),
        messagesPage: page,
        ...(pendingActions?.length && { pendingActions }),
      },
    };
  }

  /**
   * One page of a conversation's history for `GET /conversations/:id`: `limit` messages
   * (default `limits.messagePageSize`), the NEWEST ones unless `before=<messageId>` (the ones
   * just older than it) or `after=<messageId>` (just newer) say otherwise, always returned in
   * `order` (`asc` default). Page backwards with `before=<first message id>`.
   */
  private async loadMessagesPage(
    conversationId: string,
    ctx: RouteContext
  ): Promise<{ messages: Message[]; page: MessagesPage }> {
    const { limit } = parsePaging(ctx.query, this.messagePageSize, this.maxPageSize);
    const order: MessagesPage["order"] = ctx.query.order === "desc" ? "desc" : "asc";
    const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;
    const before = one(ctx.query.before);
    const after = one(ctx.query.after);
    if (before && after) {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message: "Use either before or after, not both" } as ValidationError;
    }

    const cursor = before ?? after;
    if (cursor) {
      const anchor = await this.config.storage.getMessage(cursor, ctx.context);
      if (!anchor || anchor.conversationId !== conversationId) {
        throw { statusCode: 404, code: "NOT_FOUND", message: `Message not found: ${cursor}` } as NotFoundError;
      }
    }

    let chronological: Message[];
    let hasMoreBefore: boolean;
    let hasMoreAfter: boolean;
    if (after) {
      const result = await this.config.storage.getMessages(conversationId, { after, order: "asc", limit }, ctx.context);
      chronological = result.data;
      hasMoreBefore = true; // the anchor itself
      hasMoreAfter = result.hasMore;
    } else {
      // Newest first so that `limit` takes the ones nearest the end (or the cursor), then back to chronological
      const result = await this.config.storage.getMessages(conversationId, { before, order: "desc", limit }, ctx.context);
      chronological = [...result.data].reverse();
      hasMoreBefore = result.hasMore;
      hasMoreAfter = Boolean(before);
    }

    return {
      messages: order === "asc" ? chronological : [...chronological].reverse(),
      page: { limit, order, hasMoreBefore, hasMoreAfter },
    };
  }

  private async handleUpdateConversation(
    ctx: RouteContext
  ): Promise<RouteResult<Conversation>> {
    const { conversationId } = ctx.params;
    const body = ctx.body as UpdateConversationRequest;

    const existing = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!existing) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Conversation not found: ${conversationId}`,
      } as NotFoundError;
    }

    // Verify user has access to this conversation
    await this.verifyConversationAccess(existing, ctx);

    let conversation = existing;
    let agent: AgentRegistration | undefined;
    if (body?.budget !== undefined) {
      agent = await this.getAgentFor(existing.agentId, ctx.context);
      const requested = this.parseBudgetRequest(body.budget, agent);
      const done = await this.mutateConversation(conversationId, ctx.context, async (fresh) => {
        const current = this.effectiveBudget(fresh, agent);
        const spentUsd = this.spentOf(fresh);
        if (requested && requested.maxCostUsd <= spentUsd) {
          throw {
            statusCode: 400,
            code: "invalid_budget",
            message: `The budget has to be more than the conversation has already spent ($${spentUsd})`,
            details: { spentUsd },
          };
        }
        // Lowering is the owner's; raising or removing it is the host's call
        await this.checkBudgetChange(ctx, {
          conversation: this.publicConversation(fresh, undefined, agent),
          current,
          requested,
          spentUsd,
        });
        if (budgetChangeKind(current, requested) === "same") return null;
        return { state: writeBudget(fresh.state, { ...readBudget(fresh.state), budget: requested }) };
      });
      conversation = done.conversation;
    }

    if (body?.budget === undefined || body.title !== undefined || body.metadata !== undefined) {
      conversation = await this.config.storage.updateConversation(conversationId, {
        title: body?.title,
        metadata: this.clientMetadata(body?.metadata, conversation.metadata),
      }, ctx.context);
    }

    const runtime = body?.budget !== undefined ? (await this.runtimesFor([conversation], ctx.context)).get(conversation.id) : undefined;
    return {
      status: 200,
      body: this.publicConversation(conversation, runtime, agent),
    };
  }

  private async handleDeleteConversation(ctx: RouteContext): Promise<RouteResult> {
    const { conversationId } = ctx.params;

    const existing = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!existing) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Conversation not found: ${conversationId}`,
      } as NotFoundError;
    }

    // Verify user has access to this conversation
    await this.verifyConversationAccess(existing, ctx);

    // A turn that is running is stopped first; one running on another node cannot be
    const active = this.runs.get(conversationId);
    if (active) {
      active.cancel("deleted");
      await this.settledWithin(active, this.runCfg.cancelWaitMs);
      if (this.runs.get(conversationId) === active) throw this.busyError(active.id);
    } else if (this.leasesAvailable) {
      const [lease] = (await this.config.storage.getLeases!([conversationLeaseKey(conversationId)], ctx.context)) ?? [];
      if (lease) throw this.busyError(lease.data?.runId as string | undefined);
    }

    // A host agent that holds open requests of this conversation is told they are gone (a run that was stopped was told already)
    const open = active ? undefined : readHitl(existing.state)?.pending?.actions;
    if (open?.length) {
      const agent = await this.getAgentFor(existing.agentId, ctx.context).catch(() => undefined);
      await this.notifyHost(agent, { conversationId, reason: "deleted", actions: open, context: ctx.context! });
    }

    await this.config.storage.deleteConversation(conversationId, ctx.context);
    this.fallbackEvents?.deleteConversation(conversationId);
    this.bus.publish(conversationId, { kind: "closed" });

    return { status: 204 };
  }

  private async handleListMessages(ctx: RouteContext): Promise<RouteResult> {
    const { conversationId } = ctx.params;
    const { limit, offset } = parsePaging(ctx.query, this.messagePageSize, this.maxPageSize);
    const order = (ctx.query.order as string) === "desc" ? "desc" : "asc";

    // Check if conversation exists
    const conversation = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!conversation) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Conversation not found: ${conversationId}`,
      } as NotFoundError;
    }

    // Verify user has access to this conversation
    await this.verifyConversationAccess(conversation, ctx);

    const result = await this.config.storage.getMessages(conversationId, {
      limit,
      offset,
      order,
    }, ctx.context);

    return {
      status: 200,
      body: {
        messages: result.data.map(publicMessage),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    };
  }

  // ============================================================================
  // Human-in-the-loop (pending actions)
  // ============================================================================

  /**
   * Conversation as clients see it: without the internal stores (pending actions, budget) and storage bookkeeping,
   * plus what is worth showing of them - the budget and what is spent, the tools remembered for the session.
   */
  private publicConversation<T extends Conversation>(
    conversation: T,
    runtime?: ConversationRuntime,
    agent?: Pick<AgentRegistration, "budget">
  ): T {
    const { version: _version, actionDueAt: _due, ...visible } = conversation;
    const hidden = conversation.state && (HITL_STATE_KEY in conversation.state || BUDGET_STATE_KEY in conversation.state);
    const budget = this.effectiveBudget(conversation, agent);
    const spent = this.spentOf(conversation);
    const remembered = readHitl(conversation.state)?.allowedTools;
    return {
      ...visible,
      ...(hidden ? { state: publicState(conversation.state) } : {}),
      ...(runtime ? { runtime, continuable: this.continuableOf(conversation, runtime) } : {}),
      ...(budget ? { budget } : {}),
      ...(budget || spent > 0 ? { spentUsd: spent } : {}),
      ...(remembered?.length ? { rememberedTools: [...remembered] } : {}),
    } as T;
  }

  /**
   * Whether a turn the budget cut short waits to be carried on (`POST .../continue`): its state is kept, and nothing
   * is running or waiting on a person. It stays so after the budget is raised or removed - the raise only makes room -
   * until the turn is continued or a new message gives it up. A turn that finished its answer as it crossed the limit
   * kept nothing to carry on from: raising the budget only reopens the conversation.
   */
  private continuableOf(conversation: Pick<Conversation, "state">, runtime: ConversationRuntime): boolean {
    if (runtime.status === "running" || runtime.status === "requires_action") return false;
    return !!readHitl(conversation.state)?.budgetPause;
  }

  /** The event data of a decision on `action` (`action.resolved`). */
  private actionResolvedData(
    action: PendingAction,
    resolution: ActionResolution | undefined,
    resolvedBy: string,
    channel: "api" | "system" | "timeout" | "remembered",
    extra: { cancelled?: boolean; expired?: boolean; remembered?: boolean; edited?: boolean } = {}
  ): Record<string, unknown> {
    const approval = resolution?.type === "tool_approval" ? resolution : undefined;
    const questionCancelled = resolution?.type === "user_question" && resolution.cancelled === true;
    const wasCancelled = extra.cancelled === true || questionCancelled;
    return {
      action_id: action.id,
      kind: action.type,
      ...(action.type === "tool_approval" && (extra.remembered || extra.expired) ? { tool_name: action.toolName } : {}),
      ...(approval ? { decision: approval.decision } : {}),
      ...(wasCancelled ? { cancelled: true } : {}),
      ...(extra.expired ? { expired: true } : {}),
      ...(extra.remembered ? { remembered: true } : {}),
      ...(extra.edited ? { edited_args: true } : {}),
      ...(approval?.rememberForSession ? { remember_for_session: true } : {}),
      status:
        extra.expired && extra.cancelled
          ? "expired"
          : wasCancelled
            ? "cancelled"
            : approval
              ? approval.decision === "allow"
                ? "approved"
                : "rejected"
              : "answered",
      resolved_by: resolvedBy,
      channel,
    };
  }

  // ---- state writes -----------------------------------------------------------

  /** Whether the storage provider can compare-and-set a conversation. */
  private get atomicUpdates(): boolean {
    const provider = this.config.storage;
    return typeof provider.updateConversationIf === "function" && provider.capabilities?.().atomicUpdate === true;
  }

  /**
   * Changes a conversation from what it is NOW: reads it, lets `build` say what to write, and writes it only if
   * nobody changed it in between (`updateConversationIf`; a store without it writes plainly). When somebody did, it reads
   * again and `build` runs again on the newer record, so two writers of one conversation - two answers to one pause,
   * a sweep and an answer, a budget change and a turn - never overwrite each other. `build` returns `null` to write
   * nothing, and may throw to give up.
   */
  private async mutateConversation(
    conversationId: string,
    rc: RequestContext | undefined,
    build: (fresh: Conversation) => UpdateConversationParams | null | Promise<UpdateConversationParams | null>
  ): Promise<{ conversation: Conversation; written: boolean }> {
    const storage = this.config.storage;
    for (let attempt = 0; attempt < 12; attempt++) {
      const fresh = await storage.getConversation(conversationId, rc);
      if (!fresh) throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
      const params = await build(fresh);
      if (!params) return { conversation: fresh, written: false };
      if (this.atomicUpdates && typeof fresh.version === "number") {
        const updated = await storage.updateConversationIf!(conversationId, fresh.version, params, rc);
        if (updated) return { conversation: updated, written: true };
        // somebody else got in first: look again (a short, growing pause keeps a crowd from colliding forever)
        await new Promise((resolve) => setTimeout(resolve, Math.min(5 * (attempt + 1), 40)));
        continue;
      }
      return { conversation: await storage.updateConversation(conversationId, params, rc), written: true };
    }
    throw {
      statusCode: 409,
      code: "conversation_conflict",
      message: "The conversation keeps changing under this request. Try again.",
    };
  }

  /**
   * The conversation state after a turn: `fresh` (the conversation as it is now) with the visible part replaced
   * by what a handler returned or patched, the HITL store rewritten for what the turn waits on, and the budget store
   * brought up to date with the turn's spend. Hidden stores are the server's alone: a handler's state never overwrites them.
   * `changed` is false when the turn leaves the state exactly as it was (a plain agent's turn writes nothing).
   */
  private composeState(
    fresh: Conversation,
    plan: {
      baseState?: Record<string, unknown>;
      statePatch?: Record<string, unknown>;
      pending?: { actions: PendingAction[]; messageId: string; sdkState?: unknown; onTimeout: "deny" | "cancel" };
      budgetPause?: { sdkState: unknown; messageId: string };
      rememberAdd?: string[];
      spend?: { turnCostUsd: number; budget: SessionBudget | null };
    }
  ): { state: Record<string, unknown>; changed: boolean } {
    const before = readHitl(fresh.state);
    const stored = readBudget(fresh.state);
    // A conversation that inherits its agent's budget keeps it from here on, so the runtime state needs nothing else
    const adoptBudget = !!plan.spend?.budget && stored?.budget === undefined;
    const spendWrite = !!plan.spend && (plan.spend.turnCostUsd > 0 || adoptBudget);
    const changed = !!(
      plan.baseState ||
      plan.statePatch ||
      plan.pending ||
      before?.pending ||
      plan.budgetPause ||
      before?.budgetPause ||
      plan.rememberAdd?.length ||
      spendWrite
    );
    if (!changed) return { state: fresh.state ?? {}, changed };

    let visible: Record<string, unknown> = plan.baseState ? withHiddenStores(plan.baseState, fresh.state) : { ...(fresh.state ?? {}) };
    if (plan.statePatch) visible = { ...visible, ...plan.statePatch };

    const allowed = [...new Set([...(before?.allowedTools ?? []), ...(plan.rememberAdd ?? [])])];
    const hitl: HitlStore = {
      ...(allowed.length > 0 && { allowedTools: allowed }),
      ...(plan.pending && {
        pending: {
          actions: plan.pending.actions,
          messageId: plan.pending.messageId,
          onTimeout: plan.pending.onTimeout,
          ...(plan.pending.sdkState !== undefined && { sdkState: plan.pending.sdkState }),
        },
      }),
      ...(plan.budgetPause && { budgetPause: plan.budgetPause }),
    };
    let next = writeHitl(visible, hitl);
    if (spendWrite) {
      const budgetStore: BudgetStore = {
        budget: stored?.budget !== undefined ? stored.budget : plan.spend!.budget ?? undefined,
        spentUsd: roundUsd((stored?.spentUsd ?? 0) + plan.spend!.turnCostUsd),
      };
      next = writeBudget(next, budgetStore);
    } else {
      next = writeBudget(next, stored);
    }
    return { state: next, changed };
  }

  /**
   * Records how actions ended on the paused assistant message (`metadata.pendingActions`), so a history shows
   * approved / denied / answered / expired / cancelled. Best effort: the answer itself is already in the conversation's
   * state, and a store that cannot update messages simply keeps showing the request as it was asked.
   */
  private async settleOnMessage(
    messageId: string,
    settled: Map<string, SettledAction>,
    rc: RequestContext | undefined
  ): Promise<void> {
    const storage = this.config.storage;
    if (typeof storage.updateMessage !== "function" || settled.size === 0) return;
    try {
      const message = await storage.getMessage(messageId, rc);
      if (!message) return;
      const metadata = settleSnapshot(message.metadata, settled);
      if (metadata) await storage.updateMessage(messageId, { metadata }, rc);
    } catch (error) {
      if (!this.snapshotWarned) {
        this.snapshotWarned = true;
        console.error("[AgentServer] Could not record how an action ended on its message (further failures are not logged):", error);
      }
    }
  }

  /**
   * Withdraws the actions a conversation waits on, under the state write rules above: they leave the pause, the paused message
   * records each as `cancelled` / `expired`, and `action.resolved` events are written (the caller adds whatever else the log
   * needs, in the same append). Resolves the actions that were open and the message they were asked on.
   */
  private async closePause(
    conversationId: string,
    rc: RequestContext | undefined,
    how: {
      status: (action: PendingAction) => "cancelled" | "expired";
      by: string;
      channel: "system" | "api" | "timeout";
      /** Only these (default: all open ones). */
      only?: (action: PendingAction) => boolean;
      moreEvents?: NewConversationEvent[];
      /** Where the events go (default: appended to the log outside any run). */
      emit?: (events: NewConversationEvent[]) => void | Promise<void>;
    }
  ): Promise<{ actions: PendingAction[]; messageId?: string }> {
    let closed: PendingAction[] = [];
    let messageId: string | undefined;
    let agentId: string | undefined;
    await this.mutateConversation(conversationId, rc, (fresh) => {
      const store = readHitl(fresh.state);
      closed = [];
      if (!store?.pending) return null;
      messageId = store.pending.messageId;
      agentId = fresh.agentId;
      closed = store.pending.actions.filter((action) => !how.only || how.only(action));
      if (closed.length === 0) return null;
      const closedIds = new Set(closed.map((action) => action.id));
      const left = store.pending.actions.filter((action) => !closedIds.has(action.id));
      const next: HitlStore = { ...store, pending: left.length > 0 ? { ...store.pending, actions: left } : undefined };
      return { state: writeHitl(fresh.state, next), actionDueAt: earliestDeadline(left) ?? (fresh.actionDueAt ? null : undefined) };
    });
    if (closed.length === 0) return { actions: [] };
    const now = new Date();
    await this.settleOnMessage(
      messageId!,
      new Map(
        closed.map((action) => [
          action.id,
          {
            status: how.status(action),
            resolvedBy: how.by,
            resolvedAt: now,
            ...(action.type === "user_question" ? { resolution: { type: "user_question" as const, answers: {}, cancelled: true } } : {}),
          } satisfies SettledAction,
        ])
      ),
      rc
    );
    const events: NewConversationEvent[] = [
      ...closed.map((action) => ({
        type: EVENT_TYPES.actionResolved,
        data: this.actionResolvedData(action, undefined, how.by, how.channel, {
          cancelled: true,
          expired: how.status(action) === "expired",
        }),
      })),
      ...(how.moreEvents ?? []),
    ];
    if (how.emit) await how.emit(events);
    else await this.appendEvents(conversationId, events, rc);

    // A host agent may hold the requests itself: tell it they are gone
    const agent = agentId ? await this.getAgentFor(agentId, rc).catch(() => undefined) : undefined;
    if (agent?.host?.cancel) {
      await this.notifyHost(agent, {
        conversationId,
        reason: how.channel === "timeout" ? "expired" : "withdrawn",
        actions: closed,
        context: rc ?? this.systemContext(),
      });
    }
    return { actions: closed, messageId };
  }

  /**
   * A new message while the conversation waits on a human: 409 by default, or
   * (`pendingActionPolicy: "cancel"`) cancel the pending actions and carry on.
   * Returns the conversation to continue with.
   */
  private async guardPendingActions(conversation: Conversation, ctx: RouteContext): Promise<Conversation> {
    const store = readHitl(conversation.state);
    if (!store?.pending) return conversation;
    if (this.config.pendingActionPolicy !== "cancel") {
      throw {
        statusCode: 409,
        code: "action_pending",
        message: "The conversation is waiting for a pending action to be resolved",
        details: { pendingActionIds: store.pending.actions.map((a) => a.id) },
      };
    }
    await this.closePause(conversation.id, ctx.context, { status: () => "cancelled", by: "system", channel: "system" });
    return (await this.config.storage.getConversation(conversation.id, ctx.context)) ?? conversation;
  }

  // ============================================================================
  // Runs
  // ============================================================================

  private get eventStore(): EventStore {
    const provider = this.config.storage;
    if (provider.events && provider.capabilities?.().events !== false) return provider.events;
    return (this.fallbackEvents ??= new MemoryEventLog({ maxPerConversation: this.runCfg.memoryEventLimit }));
  }

  /** Whether the storage provider can hold leases (otherwise runs are serialised in this process only). */
  private get leasesAvailable(): boolean {
    const provider = this.config.storage;
    return (
      typeof provider.acquireLease === "function" &&
      typeof provider.renewLease === "function" &&
      typeof provider.releaseLease === "function" &&
      typeof provider.getLeases === "function" &&
      provider.capabilities?.().leases !== false
    );
  }

  /** The context of work that belongs to no request (recovery, pruning). */
  private systemContext(): RequestContext {
    return { data: { system: true } };
  }

  private busyError(activeRunId?: string, runKind?: string) {
    return {
      statusCode: 409,
      code: "conversation_busy",
      message: "The conversation is already running a turn. Wait for it to finish, or cancel it.",
      details: { ...(activeRunId ? { activeRunId } : {}) },
      // (for the server's own use: an answer waits for another answer, not for a turn that takes as long as the model)
      runKind,
    };
  }

  /** Appends events outside a run (a failure is logged; the log must not break what it reports). */
  private async appendEvents(
    conversationId: string,
    events: NewConversationEvent[],
    rc?: RequestContext
  ): Promise<void> {
    if (events.length === 0) return;
    try {
      const stored = await this.eventStore.append(conversationId, events, rc);
      for (const event of stored) this.bus.publish(conversationId, { kind: "event", event });
    } catch (error) {
      console.error(`[AgentServer] Could not store events of conversation ${conversationId}:`, error);
    }
  }

  /** The conversation and its agent for a turn: 404 / 403 as the other routes answer them. */
  private async loadForTurn(
    conversationId: string,
    ctx: RouteContext
  ): Promise<{ conversation: Conversation; agent: AgentRegistration }> {
    const conversation = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!conversation) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    await this.verifyConversationAccess(conversation, ctx);
    const agent = await this.getAgentFor(conversation.agentId, ctx.context);
    if (!agent) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Agent not found: ${conversation.agentId}` } as NotFoundError;
    }
    return { conversation, agent };
  }

  /**
   * Takes the conversation for one run: in this process, and - when the storage provider has leases - across
   * nodes. 409 `conversation_busy` when a turn is already running. The registry slot is reserved before
   * anything is awaited, so two requests arriving together cannot both get in.
   */
  private async beginRun(
    ctx: RouteContext,
    conversation: Conversation,
    kind: RunKind,
    trigger: RunTrigger,
    streaming: boolean
  ): Promise<ActiveRun> {
    const conversationId = conversation.id;
    const existing = this.runs.get(conversationId);
    if (existing) throw this.busyError(existing.id, existing.kind);

    const run = new ActiveRun({
      conversationId,
      kind,
      trigger,
      streaming,
      append: (events) => this.eventStore.append(conversationId, events, ctx.context),
      bus: this.bus,
      maxEventDataBytes: this.runCfg.maxEventDataBytes,
    });
    this.runs.set(conversationId, run);

    try {
      // The task a conversation runs for is the one that points back at it, for the same user: the metadata alone is not trusted
      const taskId = conversation.metadata?.taskId;
      if (typeof taskId === "string" && (await this.taskOwnsConversation(taskId, conversation, ctx.context))) run.taskId = taskId;
      if (this.leasesAvailable) {
        const key = conversationLeaseKey(conversationId);
        const result = await this.config.storage.acquireLease!(
          {
            key,
            owner: this.nodeId,
            ttlMs: this.runCfg.leaseTtlMs,
            data: { conversationId, runId: run.id, kind, trigger, startedAt: run.startedAt.toISOString() },
          },
          ctx.context
        );
        if (!result.acquired) throw this.busyError(result.lease.data?.runId as string | undefined, result.lease.data?.kind as string | undefined);
        run.lease = new LeaseKeeper({
          storage: this.config.storage,
          key,
          owner: this.nodeId,
          ttlMs: this.runCfg.leaseTtlMs,
          ctx: ctx.context,
          // Another node asked us to stop (its `POST .../cancel` could not reach this process)
          onCancelRequested: () => run.cancel("remote"),
          // We could not renew in time and someone else may hold the conversation now: write nothing more
          onLost: () => {
            run.leaseLost = true;
            run.cancel("lease_lost");
          },
        });
        run.lease.start();
        // The previous holder died mid-turn: close its run in the log before this one starts
        if (result.takenOver) {
          await this.closeInterruptedRun(result.takenOver, ctx.context).catch((error) =>
            console.error("[AgentServer] Could not close an interrupted run:", error)
          );
        }
      }
    } catch (error) {
      // (also resolves `released`: whoever waits for this run to give the conversation back is not left waiting for a run that never started)
      await this.endRun(run);
      throw error;
    }
    return run;
  }

  /** Gives the conversation back. */
  private async endRun(run: ActiveRun): Promise<void> {
    await run.lease?.stop();
    if (this.runs.get(run.conversationId) === run) this.runs.delete(run.conversationId);
    run.end();
  }

  /**
   * Starts a run's work detached from the request: whatever happens to the HTTP connection, the turn
   * finishes, stores its messages and pending actions, and gives the conversation back.
   */
  private launch(run: ActiveRun, ctx: RouteContext, execute: () => Promise<TurnOutcome>): void {
    run.done = (async () => {
      let outcome: TurnOutcome;
      try {
        if (run.taskId) await this.markTaskRunning(run.taskId, ctx.context, run.conversationId);
        outcome = await runWithRequestContext(ctx.context!, execute);
      } catch (error) {
        outcome = await this.failRun(run, error);
      }
      try {
        await run.flush();
      } catch (error) {
        console.error(`[AgentServer] Could not finish run ${run.id}:`, error);
      }
      // The conversation is given back before the task says it is done: whoever sees the task settle can use the conversation
      await this.endRun(run);
      try {
        await this.syncTask(run, outcome, ctx.context);
      } catch (error) {
        console.error(`[AgentServer] Could not bring task ${run.taskId} up to date:`, error);
      }
      return outcome;
    })();
  }

  /** A turn that threw: the log and the stream say so; the caller of a non-streaming request gets the error. */
  private async failRun(run: ActiveRun, error: unknown): Promise<TurnOutcome> {
    const outcome: TurnOutcome = { content: "", stopReason: "error", pendingActions: [], error };
    if (run.leaseLost) return outcome; // someone else owns the conversation now
    // (logged where it is reported: the HTTP error, the stream error, the failed task)
    const failure = this.streamErrorEvent(error);
    run.emit({
      events: [
        { type: EVENT_TYPES.error, data: { message: failure.error, code: failure.code } },
        { type: EVENT_TYPES.statusIdle, data: { stop_reason: "error", detail: failure.code } },
      ],
      frame: (seq) => ({ ...failure, seq }),
    });
    return outcome;
  }

  /** A stream the caller only reads the error from: a turn that could not start. */
  private errorStream(error: unknown): RouteResult<never> {
    const self = this;
    async function* generate(): AsyncGenerator<string, void, unknown> {
      yield `data: ${JSON.stringify(self.streamErrorEvent(error))}\n\n`;
    }
    return { status: 200, headers: SSE_HEADERS, stream: generate() };
  }

  /**
   * The connection that started a run: legacy `stream.*` frames until the run ends. Going away only
   * unsubscribes (`close`); the run is not touched.
   */
  private attachStream(run: ActiveRun): { generator: AsyncGenerator<string, void, unknown>; close: () => void } {
    const queue: RunItem[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const unsubscribe = run.subscribe((item) => {
      queue.push(item);
      wake?.();
    });
    async function* generate(): AsyncGenerator<string, void, unknown> {
      try {
        for (;;) {
          while (queue.length > 0) {
            const item = queue.shift()!;
            if (item.kind === "end") return;
            yield `data: ${JSON.stringify(item.frame)}\n\n`;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        unsubscribe();
      }
    }
    return {
      generator: generate(),
      close: () => {
        closed = true;
        unsubscribe();
        wake?.();
      },
    };
  }

  // ---- messages -------------------------------------------------------------

  private async handleSendMessage(
    ctx: RouteContext
  ): Promise<RouteResult<SendMessageResponse>> {
    const { conversationId } = ctx.params;
    const body = ctx.body as SendMessageRequest;

    if (!body?.message) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "message is required",
      } as ValidationError;
    }

    // A message that attaches files is checked against its conversation and agent before anything starts,
    // streamed or not: a refused file is an HTTP status, not a frame of a stream.
    const streaming = !!body.stream;
    const attachesFiles =
      (Array.isArray(body.fileIds) ? body.fileIds.length > 0 : body.fileIds !== undefined) ||
      (Array.isArray(body.files) ? body.files.length > 0 : body.files !== undefined && body.files !== null);
    let loaded: { conversation: Conversation; agent: AgentRegistration } | undefined;
    let attachments: PreparedAttachments | undefined;
    if (attachesFiles) {
      loaded = await this.loadForTurn(conversationId, ctx);
      attachments = await this.prepareAttachments(loaded, body, ctx);
    }

    // A streamed request for a conversation or agent that is not there (or not the caller's) answers with a
    // stream that carries the error, as it always has; a plain request answers the HTTP status.
    if (!loaded) {
      try {
        loaded = await this.loadForTurn(conversationId, ctx);
      } catch (error) {
        if (streaming) return this.errorStream(error);
        throw error;
      }
    }
    const { agent } = loaded;
    let { conversation } = loaded;

    // One turn at a time per conversation (409 conversation_busy), then: waiting on a human?
    // Reject (409) or cancel the pending actions, per config.
    const run = await this.beginRun(ctx, conversation, "message", "message", streaming);
    let budget: TurnBudget;
    try {
      // Read again under the lease: the turn that held the conversation before this one may have stored a pause (or spent
      // budget) after it was loaded above, and the checks below have to see that
      const fresh = await this.config.storage.getConversation(conversationId, ctx.context);
      if (!fresh) {
        throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
      }
      conversation = fresh;
      // A conversation whose budget is used up takes no message (402 budget_reached, before anything is stored - not even
      // the cancelling of what it waits on)
      budget = this.planTurnBudget(conversation, agent);
      conversation = await this.guardPendingActions(conversation, ctx);
    } catch (error) {
      await this.endRun(run);
      throw error;
    }

    const stream = streaming ? this.attachStream(run) : undefined;
    this.launch(run, ctx, () => this.executeMessage(run, { ctx, conversation, agent, body, attachments, budget }));
    if (stream) return { status: 200, headers: SSE_HEADERS, stream: stream.generator, close: stream.close };

    const outcome = await run.done;
    if (outcome.error) throw outcome.error;
    return {
      status: 200,
      body: {
        message: publicMessage(outcome.userMessage!),
        response: publicMessage(outcome.assistant!),
        conversationTitle: outcome.conversationTitle,
        usage: outcome.usage,
        ...(outcome.status && outcome.status !== "completed" && { status: outcome.status }),
        ...(outcome.pendingActions.length > 0 && { pendingActions: outcome.pendingActions }),
        ...(outcome.warnings && { warnings: outcome.warnings }),
        stopReason: outcome.stopReason,
        runId: run.id,
        ...(outcome.budget && { budget: outcome.budget, spentUsd: outcome.spentUsd }),
      },
    };
  }

  /** Forgets the state a budget-stopped turn was to be carried on from: a new message supersedes it. Writes nothing when there is none. */
  private async abandonBudgetPause(conversation: Pick<Conversation, "id" | "state">, ctx: RouteContext): Promise<void> {
    if (!readHitl(conversation.state)?.budgetPause) return;
    await this.mutateConversation(conversation.id, ctx.context, (fresh) => {
      const store = readHitl(fresh.state);
      if (!store?.budgetPause) return null;
      const { budgetPause: _given, ...rest } = store;
      return { state: writeHitl(fresh.state, rest) };
    });
  }

  /** One message turn: stores the user message, runs the agent, stores the answer (and what it waits on). */
  private async executeMessage(
    run: ActiveRun,
    x: {
      ctx: RouteContext;
      conversation: Conversation;
      agent: AgentRegistration;
      body: SendMessageRequest;
      /** The files the message attaches (checked by `prepareAttachments`; a task hands over its input files). */
      attachments?: PreparedAttachments;
      /** What a custom handler gets as `metadata`, when it is not the message's own (a task hands over its comments). */
      handlerMetadata?: Record<string, unknown>;
      /** The money plan of the turn (made by the caller, which can answer 402 before anything starts; a task makes it here). */
      budget?: TurnBudget;
    }
  ): Promise<TurnOutcome> {
    const { ctx, conversation, agent, body } = x;
    const conversationId = conversation.id;
    const cfg = x.attachments?.cfg ?? this.filesConfigFor(agent);
    const budget = x.budget ?? this.planTurnBudget(conversation, agent);

    // Which uploads were already sent is known from the conversation's history (only read early when it is needed)
    const attachNewUploads = cfg.attachNewUploads && cfg.enabled;
    const prior = attachNewUploads ? await this.loadHistory(conversationId, ctx.context) : undefined;

    // Files sent inline are stored first, so the message carries real ids; then the ones attached by id, then
    // - if the agent is set up for it - uploads no message has carried yet
    const stored: FileAttachment[] = [];
    for (const file of x.attachments?.inline ?? []) {
      const record = await this.saveIncomingFile(ctx, { file, cfg, conversation });
      stored.push(attachmentOf(record));
    }
    let files = uniqueAttachments([...(x.attachments?.refs ?? []), ...stored]);
    if (prior) {
      files = uniqueAttachments([...files, ...(await this.unsentUploads(conversationId, prior, files, ctx.context))]);
    }

    // Save user message
    const userMessage = await this.config.storage.createMessage({
      conversationId,
      role: "user",
      content: body.message,
      files: files.length > 0 ? files : undefined,
      metadata: body.metadata,
    }, ctx.context);

    // (a follower that joins from here on is shown the message even if it reads the stored history before the message was in it)
    run.userMessage = { id: userMessage.id, content: body.message, files };

    // A message goes on from the conversation as it is: a turn the budget cut short is given up, not left to be
    // continued behind the person's back if this turn fails
    await this.abandonBudgetPause(conversation, ctx);

    run.emit({
      events: [
        {
          type: EVENT_TYPES.userMessage,
          data: {
            content: body.message,
            message_id: userMessage.id,
            ...(files.length > 0 ? { files: files.map((f) => ({ id: f.id, name: f.name, mime_type: f.mimeType, size: f.size })) } : {}),
          },
        },
        { type: EVENT_TYPES.statusRunning, data: { trigger: run.trigger } },
      ],
      frame: (seq) => ({
        type: "stream.start",
        timestamp: Date.now(),
        conversationId,
        messageId: userMessage.id,
        seq,
      } satisfies StreamStartEvent),
    });

    // Get previous messages for context
    const history = prior ? [...prior, userMessage] : await this.loadHistory(conversationId, ctx.context);

    const step = await this.runMessageStep(run, {
      ctx,
      conversation,
      agent,
      history,
      body,
      files: files.length > 0 ? files : undefined,
      currentMessageId: userMessage.id,
      handlerMetadata: x.handlerMetadata,
      budget,
    });
    return this.finalizeTurn(run, {
      ctx,
      conversation,
      agent,
      step,
      userMessage,
      // (a task's conversation gets no generated title: it is not a chat)
      firstExchange: history.length === 1 && !run.taskId ? body.message : undefined,
      budget,
    });
  }

  /**
   * Files uploaded to the conversation that no message has carried yet, oldest first (`files.attachNewUploads`),
   * as many as a message may attach. "Carried" = named in the `files` of a message the conversation holds.
   */
  private async unsentUploads(
    conversationId: string,
    prior: Message[],
    already: FileAttachment[],
    rc?: RequestContext
  ): Promise<FileAttachment[]> {
    const taken = new Set(already.map((file) => file.id));
    for (const message of prior) for (const file of message.files ?? []) taken.add(file.id);
    const room = Math.max(0, (this.config.limits?.maxFiles ?? FILES_DEFAULTS.maxFiles) - already.length);
    return (await this.conversationFiles(conversationId, rc))
      .filter((record) => !taken.has(record.id))
      .slice(0, room)
      .map(attachmentOf);
  }

  /** The agent's side of a message turn, for every kind of agent. */
  private async runMessageStep(
    run: ActiveRun,
    x: {
      ctx: RouteContext;
      conversation: Conversation;
      agent: AgentRegistration;
      history: Message[];
      body: SendMessageRequest;
      files?: FileAttachment[];
      /** The user message being answered (its images are shown; its warnings are reported). */
      currentMessageId?: string;
      handlerMetadata?: Record<string, unknown>;
      budget: TurnBudget;
    }
  ): Promise<AgentStep> {
    const { ctx, conversation, agent, history, body, files } = x;
    const pricing = x.budget.pricing;
    const conversationId = conversation.id;
    const grace = this.runCfg.cancelGraceMs;
    // Text streamed so far: what a cancelled turn keeps
    const partial = { text: "" };

    const textFrame = (text: string, isFinal: boolean) => (seq: number) =>
      ({ type: "stream.text", timestamp: Date.now(), text, isFinal, seq } satisfies StreamTextEvent);

    try {
      // What the conversation's files add to what the model is told (a custom handler reads them itself)
      const turn = this.turnFilesFor(conversationId, agent, ctx.context);
      let attached = new Map<string, AssembledAttachments>();
      let warnings: TurnWarning[] = [];
      if (!agent.handler && !agent.host && history.some((m) => m.role === "user" && m.files?.length)) {
        const assembled = await assembleHistory(history, {
          currentMessageId: x.currentMessageId,
          source: this.attachmentSource(turn),
          cfg: turn.cfg,
          canPage: this.agentCanPage(agent),
          viewImageTool: turn.viewImageTool,
          signal: run.signal,
          onError: (file, error) => console.error(`[AgentServer] Could not read file ${file.id}:`, error),
        });
        attached = assembled.byMessage;
        warnings = assembled.warnings;
      }
      const withWarnings = (step: AgentStep): AgentStep => (warnings.length > 0 ? { ...step, warnings } : step);

      if (agent.sdkAgent) {
        // Map messages with tool_calls and tool_call_id preserved
        return withWarnings(
          await this.runSdk(
            run,
            ctx,
            agent,
            { messages: toSdkMessages(history, attached) },
            new Set(readHitl(conversation.state)?.allowedTools ?? []),
            partial,
            turn,
            x.budget
          )
        );
      }

      if (agent.chatCompletions) {
        const raw = history.map((m) => ({
          role: m.role,
          content: modelContent(m, attached),
          ...(m.toolCalls && m.toolCalls.length > 0 && {
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments }
            }))
          }),
          ...(m.toolCallId && { tool_call_id: m.toolCallId }),
          ...(m.name && { name: m.name }),
        }));
        const messages = (await this.resolveImages(raw, turn, "data-url")) as typeof raw;

        const priced = (raw: unknown) => normalizeUsage(raw, { pricing, model: agent.chatCompletions!.model });
        if (!run.streaming) {
          const result = await invokeChatCompletions(agent.chatCompletions, messages, { signal: run.signal });
          return withWarnings({ content: result.content, usage: priced(result.usage), pending: [], cancelled: run.cancelled });
        }
        let content = "";
        let usage: UsageInfo | undefined;
        for await (const event of streamChatCompletions(agent.chatCompletions, messages, { signal: run.signal })) {
          if (event.type === "text") {
            partial.text += event.text;
            run.emit({ delta: event.text, frame: textFrame(event.text, false) });
          } else if (event.type === "done") {
            content = event.content;
            usage = priced(event.usage);
          }
        }
        return withWarnings({ content, usage, pending: [], cancelled: run.cancelled });
      }

      if (agent.responsesApi) {
        const raw = history.map((m) => ({ role: m.role, content: modelContent(m, attached) }));
        // Parts of the Responses API: text is input_text, a picture input_image
        const messages = ((await this.resolveImages(raw, turn, "responses")) as typeof raw).map((m) => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? m.content.map((part) =>
                (part as { type?: string }).type === "text"
                  ? { type: m.role === "assistant" ? "output_text" : "input_text", text: (part as { text?: string }).text }
                  : part
              )
            : m.content,
        }));

        let content = "";
        let usage: UsageInfo | undefined;
        let responseId: string | undefined;
        const priced = (raw: unknown) => normalizeUsage(raw, { pricing, model: agent.responsesApi!.model });
        if (!run.streaming) {
          const result = await invokeResponsesApi(agent.responsesApi, messages, undefined, { signal: run.signal });
          content = result.content;
          usage = priced(result.usage);
          responseId = result.responseId;
        } else {
          for await (const event of streamResponsesApi(agent.responsesApi, messages, undefined, { signal: run.signal })) {
            if (event.type === "text") {
              partial.text += event.text;
              run.emit({ delta: event.text, frame: textFrame(event.text, false) });
            } else if (event.type === "done") {
              content = event.content;
              usage = priced(event.usage);
              responseId = event.responseId || undefined;
            }
          }
        }
        // The id of the response is kept in the conversation's state for chaining (written with the rest of the turn)
        return withWarnings({
          content,
          usage,
          pending: [],
          cancelled: run.cancelled,
          ...(responseId ? { statePatch: { lastResponseId: responseId } } : {}),
        });
      }

      if (agent.host) {
        // Host-backed agent: it reports its progress with events and returns a typed result
        return await this.runHostStep(run, {
          ctx,
          agent,
          partial,
          turn,
          budget: x.budget,
          call: (host, io) =>
            host.invoke(
              {
                conversationId,
                runId: run.id,
                message: body.message,
                history,
                files: files ?? [],
                metadata: x.handlerMetadata ?? body.metadata,
                context: ctx.context!,
              },
              io
            ),
        });
      }

      if (agent.handler) {
        // Custom handler (not streaming; a streamed request gets a progress frame and the whole answer at once)
        if (run.streaming) {
          run.emit({
            frame: () => ({
              type: "stream.progress",
              timestamp: Date.now(),
              stage: "processing",
              message: "Processing message...",
            } satisfies StreamProgressEvent),
          });
        }
        const work = agent.handler.processMessage({
          conversationId,
          message: body.message,
          files,
          state: conversation.state,
          metadata: x.handlerMetadata ?? body.metadata,
          context: ctx.context,
          signal: run.signal,
          ...this.handlerFileReaders(turn),
        });
        const raced = await run.raceCancel(work, grace);
        if ("abandoned" in raced) return cancelledStep(partial.text);
        const result = raced.value;
        const pending = result.pendingActions ?? [];
        if (run.streaming) {
          // Send the full content as a single text event
          run.emit({ frame: textFrame(result.content, true) });
        }
        // (the state it returned is stored with the rest of the turn, next to the server's own bookkeeping)
        return {
          content: result.content,
          files: result.files,
          usage: normalizeUsage(result.usage, { pricing }),
          pending,
          handlerState: result.state,
          handlerMetadata: result.metadata,
          cancelled: run.cancelled,
          stopReason: result.stopReason,
          handlerStatus: normalizeTurnStatus(result.status, pending),
        };
      }
    } catch (error) {
      // The model call / handler was cut off by the cancellation: that is the cancellation working
      if (run.cancelled) return cancelledStep(partial.text);
      throw error;
    }

    throw {
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Agent has no handler",
    };
  }

  /** The conversation's files as a host agent reads them (`io.files`). */
  private hostFiles(turn: TurnFiles): HostFiles {
    const readers = this.handlerFileReaders(turn);
    return {
      list: async () => (await turn.list()).map(attachmentOf),
      read: async (fileId) => (await readers.getFileContent!(fileId)) ?? null,
      text: async (fileId) => (await readers.getFileText!(fileId)) ?? null,
    };
  }

  /**
   * Tells a host agent that the server lets go of something. A failing hook is logged; it never fails the request, and one
   * that does not answer within `runs.cancelGraceMs` is given up on (the conversation is not held for a hook).
   */
  private async notifyHost(agent: AgentRegistration | undefined, input: HostCancelInput): Promise<void> {
    const cancel = agent?.host?.cancel;
    if (!cancel) return;
    const limit = this.runCfg.cancelGraceMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => cancel(input)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`it did not answer within ${limit} ms`)), limit);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      console.error(`[AgentServer] The cancel hook of host agent ${agent!.info.id} failed:`, error);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The agent's side of a turn for a host-backed agent (a message or an answer). What it emits becomes the run's
   * stored events and live output - the same ones an agent-sdk agent produces - and what it returns is checked and
   * reduced to a step. Cancelling the run aborts `io.signal` and calls the agent's `cancel` hook.
   */
  private async runHostStep(
    run: ActiveRun,
    x: {
      ctx: RouteContext;
      agent: AgentRegistration;
      partial: { text: string };
      turn: TurnFiles;
      budget: TurnBudget;
      /** Calls `invoke` or `resolveAction`. */
      call: (host: HostAgent, io: HostRunIo) => Promise<unknown> | unknown;
    }
  ): Promise<AgentStep> {
    const { agent, partial } = x;
    const host = agent.host!;
    // Cancelled before it started: nothing to run
    if (run.cancelled) return cancelledStep(partial.text);

    const collected: HostCollected = { actions: [], usage: [] };
    const bridge = createSdkBridge(run, partial);
    const toolNames = new Map<string, string>();
    let open = true;
    let warned = false;
    const io: HostRunIo = {
      signal: run.signal,
      files: this.hostFiles(x.turn),
      emit: (raw) => {
        // (an agent that was abandoned after a cancellation, or that kept a handle past its turn, may still report)
        if (!open) return;
        const read = readHostEvent(raw);
        if (!read.ok) {
          if (!warned) {
            warned = true;
            console.warn(`[AgentServer] Host agent ${agent.info.id} reported an event the server ignored: ${read.message}`);
          }
          return;
        }
        const event = read.value;
        switch (event.type) {
          case "text":
            if (event.text !== "") bridge.onStream({ text: event.text });
            break;
          case "tool_use":
            toolNames.set(event.id, event.name);
            bridge.onEvent({ type: "tool_call", phase: "start", id: event.id, name: event.name, args: event.args ?? {} });
            break;
          case "tool_result":
            bridge.onEvent({
              type: "tool_call",
              phase: event.error !== undefined ? "error" : "success",
              id: event.id,
              name: event.name ?? toolNames.get(event.id),
              result: event.result,
              ...(event.error !== undefined ? { error: { message: event.error } } : {}),
            });
            break;
          case "action_required": {
            // (stored and announced when the turn ends: the pause is persisted before anyone is told about it)
            const known = new Set(collected.actions.map((a) => a.id));
            collected.actions.push(...event.actions.filter((a) => !known.has(a.id)));
            break;
          }
          case "usage":
            collected.usage.push(event.usage);
            break;
          case "stop":
            collected.stopReason = event.stopReason;
            collected.detail = event.detail;
            break;
        }
      },
    };

    const onAbort = () => {
      void this.notifyHost(agent, {
        conversationId: run.conversationId,
        runId: run.id,
        reason: (run.cancelReason ?? "user") as HostCancelReason,
        context: x.ctx.context!,
      });
    };
    run.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const raced = await run.raceCancel(
        Promise.resolve().then(() => x.call(host, io)),
        this.runCfg.cancelGraceMs
      );
      if ("abandoned" in raced) return cancelledStep(partial.text);
      const step = readHostResult(agent.info.id, raced.value, collected, { pricing: x.budget.pricing });
      // A turn that streamed its answer and returned no text of its own: what was streamed is the answer
      const content = step.content !== "" ? step.content : partial.text;
      // Nothing was streamed but the request asked for a stream: the whole answer goes out once, so no bubble stays empty
      if (run.streaming && !bridge.streamedAnyText && content) {
        run.emit({
          delta: content,
          frame: (seq) => ({ type: "stream.text", timestamp: Date.now(), text: content, isFinal: true, seq } satisfies StreamTextEvent),
        });
      }
      return {
        content,
        files: step.files,
        usage: step.usage,
        pending: step.pending,
        handlerMetadata: step.metadata,
        cancelled: run.cancelled,
        stopReason: step.stopReason,
        handlerStatus: normalizeTurnStatus(step.status, step.pending),
        detail: step.detail,
      };
    } catch (error) {
      if (run.cancelled) return cancelledStep(partial.text);
      throw error;
    } finally {
      open = false;
      run.signal.removeEventListener("abort", onAbort);
    }
  }

  /** The input of a model call written by the server (Chat Completions, Responses) with its image references read from storage. */
  private async resolveImages<T extends unknown[]>(messages: T, turn: TurnFiles, format: ImageFormat): Promise<unknown[]> {
    if (!hasImageReferences(messages)) return messages;
    return resolveImageReferences(messages, {
      source: turn.images,
      maxImages: turn.cfg.maxImages,
      maxBytes: turn.cfg.maxImageBytes,
      viewImageTool: false,
      format,
    });
  }

  /** An SDK input (`{ messages }` or a resumed state) with the image references of its messages read from storage. */
  private async hydrateSdkInput(input: unknown, turn: TurnFiles): Promise<unknown> {
    const messages = (input as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages) || !hasImageReferences(messages)) return input;
    return {
      ...(input as Record<string, unknown>),
      messages: await resolveImageReferences(messages, {
        source: turn.images,
        maxImages: turn.cfg.maxImages,
        maxBytes: turn.cfg.maxImageBytes,
        viewImageTool: false,
        format: "sdk",
      }),
    };
  }

  /** Invokes an agent-sdk agent (with the remembered-approval loop), cancellable. */
  private async runSdk(
    run: ActiveRun,
    ctx: RouteContext,
    agent: AgentRegistration,
    input: unknown,
    allowedTools: ReadonlySet<string>,
    partial: { text: string },
    turn: TurnFiles,
    budget: TurnBudget
  ): Promise<AgentStep> {
    const sdkAgent = agent.sdkAgent as HitlSdkAgent;
    const bridge = createSdkBridge(run, partial);
    // A resumed turn starts from a state that already holds the usage of its earlier legs: they are not this run's.
    // (A copy: agent-sdk adds this run's calls to the ledger it is handed, in place.)
    const carried = snapshotLedger((input as { usage?: unknown } | null)?.usage);
    const config = {
      context: ctx.context,
      // An AbortSignal is a valid SDK cancellation token, and tools see it as their `signal`
      cancellationToken: run.signal,
      onEvent: bridge.onEvent,
      ...(run.streaming ? { stream: true, onStream: bridge.onStream } : {}),
      // The conversation's budget stops the turn in the middle (when the agent can price its calls: see costEstimatorFromPricing)
      ...(budget.limit ? { limits: { maxCostUsd: budget.limit.maxCostUsd } } : {}),
    };
    // An agent whose model reads image references itself (`withSessionImages`) is given references; for any other
    // the server reads the images now - they are put back to references before a paused state is stored.
    const wrapped = isSessionImageModel((sdkAgent as { __runtime?: { model?: unknown } }).__runtime?.model);
    const sdkInput = wrapped ? input : await this.hydrateSdkInput(input, turn);
    // The tools and the model wrapper find the conversation's files through the turn
    const raced = await run.raceCancel(
      runWithTurnFiles(turn, () =>
        runSdkTurn(sdkAgent, sdkInput, config, allowedTools, (action) =>
          // A tool the person asked not to be asked about again was approved without asking: the log says so
          run.emit({
            events: [
              {
                type: EVENT_TYPES.actionResolved,
                data: this.actionResolvedData(action, { type: "tool_approval", decision: "allow" }, "remembered", "remembered", { remembered: true }),
              },
            ],
          })
        )
      ),
      this.runCfg.cancelGraceMs
    );
    if ("abandoned" in raced) return cancelledStep(partial.text);

    const { result, pending } = raced.value;
    const sdkCtx = (result.state as { ctx?: Record<string, unknown> } | undefined)?.ctx;
    let content = result.content;
    const usage = normalizeUsage(result.metadata?.usage, { previous: carried, pricing: budget.pricing });

    // Stopped: the SDK says so (`__cancelled`), or the run was asked to stop while the SDK was still finishing and it returned an
    // ordinary result anyway (an SDK that does not hang up on the model, a call that completed in the same breath). Either way the
    // person pressed Stop, so the turn is recorded as cancelled with the text that was streamed - not as a finished answer.
    if (sdkCtx?.__cancelled || run.cancelled) {
      return { ...cancelledStep(content || partial.text || bridge.finalChunkText), usage };
    }

    // The agent returned its answer without streaming any text: emit it once
    // so streaming clients (chat-ui) don't end up with an empty bubble.
    if (run.streaming && !bridge.streamedAnyText) {
      const fallbackText = content || bridge.finalChunkText;
      if (fallbackText) {
        run.emit({
          delta: fallbackText,
          frame: (seq) => ({
            type: "stream.text",
            timestamp: Date.now(),
            text: fallbackText,
            isFinal: true,
            seq,
          } satisfies StreamTextEvent),
        });
      }
      content = fallbackText;
    }

    // agent-sdk stopped the turn on a cost limit, and the limit was the conversation's budget (not the agent's own cap)
    const breach =
      typeof sdkCtx?.__limitBreached === "string" &&
      isCostLimitDetail(sdkCtx.__limitBreached) &&
      budget.limit?.sessionBinds === true &&
      pending.length === 0;
    return {
      content,
      usage,
      pending,
      sdkState: pending.length > 0 ? dehydrateImages(portableState(result.state)) : undefined,
      cancelled: false,
      limited: !!sdkCtx?.__limitBreached,
      ...(breach && { budgetBreach: true }),
      // Where to carry on from once the budget is raised (`pause` only: a `stop` budget ends the conversation)
      ...(breach && budget.budget?.onReach === "pause" && result.state
        ? { budgetState: dehydrateImages(portableState(result.state)) }
        : {}),
      ...(typeof sdkCtx?.__limitBreached === "string" ? { detail: sdkCtx.__limitBreached } : {}),
    };
  }

  /**
   * Stores what a step produced as the assistant message, records what it waits on, settles the money, and reports
   * the end of the turn (events, then the legacy done frame). A pause whose state the store cannot hold
   * is not taken: the turn finishes with a `pause_state_too_large` warning.
   */
  private async finalizeTurn(
    run: ActiveRun,
    x: {
      ctx: RouteContext;
      conversation: Conversation;
      agent: AgentRegistration;
      step: AgentStep;
      userMessage?: Message;
      /** The first message of the conversation: a title is generated from it. */
      firstExchange?: string;
      budget: TurnBudget;
      /** Tools this turn's answer asked to remember for the session. */
      rememberAdd?: string[];
      /** How this turn's answer ended the actions of the paused message it continues. */
      settled?: { messageId: string; entries: Map<string, SettledAction> };
    }
  ): Promise<TurnOutcome> {
    const { ctx, conversation, step } = x;
    const conversationId = conversation.id;
    if (run.leaseLost) {
      throw { statusCode: 409, code: "lease_lost", message: "The conversation was taken over by another run" };
    }

    // A cancelled step ends the turn: nothing it was waiting on is kept
    const hitl = this.hitlFor(x.agent);
    const actions = step.cancelled ? [] : this.withArgsSchemas(x.agent, stampDeadlines(step.pending, hitl.timeoutMinutes));
    let wanted: StopReason = step.cancelled
      ? "cancelled"
      : actions.length > 0
        ? "requires_action"
        : step.stopReason ?? (step.limited || step.handlerStatus === "incomplete" ? "limit" : step.handlerStatus === "cancelled" ? "cancelled" : "end_turn");

    // Money: what the turn cost goes on the conversation's total - also when it was cancelled - and a budget that is used
    // up ends the turn. A pause for a person and a cancellation keep their own stop: the next turn is refused anyway.
    const tb = x.budget;
    const turnCostUsd = step.usage?.costUsd ?? 0;
    const spentUsd = tb.pricing ? roundUsd(tb.spentBefore + turnCostUsd) : undefined;
    const keepsOwnStop = step.cancelled || actions.length > 0;
    const reached = !!tb.budget && spentUsd !== undefined && (step.budgetBreach === true || (!keepsOwnStop && spentUsd >= tb.budget.maxCostUsd));
    if (reached && !keepsOwnStop) wanted = "budget_reached";

    const saved = await this.saveAssistantTurn(ctx, conversation, {
      content: step.content,
      files: step.files,
      handlerState: step.handlerState,
      statePatch: step.statePatch,
      actions,
      sdkState: step.sdkState,
      budgetState: reached ? step.budgetState : undefined,
      stopReason: wanted,
      // A turn that crossed the budget on its own finished its answer; one the budget cut short did not
      status: wanted === "budget_reached" && !step.budgetBreach ? "completed" : undefined,
      rememberAdd: x.rememberAdd,
      warnings: step.warnings,
      onTimeout: hitl.onTimeout,
      spend: tb.pricing ? { turnCostUsd, budget: tb.budget } : undefined,
      settled: x.settled,
    });
    const assistant = saved.message;
    const stopReason = saved.stopReason;
    const pendingActions = saved.actions;
    let content = step.content;
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    // The turn could not pause and had said nothing: the stream gets the notice too
    let noticeFrame: ((seq: number) => Record<string, unknown>) | undefined;
    if (assistant.content !== content) {
      content = assistant.content as string;
      const notice = content;
      noticeFrame = (seq) => ({ type: "stream.text", timestamp: Date.now(), text: notice, isFinal: true, seq } satisfies StreamTextEvent);
    }

    const tokens = (usage: UsageInfo) => ({
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      ...(usage.cachedInputTokens !== undefined ? { cached_input_tokens: usage.cachedInputTokens } : {}),
    });
    if (content !== "") {
      events.push({
        type: EVENT_TYPES.message,
        data: {
          content,
          message_id: assistant.id,
          stop_reason: stopReason,
          ...(step.usage ? { usage: { ...tokens(step.usage), ...(step.usage.costUsd !== undefined ? { cost_usd: step.usage.costUsd } : {}) } } : {}),
        },
      });
    }
    if (step.usage || tb.budget) {
      events.push({
        type: EVENT_TYPES.usage,
        data: {
          ...(step.usage ? tokens(step.usage) : {}),
          ...(spentUsd !== undefined ? { turn_cost_usd: turnCostUsd, spent_usd: spentUsd } : {}),
          ...(tb.budget ? { budget: budgetWire(tb.budget) } : {}),
        },
      });
    }
    for (const action of pendingActions) events.push({ type: EVENT_TYPES.actionRequired, data: actionRequiredData(action) });
    run.emit({ events, ...(noticeFrame && { frame: noticeFrame }) });

    if (pendingActions.length > 0) {
      run.emit({
        frame: (seq) => ({
          type: "stream.action_required",
          timestamp: Date.now(),
          conversationId,
          messageId: assistant.id,
          actions: pendingActions,
          seq,
        } satisfies StreamActionRequiredEvent),
      });
    }

    // Auto-generate title on the first exchange
    let conversationTitle: string | undefined;
    if (!conversation.title && x.firstExchange && !step.cancelled) {
      conversationTitle = await this.generateTitle(x.firstExchange, run.signal);
      if (conversationTitle) {
        await this.config.storage.updateConversation(conversationId, { title: conversationTitle }, ctx.context);
      }
    }

    const budgetNow = tb.budget && spentUsd !== undefined ? tb.budget : undefined;
    const legacyStatus = saved.status && saved.status !== "completed" ? saved.status : undefined;
    run.emit({
      events: [
        ...(stopReason === "budget_reached" && tb.budget
          ? [{ type: EVENT_TYPES.budgetReached, data: { spent_usd: spentUsd, max_cost_usd: tb.budget.maxCostUsd, on_reach: tb.budget.onReach } }]
          : []),
        {
          type: EVENT_TYPES.statusIdle,
          data: {
            stop_reason: stopReason,
            ...(pendingActions.length > 0 ? { pending_action_ids: pendingActions.map((a) => a.id) } : {}),
            ...(saved.warnings?.some((w) => w.code === "pause_state_too_large")
              ? { detail: "pause_state_too_large" }
              : step.detail
                ? { detail: step.detail }
                : {}),
          },
        },
        ...(stopReason === "end_turn" ? [{ type: EVENT_TYPES.workDone, data: {} }] : []),
      ],
      frame: (seq) => ({
        type: "stream.done",
        timestamp: Date.now(),
        conversationId,
        messageId: assistant.id,
        content,
        title: conversationTitle,
        usage: step.usage,
        ...(legacyStatus && { status: legacyStatus }),
        ...(pendingActions.length > 0 && { pendingActions }),
        ...(saved.warnings && { warnings: saved.warnings }),
        stopReason,
        runId: run.id,
        ...(budgetNow && { budget: budgetNow, spentUsd }),
        seq,
      } satisfies StreamDoneEvent),
    });

    return {
      userMessage: x.userMessage,
      assistant,
      content,
      usage: step.usage,
      status: legacyStatus,
      stopReason,
      pendingActions,
      warnings: saved.warnings,
      conversationTitle,
      handlerMetadata: step.handlerMetadata,
      ...(budgetNow && { budget: budgetNow, spentUsd }),
    };
  }

  /**
   * Saves the assistant message of a turn and what it waits on, and brings the conversation's state up to date (the
   * pause, the money, remembered tools) in one compare-and-set write. A pause whose state the
   * store cannot hold (`limits.maxStateBytes`, or the provider's own limit) is not taken: the turn finishes as if
   * it had not paused and the message carries a `pause_state_too_large` warning, instead of failing after the message was written.
   */
  private async saveAssistantTurn(
    ctx: RouteContext,
    conversation: Conversation,
    turn: {
      content: string;
      files?: Message["files"];
      /** State a handler wrote this turn; without it the conversation's own is kept. */
      handlerState?: Record<string, unknown>;
      statePatch?: Record<string, unknown>;
      actions: PendingAction[];
      sdkState?: unknown;
      /** The agent-sdk state to carry on from after a budget stop. */
      budgetState?: unknown;
      /** Why the turn stopped, unless the pause is dropped (then it simply ended). */
      stopReason: StopReason;
      /** The message status when it is not the one the stop reason implies. */
      status?: MessageStatus;
      /** Tools this turn's answer asked to remember. */
      rememberAdd?: string[];
      /** Warnings the turn already has (about its files); the message carries them. */
      warnings?: TurnWarning[];
      onTimeout: "deny" | "cancel";
      spend?: { turnCostUsd: number; budget: SessionBudget | null };
      /** The actions of the message this turn continues that the turn's answer ended. */
      settled?: { messageId: string; entries: Map<string, SettledAction> };
    }
  ): Promise<{
    message: Message;
    actions: PendingAction[];
    stopReason: StopReason;
    status: MessageStatus;
    warnings?: TurnWarning[];
  }> {
    let { actions, sdkState, budgetState, content, stopReason } = turn;
    let warnings: TurnWarning[] | undefined = turn.warnings?.length ? [...turn.warnings] : undefined;

    const dropPause = (bytes: number | undefined) => {
      const max = this.maxStateBytes;
      const what = actions.length > 0 ? "paused state" : "state to carry on from";
      warnings = [
        ...(warnings ?? []),
        {
          code: "pause_state_too_large",
          message: `The ${what}${bytes ? ` (${bytes} bytes)` : ""} does not fit the ${max} byte limit, so the turn was not paused`,
          ...(bytes && { stateBytes: bytes }),
          maxStateBytes: max,
        },
      ];
      const waited = actions.length > 0;
      actions = [];
      sdkState = undefined;
      budgetState = undefined;
      if (stopReason === "requires_action") stopReason = "end_turn";
      if (waited && !content) content = PAUSE_NOT_STORED_NOTICE;
    };

    const plan = (messageId: string) => ({
      baseState: turn.handlerState,
      statePatch: turn.statePatch,
      pending: actions.length > 0 ? { actions, messageId, sdkState, onTimeout: turn.onTimeout } : undefined,
      budgetPause: budgetState !== undefined ? { sdkState: budgetState, messageId } : undefined,
      rememberAdd: turn.rememberAdd,
      spend: turn.spend,
    });

    if (actions.length > 0 || budgetState !== undefined) {
      const { state } = this.composeState(conversation, plan("msg_".padEnd(25, "x")));
      const bytes = Buffer.byteLength(JSON.stringify(state));
      if (bytes > this.maxStateBytes) dropPause(bytes);
    }

    let message!: Message;
    let status: MessageStatus = turn.status ?? statusForStop(stopReason);
    for (let attempt = 0; ; attempt++) {
      status = turn.status ?? statusForStop(stopReason);
      message = await this.config.storage.createMessage({
        conversationId: conversation.id,
        role: "assistant",
        content,
        files: turn.files,
        metadata: {
          ...(actions.length > 0 && { requiresAction: true }),
          status,
          stopReason,
          ...(warnings && { warnings }),
          // What was asked, so a history can show it - and, once it is answered, how
          ...(actions.length > 0 && { pendingActions: openSnapshot(actions) }),
        },
      }, ctx.context);
      try {
        // A plain turn changes nothing in the conversation record: it is not even read again. (Under the conversation's
        // lease nothing else changes what decides that: the pause, the remembered tools, the spend.)
        const touches = this.composeState(conversation, plan(message.id)).changed || !!conversation.actionDueAt;
        if (touches) {
          await this.mutateConversation(conversation.id, ctx.context, (fresh) => {
            const { state, changed } = this.composeState(fresh, plan(message.id));
            const due = earliestDeadline(actions);
            const dueChange = due ?? (fresh.actionDueAt ? null : undefined);
            if (!changed && dueChange === undefined) return null;
            return { state, ...(dueChange !== undefined && { actionDueAt: dueChange }) };
          });
        }
        break;
      } catch (error) {
        // Never leave an assistant message that says it waits on an action the store did not keep
        await this.config.storage.deleteMessage(message.id, ctx.context).catch(() => undefined);
        const tooLarge = (error as { code?: string } | null)?.code === "STORAGE_LIMIT_EXCEEDED";
        if (attempt === 0 && (actions.length > 0 || budgetState !== undefined) && tooLarge) {
          dropPause(undefined);
          continue;
        }
        throw error;
      }
    }
    // The state is stored; now the paused message this turn continues learns how its actions ended
    if (turn.settled) await this.settleOnMessage(turn.settled.messageId, turn.settled.entries, ctx.context);
    return { message, actions, stopReason, status, warnings };
  }

  /** The error of a failed stream as the legacy `stream.error` event (honours `maskServerErrors`). */
  private streamErrorEvent(error: unknown): StreamErrorEvent {
    const exposed = this.isExposedError(error as { statusCode?: number; expose?: boolean } | null);
    if (!exposed) console.error("[AgentServer] Stream error:", error);
    const errorMessage = !exposed
      ? "An unexpected error occurred"
      : error instanceof Error
        ? error.message
        : (error as { message?: string } | null)?.message || "Unknown error";
    return {
      type: "stream.error",
      timestamp: Date.now(),
      error: errorMessage,
      // Host-authored errors (statusCode + code) keep their own code, e.g. CONVERSATION_BUSY.
      code: exposed && typeof (error as { statusCode?: unknown })?.statusCode === "number" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "INTERNAL_ERROR",
    };
  }

  // ============================================================================
  // Resolve a pending action
  // ============================================================================

  private validateResolution(body: ResolveActionRequest | undefined): ActionResolution {
    const bad = (message: string): never => {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message } as ValidationError;
    };
    const r = body?.resolution as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") return bad("resolution is required");
    if (r.type === "tool_approval") {
      if (r.decision !== "allow" && r.decision !== "deny") return bad('resolution.decision must be "allow" or "deny"');
      if (r.approvedArgs !== undefined && (!r.approvedArgs || typeof r.approvedArgs !== "object" || Array.isArray(r.approvedArgs))) {
        return bad("resolution.approvedArgs must be a JSON object");
      }
      if (r.comment !== undefined && typeof r.comment !== "string") return bad("resolution.comment must be a string");
      return r as unknown as ActionResolution;
    }
    if (r.type === "user_question") {
      if (r.cancelled !== true) {
        const answers = r.answers as Record<string, unknown> | undefined;
        if (!answers || typeof answers !== "object" || Array.isArray(answers)) return bad("resolution.answers must be an object");
        for (const value of Object.values(answers)) {
          const ok = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
          if (!ok) return bad("resolution.answers values must be a string or an array of strings");
        }
      }
      return r as unknown as ActionResolution;
    }
    return bad('resolution.type must be "tool_approval" or "user_question"');
  }

  /**
   * Takes the conversation for an answer. An answer that meets another answer being recorded waits for it (up to
   * `hitl.resolveWaitMs`) instead of failing, so the several actions of one pause can be answered at the same time; a
   * message or a continuation that takes as long as the model is not waited for.
   */
  private async beginResolveRun(
    ctx: RouteContext,
    conversation: Conversation,
    trigger: RunTrigger,
    streaming: boolean,
    kind: RunKind = "resolve"
  ): Promise<ActiveRun> {
    const deadline = Date.now() + this.resolveWaitMs;
    for (;;) {
      try {
        return await this.beginRun(ctx, conversation, kind, trigger, streaming);
      } catch (error) {
        const busy = error as { code?: string; runKind?: string } | null;
        if (busy?.code !== "conversation_busy" || Date.now() >= deadline) throw error;
        const local = this.runs.get(conversation.id);
        if (local) {
          if (local.kind !== "resolve") throw error;
          // (until it gives the conversation back: a run that has not even started has no result to wait for yet)
          await this.releasedWithin(local, deadline - Date.now());
        } else {
          if (busy.runKind !== "resolve") throw error;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
    }
  }

  private async handleResolveAction(ctx: RouteContext): Promise<RouteResult<ResolveActionResponse>> {
    const { conversationId, actionId } = ctx.params;
    const body = ctx.body as ResolveActionRequest | undefined;
    const resolution = this.validateResolution(body);

    const initial = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!initial) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    // Who may answer: the owner of the conversation - unless the host says (`hitl.authorizeResolve`), who then decides for everyone
    const authorize = this.config.hitl?.authorizeResolve;
    if (!authorize) await this.verifyConversationAccess(initial, ctx);

    const agent = await this.getAgentFor(initial.agentId, ctx.context);
    if (!agent) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Agent not found: ${initial.agentId}` } as NotFoundError;
    }
    const useSdk = !!agent.sdkAgent;
    const supported = useSdk
      ? supportsSdkPause(agent.sdkAgent)
      : agent.host
        ? typeof agent.host.resolveAction === "function"
        : typeof agent.handler?.resolveAction === "function";
    if (!supported) {
      throw { statusCode: 404, code: "NOT_FOUND", message: "This agent does not support resolving actions" } as NotFoundError;
    }

    // Answering is a turn like any other: one at a time. An answer that meets another answer waits for it a moment;
    // a second answer to the same action then finds it answered.
    const streaming = !!body?.stream;
    const run = await this.beginResolveRun(ctx, initial, "resume", streaming);
    let resolveRun!: ResolveRun;
    let budget: TurnBudget | undefined;
    try {
      // Read again under the lease: another request may have answered since the check above
      const conversation = (await this.config.storage.getConversation(conversationId, ctx.context)) ?? initial;
      const store = readHitl(conversation.state);
      const action = store?.pending?.actions.find((a) => a.id === actionId);
      if (!store?.pending || !action) {
        throw { statusCode: 409, code: "action_not_pending", message: `Action is not pending: ${actionId}` };
      }
      if (isExpired(action)) {
        throw {
          statusCode: 410,
          code: "action_expired",
          message: `This request lapsed at ${action.expiresAt} and can no longer be answered`,
          details: { actionId, expiresAt: action.expiresAt },
        };
      }
      if (authorize && !(await authorize(ctx.context!, { conversation: this.publicConversation(conversation), action }))) {
        throw { statusCode: 403, code: "action_forbidden", message: "You are not allowed to answer this request" };
      }
      if (action.type !== resolution.type) {
        throw {
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: `resolution.type "${resolution.type}" does not match the action (${action.type})`,
        } as ValidationError;
      }

      // Edited arguments have to be arguments the tool accepts
      const edited =
        action.type === "tool_approval" &&
        resolution.type === "tool_approval" &&
        resolution.decision === "allow" &&
        resolution.approvedArgs !== undefined &&
        !isDeepStrictEqual(resolution.approvedArgs, action.args ?? {});
      // (an agent-sdk agent's tools are looked up; any other agent is checked against the schema it put on the request, if it did)
      if (edited && this.hitlFor(agent).validateApprovedArgs && (useSdk || (action as { argsSchema?: unknown }).argsSchema !== undefined)) {
        this.checkApprovedArgs(agent, action as Extract<PendingAction, { type: "tool_approval" }>, (resolution as Extract<ActionResolution, { type: "tool_approval" }>).approvedArgs!);
      }

      // Apply the decision to the paused SDK state up front, so an invalid answer is a plain 400.
      const actor = ctx.context?.user?.id ?? ctx.user?.id ?? "anonymous";
      let nextSdkState: unknown;
      if (useSdk) {
        if (store.pending.sdkState === undefined) {
          throw { statusCode: 409, code: "action_not_pending", message: `Action cannot be resumed: ${actionId}` };
        }
        try {
          nextSdkState = applySdkResolution(
            agent.sdkAgent as HitlSdkAgent,
            jsonSafe(store.pending.sdkState),
            action,
            resolution,
            ctx.context?.user?.id ?? ctx.user?.id
          );
        } catch (error) {
          throw {
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: error instanceof Error ? error.message : "Invalid resolution",
          } as ValidationError;
        }
      }

      // The answer that lets the model run again needs a budget with something left (402 before anything is recorded)
      const lastOpen = store.pending.actions.length === 1;
      if (lastOpen || !useSdk) budget = this.planTurnBudget(conversation, agent, (nextSdkState as { usage?: unknown } | undefined)?.usage);
      resolveRun = { ctx, conversation, agent, store, action, resolution, nextSdkState, metadata: body?.metadata, actor, channel: "api", edited };
    } catch (error) {
      await this.endRun(run);
      throw error;
    }

    const stream = streaming ? this.attachStream(run) : undefined;
    this.launch(run, ctx, () => this.executeResolve(run, resolveRun, budget));
    if (stream) return { status: 200, headers: SSE_HEADERS, stream: stream.generator, close: stream.close };

    const outcome = await run.done;
    if (outcome.error) throw outcome.error;
    return {
      status: 200,
      body: {
        response: publicMessage(outcome.assistant!),
        usage: outcome.usage,
        ...(outcome.status && outcome.status !== "completed" && { status: outcome.status }),
        ...(outcome.pendingActions.length > 0 && { pendingActions: outcome.pendingActions }),
        ...(outcome.warnings && { warnings: outcome.warnings }),
        stopReason: outcome.stopReason,
        runId: run.id,
        ...(outcome.budget && { budget: outcome.budget, spentUsd: outcome.spentUsd }),
      },
    };
  }

  /**
   * The approvals among `actions` with the JSON Schema of their tool's arguments, where the agent says what the tool takes (an
   * agent-sdk tool's zod / JSON schema). One that already carries a schema (a host agent set it) is left alone.
   */
  private withArgsSchemas(agent: AgentRegistration, actions: PendingAction[]): PendingAction[] {
    if (!agent.sdkAgent || !actions.some((action) => action.type === "tool_approval" && action.argsSchema === undefined)) return actions;
    return actions.map((action) => {
      if (action.type !== "tool_approval" || action.argsSchema !== undefined) return action;
      const argsSchema = toJsonSchema(findToolSchema(agent.sdkAgent, action.toolName));
      return argsSchema ? { ...action, argsSchema } : action;
    });
  }

  /** 400 `invalid_approved_args` when the tool's schema does not accept the arguments the person edited the approval to. */
  private checkApprovedArgs(
    agent: AgentRegistration,
    action: Extract<PendingAction, { type: "tool_approval" }>,
    approvedArgs: Record<string, unknown>
  ): void {
    // (a host agent has no tool list to look in: the schema it put on the action is what it says the tool takes)
    const schema = findToolSchema(agent.sdkAgent, action.toolName) ?? action.argsSchema;
    if (schema === undefined) return; // the agent does not say what the tool takes: nothing to check against
    const problem = validateAgainstSchema(schema, approvedArgs);
    if (problem) {
      throw {
        statusCode: 400,
        code: "invalid_approved_args",
        message: `The edited arguments are not valid for ${action.toolName}: ${problem}`,
        details: { toolName: action.toolName },
      };
    }
  }

  /**
   * The end of an answer that left other actions of the pause open: the answer is recorded on the message that asked, and the
   * connection hears what is still open. No turn ran, so there is no new message.
   */
  private async partialOutcome(
    run: ActiveRun,
    ctx: RouteContext,
    x: {
      conversationId: string;
      pending: NonNullable<HitlStore["pending"]>;
      action: PendingAction;
      answered: SettledAction;
      remaining: PendingAction[];
    }
  ): Promise<TurnOutcome> {
    const { conversationId, pending, action, answered, remaining } = x;
    await this.settleOnMessage(pending.messageId, new Map([[action.id, answered]]), ctx.context);

    const paused = await this.config.storage.getMessage(pending.messageId, ctx.context);
    const now = new Date();
    const assistant: Message =
      paused ?? { id: pending.messageId, conversationId, role: "assistant", content: "", createdAt: now, updatedAt: now };
    run.emit({
      frame: (seq) => ({
        type: "stream.action_required",
        timestamp: Date.now(),
        conversationId,
        messageId: assistant.id,
        actions: remaining,
        seq,
      } satisfies StreamActionRequiredEvent),
    });
    run.emit({
      frame: (seq) => ({
        type: "stream.done",
        timestamp: Date.now(),
        conversationId,
        messageId: assistant.id,
        content: typeof assistant.content === "string" ? assistant.content : JSON.stringify(assistant.content),
        status: "requires_action",
        pendingActions: remaining,
        stopReason: "requires_action",
        runId: run.id,
        seq,
      } satisfies StreamDoneEvent),
    });
    return {
      assistant,
      content: typeof assistant.content === "string" ? assistant.content : "",
      pendingActions: remaining,
      status: "requires_action",
      stopReason: "requires_action",
      partial: true,
    };
  }

  /**
   * Records one answer and, when it was the last open action of the pause, continues the turn. An answer that leaves
   * other actions open is written with a compare-and-set against the conversation as it is now (the decision applied
   * to the stored state, never to a copy read earlier), so answers to the actions of one pause lose none of each other.
   */
  private async executeResolve(run: ActiveRun, resolveRun: ResolveRun, budget?: TurnBudget): Promise<TurnOutcome> {
    const { ctx, conversation, agent, store, action, resolution, actor } = resolveRun;
    const conversationId = conversation.id;
    const pending = store.pending!;
    const sdk = agent.sdkAgent as HitlSdkAgent | undefined;

    run.emit({
      events: [
        {
          type: EVENT_TYPES.actionResolved,
          data: this.actionResolvedData(action, resolution, actor, resolveRun.channel, {
            edited: resolveRun.edited,
            expired: resolveRun.expired,
          }),
        },
      ],
      frame: (seq) => [
        {
          type: "stream.start",
          timestamp: Date.now(),
          conversationId,
          messageId: pending.messageId,
          seq,
        } satisfies StreamStartEvent,
        {
          type: "stream.action_resolved",
          timestamp: Date.now(),
          conversationId,
          actionId: action.id,
          resolution: {
            type: resolution.type,
            ...(resolution.type === "tool_approval" && { decision: resolution.decision }),
            ...(resolution.type === "user_question" && resolution.cancelled && { cancelled: true }),
            ...(resolveRun.expired && { expired: true }),
          },
          seq,
        } satisfies StreamActionResolvedEvent,
      ],
    });

    const answered: SettledAction = { status: "resolved", resolution, resolvedBy: actor, resolvedAt: new Date() };
    const remaining = pending.actions.filter((a) => a.id !== action.id);
    const allowedTools = new Set(store.allowedTools ?? []);
    const rememberAdd: string[] = [];
    const partial = { text: "" };
    let step: AgentStep;
    /** Actions of this pause that the turn did not carry on (a host agent that stopped asking for them). */
    const withdrawn = new Map<string, SettledAction>();

    if (sdk) {
      if (resolution.type === "tool_approval" && resolution.decision === "allow" && resolution.rememberForSession
        && this.config.allowRememberApproval !== false) {
        const toolName = (action as Extract<PendingAction, { type: "tool_approval" }>).toolName;
        // A per-call predicate decides on the arguments; remembering by name would skip that check.
        const runtimeTools = (agent.sdkAgent as { __runtime?: { tools?: Array<{ name?: string; needsApproval?: unknown }> } }).__runtime?.tools;
        const predicateGated = Array.isArray(runtimeTools)
          && runtimeTools.some((t) => t?.name === toolName && typeof t.needsApproval === "function");
        if (!predicateGated) {
          allowedTools.add(toolName);
          rememberAdd.push(toolName);
        }
      }

      if (remaining.length > 0) {
        // More actions of the same pause are still open: record this answer and wait.
        await this.mutateConversation(conversationId, ctx.context, (fresh) => {
          const freshStore = readHitl(fresh.state);
          const freshPending = freshStore?.pending;
          const stillOpen = freshPending?.actions.find((a) => a.id === action.id);
          if (!freshPending || !stillOpen) {
            throw { statusCode: 409, code: "action_not_pending", message: `Action is not pending: ${action.id}` };
          }
          if (freshPending.sdkState === undefined) {
            throw { statusCode: 409, code: "action_not_pending", message: `Action cannot be resumed: ${action.id}` };
          }
          const left = freshPending.actions.filter((a) => a.id !== action.id);
          if (left.length === 0) {
            throw { statusCode: 409, code: "conversation_conflict", message: "The conversation changed while the answer was recorded. Try again." };
          }
          // the decision goes onto the state as it is NOW
          const applied = applySdkResolution(sdk, jsonSafe(freshPending.sdkState), stillOpen, resolution, actor);
          const hitl: HitlStore = {
            ...freshStore,
            allowedTools: [...new Set([...(freshStore?.allowedTools ?? []), ...rememberAdd])],
            pending: { ...freshPending, actions: left, sdkState: jsonSafe(applied) },
          };
          return { state: writeHitl(fresh.state, hitl), actionDueAt: earliestDeadline(left) ?? (fresh.actionDueAt ? null : undefined) };
        });
        return this.partialOutcome(run, ctx, { conversationId, pending, action, answered, remaining });
      }

      run.emit({ events: [{ type: EVENT_TYPES.statusRunning, data: { trigger: run.trigger } }] });
      try {
        step = await this.runSdk(run, ctx, agent, resolveRun.nextSdkState, allowedTools, partial, this.turnFilesFor(conversationId, agent, ctx.context), budget!);
      } catch (error) {
        if (run.cancelled) step = cancelledStep(partial.text);
        else throw error;
      }
    } else if (agent.host) {
      run.emit({ events: [{ type: EVENT_TYPES.statusRunning, data: { trigger: run.trigger } }] });
      try {
        step = await this.runHostStep(run, {
          ctx,
          agent,
          partial,
          turn: this.turnFilesFor(conversationId, agent, ctx.context),
          budget: budget!,
          call: (host, io) =>
            host.resolveAction!(
              {
                conversationId,
                runId: run.id,
                actionId: action.id,
                action,
                resolution,
                pendingActions: remaining,
                actor,
                channel: resolveRun.channel,
                ...(resolveRun.expired && { expired: true }),
                metadata: resolveRun.metadata,
                context: ctx.context!,
              },
              io
            ),
        });
      } catch (error) {
        if (run.cancelled) step = cancelledStep(partial.text);
        else throw error;
      }

      if (stillWaiting(step, remaining)) {
        // The agent answered "I still wait on the rest": nothing happened but this answer, so there is no new message.
        // The answer is recorded on the message that asked, the others stay open there.
        await this.mutateConversation(conversationId, ctx.context, (fresh) => {
          const freshStore = readHitl(fresh.state);
          const freshPending = freshStore?.pending;
          if (!freshPending?.actions.some((a) => a.id === action.id)) {
            throw { statusCode: 409, code: "action_not_pending", message: `Action is not pending: ${action.id}` };
          }
          const left = freshPending.actions.filter((a) => a.id !== action.id);
          if (left.length === 0) {
            throw { statusCode: 409, code: "conversation_conflict", message: "The conversation changed while the answer was recorded. Try again." };
          }
          const hitl: HitlStore = { ...freshStore, pending: { ...freshPending, actions: left } };
          return { state: writeHitl(fresh.state, hitl), actionDueAt: earliestDeadline(left) ?? (fresh.actionDueAt ? null : undefined) };
        });
        run.emit({
          events: [
            {
              type: EVENT_TYPES.statusIdle,
              data: { stop_reason: "requires_action", pending_action_ids: remaining.map((a) => a.id) },
            },
          ],
        });
        return this.partialOutcome(run, ctx, { conversationId, pending, action, answered, remaining });
      }

      // Open actions the agent no longer reports (or asks again, changed, on its reply) are withdrawn from the message that asked
      for (const old of remaining) {
        if (step.pending.some((p) => p.id === old.id && sameRequest(p, old))) continue;
        withdrawn.set(old.id, { status: "cancelled", resolvedBy: "system", resolvedAt: new Date() });
        run.emit({
          events: [{ type: EVENT_TYPES.actionResolved, data: this.actionResolvedData(old, undefined, "system", "system", { cancelled: true }) }],
        });
      }
    } else {
      run.emit({ events: [{ type: EVENT_TYPES.statusRunning, data: { trigger: run.trigger } }] });
      const handler = agent.handler!;
      try {
        const raced = await run.raceCancel(
          handler.resolveAction!({
            conversationId,
            actionId: action.id,
            resolution,
            state: publicState(conversation.state),
            metadata: resolveRun.metadata,
            context: ctx.context,
            signal: run.signal,
            ...this.handlerFileReaders(this.turnFilesFor(conversationId, agent, ctx.context)),
          }),
          this.runCfg.cancelGraceMs
        );
        if ("abandoned" in raced) {
          step = cancelledStep("");
        } else {
          const result: ProcessMessageResult = raced.value;
          const newPending = result.pendingActions ?? [];
          if (run.streaming) {
            run.emit({
              frame: (seq) => ({
                type: "stream.text",
                timestamp: Date.now(),
                text: result.content,
                isFinal: true,
                seq,
              } satisfies StreamTextEvent),
            });
          }
          step = {
            content: result.content,
            files: result.files,
            usage: normalizeUsage(result.usage, { pricing: budget?.pricing }),
            pending: newPending,
            handlerState: result.state ?? conversation.state,
            handlerMetadata: result.metadata,
            cancelled: run.cancelled,
            stopReason: result.stopReason,
            handlerStatus: normalizeTurnStatus(result.status, newPending),
          };
        }
      } catch (error) {
        if (run.cancelled) step = cancelledStep("");
        else throw error;
      }
    }

    return this.finalizeTurn(run, {
      ctx,
      conversation,
      agent,
      step,
      budget: budget!,
      rememberAdd,
      settled: { messageId: pending.messageId, entries: new Map([[action.id, answered], ...withdrawn]) },
    });
  }

  // ============================================================================
  // Continue (after the budget stopped a turn)
  // ============================================================================

  /**
   * Carries on a turn the conversation's budget stopped in the middle - with no new message. The agent resumes from the
   * state it stopped in. Needs the budget to allow it (raise it first: 402 `budget_reached`), nothing to be waiting on a
   * person (409 `action_pending`) and a stopped turn to carry on (409 `nothing_to_continue`).
   */
  private async handleContinue(ctx: RouteContext): Promise<RouteResult<ResolveActionResponse>> {
    const { conversationId } = ctx.params;
    const body = (ctx.body ?? {}) as ContinueConversationRequest;
    const streaming = !!body.stream;
    const { conversation: initial, agent } = await this.loadForTurn(conversationId, ctx);

    const run = await this.beginRun(ctx, initial, "continue", "resume", streaming);
    let conversation: Conversation = initial;
    let budget!: TurnBudget;
    let carried: Record<string, unknown> | undefined;
    let allowedTools: Set<string>;
    let fromMessageId: string;
    try {
      conversation = (await this.config.storage.getConversation(conversationId, ctx.context)) ?? initial;
      const store = readHitl(conversation.state);
      if (store?.pending) {
        throw {
          statusCode: 409,
          code: "action_pending",
          message: "The conversation is waiting for a pending action to be resolved",
          details: { pendingActionIds: store.pending.actions.map((a) => a.id) },
        };
      }
      const pause = store?.budgetPause;
      if (!pause || !agent.sdkAgent) {
        throw {
          statusCode: 409,
          code: "nothing_to_continue",
          message: "No turn was stopped by the budget, so there is nothing to carry on. Send a message to go on.",
        };
      }
      // The stopped state, without the verdicts that stopped it
      carried = jsonSafe(pause.sdkState) as Record<string, unknown>;
      if (carried?.ctx && typeof carried.ctx === "object") {
        const { __limitBreached: _breached, __cancelled: _cancelled, ...rest } = carried.ctx as Record<string, unknown>;
        carried.ctx = rest;
      }
      allowedTools = new Set(store?.allowedTools ?? []);
      fromMessageId = pause.messageId;
      budget = this.planTurnBudget(conversation, agent, carried?.usage);
    } catch (error) {
      await this.endRun(run);
      throw error;
    }

    const stream = streaming ? this.attachStream(run) : undefined;
    this.launch(run, ctx, async () => {
      run.emit({
        events: [{ type: EVENT_TYPES.statusRunning, data: { trigger: run.trigger } }],
        frame: (seq) => ({
          type: "stream.start",
          timestamp: Date.now(),
          conversationId,
          messageId: fromMessageId,
          seq,
        } satisfies StreamStartEvent),
      });
      const partial = { text: "" };
      let step: AgentStep;
      try {
        step = await this.runSdk(run, ctx, agent, carried, allowedTools, partial, this.turnFilesFor(conversationId, agent, ctx.context), budget);
      } catch (error) {
        if (run.cancelled) step = cancelledStep(partial.text);
        else throw error;
      }
      return this.finalizeTurn(run, { ctx, conversation, agent, step, budget });
    });
    if (stream) return { status: 200, headers: SSE_HEADERS, stream: stream.generator, close: stream.close };

    const outcome = await run.done;
    if (outcome.error) throw outcome.error;
    return {
      status: 200,
      body: {
        response: publicMessage(outcome.assistant!),
        usage: outcome.usage,
        ...(outcome.status && outcome.status !== "completed" && { status: outcome.status }),
        ...(outcome.pendingActions.length > 0 && { pendingActions: outcome.pendingActions }),
        ...(outcome.warnings && { warnings: outcome.warnings }),
        stopReason: outcome.stopReason,
        runId: run.id,
        ...(outcome.budget && { budget: outcome.budget, spentUsd: outcome.spentUsd }),
      },
    };
  }

  // ============================================================================
  // Remembered tools
  // ============================================================================

  private async handleListRememberedTools(ctx: RouteContext): Promise<RouteResult<RememberedToolsResponse>> {
    const { conversationId } = ctx.params;
    const conversation = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!conversation) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    await this.verifyConversationAccess(conversation, ctx);
    return { status: 200, body: { tools: [...(readHitl(conversation.state)?.allowedTools ?? [])] } };
  }

  /** Takes a tool off the list of those the person asked not to be asked about again: the next call asks again. */
  private async handleRevokeRememberedTool(ctx: RouteContext): Promise<RouteResult<RememberedToolsResponse>> {
    const { conversationId } = ctx.params;
    let tool = ctx.params.tool ?? "";
    try {
      tool = decodeURIComponent(tool);
    } catch {
      // (not percent-encoded after all)
    }
    const existing = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!existing) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    await this.verifyConversationAccess(existing, ctx);

    let tools: string[] = [];
    await this.mutateConversation(conversationId, ctx.context, (fresh) => {
      const store = readHitl(fresh.state);
      if (!store?.allowedTools?.includes(tool)) {
        throw { statusCode: 404, code: "NOT_FOUND", message: `The tool is not remembered for this conversation: ${tool}` } as NotFoundError;
      }
      tools = store.allowedTools.filter((name) => name !== tool);
      return { state: writeHitl(fresh.state, { ...store, allowedTools: tools }) };
    });
    return { status: 200, body: { tools } };
  }

  // ============================================================================
  // Cancel
  // ============================================================================

  private async handleCancel(ctx: RouteContext): Promise<RouteResult<CancelConversationResponse>> {
    const { conversationId } = ctx.params;
    const conversation = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!conversation) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    await this.verifyConversationAccess(conversation, ctx);

    const result = await this.cancelConversation(conversation, ctx.context);
    // The conversation as it is now (the pause may be gone)
    const current = (await this.config.storage.getConversation(conversationId, ctx.context)) ?? conversation;
    const runtime = (await this.runtimesFor([current], ctx.context)).get(current.id)!;
    return {
      status: result.cancelled && !result.settled ? 202 : 200,
      body: { ...result, runtime },
    };
  }

  /**
   * Stops what a conversation is doing: a running turn is aborted (the SDK sees the cancellation token,
   * a handler the `signal`), a turn running on another node is asked to stop through its lease, and a
   * conversation that only waits on a human has its open actions cancelled.
   */
  private async cancelConversation(
    conversation: Conversation,
    rc?: RequestContext
  ): Promise<Omit<CancelConversationResponse, "runtime">> {
    const conversationId = conversation.id;
    const active = this.runs.get(conversationId);
    if (active) {
      active.cancel("user");
      const waited = await this.settledWithin(active, this.runCfg.cancelWaitMs);
      return { cancelled: true, runId: active.id, settled: waited, stopReason: "cancelled" };
    }

    if (this.leasesAvailable) {
      const [lease] = await this.config.storage.getLeases!([conversationLeaseKey(conversationId)], rc);
      if (lease) {
        // Another node runs it: it sees the request on its next lease renewal
        await this.config.storage.markLeaseCancel?.(lease.key, rc);
        return { cancelled: true, runId: lease.data?.runId as string | undefined, settled: false };
      }
    }

    // Not running: a conversation that waits on a human is stopped by cancelling what it waits on
    const store = readHitl(conversation.state);
    if (!store?.pending) return { cancelled: false, settled: true };

    const cancelledIds = await this.cancelPaused(conversation, rc);
    return { cancelled: cancelledIds.length > 0, settled: true, cancelledActionIds: cancelledIds, stopReason: "cancelled" };
  }

  /** Whether the run has given the conversation back within `ms`. */
  private async releasedWithin(run: ActiveRun, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run.released.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(1, ms));
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether the run has finished within `ms`. */
  private async settledWithin(run: ActiveRun, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run.done.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cancels the actions a paused conversation waits on, under the conversation lease. */
  private async cancelPaused(conversation: Conversation, rc?: RequestContext): Promise<string[]> {
    const routeCtx = { params: {}, query: {}, context: rc, user: rc?.user } as RouteContext;
    const run = await this.beginRun(routeCtx, conversation, "resolve", "resume", false);
    try {
      const closed = await this.closePause(conversation.id, rc, {
        status: () => "cancelled",
        by: rc?.user?.id ?? "anonymous",
        channel: "api",
        moreEvents: [{ type: EVENT_TYPES.statusIdle, data: { stop_reason: "cancelled" } }],
        emit: (events) => {
          run.emit({ events: events.map((e) => ({ type: e.type, data: e.data ?? {} })) });
        },
      });
      await run.flush();
      return closed.actions.map((a) => a.id);
    } finally {
      await this.endRun(run);
      if (run.taskId) await this.syncTask(run, { content: "", stopReason: "cancelled", pendingActions: [], partial: false }, rc);
    }
  }

  // ============================================================================
  // Events
  // ============================================================================

  private async handleListEvents(ctx: RouteContext): Promise<RouteResult<ListEventsResponse>> {
    const { conversationId } = ctx.params;
    const conversation = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!conversation) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    await this.verifyConversationAccess(conversation, ctx);

    const after = this.parseCursor(ctx.query.after, "after") ?? 0;
    const types = this.parseTypes(ctx.query.types);
    const limit = clampLimit(
      parseInt(String(ctx.query.limit ?? ""), 10),
      this.runCfg.eventPageSize,
      this.runCfg.maxEventPageSize
    );
    const page = await this.eventStore.list(conversationId, { after, types, limit }, ctx.context);
    return {
      status: 200,
      body: { events: page.events.map(wireEvent), hasMore: page.hasMore, lastSeq: page.lastSeq },
    };
  }

  private parseCursor(value: string | string[] | undefined, name: string): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message: `${name} must be a non-negative integer` } as ValidationError;
    }
    return n;
  }

  private parseTypes(value: string | string[] | undefined): string[] | undefined {
    const raw = Array.isArray(value) ? value.join(",") : value;
    const types = (raw ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    return types.length > 0 ? types : undefined;
  }

  private async handleEventsStream(ctx: RouteContext): Promise<RouteResult> {
    const { conversationId } = ctx.params;
    const conversation = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!conversation) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    await this.verifyConversationAccess(conversation, ctx);

    // A browser's EventSource reconnects with the id of the last frame it saw: that wins over the URL
    const headers = normalizeHeaders(ctx.headers);
    const header = Array.isArray(headers["last-event-id"]) ? headers["last-event-id"][0] : headers["last-event-id"];
    let after: number;
    try {
      after = this.parseCursor(header, "Last-Event-ID") ?? this.parseCursor(ctx.query.after, "after") ?? 0;
    } catch (error) {
      if (header === undefined) throw error;
      after = this.parseCursor(ctx.query.after, "after") ?? 0; // a header that is not a number is ignored
    }

    const follower = this.followEvents(conversationId, ctx, after, this.parseTypes(ctx.query.types));
    return { status: 200, headers: SSE_HEADERS, stream: follower.generator, close: follower.close };
  }

  /**
   * Replays the stored events after `after`, then follows the conversation live. It subscribes before it
   * reads, so nothing that happens during the replay is missed, and drops what it has already sent, so
   * nothing is sent twice. Events written by another node arrive by polling the log.
   */
  private followEvents(
    conversationId: string,
    ctx: RouteContext,
    after: number,
    types?: string[]
  ): { generator: AsyncGenerator<string, void, unknown>; close: () => void } {
    const self = this;
    const cfg = this.runCfg;
    const wanted = types ? new Set(types) : undefined;
    const queue: BusItem[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const unsubscribe = this.bus.subscribe(conversationId, (item) => {
      queue.push(item);
      wake?.();
    });
    // A run going on this node is told first: its text so far (and the person's message, which the stored history may not have yet).
    // Read in the same step as subscribing, so what the deltas that follow carry starts exactly where the snapshot stops. (A run on another
    // node streams no text here: that follower reads the stored events.) A `types` filter that names neither frame does not want it.
    const active = this.runs.get(conversationId);
    const snapshot =
      active && (!wanted || wanted.has(EVENT_TYPES.messageSnapshot) || wanted.has(EVENT_TYPES.messageDelta)) ? active.snapshot() : undefined;
    // Runs whose answer this follower has been sent as a stored event: text still queued for them is already in it
    const answered = new Set<string>();
    const noteAnswered = (event: import("./types.js").ConversationEvent): void => {
      if (event.runId && (event.type === EVENT_TYPES.message || event.type === EVENT_TYPES.statusIdle)) answered.add(event.runId);
    };

    const eventFrame = (event: import("./types.js").ConversationEvent): string | undefined =>
      !wanted || wanted.has(event.type)
        ? `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(wireEvent(event))}\n\n`
        : undefined;
    const deltaFrame = (item: Extract<BusItem, { kind: "delta" }>): string =>
      `event: ${EVENT_TYPES.messageDelta}\ndata: ${JSON.stringify({ text: item.text, ...(item.runId ? { run_id: item.runId } : {}) })}\n\n`;

    async function* generate(): AsyncGenerator<string, void, unknown> {
      let cursor = after;
      let lastWrite = Date.now();
      let lastPoll = Date.now();
      const deadline = Date.now() + cfg.maxStreamMs;
      const written = () => {
        lastWrite = Date.now();
      };

      // Everything stored after the cursor, in order
      async function* catchUp(): AsyncGenerator<string, void, unknown> {
        for (;;) {
          const page = await self.eventStore.list(conversationId, { after: cursor, limit: 200 }, ctx.context);
          for (const event of page.events) {
            cursor = event.seq;
            noteAnswered(event);
            const frame = eventFrame(event);
            if (frame) {
              written();
              yield frame;
            }
          }
          if (!page.hasMore || closed) return;
        }
      }

      try {
        yield ": open\n\n";
        written();
        if (snapshot) {
          yield snapshotFrame(snapshot);
          written();
        }
        yield* catchUp();

        while (!closed && Date.now() < deadline) {
          while (queue.length > 0) {
            const item = queue.shift()!;
            if (item.kind === "closed") return;
            if (item.kind === "delta") {
              // A chunk of text of an answer this follower was already sent as a stored event is stale; any other is not (events of the
              // same run stored in between - a tool call - say nothing about the text that is still queued)
              if (!(item.runId && answered.has(item.runId)) && (!wanted || wanted.has(EVENT_TYPES.messageDelta))) {
                written();
                yield deltaFrame(item);
              }
              continue;
            }
            const event = item.event;
            if (event.seq <= cursor) continue; // already sent (it was stored while we replayed)
            if (event.seq > cursor + 1) {
              // Something stored in between that we have not seen (another node, a slower writer): read it in order
              yield* catchUp();
              if (event.seq <= cursor) continue;
            }
            cursor = event.seq;
            noteAnswered(event);
            const frame = eventFrame(event);
            if (frame) {
              written();
              yield frame;
            }
          }
          if (closed) return;

          // Wait for something to happen, a ping to be due, or the log to be polled
          const now = Date.now();
          const local = self.runs.has(conversationId);
          const due = Math.min(lastWrite + cfg.pingIntervalMs, local ? Infinity : lastPoll + cfg.followPollMs, deadline);
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, Math.max(0, due - now));
          });
          clearTimeout(timer);
          wake = undefined;
          if (closed) return;
          if (queue.length > 0) continue;

          if (!self.runs.has(conversationId) && Date.now() >= lastPoll + cfg.followPollMs) {
            lastPoll = Date.now();
            yield* catchUp();
          }
          if (Date.now() >= lastWrite + cfg.pingIntervalMs) {
            written();
            yield ": ping\n\n";
          }
        }
      } finally {
        unsubscribe();
      }
    }

    return {
      generator: generate(),
      close: () => {
        closed = true;
        unsubscribe();
        wake?.();
      },
    };
  }

  // ============================================================================
  // Runtime
  // ============================================================================

  /** Summaries of the event logs of these conversations (last sequence number, last stop reason). */
  private async eventSummaries(ids: string[], rc?: RequestContext): Promise<Record<string, EventSummary>> {
    const store = this.eventStore;
    if (store.summary) return store.summary(ids, rc);
    // A custom log without summaries: two small reads per conversation
    const out: Record<string, EventSummary> = {};
    for (const id of ids) {
      const last = (await store.list(id, { order: "desc", limit: 1 }, rc)).events[0];
      if (!last) continue;
      const idle = (await store.list(id, { order: "desc", limit: 1, types: [EVENT_TYPES.statusRunning, EVENT_TYPES.statusIdle] }, rc)).events[0];
      const stop = idle?.type === EVENT_TYPES.statusIdle ? idle.data.stop_reason : undefined;
      out[id] = { lastSeq: last.seq, ...(typeof stop === "string" ? { stopReason: stop } : {}) };
    }
    return out;
  }

  /** Where each conversation is in its run lifecycle. A failure to read the log does not fail the request. */
  private async runtimesFor(
    conversations: Conversation[],
    rc?: RequestContext
  ): Promise<Map<string, ConversationRuntime>> {
    const ids = conversations.map((c) => c.id);
    let summaries: Record<string, EventSummary> = {};
    let leases: Lease[] = [];
    try {
      [summaries, leases] = await Promise.all([
        this.eventSummaries(ids, rc),
        this.leasesAvailable && ids.length > 0
          ? this.config.storage.getLeases!(ids.map(conversationLeaseKey), rc)
          : Promise.resolve([] as Lease[]),
      ]);
    } catch (error) {
      console.error("[AgentServer] Could not read the run state of conversations:", error);
    }
    const leaseByKey = new Map(leases.map((lease) => [lease.key, lease]));

    // Why a turn ended in error is in the log, not in the summary: asked only for the conversations that did
    const failed = conversations.filter((conversation) => {
      if (this.runs.has(conversation.id) || leaseByKey.has(conversationLeaseKey(conversation.id))) return false;
      return summaries[conversation.id]?.stopReason === "error";
    });
    const errors = new Map<string, RuntimeError>();
    await Promise.all(
      failed.map(async (conversation) => {
        const error = await this.lastRunError(conversation.id, rc);
        if (error) errors.set(conversation.id, error);
      })
    );

    const out = new Map<string, ConversationRuntime>();
    for (const conversation of conversations) {
      const active = this.runs.get(conversation.id);
      const lease = leaseByKey.get(conversationLeaseKey(conversation.id));
      const summary = summaries[conversation.id];
      const pendingActionIds = readHitl(conversation.state)?.pending?.actions.map((a) => a.id) ?? [];
      const activeRunId = active?.id ?? (lease?.data?.runId as string | undefined);
      const running = !!active || !!lease;
      const stop = summary?.stopReason as StopReason | undefined;
      // Paused on its budget: the last turn stopped on it and either
      //  - the turn was cut short, and its state is kept to carry on from (`budgetPause`): it stays paused after the budget is
      //    raised or removed, until `POST .../continue` carries it on or a new message gives it up; or
      //  - the turn finished its answer as it crossed the limit, the conversation is set to wait, and the budget is still used up
      //    (raising or removing it makes the conversation idle again: there is nothing to carry on).
      const budget = this.effectiveBudget(conversation);
      const budgetPaused =
        stop === "budget_reached" &&
        (!!readHitl(conversation.state)?.budgetPause ||
          (budget?.onReach === "pause" && this.spentOf(conversation) >= budget.maxCostUsd));
      const status: ConversationRuntime["status"] = running
        ? "running"
        : pendingActionIds.length > 0
          ? "requires_action"
          : budgetPaused
            ? "budget_paused"
            : "idle";
      out.set(conversation.id, {
        status,
        ...(!running && (stop ?? (status === "requires_action" ? "requires_action" : undefined))
          ? { stopReason: (stop ?? "requires_action") as StopReason }
          : {}),
        lastEventSeq: summary?.lastSeq ?? 0,
        pendingActionIds,
        ...(running && activeRunId ? { activeRunId } : {}),
        ...(!running && errors.has(conversation.id) ? { error: errors.get(conversation.id) } : {}),
      });
    }
    return out;
  }

  /**
   * The failure the newest turn of a conversation ended with: the `session.error` event of its run (`run_interrupted` for a run whose
   * process died). `undefined` when that turn left none - a handler that merely reported `stopReason: "error"` - or the log cannot be read.
   */
  private async lastRunError(conversationId: string, rc?: RequestContext): Promise<RuntimeError | undefined> {
    try {
      // Newest first: the idle that ended the turn, then (if it failed with a message) its error, then where the turn began
      const newest = (
        await this.eventStore.list(
          conversationId,
          { order: "desc", limit: 3, types: [EVENT_TYPES.statusIdle, EVENT_TYPES.error, EVENT_TYPES.statusRunning] },
          rc
        )
      ).events;
      if (newest[0]?.type !== EVENT_TYPES.statusIdle) return undefined;
      const failure = newest[1]?.type === EVENT_TYPES.error ? newest[1] : undefined;
      if (!failure) return undefined;
      const code = failure.data.code ?? newest[0].data.detail;
      return {
        code: typeof code === "string" && code !== "" ? code : "INTERNAL_ERROR",
        message: typeof failure.data.message === "string" ? failure.data.message : "The turn failed",
      };
    } catch {
      // (the log failing to answer must not fail the request that only wanted to know the status)
      return undefined;
    }
  }

  // ============================================================================
  // Recovery
  // ============================================================================

  /** Starts the recovery and the periodic sweep, once, at the first request. */
  private ensureMaintenance(): void {
    if (this.maintenanceStarted || this.closed) return;
    this.maintenanceStarted = true;
    if (this.runCfg.recoverOnStart) void this.sweep();
    if (this.runCfg.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), this.runCfg.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  private async sweep(): Promise<void> {
    if (this.closed || this.sweeping || !this.config.storage.isConnected()) return;
    this.sweeping = true;
    try {
      await this.recoverStaleRuns();
      // (the turns it sets going are runs like any other: the sweep does not wait for them)
      await this.expireLapsed({}, false);
      await this.pruneOldEvents();
      await this.purgeDueFiles();
    } catch (error) {
      // The store going away under a sweep (shutdown) is not a failure worth a log line
      if (!this.config.storage.isConnected() || /closed|not connected|disconnect/i.test((error as Error)?.message ?? "")) return;
      if (!this.sweepWarned) {
        this.sweepWarned = true;
        console.error("[AgentServer] The recovery sweep failed (further failures are not logged):", error);
      }
    } finally {
      this.sweeping = false;
    }
  }

  // ============================================================================
  // Requests that lapsed
  // ============================================================================

  /**
   * Handles the approvals and questions nobody answered in time (`PendingAction.expiresAt`), per the agent's
   * `onTimeout`: `"deny"` answers each as a refusal (a question as skipped) and, once nothing else is open, lets the agent carry
   * on - as a run of its own, `session.status_running` with `trigger: "timeout"`; `"cancel"` drops the pause, and the turn ends with
   * `stopReason: "cancelled"`. The server does it by itself in the recovery sweep (`runs.sweepIntervalMs`); call it to do it
   * now. With `conversationId` it looks at that conversation only (also for a store without `capabilities().actionDeadlines`,
   * which the sweep cannot search). Resolves when the continuations it started have finished.
   */
  async expirePendingActions(
    options: { now?: Date; conversationId?: string } = {}
  ): Promise<{ conversations: number; expired: number; denied: number; continued: number }> {
    return this.expireLapsed(options, true);
  }

  private async expireLapsed(
    options: { now?: Date; conversationId?: string },
    wait: boolean
  ): Promise<{ conversations: number; expired: number; denied: number; continued: number }> {
    const storage = this.config.storage;
    const now = options.now ?? new Date();
    const rc = this.systemContext();
    const result = { conversations: 0, expired: 0, denied: 0, continued: 0 };
    const continuing: Promise<unknown>[] = [];

    const handle = async (conversation: Conversation): Promise<boolean> => {
      try {
        return await this.expireConversation(conversation, now, result, continuing);
      } catch (error) {
        console.error(`[AgentServer] Could not handle the expired requests of conversation ${conversation.id}:`, error);
        return false;
      }
    };

    if (options.conversationId) {
      const conversation = await storage.getConversation(options.conversationId, rc);
      if (conversation) await handle(conversation);
    } else if (storage.capabilities?.().actionDeadlines === true) {
      // A handled conversation leaves the due list; one that could not be handled (it is busy) stays, so the page skips it
      let skip = 0;
      for (let round = 0; round < 40; round++) {
        const page = await storage.getConversations({ actionDueBefore: now, limit: 50, offset: skip }, rc);
        if (page.data.length === 0) break;
        for (const conversation of page.data) {
          if (!(await handle(conversation))) skip++;
        }
        if (page.data.length < 50) break;
      }
    }
    if (wait) await Promise.all(continuing);
    return result;
  }

  /** Resolves whether the conversation's deadline marker is dealt with (false: it is busy, try again next time). */
  private async expireConversation(
    conversation: Conversation,
    now: Date,
    result: { conversations: number; expired: number; denied: number; continued: number },
    continuing: Promise<unknown>[]
  ): Promise<boolean> {
    const storage = this.config.storage;
    const owner: RequestContext = {
      user: conversation.userId ? { id: conversation.userId } : undefined,
      data: { system: true, timeout: true },
    };
    const routeCtx = { params: {}, query: {}, context: owner, user: owner.user } as RouteContext;

    let run: ActiveRun;
    try {
      run = await this.beginRun(routeCtx, conversation, "resolve", "timeout", false);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "conversation_busy") return false;
      throw error;
    }

    // Under the lease: look at the conversation as it is now
    let handedOver = false;
    let dropped = false;
    try {
      const fresh = (await storage.getConversation(conversation.id, owner)) ?? conversation;
      const store = readHitl(fresh.state);
      const due = store?.pending?.actions.filter((action) => isExpired(action, now)) ?? [];
      if (!store?.pending || due.length === 0) {
        // The marker is out of date (the pause was answered, or its next deadline is later): put it right
        await this.mutateConversation(fresh.id, owner, (current) => {
          const wanted = earliestDeadline(readHitl(current.state)?.pending?.actions ?? []);
          if ((wanted?.getTime() ?? null) === (current.actionDueAt?.getTime() ?? null)) return null;
          return { actionDueAt: wanted ?? null };
        });
        return true;
      }

      result.conversations++;
      const agent = await this.getAgentFor(fresh.agentId, owner).catch(() => undefined);
      const policy = store.pending.onTimeout ?? this.hitlFor(agent).onTimeout;
      if (policy === "deny" && !agent) {
        console.warn(
          `[AgentServer] Conversation ${fresh.id}: agent "${fresh.agentId}" could not be resolved for the timeout sweep, so its lapsed request was cancelled instead of denied. ` +
            "A per-request agents registry (and tenant-scoped storage) has to resolve for the sweep's own context too: { user: <owner>, data: { system: true, timeout: true } }."
        );
      }
      const sdkAgent = agent?.sdkAgent;
      let budget: TurnBudget | undefined;
      let canDeny =
        policy === "deny" &&
        !!agent &&
        (sdkAgent
          ? supportsSdkPause(sdkAgent) && store.pending.sdkState !== undefined
          : typeof (agent.host ?? agent.handler)?.resolveAction === "function");
      if (canDeny) {
        // (the continuation needs a budget with something left)
        try {
          budget = this.planTurnBudget(fresh, agent!, (store.pending.sdkState as { usage?: unknown } | undefined)?.usage);
        } catch {
          canDeny = false;
        }
      }

      if (!canDeny) {
        // Drop the pause: the lapsed requests are expired, the ones still open are withdrawn with them
        const closed = await this.closePause(fresh.id, owner, {
          status: (action) => (isExpired(action, now) ? "expired" : "cancelled"),
          by: "system:timeout",
          channel: "timeout",
          moreEvents: [{ type: EVENT_TYPES.statusIdle, data: { stop_reason: "cancelled", detail: "action_expired" } }],
          emit: (events) => {
            run.emit({ events: events.map((e) => ({ type: e.type, data: e.data ?? {} })) });
          },
        });
        await run.flush();
        result.expired += closed.actions.filter((action) => isExpired(action, now)).length;
        dropped = closed.actions.length > 0;
        return true;
      }

      // Answer every lapsed request as a refusal; the answer that closes the pause lets the agent carry on
      const dueIds = due.map((action) => action.id);
      handedOver = true;
      this.launch(run, routeCtx, async () => {
        let outcome: TurnOutcome = { content: "", stopReason: "requires_action", pendingActions: [], partial: true };
        for (const id of dueIds) {
          const current = await storage.getConversation(fresh.id, owner);
          const currentStore = current ? readHitl(current.state) : undefined;
          const action = currentStore?.pending?.actions.find((a) => a.id === id);
          if (!current || !currentStore?.pending || !action) continue;
          const resolution: ActionResolution =
            action.type === "tool_approval"
              ? { type: "tool_approval", decision: "deny", comment: "timed out" }
              : { type: "user_question", answers: {}, cancelled: true };
          const nextSdkState = sdkAgent
            ? applySdkResolution(sdkAgent as HitlSdkAgent, jsonSafe(currentStore.pending.sdkState), action, resolution, "system:timeout")
            : undefined;
          const lastOpen = currentStore.pending.actions.length === 1;
          const plan = lastOpen || !sdkAgent ? this.planTurnBudget(current, agent!, (nextSdkState as { usage?: unknown } | undefined)?.usage) : undefined;
          outcome = await this.executeResolve(
            run,
            {
              ctx: routeCtx,
              conversation: current,
              agent: agent!,
              store: currentStore,
              action,
              resolution,
              nextSdkState,
              actor: "system:timeout",
              channel: "timeout",
              edited: false,
              expired: true,
            },
            plan ?? budget
          );
          result.denied++;
        }
        if (!outcome.partial) result.continued++;
        return outcome;
      });
      continuing.push(run.done);
      return true;
    } finally {
      if (!handedOver) {
        await run.flush().catch(() => undefined);
        await this.endRun(run);
        // (a task whose request lapsed under "cancel" ends cancelled)
        if (dropped && run.taskId) {
          await this.syncTask(run, { content: "", stopReason: "cancelled", pendingActions: [], partial: false }, owner).catch(() => undefined);
        }
      }
    }
  }

  private async pruneOldEvents(): Promise<void> {
    const days = this.runCfg.eventRetentionDays;
    if (days <= 0 || Date.now() - this.lastPrune < 3_600_000) return;
    this.lastPrune = Date.now();
    await this.eventStore.prune?.(new Date(Date.now() - days * 86_400_000), this.systemContext());
  }

  /** The periodic file purge: at most once per `files.purgeIntervalMs`, and (with storage leases) on one node at a time. */
  private async purgeDueFiles(): Promise<void> {
    const interval = this.config.files?.purgeIntervalMs ?? FILES_DEFAULTS.purgeIntervalMs;
    if (interval <= 0 || Date.now() - this.lastFilePurge < interval) return;
    this.lastFilePurge = Date.now();
    await this.purgeExpiredFiles();
  }

  /**
   * Deletes the files past their retention (`files.retentionDays`) - record and content - and resolves how many.
   * The server does it by itself every `files.purgeIntervalMs`; call it to do it now (or when the sweep is off).
   * With storage leases only one node purges at a time (the others get 0).
   */
  async purgeExpiredFiles(): Promise<number> {
    const storage = this.config.storage;
    if (!this.filesIndexed || !storage.isConnected()) return 0;
    const rc = this.systemContext();
    const key = "files:purge";
    if (this.leasesAvailable) {
      const claim = await storage.acquireLease!({ key, owner: this.nodeId, ttlMs: 120_000 }, rc);
      if (!claim.acquired) return 0;
    }
    let purged = 0;
    try {
      // A batch at a time, so one sweep never holds the store for long
      for (let batch = 0; batch < 20; batch++) {
        const deleted = await storage.purgeExpiredFiles!({ before: new Date(), limit: 500 }, rc);
        purged += deleted;
        if (deleted < 500) break;
      }
    } finally {
      if (this.leasesAvailable) await storage.releaseLease!({ key, owner: this.nodeId }, rc).catch(() => undefined);
    }
    return purged;
  }

  /**
   * Cleans up after runs that died with their process: a run whose lease expired never wrote its
   * `session.status_idle`, so it is closed as interrupted (`stop_reason: "error"`); a task that was left
   * `running` with nothing alive behind it is failed. Runs once at the first request and periodically;
   * call it yourself after starting a server for a store that was in use before.
   */
  async recoverStaleRuns(): Promise<{ conversations: number; tasks: number }> {
    const rc = this.systemContext();
    let conversations = 0;
    let tasks = 0;

    if (this.leasesAvailable) {
      const seen = new Set<string>();
      for (;;) {
        const expired = (await this.config.storage.listExpiredLeases?.({ prefix: "conv:", limit: 100 }, rc)) ?? [];
        const fresh = expired.filter((lease) => !seen.has(lease.key));
        if (fresh.length === 0) break;
        for (const lease of fresh) {
          seen.add(lease.key);
          // Whoever takes the lease over cleans up; the others find it taken
          const claim = await this.config.storage.acquireLease!(
            { key: lease.key, owner: this.nodeId, ttlMs: 30_000, data: lease.data },
            rc
          );
          if (!claim.acquired) continue;
          try {
            if (claim.takenOver && (await this.closeInterruptedRun(claim.takenOver, rc))) conversations++;
          } catch (error) {
            console.error(`[AgentServer] Could not recover ${lease.key}:`, error);
          } finally {
            await this.config.storage.releaseLease!({ key: lease.key, owner: this.nodeId }, rc);
          }
        }
        if (expired.length < 100) break;
      }
    }

    tasks = await this.failStaleTasks(rc);
    return { conversations, tasks };
  }

  /** Writes the end of a run whose holder died, if it never wrote one. Resolves whether it did. */
  private async closeInterruptedRun(lease: Lease, rc?: RequestContext): Promise<boolean> {
    const conversationId =
      (lease.data?.conversationId as string | undefined) ?? lease.key.slice(conversationLeaseKey("").length);
    const runId = lease.data?.runId as string | undefined;
    const last = (
      await this.eventStore.list(
        conversationId,
        { types: [EVENT_TYPES.statusRunning, EVENT_TYPES.statusIdle], order: "desc", limit: 1 },
        rc
      )
    ).events[0];
    // Never started, or finished and only failed to give the lease back
    if (!last || last.type !== EVENT_TYPES.statusRunning) return false;
    try {
      const stored = await this.eventStore.append(
        conversationId,
        [
          {
            type: EVENT_TYPES.error,
            data: { message: "The run was interrupted before it finished (the server stopped or restarted).", code: "run_interrupted" },
            runId,
          },
          { type: EVENT_TYPES.statusIdle, data: { stop_reason: "error", detail: "run_interrupted" }, runId },
        ],
        rc
      );
      for (const event of stored) this.bus.publish(conversationId, { kind: "event", event });
    } catch (error) {
      // The conversation was deleted while its run was dead: nothing left to close
      if ((error as { statusCode?: number } | null)?.statusCode === 404) return false;
      throw error;
    }
    return true;
  }

  /** Fails the tasks that say `running` while nothing is running them. */
  private async failStaleTasks(rc: RequestContext): Promise<number> {
    let failed = 0;
    const storage = this.config.storage;
    const staleBefore = Date.now() - this.runCfg.leaseTtlMs;
    for (const status of ["running", "pending"] as const) {
      for (let offset = 0; ; ) {
        const page = await storage.getTasks({ status, limit: 100, offset }, rc);
        const stale: Task[] = [];
        const keys = page.data.filter((t) => t.conversationId).map((t) => conversationLeaseKey(t.conversationId!));
        const live = this.leasesAvailable && keys.length > 0 ? await storage.getLeases!(keys, rc) : [];
        const liveKeys = new Set(live.map((l) => l.key));
        for (const task of page.data) {
          if (task.conversationId && (this.runs.has(task.conversationId) || liveKeys.has(conversationLeaseKey(task.conversationId)))) continue;
          if (this.leasesAvailable) {
            // Other nodes may be processing it: only what has been quiet for longer than a lease lives is stale
            if (task.updatedAt.getTime() > staleBefore) continue;
          } else if (!this.runCfg.assumeSingleNode) {
            continue;
          } else if (task.updatedAt.getTime() >= this.startedAt) {
            // Without leases the only evidence is time: what this process has touched is its own
            continue;
          }
          stale.push(task);
        }
        for (const task of stale) {
          await storage.updateTask(
            task.id,
            { status: "failed", completedAt: new Date(), error: "The server stopped while the task was running" },
            rc
          );
          failed++;
          if (task.callbackUrl) await this.sendTaskCallback(task.callbackUrl, task.id, "failed", "The server stopped while the task was running");
        }
        // Failing a task takes it out of this listing: only move on by the ones that stayed
        offset += page.data.length - stale.length;
        if (!page.hasMore || page.data.length === 0) break;
      }
    }
    return failed;
  }

  /**
   * Stops the periodic sweep. Running turns are left alone unless `abort` is set, which cancels them
   * and waits (up to `cancelWaitMs`) for them to finish.
   */
  async close(options: { abort?: boolean } = {}): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    if (options.abort) {
      const active = [...this.runs.values()];
      for (const run of active) run.cancel("shutdown");
      await Promise.all(active.map((run) => this.settledWithin(run, this.runCfg.cancelWaitMs)));
    }
  }

  // ============================================================================
  // Files
  // ============================================================================

  /** Refuses what the agent's files settings do not allow, before anything is stored. */
  private checkIncomingFile(cfg: ResolvedFilesConfig, file: IncomingFile): void {
    if (!cfg.enabled) {
      throw { statusCode: 403, code: "attachments_disabled", message: "This agent does not take attachments." };
    }
    if (file.bytes.length === 0) {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message: "File is empty" } as ValidationError;
    }
    if (file.bytes.length > cfg.maxFileSize) throw this.fileTooLarge(cfg.maxFileSize);
    if (!isMimeAllowed(file.mimeType, cfg.allowedMimeTypes)) {
      throw {
        statusCode: 415,
        code: "unsupported_file_type",
        message: `Files of type "${file.mimeType}" are not accepted by this agent.`,
        details: { mimeType: file.mimeType, allowedMimeTypes: cfg.allowedMimeTypes },
      };
    }
  }

  private fileTooLarge(maxBytes: number) {
    return {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `File size exceeds limit of ${maxBytes} bytes`,
      details: { reason: "file_too_large", maxBytes },
    };
  }

  /** 409 `too_many_files` when the conversation cannot hold `adding` more files (needs the provider's file index). */
  private async checkRoomForFiles(
    cfg: ResolvedFilesConfig,
    conversationId: string,
    adding: number,
    ctx: RouteContext
  ): Promise<void> {
    if (adding <= 0 || !this.filesIndexed) return;
    const held = (await this.config.storage.listFiles!({ conversationId, limit: 1 }, ctx.context)).total;
    if (held + adding > cfg.maxFiles) {
      throw {
        statusCode: 409,
        code: "too_many_files",
        message: `A conversation holds at most ${cfg.maxFiles} files. Delete one to attach another.`,
        details: { maxFiles: cfg.maxFiles, held },
      };
    }
  }

  /** When the retention sweep deletes a file uploaded now. */
  private retentionExpiry(cfg: ResolvedFilesConfig): Date | undefined {
    return cfg.retentionDays > 0 ? new Date(Date.now() + cfg.retentionDays * 86_400_000) : undefined;
  }

  /** Stores a file for the caller: owned by them, in the conversation, due for the retention sweep. */
  private async saveIncomingFile(
    ctx: RouteContext,
    x: { file: IncomingFile; cfg: ResolvedFilesConfig; conversation?: Conversation; metadata?: Record<string, unknown> }
  ): Promise<FileRecord> {
    return this.config.storage.saveFile(
      {
        name: x.file.name,
        mimeType: x.file.mimeType,
        content: x.file.bytes,
        conversationId: x.conversation?.id,
        agentId: x.conversation?.agentId,
        userId: await this.effectiveUserId(ctx),
        expiresAt: this.retentionExpiry(x.cfg),
        metadata: x.metadata,
      },
      ctx.context
    );
  }

  /**
   * The stored files a message attaches by id (`fileIds`) and the files it sends inline. Refuses before the
   * turn starts: a malformed list or too many files (400), an id that is not a file of this conversation that
   * the caller uploaded (404, the same answer for a missing file and someone else's), an agent that takes no
   * files (403), a type it does not accept (415), a conversation that is full (409).
   */
  private async prepareAttachments(
    loaded: { conversation: Conversation; agent: AgentRegistration },
    body: SendMessageRequest | undefined,
    ctx: RouteContext
  ): Promise<PreparedAttachments> {
    const { conversation } = loaded;
    const cfg = this.filesConfigFor(loaded.agent);
    const bad = (message: string): never => {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message } as ValidationError;
    };

    const rawIds = body?.fileIds;
    if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string" || id.length === 0))) {
      bad("fileIds must be an array of file ids");
    }
    const ids = [...new Set((rawIds as string[] | undefined) ?? [])];

    // (`files: null` has always meant none)
    const rawInline = body?.files ?? undefined;
    if (rawInline !== undefined && !Array.isArray(rawInline)) bad("files must be an array");
    const inlineEntries = rawInline ?? [];

    const maxFiles = this.config.limits?.maxFiles ?? FILES_DEFAULTS.maxFiles;
    if (ids.length + inlineEntries.length > maxFiles) bad(`A message can attach at most ${maxFiles} files`);
    if (ids.length + inlineEntries.length === 0) return { refs: [], inline: [], cfg };
    if (!cfg.enabled) {
      throw { statusCode: 403, code: "attachments_disabled", message: "This agent does not take attachments." };
    }

    const refs: FileAttachment[] = [];
    for (const id of ids) {
      const file = await this.config.storage.getFile(id, ctx.context);
      // A file of another conversation or another user is "not found", like one that does not exist
      if (!file || file.conversationId !== conversation.id || !(await this.fileVisible(file, ctx, conversation))) {
        throw this.fileNotFound(id);
      }
      refs.push({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size });
    }

    const inline: IncomingFile[] = [];
    for (const entry of inlineEntries) {
      if (!entry || typeof entry.name !== "string" || !entry.name || typeof entry.content !== "string" || typeof entry.mimeType !== "string") {
        bad("files[].name, files[].content (base64) and files[].mimeType are required");
      }
      if (Math.floor((entry.content.length * 3) / 4) > cfg.maxFileSize + 3) throw this.fileTooLarge(cfg.maxFileSize);
      const file: IncomingFile = {
        name: entry.name,
        mimeType: resolveUploadMimeType(entry.mimeType, entry.name),
        bytes: Buffer.from(entry.content, "base64"),
      };
      this.checkIncomingFile(cfg, file);
      inline.push(file);
    }
    await this.checkRoomForFiles(cfg, conversation.id, inline.length, ctx);
    return { refs, inline, cfg };
  }

  /** Every file the conversation holds, oldest first. */
  private async conversationFiles(conversationId: string, rc?: RequestContext): Promise<FileRecord[]> {
    const storage = this.config.storage;
    if (this.filesIndexed) {
      const all: FileRecord[] = [];
      for (let offset = 0; ; ) {
        const page = await storage.listFiles!({ conversationId, limit: 200, offset }, rc);
        all.push(...page.data);
        offset += page.data.length;
        if (!page.hasMore || page.data.length === 0) return all;
      }
    }
    // A provider without a file index only knows the files that messages carry
    const seen = new Set<string>();
    const out: FileRecord[] = [];
    for (const message of await this.loadHistory(conversationId, rc)) {
      for (const attached of message.files ?? []) {
        if (seen.has(attached.id)) continue;
        seen.add(attached.id);
        const record = await storage.getFile(attached.id, rc);
        if (record && record.conversationId === conversationId) out.push(record);
      }
    }
    return out;
  }

  /** What the tools and the model wrapper of a turn need to know about the conversation's files (turn.ts). */
  private turnFilesFor(conversationId: string, agent: AgentRegistration, rc?: RequestContext): TurnFiles {
    const cfg = this.filesConfigFor(agent);
    const storage = this.config.storage;
    const records = new Map<string, Promise<FileRecord | null>>();
    const bytes = new Map<string, Promise<Buffer | null>>();

    // A file of THIS conversation, else it does not exist for the agent
    const find = (fileId: string): Promise<FileRecord | null> => {
      let found = records.get(fileId);
      if (!found) {
        found = storage.getFile(fileId, rc).then((record) => (record && record.conversationId === conversationId ? record : null));
        records.set(fileId, found);
      }
      return found;
    };
    const content = (fileId: string): Promise<Buffer | null> => {
      let found = bytes.get(fileId);
      if (!found) {
        found = storage.getFileContent(fileId, rc);
        bytes.set(fileId, found);
      }
      return found;
    };
    const images: ImageSource = {
      async find(fileId) {
        const record = await find(fileId).catch(() => null);
        return record && isVisionImageMime(record.mimeType) ? { name: record.name, size: record.size } : null;
      },
      async read(fileId) {
        const record = await find(fileId);
        if (!record || !isVisionImageMime(record.mimeType)) return null;
        const data = await content(fileId);
        return data ? { bytes: data, mediaType: record.mimeType } : null;
      },
    };
    return {
      conversationId,
      cfg,
      list: () => this.conversationFiles(conversationId, rc),
      find,
      text: (record) => this.extractor.extract(extractInfo(record), () => content(record.id), cfg.extractText),
      bytes: (record) => content(record.id),
      images,
      viewImageTool: this.agentCanViewImages(agent, cfg),
    };
  }

  /** How a turn finds and reads the files its messages carry. */
  private attachmentSource(turn: TurnFiles): AttachmentSource {
    return { find: turn.find, text: turn.text };
  }

  /** The readers a custom handler gets for the files of its conversation. */
  private handlerFileReaders(turn: TurnFiles): Pick<ProcessMessageParams, "getFileContent" | "getFileText"> {
    return {
      getFileContent: async (fileId) => {
        const record = await turn.find(fileId).catch(() => null);
        return record ? turn.bytes(record).catch(() => null) : null;
      },
      getFileText: async (fileId) => {
        const record = await turn.find(fileId).catch(() => null);
        return record ? turn.text(record) : null;
      },
    };
  }

  private async handleUploadFile(
    ctx: RouteContext
  ): Promise<RouteResult<UploadFileResponse>> {
    const upload = this.parseUpload(ctx);

    // The conversation the file is for decides whose settings apply
    let conversation: Conversation | undefined;
    let agent: AgentRegistration | undefined;
    if (upload.conversationId) {
      const found = await this.config.storage.getConversation(upload.conversationId, ctx.context);
      if (!found) {
        throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${upload.conversationId}` } as NotFoundError;
      }
      await this.verifyConversationAccess(found, ctx);
      conversation = found;
      agent = await this.getAgentFor(found.agentId, ctx.context);
    }
    const cfg = this.filesConfigFor(agent);
    if (!cfg.enabled) {
      throw { statusCode: 403, code: "attachments_disabled", message: "This agent does not take attachments." };
    }

    let bytes: Buffer;
    if (typeof upload.content === "string") {
      if (upload.content === "") {
        // A named but empty file gets its own message: it is the user's file, not a malformed request
        throw { statusCode: 400, code: "VALIDATION_ERROR", message: "File is empty" } as ValidationError;
      }
      // Check the size from the base64 length before decoding: the text is about a third larger than the file
      if (Math.floor((upload.content.length * 3) / 4) > cfg.maxFileSize + 3) throw this.fileTooLarge(cfg.maxFileSize);
      bytes = Buffer.from(upload.content, "base64");
    } else {
      bytes = upload.content;
    }
    const file: IncomingFile = { name: upload.name, mimeType: resolveUploadMimeType(upload.mimeType, upload.name), bytes };
    // (base64 that decodes to nothing - whitespace, bare padding - is an empty file too)
    this.checkIncomingFile(cfg, file);

    // Room for one more is checked and the file stored as one step per conversation: uploads that arrive together are let in one
    // after the other, so the limit holds for them
    const record = conversation
      ? await this.withUploadLock(conversation.id, async () => {
          await this.checkRoomForFiles(cfg, conversation.id, 1, ctx);
          const saved = await this.saveIncomingFile(ctx, { file, cfg, conversation, metadata: upload.metadata });
          await this.confirmRoomForFile(cfg, saved, ctx);
          return saved;
        })
      : await this.saveIncomingFile(ctx, { file, cfg, conversation, metadata: upload.metadata });
    return {
      status: 201,
      body: { file: record },
    };
  }

  /** Uploads to one conversation, one at a time (in this process). */
  private uploadLocks = new Map<string, Promise<void>>();

  private async withUploadLock<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.uploadLocks.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.uploadLocks.set(conversationId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.uploadLocks.get(conversationId) === tail) this.uploadLocks.delete(conversationId);
    }
  }

  /**
   * After a file is stored: it has to be among the first `maxFiles` the conversation holds (oldest first), else it is taken
   * back out and the upload is refused. The check before storing cannot see an upload another node is making at the same
   * moment; this one can, and the files that were there first keep their place.
   */
  private async confirmRoomForFile(cfg: ResolvedFilesConfig, record: FileRecord, ctx: RouteContext): Promise<void> {
    if (!this.filesIndexed || !record.conversationId) return;
    const storage = this.config.storage;
    const rc = ctx.context;
    const { total } = await storage.listFiles!({ conversationId: record.conversationId, limit: 1 }, rc);
    if (total <= cfg.maxFiles) return;
    for (let offset = 0; offset < cfg.maxFiles; ) {
      const page = await storage.listFiles!(
        { conversationId: record.conversationId, limit: Math.min(200, cfg.maxFiles - offset), offset, order: "asc" },
        rc
      );
      if (page.data.some((held) => held.id === record.id)) return;
      if (page.data.length === 0 || !page.hasMore) break;
      offset += page.data.length;
    }
    await storage.deleteFile(record.id, rc).catch(() => undefined);
    throw {
      statusCode: 409,
      code: "too_many_files",
      message: `A conversation holds at most ${cfg.maxFiles} files. Delete one to attach another.`,
      details: { maxFiles: cfg.maxFiles, held: Math.min(total - 1, cfg.maxFiles) },
    };
  }

  /** The upload request, whichever way the file travels: the file's raw bytes (`?name=`) or the JSON body. */
  private parseUpload(ctx: RouteContext): {
    name: string;
    mimeType: string;
    content: string | Buffer;
    conversationId?: string;
    metadata?: Record<string, unknown>;
  } {
    const bad = (message: string): never => {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message } as ValidationError;
    };
    const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;

    // A form encoding is not a file: storing "the body" would keep the whole envelope (boundaries, headers) as the file
    const declaredType = normalizeHeaders(ctx.headers)["content-type"];
    if (isFormContentType(declaredType)) {
      throw {
        statusCode: 415,
        code: "unsupported_media_type",
        message:
          "multipart and form uploads are not supported: send the file's bytes as the body with its own Content-Type and ?name=<file name>, or the JSON form { file: { name, content (base64), mimeType } }",
      };
    }

    if (Buffer.isBuffer(ctx.body)) {
      const name = one(ctx.query.name) ?? one(ctx.query.filename);
      if (!name) bad("name is required: send the file's name as ?name=<file name>");
      const contentType = normalizeHeaders(ctx.headers)["content-type"];
      return {
        name: name!,
        mimeType: one(ctx.query.mimeType) ?? (Array.isArray(contentType) ? contentType[0] : contentType) ?? "application/octet-stream",
        content: ctx.body,
        conversationId: one(ctx.query.conversationId),
      };
    }

    const body = ctx.body as UploadFileRequest | undefined;
    if (!body?.file) bad("file is required");
    const { name, content, mimeType } = body!.file;
    if (!name || !mimeType || content === undefined || content === null) {
      bad("file.name, file.content, and file.mimeType are required");
    }
    if (typeof content !== "string") bad("file.content must be a base64 string");
    if (body!.conversationId !== undefined && typeof body!.conversationId !== "string") bad("conversationId must be a string");
    return { name, mimeType, content, conversationId: body!.conversationId, metadata: body!.metadata };
  }

  private async handleListFiles(ctx: RouteContext): Promise<RouteResult<ListFilesResponse>> {
    const { conversationId } = ctx.params;
    const conversation = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!conversation) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    await this.verifyConversationAccess(conversation, ctx);
    // (an agent that was removed since still has its files listed, under the server's settings)
    const cfg = this.filesConfigFor(await this.getAgentFor(conversation.agentId, ctx.context));
    const { limit, offset } = parsePaging(ctx.query, 100, this.maxPageSize);

    if (this.filesIndexed) {
      const page = await this.config.storage.listFiles!({ conversationId, limit, offset }, ctx.context);
      return { status: 200, body: { files: page.data, total: page.total, limit, offset, hasMore: page.hasMore, maxFiles: cfg.maxFiles } };
    }
    const all = await this.conversationFiles(conversationId, ctx.context);
    const files = all.slice(offset, offset + limit);
    return { status: 200, body: { files, total: all.length, limit, offset, hasMore: offset + files.length < all.length, maxFiles: cfg.maxFiles } };
  }

  /** A file the caller may see, else the 404 every file route answers. */
  private async visibleFile(ctx: RouteContext): Promise<FileRecord> {
    const { fileId } = ctx.params;
    const file = await this.config.storage.getFile(fileId, ctx.context);
    if (!file || !(await this.fileVisible(file, ctx))) throw this.fileNotFound(fileId);
    return file;
  }

  private async handleGetFile(ctx: RouteContext): Promise<RouteResult<FileRecord>> {
    return {
      status: 200,
      body: await this.visibleFile(ctx),
    };
  }

  private async handleDeleteFile(ctx: RouteContext): Promise<RouteResult> {
    const file = await this.visibleFile(ctx);
    await this.config.storage.deleteFile(file.id, ctx.context);

    return { status: 204 };
  }

  private async handleDownloadFile(ctx: RouteContext): Promise<RouteResult> {
    const file = await this.visibleFile(ctx);

    const content = await this.config.storage.getFileContent(file.id, ctx.context);
    if (!content) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File content not found: ${file.id}`,
      } as NotFoundError;
    }

    // A file name or type that came from outside is never echoed into a header as it is
    const declared = file.mimeType.split(";")[0]!.trim().toLowerCase();
    const mimeType = isWellFormedMime(declared) ? declared : "application/octet-stream";
    const asked = Array.isArray(ctx.query.disposition) ? ctx.query.disposition[0] : ctx.query.disposition;
    const requested: FileDisposition = asked === "inline" ? "inline" : "attachment";

    return {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": contentDispositionHeader(fileDisposition(mimeType, requested), file.name),
        "Content-Length": content.length.toString(),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
      raw: content,
    };
  }

  // ============================================================================
  // Task Routes
  // ============================================================================

  private async handleCreateTask(
    ctx: RouteContext
  ): Promise<RouteResult<CreateTaskResponse>> {
    const body = ctx.body as CreateTaskRequest;

    if (!body?.agentId || !body?.input) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "agentId and input are required",
      } as ValidationError;
    }

    // Check if agent exists
    if (!(await this.getAgentFor(body.agentId, ctx.context))) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Agent not found: ${body.agentId}`,
      } as NotFoundError;
    }

    // Resolve userId
    const userId = await this.effectiveUserId(ctx);

    // Files that come with the task are checked against the agent's settings first; they are kept in the
    // conversation the task will run in (so they belong to it: owned, counted, deleted with it)
    const incoming: IncomingFile[] = [];
    const cfg = this.filesConfigFor(await this.getAgentFor(body.agentId, ctx.context));
    if (body.files !== undefined && !Array.isArray(body.files)) {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message: "files must be an array" } as ValidationError;
    }
    for (const f of body.files ?? []) {
      if (!f || typeof f.name !== "string" || !f.name || typeof f.content !== "string" || typeof f.mimeType !== "string") {
        throw {
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "files[].name, files[].content (base64) and files[].mimeType are required",
        } as ValidationError;
      }
      if (Math.floor((f.content.length * 3) / 4) > cfg.maxFileSize + 3) throw this.fileTooLarge(cfg.maxFileSize);
      const file: IncomingFile = {
        name: f.name,
        mimeType: resolveUploadMimeType(f.mimeType, f.name),
        bytes: Buffer.from(f.content, "base64"),
      };
      this.checkIncomingFile(cfg, file);
      incoming.push(file);
    }
    if (incoming.length > cfg.maxFiles) {
      throw {
        statusCode: 409,
        code: "too_many_files",
        message: `A conversation holds at most ${cfg.maxFiles} files.`,
        details: { maxFiles: cfg.maxFiles },
      };
    }

    let taskConversation: Conversation | undefined;
    const files: Task["files"] = [];
    if (incoming.length > 0) {
      taskConversation = await this.config.storage.createConversation(
        { agentId: body.agentId, userId, metadata: { source: "task" } },
        ctx.context
      );
      try {
        for (const file of incoming) {
          const record = await this.saveIncomingFile(ctx, {
            file,
            cfg,
            conversation: taskConversation,
            metadata: { uploadedForTask: true },
          });
          files.push({ ...attachmentOf(record), storageKey: record.storageKey });
        }
      } catch (error) {
        // (the conversation takes the files saved so far with it)
        await this.config.storage.deleteConversation(taskConversation.id, ctx.context).catch(() => undefined);
        throw error;
      }
    }

    // Create task
    const task = await this.config.storage.createTask({
      agentId: body.agentId,
      userId,
      conversationId: taskConversation?.id,
      input: body.input,
      files,
      callbackUrl: body.callbackUrl,
      metadata: body.metadata,
    }, ctx.context);
    if (taskConversation) {
      await this.config.storage.updateConversation(
        taskConversation.id,
        { metadata: { taskId: task.id, source: "task" } },
        ctx.context
      );
    }

    // Start background processing
    this.processTaskInBackground(task.id, ctx.context!).catch((error) => {
      console.error(`Error processing task ${task.id}:`, error);
    });

    return {
      status: 201,
      body: { task },
    };
  }

  private async handleListTasks(
    ctx: RouteContext
  ): Promise<RouteResult<ListTasksResponse>> {
    const agentId = ctx.query.agentId as string | undefined;
    const status = ctx.query.status as Task["status"] | undefined;
    const conversationId = ctx.query.conversationId as string | undefined;
    const { limit, offset } = parsePaging(ctx.query, 20, this.maxPageSize);

    // Resolve userId
    const userId = await this.listOwner(ctx);

    const result = await this.config.storage.getTasks({
      agentId,
      userId,
      status,
      conversationId,
      limit,
      offset,
    }, ctx.context);

    return {
      status: 200,
      body: {
        tasks: result.data,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    };
  }

  private async handleGetTask(
    ctx: RouteContext
  ): Promise<RouteResult<GetTaskResponse>> {
    const { taskId } = ctx.params;

    const task = await this.config.storage.getTask(taskId, ctx.context);
    if (!task) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Task not found: ${taskId}`,
      } as NotFoundError;
    }

    // Verify user has access to this task
    await this.verifyTaskAccess(task, ctx);

    // Get result if task is completed
    const result = await this.config.storage.getTaskResult(taskId, ctx.context);

    // A task waiting for input waits on actions of its conversation
    let pendingActions: PendingAction[] | undefined;
    if (task.status === "waiting_for_input" && task.conversationId) {
      const conversation = await this.config.storage.getConversation(task.conversationId, ctx.context);
      pendingActions = readHitl(conversation?.state)?.pending?.actions;
    }

    return {
      status: 200,
      body: {
        task,
        result: result || undefined,
        ...(pendingActions?.length && { pendingActions }),
      },
    };
  }

  private async handleGetTaskStatus(
    ctx: RouteContext
  ): Promise<RouteResult<GetTaskStatusResponse>> {
    const { taskId } = ctx.params;

    const task = await this.config.storage.getTask(taskId, ctx.context);
    if (!task) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Task not found: ${taskId}`,
      } as NotFoundError;
    }

    // Verify user has access to this task
    await this.verifyTaskAccess(task, ctx);

    return {
      status: 200,
      body: {
        taskId: task.id,
        status: task.status,
        conversationId: task.conversationId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        error: task.error,
      },
    };
  }

  private async handleGetTaskResult(
    ctx: RouteContext
  ): Promise<RouteResult<GetTaskResultResponse>> {
    const { taskId } = ctx.params;

    const task = await this.config.storage.getTask(taskId, ctx.context);
    if (!task) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Task not found: ${taskId}`,
      } as NotFoundError;
    }

    // Verify user has access to this task
    await this.verifyTaskAccess(task, ctx);

    const result = await this.config.storage.getTaskResult(taskId, ctx.context);
    if (!result) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Task result not found: ${taskId}`,
      } as NotFoundError;
    }

    return {
      status: 200,
      body: { result },
    };
  }

  private async handleAddTaskComment(
    ctx: RouteContext
  ): Promise<RouteResult<AddTaskCommentResponse>> {
    const { taskId } = ctx.params;
    const body = ctx.body as AddTaskCommentRequest;

    if (!body?.content) {
      throw {
        statusCode: 400,
        code: "INVALID_REQUEST",
        message: "content is required",
      } as ValidationError;
    }

    const task = await this.config.storage.getTask(taskId, ctx.context);
    if (!task) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Task not found: ${taskId}`,
      } as NotFoundError;
    }

    // Verify user has access to this task
    await this.verifyTaskAccess(task, ctx);

    // One turn at a time: a comment cannot join a task that is working, or one that waits on an action
    if (task.status === "running") {
      throw { statusCode: 409, code: "task_busy", message: "The task is running. Comment when it has finished or is waiting for input." };
    }
    if (task.conversationId) {
      const linked = await this.config.storage.getConversation(task.conversationId, ctx.context);
      const open = readHitl(linked?.state)?.pending?.actions;
      if (open?.length) {
        throw {
          statusCode: 409,
          code: "action_pending",
          message: "The task is waiting for a pending action to be resolved",
          details: { pendingActionIds: open.map((a) => a.id) },
        };
      }
    }

    // Create new comment
    const comment: TaskComment = {
      id: `comment_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      taskId,
      role: "user",
      content: body.content,
      metadata: body.metadata,
      createdAt: new Date(),
    };

    // Add comment to task
    const existingComments = task.comments || [];
    const updatedTask = await this.config.storage.updateTask(taskId, {
      comments: [...existingComments, comment],
      status: "pending", // Reset status to pending so it can be reprocessed
    }, ctx.context);

    // Reprocess the task with the new comment
    this.processTaskInBackground(taskId, ctx.context!).catch((err) => {
      console.error(`Failed to reprocess task ${taskId}:`, err);
    });

    return {
      status: 201,
      body: {
        comment,
        task: updatedTask,
      },
    };
  }

  private async handleGetTaskComments(
    ctx: RouteContext
  ): Promise<RouteResult<GetTaskCommentsResponse>> {
    const { taskId } = ctx.params;

    const task = await this.config.storage.getTask(taskId, ctx.context);
    if (!task) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Task not found: ${taskId}`,
      } as NotFoundError;
    }

    // Verify user has access to this task
    await this.verifyTaskAccess(task, ctx);

    const comments = task.comments || [];

    return {
      status: 200,
      body: {
        comments,
        total: comments.length,
      },
    };
  }

  // ============================================================================
  // Task Processing
  // ============================================================================

  /**
   * Runs a task: in a conversation of its own (created for it and linked as `task.conversationId`), through the
   * same machinery as a message - events, cancellation, approvals. The task follows the conversation: see
   * {@link syncTask}.
   */
  private async processTaskInBackground(taskId: string, rc: RequestContext): Promise<void> {
    try {
      // Get the task
      const task = await this.config.storage.getTask(taskId, rc);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      // Cancelled while it was waiting to start
      if (task.status === "cancelled") return;

      // Update task status to running
      await this.config.storage.updateTask(taskId, {
        status: "running",
        startedAt: new Date(),
      }, rc);

      // Get the agent
      const agentReg = await this.getAgentFor(task.agentId, rc);
      if (!agentReg) {
        throw new Error(`Agent not found: ${task.agentId}`);
      }

      // The conversation the task runs in
      let conversation = task.conversationId
        ? await this.config.storage.getConversation(task.conversationId, rc)
        : null;
      if (!conversation) {
        conversation = await this.config.storage.createConversation({
          agentId: task.agentId,
          userId: task.userId,
          metadata: { taskId, source: "task" },
        }, rc);
        await this.config.storage.updateTask(taskId, { conversationId: conversation.id }, rc);
      }

      // The first turn is the task's input; a later one answers the newest comment
      const started = (await this.config.storage.getMessages(conversation.id, { limit: 1 }, rc)).total > 0;
      const latestComment = [...(task.comments ?? [])].reverse().find((c) => c.role === "user");
      const message = started ? latestComment?.content ?? task.input : task.input;
      const handlerMetadata = { ...task.metadata, comments: task.comments || [] };
      const body: SendMessageRequest = { message };
      const routeCtx: RouteContext = { params: { conversationId: conversation.id }, query: {}, body, user: rc.user, context: rc };

      // (the conversation lease is what keeps two workers off one task: the one that comes second is refused)
      const run = await this.beginRun(routeCtx, conversation, "message", "message", false);
      this.launch(run, routeCtx, () =>
        this.executeMessage(run, {
          ctx: routeCtx,
          conversation: conversation!,
          agent: agentReg,
          body,
          attachments: { refs: started ? [] : (task.files ?? []).map(({ storageKey: _key, ...file }) => file), inline: [], cfg: this.filesConfigFor(agentReg) },
          handlerMetadata,
        })
      );
      // The task is brought up to date by syncTask when the run settles
      const outcome = await run.done;
      if (outcome.error) throw outcome.error;
    } catch (error) {
      // Somebody else is already running it: not a failure of the task
      if ((error as { code?: string } | null)?.code === "conversation_busy") return;
      // The task could not run at all (the run reports its own failures through syncTask)
      const current = await this.config.storage.getTask(taskId, rc).catch(() => null);
      if (current && current.status !== "failed" && current.status !== "cancelled") {
        await this.failTask(current, (error as Error).message, rc);
      }
      throw error;
    }
  }

  private async failTask(task: Task, message: string, rc: RequestContext | undefined): Promise<void> {
    await this.config.storage.updateTask(task.id, {
      status: "failed",
      completedAt: new Date(),
      error: message,
    }, rc);
    if (task.callbackUrl) await this.sendTaskCallback(task.callbackUrl, task.id, "failed", message);
  }

  /**
   * Whether `taskId` is the task of this conversation: it names the conversation and belongs to the same user. The
   * conversation's own metadata is writable by its owner, so it is only a pointer; the task is what says yes.
   */
  private async taskOwnsConversation(taskId: string, conversation: Conversation, rc: RequestContext | undefined): Promise<boolean> {
    const task = await this.config.storage.getTask(taskId, rc);
    return !!task && task.conversationId === conversation.id && (task.userId ?? undefined) === (conversation.userId ?? undefined);
  }

  /**
   * Metadata a client may set on a conversation. `taskId` (and `source: "task"`) belong to the server: what a client sends for
   * them is dropped and, on an update, the ones the conversation already has are kept (an update replaces the metadata).
   */
  private clientMetadata<T extends Record<string, unknown> | undefined>(supplied: T, existing?: Record<string, unknown>): T {
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return supplied;
    const { taskId: _taskId, ...rest } = supplied as Record<string, unknown>;
    if (rest.source === "task") delete rest.source;
    if (existing?.taskId !== undefined) rest.taskId = existing.taskId;
    if (existing?.source === "task") rest.source = "task";
    return rest as T;
  }

  /** A task whose conversation starts running (also when an answered action resumes it) is running again. */
  private async markTaskRunning(taskId: string, rc: RequestContext | undefined, conversationId?: string): Promise<void> {
    try {
      const task = await this.config.storage.getTask(taskId, rc);
      if (conversationId !== undefined && task?.conversationId !== conversationId) return;
      if (task && (task.status === "waiting_for_input" || task.status === "pending")) {
        await this.config.storage.updateTask(taskId, { status: "running" }, rc);
      }
    } catch (error) {
      console.error(`[AgentServer] Could not mark task ${taskId} running:`, error);
    }
  }

  /**
   * Brings the task of a conversation up to date when one of its runs settles - whether the task started the
   * run or somebody answered an action of the task's conversation: completed with its result, failed,
   * cancelled, or waiting for input on the open actions.
   */
  private async syncTask(run: ActiveRun, outcome: TurnOutcome, rc: RequestContext | undefined): Promise<void> {
    const taskId = run.taskId;
    // (a run that lost its lease is not the one that owns the outcome any more)
    if (!taskId || outcome.partial || run.leaseLost) return;
    const storage = this.config.storage;
    const task = await storage.getTask(taskId, rc);
    if (!task || task.conversationId !== run.conversationId) return;
    if (task.status === "cancelled" || task.status === "failed") return;

    const callback = async (status: TaskStatus, error?: string) => {
      if (task.callbackUrl && (status === "completed" || status === "failed" || status === "waiting_for_input")) {
        await this.sendTaskCallback(task.callbackUrl, taskId, status, error);
      } else if (task.callbackUrl && status === "cancelled") {
        await this.sendTaskCallback(task.callbackUrl, taskId, "cancelled");
      }
    };

    if (outcome.error) {
      await this.failTask(task, (outcome.error as Error)?.message ?? "The task failed", rc);
      return;
    }
    if (outcome.stopReason === "cancelled") {
      await storage.updateTask(taskId, { status: "cancelled", completedAt: new Date() }, rc);
      await callback("cancelled");
      return;
    }
    if (outcome.stopReason === "budget_reached" && outcome.status === "incomplete") {
      // The budget cut the task short and nobody is there to raise it (a task that only crossed it finished its answer: it completes)
      await this.failTask(task, "The budget of the conversation the task runs in was reached before the task was done", rc);
      return;
    }

    const waiting = outcome.pendingActions.length > 0 || outcome.handlerMetadata?.waitingForInput === true;
    if (waiting) {
      // A handler that asks for clarification the old way keeps its comment-based loop
      const comments = task.comments ?? [];
      const legacy = outcome.pendingActions.length === 0;
      const agentComment: TaskComment | undefined = legacy
        ? {
            id: `comment_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            taskId,
            role: "agent",
            content: outcome.content,
            metadata: outcome.handlerMetadata,
            createdAt: new Date(),
          }
        : undefined;
      // The partial result first: whoever sees "waiting_for_input" finds it
      await storage.createTaskResult({
        taskId,
        content: outcome.content,
        files: outcome.assistant?.files,
        usage: outcome.usage,
        metadata: {
          waitingForInput: true,
          ...(outcome.pendingActions.length > 0 && { pendingActionIds: outcome.pendingActions.map((a) => a.id) }),
        },
      }, rc);
      await storage.updateTask(taskId, {
        status: "waiting_for_input",
        ...(agentComment && { comments: [...comments, agentComment] }),
      }, rc);
      await callback("waiting_for_input");
      return;
    }

    // Create task result
    await storage.createTaskResult({
      taskId,
      content: outcome.content || "Task completed",
      files: outcome.assistant?.files,
      usage: outcome.usage,
      metadata: {},
    }, rc);
    await storage.updateTask(taskId, { status: "completed", completedAt: new Date() }, rc);
    await callback("completed");
  }

  private async handleCancelTask(ctx: RouteContext): Promise<RouteResult> {
    const { taskId } = ctx.params;
    const task = await this.config.storage.getTask(taskId, ctx.context);
    if (!task) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Task not found: ${taskId}` } as NotFoundError;
    }
    await this.verifyTaskAccess(task, ctx);

    if (task.status === "cancelled") return { status: 200, body: { task } };
    if (task.status === "completed" || task.status === "failed") {
      throw { statusCode: 409, code: "task_finished", message: `The task has already ${task.status === "completed" ? "completed" : "failed"}` };
    }

    // Stop the conversation the task runs in; the end of its run brings the task up to date
    let stopped = false;
    if (task.conversationId) {
      const conversation = await this.config.storage.getConversation(task.conversationId, ctx.context);
      if (conversation) stopped = (await this.cancelConversation(conversation, ctx.context)).cancelled;
    }
    let current = (await this.config.storage.getTask(taskId, ctx.context)) ?? task;
    if (!stopped && current.status !== "cancelled") {
      // Nothing was running (the task had not started): record the cancellation
      current = await this.config.storage.updateTask(taskId, { status: "cancelled", completedAt: new Date() }, ctx.context);
    }
    // 202: the run was told to stop and is still winding down (or runs on another node)
    return { status: current.status === "cancelled" ? 200 : 202, body: { task: current } };
  }

  private async sendTaskCallback(
    callbackUrl: string,
    taskId: string,
    status: "completed" | "failed" | "waiting_for_input" | "cancelled",
    error?: string
  ): Promise<void> {
    try {
      const payload = {
        taskId,
        status,
        error,
        timestamp: new Date().toISOString(),
      };

      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(
          `Callback failed: ${response.status} ${response.statusText}`,
          await response.text()
        );
      }
    } catch (error) {
      console.error(`Error sending callback to ${callbackUrl}:`, error);
    }
  }

  // ============================================================================
  // Getters
  // ============================================================================

  /**
   * Every route this server answers, as declared: the method and the path relative to the base path, with `:param`
   * placeholders (`:tool*` takes the rest of the path). For tooling - a gateway's allow-list, a check that the docs and
   * the OpenAPI spec cover the API.
   */
  getRoutes(): Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }> {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  getBasePath(): string {
    return this.basePath;
  }

  getConfig(): AgentServerConfig {
    return this.config;
  }
}

/**
 * Create an AgentServer instance
 */
export function createAgentServer(config: AgentServerConfig): AgentServer {
  return new AgentServer(config);
}
