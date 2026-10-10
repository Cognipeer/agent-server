/**
 * OpenAPI/Swagger specification generator
 */

import type { AgentServerConfig, AgentInfo } from "./types.js";

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: Array<{ url: string; description?: string }>;
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
}

export function generateOpenAPISpec(
  config: AgentServerConfig,
  agents: AgentInfo[]
): OpenAPISpec {
  const basePath = config.basePath.replace(/\/$/, "");
  const swaggerConfig = config.swagger ?? { enabled: false };

  const spec: OpenAPISpec = {
    openapi: "3.0.3",
    info: {
      title: swaggerConfig.title || "Agent Server API",
      version: swaggerConfig.version || "1.0.0",
      description:
        swaggerConfig.description ||
        "REST API for AI agents - manage conversations and messages",
    },
    servers: [{ url: basePath, description: "Agent Server" }],
    paths: {},
    components: {
      schemas: generateSchemas(),
      securitySchemes: config.auth?.enabled
        ? {
            BearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
              description: "Bearer token authentication",
            },
          }
        : undefined,
    },
    security: config.auth?.enabled ? [{ BearerAuth: [] }] : undefined,
  };

  // Generate paths
  spec.paths = generatePaths(agents, config.auth?.enabled || false);

  return spec;
}

function generateSchemas(): Record<string, unknown> {
  return {
    Agent: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent unique identifier" },
        name: { type: "string", description: "Agent name" },
        description: { type: "string", description: "Agent description" },
        version: { type: "string", description: "Agent version" },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["id", "name"],
    },
    Conversation: {
      type: "object",
      properties: {
        id: { type: "string" },
        agentId: { type: "string" },
        userId: { type: "string" },
        title: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
        state: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "agentId", "createdAt", "updatedAt"],
    },
    Message: {
      type: "object",
      properties: {
        id: { type: "string" },
        conversationId: { type: "string" },
        role: {
          type: "string",
          enum: ["user", "assistant", "system", "tool"],
        },
        content: {
          oneOf: [
            { type: "string" },
            {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  text: { type: "string" },
                },
              },
            },
          ],
        },
        name: { type: "string" },
        toolCalls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              arguments: { type: "string" },
            },
          },
        },
        files: {
          type: "array",
          items: { $ref: "#/components/schemas/FileAttachment" },
        },
        metadata: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "conversationId", "role", "content", "createdAt", "updatedAt"],
    },
    FileAttachment: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        mimeType: { type: "string" },
        size: { type: "integer" },
        url: { type: "string" },
      },
      required: ["id", "name", "mimeType", "size"],
    },
    FileRecord: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        mimeType: { type: "string" },
        size: { type: "integer" },
        storageKey: { type: "string" },
        conversationId: { type: "string" },
        messageId: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "name", "mimeType", "size", "storageKey", "createdAt"],
    },
    CreateConversationRequest: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        userId: { type: "string", description: "User ID for the conversation owner. If not provided, resolved from auth token or resolveUserId callback." },
        title: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["agentId"],
    },
    SendMessageRequest: {
      type: "object",
      properties: {
        message: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string", description: "Base64 encoded content" },
              mimeType: { type: "string" },
            },
            required: ["name", "content", "mimeType"],
          },
        },
        metadata: { type: "object", additionalProperties: true },
        stream: {
          type: "boolean",
          default: false,
          description: "Enable streaming response via Server-Sent Events (SSE). When true, response is sent as text/event-stream.",
        },
      },
      required: ["message"],
    },
    SendMessageResponse: {
      type: "object",
      properties: {
        message: { $ref: "#/components/schemas/Message" },
        response: { $ref: "#/components/schemas/Message" },
        usage: {
          type: "object",
          properties: {
            inputTokens: { type: "integer" },
            outputTokens: { type: "integer" },
            totalTokens: { type: "integer" },
          },
        },
        status: {
          type: "string",
          enum: ["completed", "requires_action", "incomplete", "cancelled"],
          description: "Only present when the turn did not simply complete (e.g. requires_action).",
        },
        pendingActions: {
          type: "array",
          items: { $ref: "#/components/schemas/PendingAction" },
        },
        warnings: { type: "array", items: { $ref: "#/components/schemas/TurnWarning" } },
      },
      required: ["message", "response"],
    },
    TurnWarning: {
      type: "object",
      description:
        "Something worth knowing about a turn that completed anyway; also stored on the assistant message as metadata.warnings. " +
        "Code pause_state_too_large: the turn needed a human but its state did not fit the store (limits.maxStateBytes or the provider's limit), so it was not paused.",
      properties: {
        code: { type: "string", example: "pause_state_too_large" },
        message: { type: "string" },
        stateBytes: { type: "integer" },
        maxStateBytes: { type: "integer" },
      },
      required: ["code", "message"],
    },
    MessagesPage: {
      type: "object",
      description: "Where a page of GET /conversations/{id} messages sits in the conversation.",
      properties: {
        limit: { type: "integer" },
        order: { type: "string", enum: ["asc", "desc"] },
        hasMoreBefore: { type: "boolean", description: "Older messages exist than the oldest one returned." },
        hasMoreAfter: { type: "boolean", description: "Newer messages exist than the newest one returned." },
      },
    },
    PendingAction: {
      type: "object",
      description: "Something the agent is waiting on (tool approval or user question).",
      properties: {
        id: { type: "string" },
        type: { type: "string", enum: ["tool_approval", "user_question"] },
        toolName: { type: "string" },
        toolCallId: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        args: { type: "object", additionalProperties: true },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              header: { type: "string" },
              multiSelect: { type: "boolean" },
              placeholder: { type: "string" },
              required: { type: "boolean" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    value: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["question"],
          },
        },
        allowFreeText: { type: "boolean" },
        expiresAt: { type: "string", format: "date-time" },
      },
      required: ["id", "type"],
    },
    ResolveActionRequest: {
      type: "object",
      properties: {
        resolution: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["tool_approval"] },
                decision: { type: "string", enum: ["allow", "deny"] },
                comment: { type: "string" },
                approvedArgs: { type: "object", additionalProperties: true },
                rememberForSession: { type: "boolean" },
              },
              required: ["type", "decision"],
            },
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["user_question"] },
                answers: {
                  type: "object",
                  additionalProperties: {
                    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                  },
                },
                cancelled: { type: "boolean" },
              },
              required: ["type"],
            },
          ],
        },
        stream: { type: "boolean", default: false, description: "Stream the continuation as SSE." },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["resolution"],
    },
    ResolveActionResponse: {
      type: "object",
      properties: {
        response: { $ref: "#/components/schemas/Message" },
        usage: {
          type: "object",
          properties: {
            inputTokens: { type: "integer" },
            outputTokens: { type: "integer" },
            totalTokens: { type: "integer" },
          },
        },
        status: { type: "string", enum: ["completed", "requires_action", "incomplete", "cancelled"] },
        pendingActions: { type: "array", items: { $ref: "#/components/schemas/PendingAction" } },
        warnings: { type: "array", items: { $ref: "#/components/schemas/TurnWarning" } },
      },
      required: ["response"],
    },
    UploadFileRequest: {
      type: "object",
      properties: {
        file: {
          type: "object",
          properties: {
            name: { type: "string" },
            content: { type: "string", description: "Base64 encoded content" },
            mimeType: { type: "string" },
          },
          required: ["name", "content", "mimeType"],
        },
        conversationId: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["file"],
    },
    Error: {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: { type: "object", additionalProperties: true },
          },
          required: ["code", "message"],
        },
      },
      required: ["error"],
    },
    PaginatedConversations: {
      type: "object",
      properties: {
        conversations: {
          type: "array",
          items: { $ref: "#/components/schemas/Conversation" },
        },
        total: { type: "integer" },
        limit: { type: "integer" },
        offset: { type: "integer" },
        hasMore: { type: "boolean" },
      },
      required: ["conversations", "total", "limit", "offset", "hasMore"],
    },
    PaginatedMessages: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: { $ref: "#/components/schemas/Message" },
        },
        total: { type: "integer" },
        limit: { type: "integer" },
        offset: { type: "integer" },
        hasMore: { type: "boolean" },
      },
      required: ["messages", "total", "limit", "offset", "hasMore"],
    },
    // Stream Event Types (SSE)
    StreamStartEvent: {
      type: "object",
      description: "Sent when streaming begins",
      properties: {
        type: { type: "string", enum: ["stream.start"] },
        timestamp: { type: "integer" },
        conversationId: { type: "string" },
        messageId: { type: "string" },
      },
    },
    StreamTextEvent: {
      type: "object",
      description: "Partial text chunk from the response",
      properties: {
        type: { type: "string", enum: ["stream.text"] },
        timestamp: { type: "integer" },
        text: { type: "string" },
        isFinal: { type: "boolean" },
      },
    },
    StreamToolCallEvent: {
      type: "object",
      description: "Agent is calling a tool",
      properties: {
        type: { type: "string", enum: ["stream.tool_call"] },
        timestamp: { type: "integer" },
        toolName: { type: "string" },
        toolCallId: { type: "string" },
        args: { type: "object" },
      },
    },
    StreamToolResultEvent: {
      type: "object",
      description: "Tool execution completed",
      properties: {
        type: { type: "string", enum: ["stream.tool_result"] },
        timestamp: { type: "integer" },
        toolName: { type: "string" },
        toolCallId: { type: "string" },
        result: {},
      },
    },
    StreamProgressEvent: {
      type: "object",
      description: "Progress update",
      properties: {
        type: { type: "string", enum: ["stream.progress"] },
        timestamp: { type: "integer" },
        stage: { type: "string" },
        message: { type: "string" },
        percent: { type: "number" },
      },
    },
    StreamErrorEvent: {
      type: "object",
      description: "An error occurred",
      properties: {
        type: { type: "string", enum: ["stream.error"] },
        timestamp: { type: "integer" },
        error: { type: "string" },
        code: { type: "string" },
      },
    },
    StreamDoneEvent: {
      type: "object",
      description: "Stream completed successfully",
      properties: {
        type: { type: "string", enum: ["stream.done"] },
        timestamp: { type: "integer" },
        conversationId: { type: "string" },
        messageId: { type: "string" },
        content: { type: "string" },
        usage: {
          type: "object",
          properties: {
            inputTokens: { type: "integer" },
            outputTokens: { type: "integer" },
            totalTokens: { type: "integer" },
          },
        },
        status: { type: "string", enum: ["completed", "requires_action", "incomplete", "cancelled"] },
        pendingActions: { type: "array", items: { $ref: "#/components/schemas/PendingAction" } },
        warnings: { type: "array", items: { $ref: "#/components/schemas/TurnWarning" } },
      },
    },
    StreamActionRequiredEvent: {
      type: "object",
      description: "The agent paused and is waiting on a human",
      properties: {
        type: { type: "string", enum: ["stream.action_required"] },
        timestamp: { type: "integer" },
        conversationId: { type: "string" },
        messageId: { type: "string" },
        actions: { type: "array", items: { $ref: "#/components/schemas/PendingAction" } },
      },
    },
    StreamActionResolvedEvent: {
      type: "object",
      description: "A pending action was resolved",
      properties: {
        type: { type: "string", enum: ["stream.action_resolved"] },
        timestamp: { type: "integer" },
        conversationId: { type: "string" },
        actionId: { type: "string" },
        resolution: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["tool_approval", "user_question"] },
            decision: { type: "string", enum: ["allow", "deny"] },
            cancelled: { type: "boolean" },
          },
        },
      },
    },
    Task: {
      type: "object",
      properties: {
        id: { type: "string" },
        agentId: { type: "string" },
        userId: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "running", "completed", "failed", "waiting_for_input"],
        },
        callbackUrl: { type: "string" },
        input: { type: "string" },
        files: {
          type: "array",
          items: { $ref: "#/components/schemas/FileAttachment" },
        },
        comments: {
          type: "array",
          items: { $ref: "#/components/schemas/TaskComment" },
          description: "Comments between agent and user for clarification",
        },
        metadata: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        startedAt: { type: "string", format: "date-time" },
        completedAt: { type: "string", format: "date-time" },
        error: { type: "string" },
      },
      required: ["id", "agentId", "status", "input", "createdAt", "updatedAt"],
    },
    TaskComment: {
      type: "object",
      properties: {
        id: { type: "string" },
        taskId: { type: "string" },
        role: {
          type: "string",
          enum: ["agent", "user"],
          description: "Who sent this comment",
        },
        content: { type: "string", description: "Comment content" },
        metadata: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "taskId", "role", "content", "createdAt"],
    },
    TaskResult: {
      type: "object",
      properties: {
        id: { type: "string" },
        taskId: { type: "string" },
        content: { type: "string" },
        files: {
          type: "array",
          items: { $ref: "#/components/schemas/FileAttachment" },
        },
        metadata: { type: "object", additionalProperties: true },
        usage: {
          type: "object",
          properties: {
            inputTokens: { type: "integer" },
            outputTokens: { type: "integer" },
            totalTokens: { type: "integer" },
          },
        },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "taskId", "content", "createdAt"],
    },
    CreateTaskRequest: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        input: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string", description: "Base64 encoded content" },
              mimeType: { type: "string" },
            },
            required: ["name", "content", "mimeType"],
          },
        },
        callbackUrl: { type: "string", description: "URL to receive task completion notification" },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["agentId", "input"],
    },
    CreateTaskResponse: {
      type: "object",
      properties: {
        task: { $ref: "#/components/schemas/Task" },
      },
      required: ["task"],
    },
    ListTasksResponse: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { $ref: "#/components/schemas/Task" },
        },
        total: { type: "integer" },
        limit: { type: "integer" },
        offset: { type: "integer" },
        hasMore: { type: "boolean" },
      },
      required: ["tasks", "total", "limit", "offset", "hasMore"],
    },
    GetTaskResponse: {
      type: "object",
      properties: {
        task: { $ref: "#/components/schemas/Task" },
        result: { $ref: "#/components/schemas/TaskResult" },
      },
      required: ["task"],
    },
    GetTaskStatusResponse: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "running", "completed", "failed", "waiting_for_input"],
        },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        startedAt: { type: "string", format: "date-time" },
        completedAt: { type: "string", format: "date-time" },
        error: { type: "string" },
      },
      required: ["taskId", "status", "createdAt", "updatedAt"],
    },
    GetTaskResultResponse: {
      type: "object",
      properties: {
        result: { $ref: "#/components/schemas/TaskResult" },
      },
      required: ["result"],
    },
    AddTaskCommentRequest: {
      type: "object",
      properties: {
        content: { type: "string", description: "Comment content" },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["content"],
    },
    AddTaskCommentResponse: {
      type: "object",
      properties: {
        comment: { $ref: "#/components/schemas/TaskComment" },
        task: { $ref: "#/components/schemas/Task" },
      },
      required: ["comment", "task"],
    },
    GetTaskCommentsResponse: {
      type: "object",
      properties: {
        comments: {
          type: "array",
          items: { $ref: "#/components/schemas/TaskComment" },
        },
        total: { type: "integer" },
      },
      required: ["comments", "total"],
    },
  };
}

