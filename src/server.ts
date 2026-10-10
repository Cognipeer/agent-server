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
  TurnWarning,
  MessagesPage,
  StopReason,
  ConversationRuntime,
  RunsConfig,
  EventStore,
  EventSummary,
  Lease,
  ListEventsResponse,
  CancelConversationResponse,
  NewConversationEvent,
  TaskStatus,
} from "./types.js";
import {
  HITL_STATE_KEY,
  applySdkResolution,
  jsonSafe,
  portableState,
  publicState,
  readHitl,
  runSdkTurn,
  supportsSdkPause,
  writeHitl,
  type HitlSdkAgent,
  type HitlStore,
} from "./hitl.js";
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
import { EVENT_TYPES, MemoryEventLog, actionRequiredData, clampLimit, wireEvent } from "./events.js";
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

/** Maps stored messages to the agent-sdk message shape (tool calls preserved). */
function toSdkMessages(data: Message[]) {
  return data
    // A turn that paused or was stopped before it said anything leaves an empty assistant message behind.
    .filter((m) => !(m.role === "assistant" && m.content === "" && (m.metadata?.requiresAction === true || m.metadata?.status === "cancelled" || m.metadata?.status === "incomplete")))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
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
    }));
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
}

/** What the agent produced in one step of a turn, before it is persisted. */
interface AgentStep {
  content: string;
  files?: Message["files"];
  usage?: SendMessageResponse["usage"];
  /** What the step waits on (never set for a cancelled step). */
  pending: PendingAction[];
  sdkState?: unknown;
  /** State a custom handler wrote this step. */
  handlerState?: Record<string, unknown>;
  handlerMetadata?: Record<string, unknown>;
  /** The run was cancelled while the step ran. */
  cancelled: boolean;
  /** The agent stopped at one of its limits. */
  limited?: boolean;
  /** What the agent said about it (reported as the `detail` of `session.status_idle`). */
  detail?: string;
  /** Why the step stopped, when the agent said so (a custom handler's `stopReason`). */
  stopReason?: StopReason;
  /** What a custom handler reported as `status` ("incomplete" without a reason becomes a `limit`). */
  handlerStatus?: MessageStatus;
}

