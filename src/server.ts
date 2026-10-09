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
  Message,
  FileRecord,
  Task,
  TaskResult,
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
} from "./types.js";
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
const MAX_PAGE_SIZE = 200;
function parsePaging(query: Record<string, unknown>, defaultLimit: number): { limit: number; offset: number } {
  const limit = parseInt(String(query.limit ?? ""), 10);
  const offset = parseInt(String(query.offset ?? ""), 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_SIZE) : defaultLimit,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

export class AgentServer {
  private config: AgentServerConfig;
  private agents: Map<string, AgentRegistration> = new Map();
  private routes: Route[] = [];
  private basePath: string;
  /** Per-request memo of the resolved dynamic agent registry. */
  private dynamicAgentCache = new WeakMap<RequestContext, Promise<Map<string, AgentRegistration>>>();

  constructor(config: AgentServerConfig) {
    this.config = config;
    this.basePath = config.basePath.replace(/\/$/, "");
    if (Array.isArray(config.agents)) {
      for (const registration of config.agents) this.agents.set(registration.info.id, registration);
    }
    this.setupRoutes();
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
    const agentAny = agent as { __runtime?: { name?: string; version?: string } };
    const name =
      info?.name || agentAny.__runtime?.name || id;
    const version = info?.version || agentAny.__runtime?.version;

    this.agents.set(id, {
      info: {
        id,
        name,
        version,
        description: info?.description,
        metadata: info?.metadata,
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
    const { limit, offset } = parsePaging(ctx.query, 20);

    // Resolve userId: from query param, ctx.user (token), or resolveUserId callback
    const resolvedUserId = await this.effectiveUserId(ctx, userId);
    const registry = await this.resolveRegistry(ctx.context!);

    const result = await this.config.storage.getConversations({
      agentId,
      userId: resolvedUserId,
      limit,
      offset,
    }, ctx.context);

    return {
      status: 200,
      body: {
        conversations: result.data.map((conv) => ({
          ...conv,
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

    const messagesResult = await this.config.storage.getMessages(conversationId, undefined, ctx.context);

    return {
      status: 200,
      body: {
        conversation,
        messages: messagesResult.data,
      },
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
      body: conversation,
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

    await this.config.storage.deleteConversation(conversationId, ctx.context);

    return { status: 204 };
  }

  private async handleListMessages(ctx: RouteContext): Promise<RouteResult> {
    const { conversationId } = ctx.params;
    const { limit, offset } = parsePaging(ctx.query, 100);
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
        messages: result.data,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    };
  }

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

    // Check if streaming is requested
    if (body.stream) {
      return this.handleSendMessageStream(ctx);
    }

    // Get conversation
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

    // Get agent
    const agent = await this.getAgentFor(conversation.agentId, ctx.context);
    if (!agent) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Agent not found: ${conversation.agentId}`,
      } as NotFoundError;
    }

    // Handle file attachments
    const files = body.files?.map((file) => ({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: file.name,
      mimeType: file.mimeType,
      size: Buffer.from(file.content, "base64").length,
    }));

    // Save user message
    const userMessage = await this.config.storage.createMessage({
      conversationId,
      role: "user",
      content: body.message,
      files,
      metadata: body.metadata,
    }, ctx.context);

    // Get previous messages for context
    const previousMessages = await this.config.storage.getMessages(conversationId, {
      order: "asc",
    }, ctx.context);

    // Process with agent
    let responseContent: string;
    let responseFiles: Message["files"];
    let usage: SendMessageResponse["usage"];

    if (agent.sdkAgent) {
      // Use SDK agent
      const sdkAgent = agent.sdkAgent as {
        invoke: (
          params: {
            messages: Array<{ role: string; content: string; tool_calls?: any; tool_call_id?: string; name?: string }>;
          },
          config?: { context?: RequestContext }
        ) => Promise<{ content: string; metadata?: { usage?: unknown } }>;
      };

      // Map messages with tool_calls and tool_call_id preserved
      const messages = previousMessages.data.map((m) => ({
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

      const result = await sdkAgent.invoke({ messages }, { context: ctx.context });
      responseContent = result.content;
      usage = result.metadata?.usage as SendMessageResponse["usage"];
    } else if (agent.chatCompletions) {
      // Use Chat Completions API
      const messages = previousMessages.data.map((m) => ({
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

      const result = await invokeChatCompletions(agent.chatCompletions, messages);
      responseContent = result.content;
      usage = result.usage;
    } else if (agent.responsesApi) {
      // Use Responses API
      const messages = previousMessages.data.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));

      const result = await invokeResponsesApi(agent.responsesApi, messages);
      responseContent = result.content;
      usage = result.usage;

      // Store responseId in conversation state for potential chaining
      await this.config.storage.updateConversation(conversationId, {
        state: { ...conversation.state, lastResponseId: result.responseId },
      }, ctx.context);
    } else if (agent.handler) {
      // Use custom handler
      const result = await agent.handler.processMessage({
        conversationId,
        message: body.message,
        files,
        state: conversation.state,
        metadata: body.metadata,
        context: ctx.context,
      });
      responseContent = result.content;
      responseFiles = result.files;
      usage = result.usage;

      // Update conversation state if provided
      if (result.state) {
        await this.config.storage.updateConversation(conversationId, {
          state: result.state,
        }, ctx.context);
      }
    } else {
      throw {
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "Agent has no handler",
      };
    }

    // Save assistant message
    const assistantMessage = await this.config.storage.createMessage({
      conversationId,
      role: "assistant",
      content: responseContent,
      files: responseFiles,
    }, ctx.context);

    // Auto-generate title on the first exchange
    let conversationTitle: string | undefined;
    if (!conversation.title && previousMessages.data.length === 1) {
      conversationTitle = await this.generateTitle(body.message);
      if (conversationTitle) {
        await this.config.storage.updateConversation(conversationId, { title: conversationTitle }, ctx.context);
      }
    }

    return {
      status: 200,
      body: {
        message: userMessage,
        response: assistantMessage,
        conversationTitle,
        usage,
      },
    };
  }

  /**
   * Handle streaming message send via SSE
   */
  private async handleSendMessageStream(
    ctx: RouteContext
  ): Promise<RouteResult<SendMessageResponse>> {
    const { conversationId } = ctx.params;
    const body = ctx.body as SendMessageRequest;

    // Create the SSE stream generator
    const self = this;

    async function* generateStream(): AsyncGenerator<string, void, unknown> {
      const timestamp = Date.now();

      try {
        // Get conversation
        const conversation = await self.config.storage.getConversation(conversationId, ctx.context);
        if (!conversation) {
          const errorEvent: StreamErrorEvent = {
            type: "stream.error",
            timestamp,
            error: `Conversation not found: ${conversationId}`,
            code: "NOT_FOUND",
          };
          yield `data: ${JSON.stringify(errorEvent)}\n\n`;
          return;
        }

        // Verify user has access to this conversation
        try {
          await self.verifyConversationAccess(conversation, ctx);
        } catch (error) {
          const errorEvent: StreamErrorEvent = {
            type: "stream.error",
            timestamp,
            error: (error as { message?: string }).message || "Access denied",
            code: "FORBIDDEN",
          };
          yield `data: ${JSON.stringify(errorEvent)}\n\n`;
          return;
        }

        // Get agent
        const agent = await self.getAgentFor(conversation.agentId, ctx.context);
        if (!agent) {
          const errorEvent: StreamErrorEvent = {
            type: "stream.error",
            timestamp,
            error: `Agent not found: ${conversation.agentId}`,
            code: "NOT_FOUND",
          };
          yield `data: ${JSON.stringify(errorEvent)}\n\n`;
          return;
        }

        // Handle file attachments
        const files = body.files?.map((file) => ({
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: file.name,
          mimeType: file.mimeType,
          size: Buffer.from(file.content, "base64").length,
        }));

        // Save user message
        const userMessage = await self.config.storage.createMessage({
          conversationId,
          role: "user",
          content: body.message,
          files,
          metadata: body.metadata,
        }, ctx.context);

        // Send start event
        const startEvent: StreamStartEvent = {
          type: "stream.start",
          timestamp: Date.now(),
          conversationId,
          messageId: userMessage.id,
        };
        yield `data: ${JSON.stringify(startEvent)}\n\n`;

        // Get previous messages for context
        const previousMessages = await self.config.storage.getMessages(conversationId, {
          order: "asc",
        }, ctx.context);

        // Process with agent
        let responseContent = "";
        let responseFiles: Message["files"];
        let usage: SendMessageResponse["usage"];

        if (agent.sdkAgent) {
          // Use SDK agent with streaming
          const sdkAgent = agent.sdkAgent as {
            invoke: (
              params: { messages: Array<{ role: string; content: string; tool_calls?: any; tool_call_id?: string; name?: string }> },
              config?: {
                stream?: boolean;
                context?: RequestContext;
                onStream?: (chunk: { text: string; isFinal?: boolean }) => void;
                onEvent?: (event: { type: string; [key: string]: unknown }) => void;
              }
            ) => Promise<{ content: string; metadata?: { usage?: unknown } }>;
          };

          // Map messages with tool_calls and tool_call_id preserved
          const messages = previousMessages.data.map((m) => ({
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

          // Use async queue to bridge callback-based streaming with generator-based yielding
          const queue: string[] = [];
          let resolveWait: (() => void) | null = null;
          let streamDone = false;
          let streamedAnyText = false;
          let finalChunkText = "";
          let invokeFailure: { error: unknown } | undefined;

          const pushToQueue = (item: string) => {
            queue.push(item);
            if (resolveWait) {
              resolveWait();
              resolveWait = null;
            }
          };

          const waitForItem = (): Promise<void> => {
            if (queue.length > 0 || streamDone) {
              return Promise.resolve();
            }
            return new Promise((resolve) => {
              resolveWait = resolve;
            });
          };

          // Start the agent invocation in background
          const invokePromise = sdkAgent.invoke(
            { messages },
            {
              stream: true,
              context: ctx.context,
              onStream: (chunk) => {
                // Agent SDK emits a final full-text chunk (isFinal:true). Don't
                // forward it as stream.text (it would duplicate the streamed
                // text) - but remember it: an agent that never streamed
                // (tool agents run non-streaming) only delivers the answer here.
                if (chunk.isFinal) {
                  finalChunkText = chunk.text;
                  return;
                }
                streamedAnyText = streamedAnyText || chunk.text.length > 0;
                const textEvent: StreamTextEvent = {
                  type: "stream.text",
                  timestamp: Date.now(),
                  text: chunk.text,
                  isFinal: false,
                };
                pushToQueue(`data: ${JSON.stringify(textEvent)}\n\n`);
              },
              onEvent: (event) => {
                // Handle tool calls and other events
                // The SDK emits tool_call events at multiple phases:
                //   phase "start"   → tool execution is beginning
                //   phase "success" → tool execution completed with result
                //   phase "error"   → tool execution failed
                //   phase "skipped" → tool was skipped (limit reached)
                // Only emit stream.tool_call on "start"; convert "success"/"error" to stream.tool_result.
                if (event.type === "tool_call") {
                  const phase = (event as { phase?: string }).phase;
                  const props = extractToolEventProps(event);

                  if (phase === "success" || phase === "error") {
                    // Tool finished — emit as tool_result
                    const toolResultEvent: StreamToolResultEvent = {
                      type: "stream.tool_result",
                      timestamp: Date.now(),
                      toolName: props.toolName,
                      toolCallId: props.toolCallId,
                      result: phase === "success"
                        ? (event as { result?: unknown }).result
                        : { error: ((event as { error?: { message?: string } }).error)?.message || "Tool execution failed" },
                    };
                    pushToQueue(`data: ${JSON.stringify(toolResultEvent)}\n\n`);
                  } else if (!phase || phase === "start") {
                    // Tool starting — emit as tool_call
                    const toolEvent: StreamToolCallEvent = {
                      type: "stream.tool_call",
                      timestamp: Date.now(),
                      toolName: props.toolName,
                      toolCallId: props.toolCallId,
                      args: props.args as Record<string, unknown>,
                    };
                    pushToQueue(`data: ${JSON.stringify(toolEvent)}\n\n`);
                  }
                  // phase "skipped" → do not emit (already at tool limit)
                } else if (event.type === "tool_result") {
                  const props = extractToolEventProps(event);
                  const toolResultEvent: StreamToolResultEvent = {
                    type: "stream.tool_result",
                    timestamp: Date.now(),
                    toolName: props.toolName,
                    toolCallId: props.toolCallId,
                    result: event.result,
                  };
                  pushToQueue(`data: ${JSON.stringify(toolResultEvent)}\n\n`);
                }
              },
            }
          ).then(
            (result) => {
              streamDone = true;
              if (resolveWait) {
                resolveWait();
                resolveWait = null;
              }
              return result;
            },
            (error: unknown) => {
              // A rejected invoke must end the wait loop below. Left unhandled it
              // both hangs the stream (streamDone never flips) and surfaces as an
              // unhandledRejection, which takes down a host process.
              invokeFailure = { error };
              streamDone = true;
              if (resolveWait) {
                resolveWait();
                resolveWait = null;
              }
              return undefined;
            }
          );

          // Yield chunks as they arrive
          while (!streamDone || queue.length > 0) {
            await waitForItem();
            while (queue.length > 0) {
              yield queue.shift()!;
            }
          }

          const settled = await invokePromise;
          // Reported as a stream.error event by the catch below (text already sent stays sent).
          if (invokeFailure) throw invokeFailure.error;
          const result = settled!;

          responseContent = result.content;
          usage = result.metadata?.usage as SendMessageResponse["usage"];

          // The agent returned its answer without streaming any text: emit it once
          // so streaming clients (chat-ui) don't end up with an empty bubble.
          if (!streamedAnyText) {
            const fallbackText = responseContent || finalChunkText;
            if (fallbackText) {
              const textEvent: StreamTextEvent = {
                type: "stream.text",
                timestamp: Date.now(),
                text: fallbackText,
                isFinal: true,
              };
              yield `data: ${JSON.stringify(textEvent)}\n\n`;
            }
            responseContent = fallbackText;
          }
        } else if (agent.chatCompletions) {
          // Use Chat Completions API with streaming
          const messages = previousMessages.data.map((m) => ({
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

          const stream = streamChatCompletions(agent.chatCompletions, messages);
          for await (const event of stream) {
            if (event.type === "text") {
              const textEvent: StreamTextEvent = {
                type: "stream.text",
                timestamp: Date.now(),
                text: event.text,
                isFinal: false,
              };
              yield `data: ${JSON.stringify(textEvent)}\n\n`;
            } else if (event.type === "done") {
              responseContent = event.content;
              usage = event.usage;
            }
          }
        } else if (agent.responsesApi) {
          // Use Responses API with streaming
          const messages = previousMessages.data.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }));

          const stream = streamResponsesApi(agent.responsesApi, messages);
          for await (const event of stream) {
            if (event.type === "text") {
              const textEvent: StreamTextEvent = {
                type: "stream.text",
                timestamp: Date.now(),
                text: event.text,
                isFinal: false,
              };
              yield `data: ${JSON.stringify(textEvent)}\n\n`;
            } else if (event.type === "done") {
              responseContent = event.content;
              usage = event.usage;

              // Store responseId in conversation state for potential chaining
              if (event.responseId) {
                await self.config.storage.updateConversation(conversationId, {
                  state: { ...conversation.state, lastResponseId: event.responseId },
                }, ctx.context);
              }
            }
          }
        } else if (agent.handler) {
          // Use custom handler (non-streaming, send progress updates)
          const progressEvent: StreamProgressEvent = {
            type: "stream.progress",
            timestamp: Date.now(),
            stage: "processing",
            message: "Processing message...",
          };
          yield `data: ${JSON.stringify(progressEvent)}\n\n`;

          const result = await agent.handler.processMessage({
            conversationId,
            message: body.message,
            files,
            state: conversation.state,
            metadata: body.metadata,
            context: ctx.context,
          });

          responseContent = result.content;
          responseFiles = result.files;
          usage = result.usage;

          // Send the full content as a single text event
          const textEvent: StreamTextEvent = {
            type: "stream.text",
            timestamp: Date.now(),
            text: responseContent,
            isFinal: true,
          };
          yield `data: ${JSON.stringify(textEvent)}\n\n`;

          // Update conversation state if provided
          if (result.state) {
            await self.config.storage.updateConversation(conversationId, {
              state: result.state,
            }, ctx.context);
          }
        } else {
          const errorEvent: StreamErrorEvent = {
            type: "stream.error",
            timestamp: Date.now(),
            error: "Agent has no handler",
            code: "INTERNAL_ERROR",
          };
          yield `data: ${JSON.stringify(errorEvent)}\n\n`;
          return;
        }

        // Save assistant message
        const assistantMessage = await self.config.storage.createMessage({
          conversationId,
          role: "assistant",
          content: responseContent,
          files: responseFiles,
        }, ctx.context);

        // Auto-generate title on the first exchange
        let generatedTitle: string | undefined;
        if (!conversation.title && previousMessages.data.length === 1) {
          generatedTitle = await self.generateTitle(body.message);
          if (generatedTitle) {
            await self.config.storage.updateConversation(conversationId, { title: generatedTitle }, ctx.context);
          }
        }

        // Send done event
        const doneEvent: StreamDoneEvent = {
          type: "stream.done",
          timestamp: Date.now(),
          conversationId,
          messageId: assistantMessage.id,
          content: responseContent,
          title: generatedTitle,
          usage: usage
            ? {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
              }
            : undefined,
        };
        yield `data: ${JSON.stringify(doneEvent)}\n\n`;
      } catch (error) {
        const exposed = self.isExposedError(error as { statusCode?: number; expose?: boolean } | null);
        if (!exposed) console.error("[AgentServer] Stream error:", error);
        const errorMessage = !exposed
          ? "An unexpected error occurred"
          : error instanceof Error
            ? error.message
            : "Unknown error";
        const errorEvent: StreamErrorEvent = {
          type: "stream.error",
          timestamp: Date.now(),
          error: errorMessage,
          // Host-authored errors (statusCode + code) keep their own code, e.g. CONVERSATION_BUSY.
          code: exposed && typeof (error as { statusCode?: unknown })?.statusCode === "number" && typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "INTERNAL_ERROR",
        };
        yield `data: ${JSON.stringify(errorEvent)}\n\n`;
      }
    }

    return {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
      stream: generateStream(),
    };
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

    if (!name || !content || !mimeType) {
      throw {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "file.name, file.content, and file.mimeType are required",
      } as ValidationError;
    }

    // Check file size limits
    const contentBuffer = Buffer.from(content, "base64");
    const maxSize = this.config.limits?.maxFileSize || 10 * 1024 * 1024; // 10MB default

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
    const { limit, offset } = parsePaging(ctx.query, 20);

    // Resolve userId
    const userId = await this.effectiveUserId(ctx);

    const result = await this.config.storage.getTasks({
      agentId,
      userId,
      status,
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

    return {
      status: 200,
      body: {
        task,
        result: result || undefined,
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

  private async processTaskInBackground(taskId: string, rc: RequestContext): Promise<void> {
    try {
      // Get the task
      const task = await this.config.storage.getTask(taskId, rc);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

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

      let responseContent: string;
      let responseFiles: Task["files"];
      let usage: TaskResult["usage"];

      // Build messages from input and comments history
      const messages: Array<{ role: string; content: string }> = [
        { role: "user", content: task.input },
      ];
      
      // Add comments as conversation history
      if (task.comments && task.comments.length > 0) {
        for (const comment of task.comments) {
          messages.push({
            role: comment.role === "agent" ? "assistant" : "user",
            content: comment.content,
          });
        }
      }

      // Process with SDK agent, AI provider, or custom handler
      if (agentReg.sdkAgent) {
        // SDK Agent processing - use invoke method like regular message processing
        const sdkAgent = agentReg.sdkAgent as {
          invoke: (
            params: { messages: Array<{ role: string; content: string }> },
            config?: { context?: RequestContext }
          ) => Promise<{ content: string; metadata?: { usage?: unknown } }>;
        };

        const result = await sdkAgent.invoke({ messages }, { context: rc });

        responseContent = result.content || "Task completed";
        usage = result.metadata?.usage as TaskResult["usage"];
      } else if (agentReg.chatCompletions) {
        // Chat Completions API processing
        const result = await invokeChatCompletions(agentReg.chatCompletions, messages);
        responseContent = result.content || "Task completed";
        usage = result.usage;
      } else if (agentReg.responsesApi) {
        // Responses API processing
        const result = await invokeResponsesApi(agentReg.responsesApi, messages);
        responseContent = result.content || "Task completed";
        usage = result.usage;
      } else if (agentReg.handler) {
        // Custom handler processing
        const result = await agentReg.handler.processMessage({
          conversationId: `task_${taskId}`,
          message: task.input,
          files: task.files,
          metadata: {
            ...task.metadata,
            comments: task.comments || [],
          },
          context: rc,
        });

        responseContent = result.content;
        responseFiles = result.files;
        usage = result.usage;

        // Check if agent requested clarification (waiting_for_input)
        if (result.metadata?.waitingForInput) {
          const agentComment: TaskComment = {
            id: `comment_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            taskId,
            role: "agent",
            content: responseContent,
            metadata: result.metadata,
            createdAt: new Date(),
          };

          const existingComments = task.comments || [];
          await this.config.storage.updateTask(taskId, {
            status: "waiting_for_input",
            comments: [...existingComments, agentComment],
          }, rc);

          // Create partial task result
          await this.config.storage.createTaskResult({
            taskId,
            content: responseContent,
            files: responseFiles,
            usage,
            metadata: { waitingForInput: true },
          }, rc);

          // Send callback notification
          if (task.callbackUrl) {
            await this.sendTaskCallback(task.callbackUrl, taskId, "waiting_for_input");
          }
          return;
        }
      } else {
        throw new Error("Agent has no SDK agent, AI provider, or custom handler");
      }

      // Create task result
      await this.config.storage.createTaskResult({
        taskId,
        content: responseContent,
        files: responseFiles,
        usage,
        metadata: {},
      }, rc);

      // Update task status to completed
      await this.config.storage.updateTask(taskId, {
        status: "completed",
        completedAt: new Date(),
      }, rc);

      // Send callback notification
      if (task.callbackUrl) {
        await this.sendTaskCallback(task.callbackUrl, taskId, "completed");
      }
    } catch (error) {
      // Update task status to failed
      await this.config.storage.updateTask(taskId, {
        status: "failed",
        completedAt: new Date(),
        error: (error as Error).message,
      }, rc);

      // Send callback notification with error
      const task = await this.config.storage.getTask(taskId, rc);
      if (task?.callbackUrl) {
        await this.sendTaskCallback(task.callbackUrl, taskId, "failed", (error as Error).message);
      }

      throw error;
    }
  }

  private async sendTaskCallback(
    callbackUrl: string,
    taskId: string,
    status: "completed" | "failed" | "waiting_for_input",
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