function generatePaths(
  _agents: AgentInfo[],
  _authEnabled: boolean
): Record<string, unknown> {
  return {
    "/agents": {
      get: {
        tags: ["Agents"],
        summary: "List all registered agents",
        operationId: "listAgents",
        responses: {
          200: {
            description: "List of agents",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    agents: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Agent" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/agents/{agentId}": {
      get: {
        tags: ["Agents"],
        summary: "Get agent details",
        operationId: "getAgent",
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Agent details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Agent" },
              },
            },
          },
          404: {
            description: "Agent not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/conversations": {
      get: {
        tags: ["Conversations"],
        summary: "List conversations",
        operationId: "listConversations",
        parameters: [
          {
            name: "agentId",
            in: "query",
            schema: { type: "string" },
            description: "Filter by agent ID",
          },
          {
            name: "userId",
            in: "query",
            schema: { type: "string" },
            description: "Filter by user ID. If not provided, uses the authenticated user ID.",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 20 },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0 },
          },
          {
            name: "orderBy",
            in: "query",
            description: "createdAt (default) or updatedAt (last activity)",
            schema: { type: "string", enum: ["createdAt", "updatedAt"], default: "createdAt" },
          },
          {
            name: "order",
            in: "query",
            description: "desc (default, newest first) or asc",
            schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
          },
        ],
        responses: {
          200: {
            description: "List of conversations",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PaginatedConversations" },
              },
            },
          },
        },
      },
      post: {
        tags: ["Conversations"],
        summary: "Create a new conversation",
        operationId: "createConversation",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateConversationRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Conversation created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    conversation: { $ref: "#/components/schemas/Conversation" },
                  },
                },
              },
            },
          },
          400: {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/conversations/{conversationId}": {
      get: {
        tags: ["Conversations"],
        summary: "Get conversation with one page of its messages",
        description:
          "Returns the newest `limit` messages (oldest first within the page) unless `before` or `after` is given. " +
          "Page backwards with `before=<id of the first message returned>`; `messagesPage` says whether there is more on either side.",
        operationId: "getConversation",
        parameters: [
          {
            name: "conversationId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            description: "Messages per page (default limits.messagePageSize = 100, at most limits.maxPageSize = 200)",
            schema: { type: "integer", minimum: 1 },
          },
          {
            name: "before",
            in: "query",
            description: "Only messages older than this message id",
            schema: { type: "string" },
          },
          {
            name: "after",
            in: "query",
            description: "Only messages newer than this message id",
            schema: { type: "string" },
          },
          {
            name: "order",
            in: "query",
            description: "Order of the returned page",
            schema: { type: "string", enum: ["asc", "desc"], default: "asc" },
          },
        ],
        responses: {
          200: {
            description: "Conversation details with a page of messages",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    conversation: { $ref: "#/components/schemas/Conversation" },
                    messages: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Message" },
                    },
                    messagesPage: { $ref: "#/components/schemas/MessagesPage" },
                    pendingActions: {
                      type: "array",
                      items: { $ref: "#/components/schemas/PendingAction" },
                    },
                  },
                },
              },
            },
          },
          400: {
            description: "Both before and after were given",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          404: {
            description: "Conversation not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
      patch: {
        tags: ["Conversations"],
        summary: "Update conversation",
        operationId: "updateConversation",
        parameters: [
          {
            name: "conversationId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  metadata: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Conversation updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Conversation" },
              },
            },
          },
          404: {
            description: "Conversation not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Conversations"],
        summary: "Delete conversation",
        operationId: "deleteConversation",
        parameters: [
          {
            name: "conversationId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          204: {
            description: "Conversation deleted",
          },
          404: {
            description: "Conversation not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/conversations/{conversationId}/messages": {
      get: {
        tags: ["Messages"],
        summary: "List messages in conversation",
        operationId: "listMessages",
        parameters: [
          {
            name: "conversationId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 100 },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0 },
          },
          {
            name: "order",
            in: "query",
            schema: { type: "string", enum: ["asc", "desc"], default: "asc" },
          },
        ],
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PaginatedMessages" },
              },
            },
          },
        },
      },
      post: {
        tags: ["Messages"],
        summary: "Send a message and get AI response",
        operationId: "sendMessage",
        parameters: [
          {
            name: "conversationId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SendMessageRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Message sent and response received",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SendMessageResponse" },
              },
            },
          },
          400: {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          404: {
            description: "Conversation not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          409: {
            description: "action_pending: the conversation is waiting for a pending action to be resolved",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/conversations/{conversationId}/actions/{actionId}": {
      post: {
        tags: ["Messages"],
        summary: "Resolve a pending action (tool approval / question) and continue the turn",
        operationId: "resolveAction",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "actionId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ResolveActionRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Action resolved; JSON, or text/event-stream when stream is true",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResolveActionResponse" },
              },
            },
          },
          400: {
            description: "Validation error (bad resolution or answers)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          404: {
            description: "Conversation not found, or the agent cannot resolve actions",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          409: {
            description: "action_not_pending: unknown or already resolved action",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/files": {
      post: {
        tags: ["Files"],
        summary: "Upload a file",
        operationId: "uploadFile",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UploadFileRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "File uploaded",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    file: { $ref: "#/components/schemas/FileRecord" },
                  },
                },
              },
            },
          },
          400: {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/files/{fileId}": {
      get: {
        tags: ["Files"],
        summary: "Get file metadata",
        operationId: "getFile",
        parameters: [
          {
            name: "fileId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "File metadata",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FileRecord" },
              },
            },
          },
          404: {
            description: "File not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Files"],
        summary: "Delete a file",
        operationId: "deleteFile",
        parameters: [
          {
            name: "fileId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          204: {
            description: "File deleted",
          },
          404: {
            description: "File not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/files/{fileId}/content": {
      get: {
        tags: ["Files"],
        summary: "Download file content",
        operationId: "downloadFile",
        parameters: [
          {
            name: "fileId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "File content",
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          404: {
            description: "File not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/tasks": {
      post: {
        tags: ["Tasks"],
        summary: "Create a new task for background processing",
        operationId: "createTask",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateTaskRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Task created successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateTaskResponse" },
              },
            },
          },
          400: {
            description: "Invalid request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          404: {
            description: "Agent not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
      get: {
        tags: ["Tasks"],
        summary: "List tasks",
        operationId: "listTasks",
        parameters: [
          {
            name: "agentId",
            in: "query",
            schema: { type: "string" },
            description: "Filter by agent ID",
          },
          {
            name: "status",
            in: "query",
            schema: {
              type: "string",
              enum: ["pending", "running", "completed", "failed"],
            },
            description: "Filter by task status",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 20 },
            description: "Number of tasks to return",
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0 },
            description: "Number of tasks to skip",
          },
        ],
        responses: {
          200: {
            description: "List of tasks",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListTasksResponse" },
              },
            },
          },
        },
      },
    },
    "/tasks/{taskId}": {
      get: {
        tags: ["Tasks"],
        summary: "Get task details",
        operationId: "getTask",
        parameters: [
          {
            name: "taskId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Task details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GetTaskResponse" },
              },
            },
          },
          404: {
            description: "Task not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/tasks/{taskId}/status": {
      get: {
        tags: ["Tasks"],
        summary: "Get task status",
        operationId: "getTaskStatus",
        parameters: [
          {
            name: "taskId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Task status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GetTaskStatusResponse" },
              },
            },
          },
          404: {
            description: "Task not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/tasks/{taskId}/result": {
      get: {
        tags: ["Tasks"],
        summary: "Get task result",
        operationId: "getTaskResult",
        parameters: [
          {
            name: "taskId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Task result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GetTaskResultResponse" },
              },
            },
          },
          404: {
            description: "Task or result not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/tasks/{taskId}/comments": {
      get: {
        tags: ["Tasks"],
        summary: "Get task comments",
        description: "Get all comments (from both agent and user) for a task",
        operationId: "getTaskComments",
        parameters: [
          {
            name: "taskId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Task ID",
          },
        ],
        responses: {
          200: {
            description: "List of task comments",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GetTaskCommentsResponse" },
              },
            },
          },
          404: {
            description: "Task not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
      post: {
        tags: ["Tasks"],
        summary: "Add comment to task",
        description: "Add a user comment to a task. If the task is in 'waiting_for_input' status, it will be reprocessed with the new comment.",
        operationId: "addTaskComment",
        parameters: [
          {
            name: "taskId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Task ID",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AddTaskCommentRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Comment added successfully. Task will be reprocessed.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AddTaskCommentResponse" },
              },
            },
          },
          400: {
            description: "Invalid request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          404: {
            description: "Task not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Generate Swagger UI HTML
 */
export function generateSwaggerHTML(specUrl: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: "${specUrl}",
        dom_id: '#swagger-ui',
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    }
  </script>
</body>
</html>`;
}
