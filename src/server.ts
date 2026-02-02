/**
 * Agent Server Core
 *
 * Framework-agnostic core that handles routing and business logic.
 * Adapters (Express, Next.js, etc.) translate HTTP requests to this interface.
 */

import type {
  AgentServerConfig,
  AgentRegistration,
  AgentInfo,
  AuthUser,
  Conversation,
  Message,
  FileRecord,
  SendMessageRequest,
  SendMessageResponse,
  CreateConversationRequest,
  CreateConversationResponse,
  ListAgentsResponse,
  ListConversationsResponse,
  GetConversationResponse,
  UploadFileRequest,
  UploadFileResponse,
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

export interface RouteContext {
  user?: AuthUser;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}

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
}

export class AgentServer {
  private config: AgentServerConfig;
  private agents: Map<string, AgentRegistration> = new Map();
  private routes: Route[] = [];
  private basePath: string;

  constructor(config: AgentServerConfig) {
    this.config = config;
    this.basePath = config.basePath.replace(/\/$/, "");
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
        query: ctx.query,
        body: ctx.body,
      });
    }

    return undefined;
  }

  /**
   * Verify that the current user has access to the conversation
   */
  private async verifyConversationAccess(
    conversation: Conversation,
    ctx: RouteContext
  ): Promise<void> {
    // If conversation has a userId, verify the current user matches
    if (conversation.userId) {
      const currentUserId = ctx.user?.id || await this.resolveUserId(ctx);
      if (currentUserId && conversation.userId !== currentUserId) {
        throw {
          statusCode: 403,
          code: "FORBIDDEN",
          message: "You do not have access to this conversation",
        };
      }
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
   * Get all registered agents
   */
  getAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map((reg) => reg.info);
  }

  /**
   * Get agent by ID
   */
  getAgent(id: string): AgentRegistration | undefined {
    return this.agents.get(id);
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
      }));

      this.addRoute("GET", `${docsPath}/openapi.json`, async () => ({
        status: 200,
        body: generateOpenAPISpec(this.config, this.getAgents()),
        headers: { "Content-Type": "application/json" },
      }));
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
  }

  private addRoute(
    method: Route["method"],
    path: string,
    handler: RouteHandler
  ): void {
    const paramNames: string[] = [];
    const patternStr = path.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    const pattern = new RegExp(`^${patternStr}$`);

    this.routes.push({ method, pattern, paramNames, handler });
  }

  // ============================================================================
  // Request Handling
  // ============================================================================

  /**
   * Handle an incoming request
   */
  async handleRequest(
    method: string,
    path: string,
    ctx: Omit<RouteContext, "params">
  ): Promise<RouteResult> {
    // Remove base path prefix
    let routePath = path;
    if (path.startsWith(this.basePath)) {
      routePath = path.slice(this.basePath.length) || "/";
    }

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
        return await route.handler({ ...ctx, params });
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
          message: `Route not found: ${method} ${path}`,
        },
      },
    };
  }

  private handleError(error: unknown): RouteResult {
    if (error instanceof Error) {
      const agentError = error as {
        statusCode?: number;
        code?: string;
        details?: Record<string, unknown>;
      };

      return {
        status: agentError.statusCode || 500,
        body: {
          error: {
            code: agentError.code || "INTERNAL_ERROR",
            message: error.message,
            details: agentError.details,
          },
        },
      };
    }

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

  private async handleListAgents(_ctx: RouteContext): Promise<RouteResult<ListAgentsResponse>> {
    return {
      status: 200,
      body: { agents: this.getAgents() },
    };
  }

  private async handleGetAgent(ctx: RouteContext): Promise<RouteResult> {
    const { agentId } = ctx.params;
    const agent = this.getAgent(agentId);

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
    const limit = parseInt(ctx.query.limit as string) || 20;
    const offset = parseInt(ctx.query.offset as string) || 0;

    // Resolve userId: from query param, ctx.user (token), or resolveUserId callback
    const resolvedUserId = userId || ctx.user?.id || await this.resolveUserId(ctx);

    const result = await this.config.storage.getConversations({
      agentId,
      userId: resolvedUserId,
      limit,
      offset,
    });

    return {
      status: 200,
      body: {
        conversations: result.data,
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
    if (!this.agents.has(body.agentId)) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Agent not found: ${body.agentId}`,
      } as NotFoundError;
    }

    // Resolve userId: from body, ctx.user (token), or resolveUserId callback
    const userId = body.userId || ctx.user?.id || await this.resolveUserId(ctx);

    const conversation = await this.config.storage.createConversation({
      agentId: body.agentId,
      userId,
      title: body.title,
      metadata: body.metadata,
    });

    return {
      status: 201,
      body: { conversation },
    };
  }

  private async handleGetConversation(
    ctx: RouteContext
  ): Promise<RouteResult<GetConversationResponse>> {
    const { conversationId } = ctx.params;

    const conversation = await this.config.storage.getConversation(conversationId);
    if (!conversation) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Conversation not found: ${conversationId}`,
      } as NotFoundError;
    }

    // Verify user has access to this conversation
    await this.verifyConversationAccess(conversation, ctx);

    const messagesResult = await this.config.storage.getMessages(conversationId);

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

    const existing = await this.config.storage.getConversation(conversationId);
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
    });

    return {
      status: 200,
      body: conversation,
    };
  }

  private async handleDeleteConversation(ctx: RouteContext): Promise<RouteResult> {
    const { conversationId } = ctx.params;

    const existing = await this.config.storage.getConversation(conversationId);
    if (!existing) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `Conversation not found: ${conversationId}`,
      } as NotFoundError;
    }

    // Verify user has access to this conversation
    await this.verifyConversationAccess(existing, ctx);

    await this.config.storage.deleteConversation(conversationId);

    return { status: 204 };
  }

  private async handleListMessages(ctx: RouteContext): Promise<RouteResult> {
    const { conversationId } = ctx.params;
    const limit = parseInt(ctx.query.limit as string) || 100;
    const offset = parseInt(ctx.query.offset as string) || 0;
    const order = (ctx.query.order as string) === "desc" ? "desc" : "asc";

    // Check if conversation exists
    const conversation = await this.config.storage.getConversation(conversationId);
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
    });

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
    const conversation = await this.config.storage.getConversation(conversationId);
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
    const agent = this.agents.get(conversation.agentId);
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
    });

    // Get previous messages for context
    const previousMessages = await this.config.storage.getMessages(conversationId, {
      order: "asc",
    });

    // Process with agent
    let responseContent: string;
    let responseFiles: Message["files"];
    let usage: SendMessageResponse["usage"];

    if (agent.sdkAgent) {
      // Use SDK agent
      const sdkAgent = agent.sdkAgent as {
        invoke: (params: {
          messages: Array<{ role: string; content: string }>;
        }) => Promise<{ content: string; metadata?: { usage?: unknown } }>;
      };

      const messages = previousMessages.data.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));

      const result = await sdkAgent.invoke({ messages });
      responseContent = result.content;
      usage = result.metadata?.usage as SendMessageResponse["usage"];
    } else if (agent.handler) {
      // Use custom handler
      const result = await agent.handler.processMessage({
        conversationId,
        message: body.message,
        files,
        state: conversation.state,
        metadata: body.metadata,
      });
      responseContent = result.content;
      responseFiles = result.files;
      usage = result.usage;

      // Update conversation state if provided
      if (result.state) {
        await this.config.storage.updateConversation(conversationId, {
          state: result.state,
        });
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
    });

    return {
      status: 200,
      body: {
        message: userMessage,
        response: assistantMessage,
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
        const conversation = await self.config.storage.getConversation(conversationId);
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
        const agent = self.agents.get(conversation.agentId);
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
        });

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
        });

        // Process with agent
        let responseContent = "";
        let responseFiles: Message["files"];
        let usage: SendMessageResponse["usage"];

        if (agent.sdkAgent) {
          // Use SDK agent with streaming
          const sdkAgent = agent.sdkAgent as {
            invoke: (
              params: { messages: Array<{ role: string; content: string }> },
              config?: {
                stream?: boolean;
                onStream?: (chunk: { text: string; isFinal?: boolean }) => void;
                onEvent?: (event: { type: string; [key: string]: unknown }) => void;
              }
            ) => Promise<{ content: string; metadata?: { usage?: unknown } }>;
          };

          const messages = previousMessages.data.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }));

          // Collect chunks to yield
          const chunks: string[] = [];
          let chunkIndex = 0;

          const result = await sdkAgent.invoke(
            { messages },
            {
              stream: true,
              onStream: (chunk) => {
                chunks.push(chunk.text);
              },
              onEvent: (event) => {
                // Handle tool calls and other events
                if (event.type === "tool_call") {
                  const toolEvent: StreamToolCallEvent = {
                    type: "stream.tool_call",
                    timestamp: Date.now(),
                    toolName: event.toolName as string,
                    toolCallId: event.toolCallId as string,
                    args: event.args as Record<string, unknown>,
                  };
                  chunks.push(`__EVENT__${JSON.stringify(toolEvent)}`);
                } else if (event.type === "tool_result") {
                  const toolResultEvent: StreamToolResultEvent = {
                    type: "stream.tool_result",
                    timestamp: Date.now(),
                    toolName: event.toolName as string,
                    toolCallId: event.toolCallId as string,
                    result: event.result,
                  };
                  chunks.push(`__EVENT__${JSON.stringify(toolResultEvent)}`);
                }
              },
            }
          );

          // Yield all collected chunks
          for (const chunk of chunks) {
            if (chunk.startsWith("__EVENT__")) {
              yield `data: ${chunk.slice(9)}\n\n`;
            } else {
              const textEvent: StreamTextEvent = {
                type: "stream.text",
                timestamp: Date.now(),
                text: chunk,
                isFinal: false,
              };
              yield `data: ${JSON.stringify(textEvent)}\n\n`;
            }
            chunkIndex++;
          }

          responseContent = result.content;
          usage = result.metadata?.usage as SendMessageResponse["usage"];
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
            });
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
        });

        // Send done event
        const doneEvent: StreamDoneEvent = {
          type: "stream.done",
          timestamp: Date.now(),
          conversationId,
          messageId: assistantMessage.id,
          content: responseContent,
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
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const errorEvent: StreamErrorEvent = {
          type: "stream.error",
          timestamp: Date.now(),
          error: errorMessage,
          code: "INTERNAL_ERROR",
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
    });

    return {
      status: 201,
      body: { file },
    };
  }

  private async handleGetFile(ctx: RouteContext): Promise<RouteResult<FileRecord>> {
    const { fileId } = ctx.params;

    const file = await this.config.storage.getFile(fileId);
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

    const file = await this.config.storage.getFile(fileId);
    if (!file) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File not found: ${fileId}`,
      } as NotFoundError;
    }

    await this.config.storage.deleteFile(fileId);

    return { status: 204 };
  }

  private async handleDownloadFile(ctx: RouteContext): Promise<RouteResult> {
    const { fileId } = ctx.params;

    const file = await this.config.storage.getFile(fileId);
    if (!file) {
      throw {
        statusCode: 404,
        code: "NOT_FOUND",
        message: `File not found: ${fileId}`,
      } as NotFoundError;
    }

    const content = await this.config.storage.getFileContent(fileId);
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