const cancelledStep = (content: string): AgentStep => ({ content, pending: [], cancelled: true });

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
  private startedAt = Date.now();

  constructor(config: AgentServerConfig) {
    this.config = config;
    this.basePath = config.basePath.replace(/\/$/, "");
    if (Array.isArray(config.agents)) {
      for (const registration of config.agents) this.agents.set(registration.info.id, registration);
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
    if (maxStateBytes && maxStateBytes > capabilities.maxStateBytes) {
      throw new Error(
        `limits.maxStateBytes (${maxStateBytes} bytes) is larger than the ${capabilities.maxStateBytes} bytes this storage provider can hold`
      );
    }
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
   * Owner to stamp on / filter by. With `resolveContext` configured the resolved
   * identity is authoritative and client-supplied ids are ignored (otherwise any
   * caller could read or create data as someone else by passing `userId`).
   */
  private async effectiveUserId(ctx: RouteContext, requested?: string): Promise<string | undefined> {
    if (this.config.resolveContext) return ctx.context?.user?.id;
    return requested || ctx.user?.id || (await this.resolveUserId(ctx));
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
  private async generateTitle(userMessage: string): Promise<string | undefined> {
    const cfg = this.config.titleGeneration;
    if (!cfg) return undefined;
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
      });
      if (!res.ok) return undefined;
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) return undefined;
      // Strip surrounding quotes if the model wraps the title
      return raw.replace(/^["""''']|["""''']$/g, "").trim() || undefined;
    } catch {
      return undefined;
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
    info?: Partial<Omit<AgentInfo, "id">>
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

    this.agents.set(id, {
      info: {
        id,
        name,
        version,
        description: info?.description,
        metadata: info?.metadata,
        ...(capabilities && { capabilities }),
      },
      sdkAgent: agent,
    });
  }

  /**
   * Register a custom agent handler
   */
  registerCustomAgent(
    id: string,
    handler: AgentRegistration["handler"],
    info: Omit<AgentInfo, "id">
  ): void {
    this.agents.set(id, {
      info: { id, ...info },
      handler,
    });
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
    info: Omit<AgentInfo, "id">
  ): void {
    this.agents.set(id, {
      info: { id, ...info },
      chatCompletions: config,
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
    info: Omit<AgentInfo, "id">
  ): void {
    this.agents.set(id, {
      info: { id, ...info },
      responsesApi: config,
    });
  }

  /**
   * Get all statically registered agents (does not include dynamic agents -
   * use `getAgentsFor` for the per-request list)
   */
  getAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map((reg) => reg.info);
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
    return Array.from((await this.resolveRegistry(rc)).values()).map((reg) => reg.info);
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

    // Runs: stop a turn, read and follow what happened in a conversation
    this.addRoute("POST", "/conversations/:conversationId/cancel", this.handleCancel.bind(this));
    this.addRoute("GET", "/conversations/:conversationId/events", this.handleListEvents.bind(this));
    this.addRoute("GET", "/conversations/:conversationId/events/stream", this.handleEventsStream.bind(this));

    // File routes
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
    const patternStr = path.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    const pattern = new RegExp(`^${patternStr}$`);

    this.routes.push({ method, pattern, paramNames, handler, public: isPublic });
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
      body: agent.info,
    };
  }

  private async handleListConversations(
    ctx: RouteContext
  ): Promise<RouteResult<ListConversationsResponse>> {
    const agentId = ctx.query.agentId as string | undefined;
    const userId = ctx.query.userId as string | undefined;
    const { limit, offset } = parsePaging(ctx.query, 20, this.maxPageSize);

    // Resolve userId: from query param, ctx.user (token), or resolveUserId callback
    const resolvedUserId = await this.effectiveUserId(ctx, userId);
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
          ...this.publicConversation(conv, runtimes.get(conv.id)),
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
    if (!(await this.getAgentFor(body.agentId, ctx.context))) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Agent not found: ${body.agentId}`,
      } as NotFoundError;
    }

    // Resolve userId: from body, ctx.user (token), or resolveUserId callback
    const userId = await this.effectiveUserId(ctx, body.userId);

    const conversation = await this.config.storage.createConversation({
      agentId: body.agentId,
      userId,
      title: body.title,
      metadata: body.metadata,
    }, ctx.context);

    return {
      status: 201,
      body: { conversation },
    };
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

    return {
      status: 200,
      body: {
        conversation: this.publicConversation(conversation, runtime),
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
    const body = ctx.body as { title?: string; metadata?: Record<string, unknown> };

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

    const conversation = await this.config.storage.updateConversation(conversationId, {
      title: body?.title,
      metadata: body?.metadata,
    }, ctx.context);

    return {
      status: 200,
      body: this.publicConversation(conversation),
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

  /** Conversation as clients see it: without the internal pending-action store. */
  private publicConversation<T extends Conversation>(conversation: T, runtime?: ConversationRuntime): T {
    const visible =
      conversation.state && HITL_STATE_KEY in conversation.state
        ? { ...conversation, state: publicState(conversation.state) }
        : conversation;
    return runtime ? { ...visible, runtime } : visible;
  }

  /** The event data of a decision on `action` (`action.resolved`). */
  private actionResolvedData(
    action: PendingAction,
    resolution: ActionResolution | undefined,
    resolvedBy: string,
    channel: "api" | "system",
    cancelled = false
  ): Record<string, unknown> {
    const approval = resolution?.type === "tool_approval" ? resolution : undefined;
    const questionCancelled = resolution?.type === "user_question" && resolution.cancelled === true;
    const wasCancelled = cancelled || questionCancelled;
    return {
      action_id: action.id,
      kind: action.type,
      ...(approval ? { decision: approval.decision } : {}),
      ...(wasCancelled ? { cancelled: true } : {}),
      status: wasCancelled ? "cancelled" : approval ? (approval.decision === "allow" ? "approved" : "rejected") : "answered",
      resolved_by: resolvedBy,
      channel,
    };
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
    const state = writeHitl(conversation.state, { allowedTools: store.allowedTools });
    await this.config.storage.updateConversation(conversation.id, { state }, ctx.context);
    await this.appendEvents(
      conversation.id,
      store.pending.actions.map((action) => ({
        type: EVENT_TYPES.actionResolved,
        data: this.actionResolvedData(action, undefined, "system", "system", true),
      })),
      ctx.context
    );
    return { ...conversation, state };
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

  private busyError(activeRunId?: string) {
    return {
      statusCode: 409,
      code: "conversation_busy",
      message: "The conversation is already running a turn. Wait for it to finish, or cancel it.",
      details: { ...(activeRunId ? { activeRunId } : {}) },
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
    if (existing) throw this.busyError(existing.id);

    const run = new ActiveRun({
      conversationId,
      kind,
      trigger,
      streaming,
      append: (events) => this.eventStore.append(conversationId, events, ctx.context),
      bus: this.bus,
      maxEventDataBytes: this.runCfg.maxEventDataBytes,
    });
    const taskId = conversation.metadata?.taskId;
    if (typeof taskId === "string") run.taskId = taskId;
    this.runs.set(conversationId, run);

    try {
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
        if (!result.acquired) throw this.busyError(result.lease.data?.runId as string | undefined);
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
      await run.lease?.stop();
      this.runs.delete(conversationId);
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
        if (run.taskId) await this.markTaskRunning(run.taskId, ctx.context);
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

    // Files the message attaches by id are checked before anything starts, streamed or not.
    const fileRefs = await this.resolveFileRefs(conversationId, body, ctx);
    const streaming = !!body.stream;

    // A streamed request for a conversation or agent that is not there (or not the caller's) answers with a
    // stream that carries the error, as it always has; a plain request answers the HTTP status.
    let loaded: { conversation: Conversation; agent: AgentRegistration };
    try {
      loaded = await this.loadForTurn(conversationId, ctx);
    } catch (error) {
      if (streaming) return this.errorStream(error);
      throw error;
    }
    const { agent } = loaded;
    let { conversation } = loaded;

    // One turn at a time per conversation (409 conversation_busy), then: waiting on a human?
    // Reject (409) or cancel the pending actions, per config.
    const run = await this.beginRun(ctx, conversation, "message", "message", streaming);
    try {
      conversation = await this.guardPendingActions(conversation, ctx);
    } catch (error) {
      await this.endRun(run);
      throw error;
    }

    const stream = streaming ? this.attachStream(run) : undefined;
    this.launch(run, ctx, () => this.executeMessage(run, { ctx, conversation, agent, body, fileRefs }));
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
      },
    };
  }

  /** One message turn: stores the user message, runs the agent, stores the answer (and what it waits on). */
  private async executeMessage(
    run: ActiveRun,
    x: {
      ctx: RouteContext;
      conversation: Conversation;
      agent: AgentRegistration;
      body: SendMessageRequest;
      fileRefs: FileAttachment[];
      /** What a custom handler gets as `metadata`, when it is not the message's own (a task hands over its comments). */
      handlerMetadata?: Record<string, unknown>;
    }
  ): Promise<TurnOutcome> {
    const { ctx, conversation, agent, body, fileRefs } = x;
    const conversationId = conversation.id;

    // Handle file attachments
    const files = this.messageFiles(body, fileRefs);

    // Save user message
    const userMessage = await this.config.storage.createMessage({
      conversationId,
      role: "user",
      content: body.message,
      files,
      metadata: body.metadata,
    }, ctx.context);

    run.emit({
      events: [
        {
          type: EVENT_TYPES.userMessage,
          data: {
            content: body.message,
            message_id: userMessage.id,
            ...(files?.length ? { files: files.map((f) => ({ id: f.id, name: f.name, mime_type: f.mimeType, size: f.size })) } : {}),
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
    const history = await this.loadHistory(conversationId, ctx.context);

    const step = await this.runMessageStep(run, { ctx, conversation, agent, history, body, files, handlerMetadata: x.handlerMetadata });
    return this.finalizeTurn(run, {
      ctx,
      conversation,
      step,
      userMessage,
      // (a task's conversation gets no generated title: it is not a chat)
      firstExchange: history.length === 1 && !run.taskId ? body.message : undefined,
      allowedTools: undefined,
    });
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
      handlerMetadata?: Record<string, unknown>;
    }
  ): Promise<AgentStep> {
    const { ctx, conversation, agent, history, body, files } = x;
    const conversationId = conversation.id;
    const grace = this.runCfg.cancelGraceMs;
    // Text streamed so far: what a cancelled turn keeps
    const partial = { text: "" };

    const textFrame = (text: string, isFinal: boolean) => (seq: number) =>
      ({ type: "stream.text", timestamp: Date.now(), text, isFinal, seq } satisfies StreamTextEvent);

    try {
      if (agent.sdkAgent) {
        // Map messages with tool_calls and tool_call_id preserved
        return await this.runSdk(
          run,
          ctx,
          agent.sdkAgent as HitlSdkAgent,
          { messages: toSdkMessages(history) },
          new Set(readHitl(conversation.state)?.allowedTools ?? []),
          partial
        );
      }

      if (agent.chatCompletions) {
        const messages = history.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
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

        if (!run.streaming) {
          const result = await invokeChatCompletions(agent.chatCompletions, messages, { signal: run.signal });
          return { content: result.content, usage: result.usage, pending: [], cancelled: run.cancelled };
        }
        let content = "";
        let usage: SendMessageResponse["usage"];
        for await (const event of streamChatCompletions(agent.chatCompletions, messages, { signal: run.signal })) {
          if (event.type === "text") {
            partial.text += event.text;
            run.emit({ delta: event.text, frame: textFrame(event.text, false) });
          } else if (event.type === "done") {
            content = event.content;
            usage = event.usage;
          }
        }
        return { content, usage, pending: [], cancelled: run.cancelled };
      }

      if (agent.responsesApi) {
        const messages = history.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }));

        let content = "";
        let usage: SendMessageResponse["usage"];
        let responseId: string | undefined;
        if (!run.streaming) {
          const result = await invokeResponsesApi(agent.responsesApi, messages, undefined, { signal: run.signal });
          content = result.content;
          usage = result.usage;
          responseId = result.responseId;
        } else {
          for await (const event of streamResponsesApi(agent.responsesApi, messages, undefined, { signal: run.signal })) {
            if (event.type === "text") {
              partial.text += event.text;
              run.emit({ delta: event.text, frame: textFrame(event.text, false) });
            } else if (event.type === "done") {
              content = event.content;
              usage = event.usage;
              responseId = event.responseId || undefined;
            }
          }
        }
        // Store responseId in conversation state for potential chaining
        if (responseId) {
          await this.config.storage.updateConversation(conversationId, {
            state: { ...conversation.state, lastResponseId: responseId },
          }, ctx.context);
        }
        return { content, usage, pending: [], cancelled: run.cancelled };
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
        });
        const raced = await run.raceCancel(work, grace);
        if ("abandoned" in raced) return cancelledStep(partial.text);
        const result = raced.value;
        const pending = result.pendingActions ?? [];
        if (run.streaming) {
          // Send the full content as a single text event
          run.emit({ frame: textFrame(result.content, true) });
        }
        // Update conversation state if provided
        if (result.state) {
          await this.config.storage.updateConversation(conversationId, {
            state: result.state,
          }, ctx.context);
        }
        return {
          content: result.content,
          files: result.files,
          usage: result.usage,
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

  /** Invokes an agent-sdk agent (with the remembered-approval loop), cancellable. */
  private async runSdk(
    run: ActiveRun,
    ctx: RouteContext,
    sdkAgent: HitlSdkAgent,
    input: unknown,
    allowedTools: ReadonlySet<string>,
    partial: { text: string }
  ): Promise<AgentStep> {
    const bridge = createSdkBridge(run, partial);
    const config = {
      context: ctx.context,
      // An AbortSignal is a valid SDK cancellation token, and tools see it as their `signal`
      cancellationToken: run.signal,
      onEvent: bridge.onEvent,
      ...(run.streaming ? { stream: true, onStream: bridge.onStream } : {}),
    };
    const raced = await run.raceCancel(runSdkTurn(sdkAgent, input, config, allowedTools), this.runCfg.cancelGraceMs);
    if ("abandoned" in raced) return cancelledStep(partial.text);

    const { result, pending } = raced.value;
    const sdkCtx = (result.state as { ctx?: Record<string, unknown> } | undefined)?.ctx;
    let content = result.content;
    const usage = result.metadata?.usage as SendMessageResponse["usage"];

    if (sdkCtx?.__cancelled) {
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

    return {
      content,
      usage,
      pending,
      sdkState: pending.length > 0 ? portableState(result.state) : undefined,
      cancelled: false,
      limited: !!sdkCtx?.__limitBreached,
      ...(typeof sdkCtx?.__limitBreached === "string" ? { detail: sdkCtx.__limitBreached } : {}),
    };
  }

  /**
   * Stores what a step produced as the assistant message, records what it waits on, and reports
   * the end of the turn (events, then the legacy done frame). A pause whose state the store cannot hold
   * is not taken: the turn finishes with a `pause_state_too_large` warning.
   */
  private async finalizeTurn(
    run: ActiveRun,
    x: {
      ctx: RouteContext;
      conversation: Conversation;
      step: AgentStep;
      userMessage?: Message;
      /** The first message of the conversation: a title is generated from it. */
      firstExchange?: string;
      allowedTools?: string[];
    }
  ): Promise<TurnOutcome> {
    const { ctx, conversation, step } = x;
    const conversationId = conversation.id;
    if (run.leaseLost) {
      throw { statusCode: 409, code: "lease_lost", message: "The conversation was taken over by another run" };
    }

    // A cancelled step ends the turn: nothing it was waiting on is kept
    const actions = step.cancelled ? [] : step.pending;
    const wanted: StopReason = step.cancelled
      ? "cancelled"
      : actions.length > 0
        ? "requires_action"
        : step.stopReason ?? (step.limited || step.handlerStatus === "incomplete" ? "limit" : step.handlerStatus === "cancelled" ? "cancelled" : "end_turn");

    const saved = await this.saveAssistantTurn(ctx, conversation, {
      content: step.content,
      files: step.files,
      handlerState: step.handlerState,
      actions,
      sdkState: step.sdkState,
      stopReason: wanted,
      allowedTools: x.allowedTools,
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

    if (content !== "") {
      events.push({
        type: EVENT_TYPES.message,
        data: {
          content,
          message_id: assistant.id,
          stop_reason: stopReason,
          ...(step.usage
            ? { usage: { input_tokens: step.usage.inputTokens, output_tokens: step.usage.outputTokens, total_tokens: step.usage.totalTokens } }
            : {}),
        },
      });
    }
    if (step.usage) {
      events.push({
        type: EVENT_TYPES.usage,
        data: { input_tokens: step.usage.inputTokens, output_tokens: step.usage.outputTokens, total_tokens: step.usage.totalTokens },
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
      conversationTitle = await this.generateTitle(x.firstExchange);
      if (conversationTitle) {
        await this.config.storage.updateConversation(conversationId, { title: conversationTitle }, ctx.context);
      }
    }

    const legacyStatus = saved.status && saved.status !== "completed" ? saved.status : undefined;
    run.emit({
      events: [
        {
          type: EVENT_TYPES.statusIdle,
          data: {
            stop_reason: stopReason,
            ...(pendingActions.length > 0 ? { pending_action_ids: pendingActions.map((a) => a.id) } : {}),
            ...(saved.warnings ? { detail: saved.warnings[0]!.code } : step.detail ? { detail: step.detail } : {}),
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
        usage: step.usage
          ? {
              inputTokens: step.usage.inputTokens,
              outputTokens: step.usage.outputTokens,
              totalTokens: step.usage.totalTokens,
            }
          : undefined,
        ...(legacyStatus && { status: legacyStatus }),
        ...(pendingActions.length > 0 && { pendingActions }),
        ...(saved.warnings && { warnings: saved.warnings }),
        stopReason,
        runId: run.id,
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
    };
  }

  /**
   * Saves the assistant message of a turn and what it waits on. A pause whose state the
   * store cannot hold (`limits.maxStateBytes`, or the provider's own limit) is not taken:
   * the turn finishes as if it had not paused and the message carries a
   * `pause_state_too_large` warning, instead of failing after the message was written.
   */
  private async saveAssistantTurn(
    ctx: RouteContext,
    conversation: Conversation,
    turn: {
      content: string;
      files?: Message["files"];
      /** State a handler wrote this turn; without it the conversation's own is kept. */
      handlerState?: Record<string, unknown>;
      actions: PendingAction[];
      sdkState?: unknown;
      /** Why the turn stopped, unless the pause is dropped (then it simply ended). */
      stopReason: StopReason;
      /** Remembered tools to store (a resolve may have added one); default: the ones already stored. */
      allowedTools?: string[];
    }
  ): Promise<{
    message: Message;
    actions: PendingAction[];
    stopReason: StopReason;
    status: MessageStatus;
    warnings?: TurnWarning[];
  }> {
    let { actions, sdkState, content, stopReason } = turn;
    let warnings: TurnWarning[] | undefined;

    const dropPause = (bytes: number | undefined) => {
      const max = this.maxStateBytes;
      warnings = [
        {
          code: "pause_state_too_large",
          message: `The paused state${bytes ? ` (${bytes} bytes)` : ""} does not fit the ${max} byte limit, so the turn was not paused`,
          ...(bytes && { stateBytes: bytes }),
          maxStateBytes: max,
        },
      ];
      actions = [];
      sdkState = undefined;
      if (stopReason === "requires_action") stopReason = "end_turn";
      if (!content) content = PAUSE_NOT_STORED_NOTICE;
    };

    if (actions.length > 0) {
      const state = this.pausedState(conversation, turn.handlerState, "msg_".padEnd(25, "x"), actions, sdkState, turn.allowedTools);
      const bytes = Buffer.byteLength(JSON.stringify(state));
      if (bytes > this.maxStateBytes) dropPause(bytes);
    }

    for (let attempt = 0; ; attempt++) {
      const status = statusForStop(stopReason);
      const message = await this.config.storage.createMessage({
        conversationId: conversation.id,
        role: "assistant",
        content,
        files: turn.files,
        metadata: {
          ...(actions.length > 0 && { requiresAction: true }),
          status,
          stopReason,
          ...(warnings && { warnings }),
        },
      }, ctx.context);
      try {
        await this.persistPendingActions(ctx, conversation, turn.handlerState, message.id, actions, sdkState, turn.allowedTools);
        return { message, actions, stopReason, status, warnings };
      } catch (error) {
        // Never leave an assistant message that says it waits on an action the store did not keep
        await this.config.storage.deleteMessage(message.id, ctx.context).catch(() => undefined);
        const tooLarge = (error as { code?: string } | null)?.code === "STORAGE_LIMIT_EXCEEDED";
        if (attempt === 0 && actions.length > 0 && tooLarge) {
          dropPause(undefined);
          continue;
        }
        throw error;
      }
    }
  }

  /** The conversation state as it is stored while the turn waits on `actions`. */
  private pausedState(
    conversation: Conversation,
    baseState: Record<string, unknown> | undefined,
    messageId: string,
    actions: PendingAction[],
    sdkState: unknown,
    allowedTools?: string[]
  ): Record<string, unknown> {
    const before = readHitl(conversation.state);
    const remembered = allowedTools ?? before?.allowedTools;
    const store: HitlStore = {
      ...(remembered?.length && { allowedTools: remembered }),
      ...(actions.length > 0 && { pending: { actions, messageId, ...(sdkState !== undefined && { sdkState }) } }),
    };
    return writeHitl(baseState ?? conversation.state, store);
  }

  /**
   * Records what a turn is waiting on (or clears it) so a reload can render
   * it and a resolve can continue. `baseState` is the state the handler just
   * wrote, if any; without it the conversation's current state is kept.
   * No-op for agents that never pause.
   */
  private async persistPendingActions(
    ctx: RouteContext,
    conversation: Conversation,
    baseState: Record<string, unknown> | undefined,
    messageId: string,
    actions: PendingAction[],
    sdkState?: unknown,
    allowedTools?: string[]
  ): Promise<void> {
    const before = readHitl(conversation.state);
    if (actions.length === 0 && !before?.pending) return;
    await this.config.storage.updateConversation(conversation.id, {
      state: this.pausedState(conversation, baseState, messageId, actions, sdkState, allowedTools),
    }, ctx.context);
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

  private async handleResolveAction(ctx: RouteContext): Promise<RouteResult<ResolveActionResponse>> {
    const { conversationId, actionId } = ctx.params;
    const body = ctx.body as ResolveActionRequest | undefined;
    const resolution = this.validateResolution(body);

    const initial = await this.config.storage.getConversation(conversationId, ctx.context);
    if (!initial) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Conversation not found: ${conversationId}` } as NotFoundError;
    }
    await this.verifyConversationAccess(initial, ctx);

    const agent = await this.getAgentFor(initial.agentId, ctx.context);
    if (!agent) {
      throw { statusCode: 404, code: "NOT_FOUND", message: `Agent not found: ${initial.agentId}` } as NotFoundError;
    }
    const useSdk = !!agent.sdkAgent;
    const supported = useSdk ? supportsSdkPause(agent.sdkAgent) : typeof agent.handler?.resolveAction === "function";
    if (!supported) {
      throw { statusCode: 404, code: "NOT_FOUND", message: "This agent does not support resolving actions" } as NotFoundError;
    }

    // Answering is a turn like any other: one at a time. A second answer to the same pause (a double
    // click, two tabs) meets the first one's run and is refused.
    const streaming = !!body?.stream;
    const run = await this.beginRun(ctx, initial, "resolve", "resume", streaming);
    let resolveRun!: ResolveRun;
    try {
      // Read again under the lease: another request may have answered since the check above
      const conversation = (await this.config.storage.getConversation(conversationId, ctx.context)) ?? initial;
      const store = readHitl(conversation.state);
      const action = store?.pending?.actions.find((a) => a.id === actionId);
      if (!store?.pending || !action) {
        throw { statusCode: 409, code: "action_not_pending", message: `Action is not pending: ${actionId}` };
      }
      if (action.type !== resolution.type) {
        throw {
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: `resolution.type "${resolution.type}" does not match the action (${action.type})`,
        } as ValidationError;
      }

      // Apply the decision to the paused SDK state up front, so an invalid answer is a plain 400.
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
      resolveRun = { ctx, conversation, agent, store, action, resolution, nextSdkState, metadata: body?.metadata };
    } catch (error) {
      await this.endRun(run);
      throw error;
    }

    const stream = streaming ? this.attachStream(run) : undefined;
    this.launch(run, ctx, () => this.executeResolve(run, resolveRun));
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
      },
    };
  }

  /**
   * Resolves one action and, when nothing else is pending, continues the turn.
   */
  private async executeResolve(run: ActiveRun, resolveRun: ResolveRun): Promise<TurnOutcome> {
    const { ctx, conversation, agent, store, action, resolution } = resolveRun;
    const conversationId = conversation.id;
    const pending = store.pending!;
    const actor = ctx.context?.user?.id ?? ctx.user?.id ?? "anonymous";

    run.emit({
      events: [{ type: EVENT_TYPES.actionResolved, data: this.actionResolvedData(action, resolution, actor, "api") }],
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
          },
          seq,
        } satisfies StreamActionResolvedEvent,
      ],
    });

    const remaining = pending.actions.filter((a) => a.id !== action.id);
    const allowedTools = new Set(store.allowedTools ?? []);
    const partial = { text: "" };
    let step: AgentStep;

    if (agent.sdkAgent) {
      if (resolution.type === "tool_approval" && resolution.decision === "allow" && resolution.rememberForSession
        && this.config.allowRememberApproval !== false) {
        const toolName = (action as Extract<PendingAction, { type: "tool_approval" }>).toolName;
        // A per-call predicate decides on the arguments; remembering by name would skip that check.
        const runtimeTools = (agent.sdkAgent as { __runtime?: { tools?: Array<{ name?: string; needsApproval?: unknown }> } }).__runtime?.tools;
        const predicateGated = Array.isArray(runtimeTools)
          && runtimeTools.some((t) => t?.name === toolName && typeof t.needsApproval === "function");
        if (!predicateGated) allowedTools.add(toolName);
      }

      if (remaining.length > 0) {
        // More actions of the same pause are still open: record this answer and wait.
        const state = writeHitl(conversation.state, {
          allowedTools: [...allowedTools],
          pending: { actions: remaining, messageId: pending.messageId, sdkState: jsonSafe(resolveRun.nextSdkState) },
        });
        await this.config.storage.updateConversation(conversationId, { state }, ctx.context);
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

      run.emit({ events: [{ type: EVENT_TYPES.statusRunning, data: { trigger: run.trigger } }] });
      try {
        step = await this.runSdk(run, ctx, agent.sdkAgent as HitlSdkAgent, resolveRun.nextSdkState, allowedTools, partial);
      } catch (error) {
        if (run.cancelled) step = cancelledStep(partial.text);
        else throw error;
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
            usage: result.usage,
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

    return this.finalizeTurn(run, { ctx, conversation, step, allowedTools: [...allowedTools] });
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
      const fresh = (await this.config.storage.getConversation(conversation.id, rc)) ?? conversation;
      const store = readHitl(fresh.state);
      if (!store?.pending) return [];
      const state = writeHitl(fresh.state, { allowedTools: store.allowedTools });
      await this.config.storage.updateConversation(fresh.id, { state }, rc);
      run.emit({
        events: [
          ...store.pending.actions.map((action) => ({
            type: EVENT_TYPES.actionResolved,
            data: this.actionResolvedData(action, undefined, rc?.user?.id ?? "anonymous", "api", true),
          })),
          { type: EVENT_TYPES.statusIdle, data: { stop_reason: "cancelled" } },
        ],
      });
      await run.flush();
      return store.pending.actions.map((a) => a.id);
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
        yield* catchUp();

        while (!closed && Date.now() < deadline) {
          while (queue.length > 0) {
            const item = queue.shift()!;
            if (item.kind === "closed") return;
            if (item.kind === "delta") {
              // A chunk of text the stored events have already caught up with is stale
              if (item.seq >= cursor && (!wanted || wanted.has(EVENT_TYPES.messageDelta))) {
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

    const out = new Map<string, ConversationRuntime>();
    for (const conversation of conversations) {
      const active = this.runs.get(conversation.id);
      const lease = leaseByKey.get(conversationLeaseKey(conversation.id));
      const summary = summaries[conversation.id];
      const pendingActionIds = readHitl(conversation.state)?.pending?.actions.map((a) => a.id) ?? [];
      const activeRunId = active?.id ?? (lease?.data?.runId as string | undefined);
      const running = !!active || !!lease;
      const stop = summary?.stopReason as StopReason | undefined;
      const status: ConversationRuntime["status"] = running
        ? "running"
        : pendingActionIds.length > 0
          ? "requires_action"
          : stop === "budget_reached"
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
      });
    }
    return out;
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
    if (this.closed || !this.config.storage.isConnected()) return;
    try {
      await this.recoverStaleRuns();
      await this.pruneOldEvents();
    } catch (error) {
      // The store going away under a sweep (shutdown) is not a failure worth a log line
      if (!this.config.storage.isConnected() || /closed|not connected|disconnect/i.test((error as Error)?.message ?? "")) return;
      if (!this.sweepWarned) {
        this.sweepWarned = true;
        console.error("[AgentServer] The recovery sweep failed (further failures are not logged):", error);
      }
    }
  }

  private async pruneOldEvents(): Promise<void> {
    const days = this.runCfg.eventRetentionDays;
    if (days <= 0 || Date.now() - this.lastPrune < 3_600_000) return;
    this.lastPrune = Date.now();
    await this.eventStore.prune?.(new Date(Date.now() - days * 86_400_000), this.systemContext());
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

  /**
   * The stored files a message attaches by id (`fileIds`). Refuses before the
   * turn starts: too many (400), or an id that is not a file of this
   * conversation (404, the same answer for a missing file and someone else's).
   */
  private async resolveFileRefs(
    conversationId: string,
    body: SendMessageRequest | undefined,
    ctx: RouteContext
  ): Promise<FileAttachment[]> {
    const raw = body?.fileIds;
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || id.length === 0)) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "fileIds must be an array of file ids",
      } as ValidationError;
    }
    const ids = [...new Set(raw)];
    const maxFiles = this.config.limits?.maxFiles ?? 10;
    if (ids.length + (body?.files?.length ?? 0) > maxFiles) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: `A message can attach at most ${maxFiles} files`,
      } as ValidationError;
    }
    const refs: FileAttachment[] = [];
    for (const id of ids) {
      const file = await this.config.storage.getFile(id, ctx.context);
      if (!file || (file.conversationId && file.conversationId !== conversationId)) {
        throw {
          statusCode: 404,
          code: "NOT_FOUND",
          message: `File not found: ${id}`,
        } as NotFoundError;
      }
      refs.push({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size });
    }
    return refs;
  }

  /** The files of a user message: stored ones attached by id, then inline ones (not stored by the server). */
  private messageFiles(
    body: SendMessageRequest | undefined,
    fileRefs: FileAttachment[]
  ): FileAttachment[] | undefined {
    const inline = (body?.files ?? []).map((file) => ({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: file.name,
      mimeType: file.mimeType,
      size: Buffer.from(file.content, "base64").length,
    }));
    const all = [...fileRefs, ...inline];
    return body?.files || fileRefs.length > 0 ? all : undefined;
  }

  private async handleUploadFile(
    ctx: RouteContext
  ): Promise<RouteResult<UploadFileResponse>> {
    const body = ctx.body as UploadFileRequest;

    if (!body?.file) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "file is required",
      } as ValidationError;
    }

    const { name, content, mimeType } = body.file;

    if (!name || !mimeType || content === undefined || content === null) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "file.name, file.content, and file.mimeType are required",
      } as ValidationError;
    }
    // A named but empty file gets its own message: it is the user's file, not a malformed request
    if (content === "") {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message: "File is empty" } as ValidationError;
    }

    // Check file size limits (before decoding: the base64 text is about a third larger than the file)
    const maxSize = this.maxFileSize;
    if (typeof content !== "string" || Math.floor((content.length * 3) / 4) > maxSize + 3) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: `File size exceeds limit of ${maxSize} bytes`,
      } as ValidationError;
    }
    const contentBuffer = Buffer.from(content, "base64");

    // Base64 that decodes to nothing (whitespace, bare padding) is an empty file too
    if (contentBuffer.length === 0) {
      throw { statusCode: 400, code: "VALIDATION_ERROR", message: "File is empty" } as ValidationError;
    }

    if (contentBuffer.length > maxSize) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: `File size exceeds limit of ${maxSize} bytes`,
      } as ValidationError;
    }

    const file = await this.config.storage.saveFile({
      name,
      mimeType,
      content: contentBuffer,
      conversationId: body.conversationId,
      metadata: body.metadata,
    }, ctx.context);

    return {
      status: 201,
      body: { file },
    };
  }

  private async handleGetFile(ctx: RouteContext): Promise<RouteResult<FileRecord>> {
    const { fileId } = ctx.params;

    const file = await this.config.storage.getFile(fileId, ctx.context);
    if (!file) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File not found: ${fileId}`,
      } as NotFoundError;
    }

    return {
      status: 200,
      body: file,
    };
  }

  private async handleDeleteFile(ctx: RouteContext): Promise<RouteResult> {
    const { fileId } = ctx.params;

    const file = await this.config.storage.getFile(fileId, ctx.context);
    if (!file) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File not found: ${fileId}`,
      } as NotFoundError;
    }

    await this.config.storage.deleteFile(fileId, ctx.context);

    return { status: 204 };
  }

  private async handleDownloadFile(ctx: RouteContext): Promise<RouteResult> {
    const { fileId } = ctx.params;

    const file = await this.config.storage.getFile(fileId, ctx.context);
    if (!file) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File not found: ${fileId}`,
      } as NotFoundError;
    }

    const content = await this.config.storage.getFileContent(fileId, ctx.context);
    if (!content) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File content not found: ${fileId}`,
      } as NotFoundError;
    }

    return {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.name}"`,
        "Content-Length": content.length.toString(),
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

    // Process file uploads if provided
    const files: Task["files"] = [];
    if (body.files && body.files.length > 0) {
      for (const f of body.files) {
        const content = Buffer.from(f.content, "base64");
        const fileRecord = await this.config.storage.saveFile({
          name: f.name,
          mimeType: f.mimeType,
          content,
          metadata: { uploadedForTask: true },
        }, ctx.context);
        files.push({
          id: fileRecord.id,
          name: fileRecord.name,
          mimeType: fileRecord.mimeType,
          size: fileRecord.size,
          storageKey: fileRecord.storageKey,
        });
      }
    }

    // Create task
    const task = await this.config.storage.createTask({
      agentId: body.agentId,
      userId,
      input: body.input,
      files,
      callbackUrl: body.callbackUrl,
      metadata: body.metadata,
    }, ctx.context);

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
    const userId = await this.effectiveUserId(ctx);

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
          fileRefs: started ? [] : task.files ?? [],
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

  /** A task whose conversation starts running (also when an answered action resumes it) is running again. */
  private async markTaskRunning(taskId: string, rc: RequestContext | undefined): Promise<void> {
    try {
      const task = await this.config.storage.getTask(taskId, rc);
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
    if (!task || task.status === "cancelled" || task.status === "failed") return;

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
