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
        metadata: {
          type: "object",
          additionalProperties: true,
          description:
            "Host data. Also carries enableFileUpload, maxFileSize, maxFiles, allowedFileTypes and acceptsImages (the keys the first chat-ui read; capabilities.attachments is the same information).",
        },
        capabilities: {
          type: "object",
          description: "What the agent can do.",
          properties: {
            toolApproval: { type: "boolean", description: "The agent can pause to ask for approval before running a tool." },
            askUser: { type: "boolean", description: "The agent can pause to ask the user a question." },
            attachments: { $ref: "#/components/schemas/AttachmentsCapability" },
          },
        },
      },
      required: ["id", "name"],
    },
    AttachmentsCapability: {
      type: "object",
      description:
        "What a conversation with the agent accepts as attachments, from the server's `files` option and the agent's own. Clients show the paperclip, the limits and the \"this agent cannot read images\" warning from it.",
      properties: {
        enabled: { type: "boolean", description: "Files can be attached at all." },
        maxFiles: { type: "integer", description: "Files one conversation may hold." },
        maxFileSize: { type: "integer", description: "Largest file, in bytes." },
        allowedMimeTypes: { type: "array", items: { type: "string" }, description: "Accepted types (image/* style wildcards); empty means any." },
        acceptsImages: { type: "boolean", description: "The agent's model looks at images; without it an attached image is only mentioned." },
      },
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
        runtime: { $ref: "#/components/schemas/ConversationRuntime" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "agentId", "createdAt", "updatedAt"],
    },
    ConversationRuntime: {
      type: "object",
      description:
        "Where the conversation is in its run lifecycle. Returned by GET /conversations and GET /conversations/{id}; computed, never stored.",
      properties: {
        status: {
          type: "string",
          enum: ["idle", "running", "requires_action", "budget_paused"],
          description: "running: a turn is executing (on this or another node). requires_action: it waits on pendingActionIds.",
        },
        stopReason: {
          $ref: "#/components/schemas/StopReason",
        },
        lastEventSeq: {
          type: "integer",
          description: "seq of the newest event in the conversation's log (0 when there is none). Follow from here with ?after=.",
        },
        pendingActionIds: { type: "array", items: { type: "string" } },
        activeRunId: { type: "string", description: "The run that is executing now." },
      },
      required: ["status", "lastEventSeq", "pendingActionIds"],
    },
    StopReason: {
      type: "string",
      enum: ["end_turn", "requires_action", "cancelled", "max_turns", "limit", "budget_reached", "error"],
      description: "Why the last turn stopped. Absent while a turn is running.",
    },
    WireEvent: {
      type: "object",
      description:
        "One entry of a conversation's event log, in the Console client wire: dotted event types and snake_case data. " +
        "Types: user.message, session.status_running, agent.tool_use, agent.tool_result, agent.message, action.required, " +
        "action.resolved, session.usage, session.status_idle, session.work_done, session.error. A client ignores the types it does not know.",
      properties: {
        seq: { type: "integer", description: "1, 2, 3 ... within the conversation; unique." },
        type: { type: "string", example: "agent.tool_use" },
        data: { type: "object", additionalProperties: true, description: "Larger than 16 KB is cut and carries _truncated: true." },
        run_id: { type: "string", description: "The run that produced the event." },
        created_at: { type: "string", format: "date-time" },
      },
      required: ["seq", "type", "data", "created_at"],
    },
    ListEventsResponse: {
      type: "object",
      properties: {
        events: { type: "array", items: { $ref: "#/components/schemas/WireEvent" } },
        hasMore: { type: "boolean" },
        lastSeq: { type: "integer", description: "seq of the last event returned (or the after you sent): pass it as after for the next page." },
      },
      required: ["events", "hasMore", "lastSeq"],
    },
    CancelConversationResponse: {
      type: "object",
      properties: {
        cancelled: { type: "boolean", description: "A run was running, or actions were open, and they were cancelled. false: there was nothing to cancel." },
        runId: { type: "string" },
        settled: { type: "boolean", description: "The run has finished winding down. false (202): it is still stopping, or it runs on another node." },
        cancelledActionIds: { type: "array", items: { type: "string" } },
        stopReason: { $ref: "#/components/schemas/StopReason" },
        runtime: { $ref: "#/components/schemas/ConversationRuntime" },
      },
      required: ["cancelled", "settled", "runtime"],
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
        metadata: {
          type: "object",
          additionalProperties: true,
          description: "Assistant messages carry metadata.status and metadata.stopReason: how, and why, the turn ended.",
        },
        status: {
          type: "string",
          enum: ["completed", "requires_action", "incomplete", "cancelled"],
          description: "Assistant messages: how the turn that produced it ended (derived from metadata.status).",
        },
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
        userId: { type: "string", description: "Who uploaded it. Only they (in a conversation they may open) can see the file." },
        agentId: { type: "string", description: "The agent of the conversation the file was uploaded to." },
        expiresAt: { type: "string", format: "date-time", description: "When the retention sweep deletes it (absent: never)." },
        metadata: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "name", "mimeType", "size", "storageKey", "createdAt"],
    },
    ListFilesResponse: {
      type: "object",
      properties: {
        files: { type: "array", items: { $ref: "#/components/schemas/FileRecord" }, description: "Oldest first." },
        total: { type: "integer" },
        limit: { type: "integer" },
        offset: { type: "integer" },
        hasMore: { type: "boolean" },
        maxFiles: { type: "integer", description: "What the conversation may hold (files.maxFiles of its agent)." },
      },
      required: ["files", "total", "limit", "offset", "hasMore", "maxFiles"],
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
          description:
            "Files sent with the message. They are stored (in this conversation, owned by the sender, under the same limits as an upload) before the turn runs and then count like fileIds.",
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
        fileIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Files uploaded earlier with POST /files (conversationId set to this conversation) that this message attaches. A file that is not one of this conversation's, or that the caller did not upload, is a 404. The agent is given their contents.",
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
        stopReason: { $ref: "#/components/schemas/StopReason" },
        runId: { type: "string", description: "The run that executed the turn; its events carry it as run_id." },
      },
      required: ["message", "response"],
    },
    TurnWarning: {
      type: "object",
      description:
        "Something worth knowing about a turn that completed anyway; also stored on the assistant message as metadata.warnings. " +
        "Code pause_state_too_large: the turn needed a human but its state did not fit the store (limits.maxStateBytes or the provider's limit), so it was not paused. " +
        "Code file_truncated: a document was longer than files.inlineMaxTokens and the agent cannot read files in pages, so only its start was given to it. " +
        "Code file_unreadable: a file's text could not be read. Code images_not_supported: an image was attached to an agent that does not read images.",
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
        stopReason: { $ref: "#/components/schemas/StopReason" },
        runId: { type: "string" },
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
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        stopReason: { $ref: "#/components/schemas/StopReason" },
        runId: { type: "string" },
      },
    },
    StreamActionRequiredEvent: {
      type: "object",
      description: "The agent paused and is waiting on a human",
      properties: {
        type: { type: "string", enum: ["stream.action_required"] },
        timestamp: { type: "integer" },
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        seq: { type: "integer", description: "Event-log cursor at this frame; resume with GET /conversations/{id}/events/stream?after=<seq>." },
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
        conversationId: {
          type: "string",
          description:
            "The conversation the task runs in. Its events, approvals and cancellation work like any conversation's.",
        },
        status: {
          type: "string",
          enum: ["pending", "running", "completed", "failed", "waiting_for_input", "cancelled"],
          description: "waiting_for_input: the agent paused on actions of the task's conversation (see pendingActions of GET /tasks/{id}), or asked through a comment.",
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
        pendingActions: {
          type: "array",
          items: { $ref: "#/components/schemas/PendingAction" },
          description: "While the task is waiting_for_input on actions: answer them on the task's conversation.",
        },
      },
      required: ["task"],
    },
    GetTaskStatusResponse: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "running", "completed", "failed", "waiting_for_input", "cancelled"],
        },
        conversationId: { type: "string" },
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
            description:
              "action_pending: the conversation is waiting for a pending action to be resolved. " +
              "conversation_busy: a turn is already running in the conversation (details.activeRunId); wait for it or cancel it.",
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
            description:
              "action_not_pending: unknown or already resolved action. conversation_busy: a turn is already running in the conversation.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/conversations/{conversationId}/cancel": {
      post: {
        tags: ["Runs"],
        summary: "Stop what the conversation is doing",
        description:
          "Aborts the turn that is running (the agent-sdk sees the cancellation token; a custom handler its signal; a streamed or " +
          "plain request that started it ends with status cancelled / stopReason cancelled). A turn running on another node is asked to " +
          "stop through its lease (202). A conversation that is only waiting on a human has its open actions cancelled (action.resolved " +
          "with cancelled: true). Nothing to cancel is not an error: cancelled is false.",
        operationId: "cancelConversation",
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "Cancelled, or nothing to cancel",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CancelConversationResponse" } } },
          },
          202: {
            description: "Cancellation requested; the run is still winding down or runs on another node (settled: false)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CancelConversationResponse" } } },
          },
          403: { description: "Not your conversation", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/conversations/{conversationId}/events": {
      get: {
        tags: ["Runs"],
        summary: "Read the event log of a conversation",
        description:
          "Everything that happened in the conversation, oldest first: messages, tool calls and results, the actions it paused on, usage, " +
          "the start and end of each turn. Page with lastSeq as after.",
        operationId: "listEvents",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 }, description: "Only events with a larger seq." },
          { name: "types", in: "query", schema: { type: "string" }, description: "Comma-separated event types to keep." },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 1000 } },
        ],
        responses: {
          200: {
            description: "A page of events",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ListEventsResponse" } } },
          },
          400: { description: "after is not a non-negative integer", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/conversations/{conversationId}/events/stream": {
      get: {
        tags: ["Runs"],
        summary: "Follow a conversation live (Server-Sent Events)",
        description:
          "Replays the stored events after `after` (or after the Last-Event-ID header a browser EventSource sends when it reconnects), " +
          "then follows the conversation. Each stored event is a frame `id: <seq>`, `event: <type>`, `data: <the event as in GET .../events>`. " +
          "agent.message.delta frames (`data: {\"text\": ...}`, no id) carry the model's text as it is written for a turn that was started with " +
          "stream: true; they are not stored. `: ping` every 15 s. Nothing is missed or repeated between the replay and the live part. " +
          "Closing the stream never affects a run; reconnect with the last id.",
        operationId: "streamEvents",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          { name: "types", in: "query", schema: { type: "string" }, description: "Comma-separated event types to keep." },
          { name: "Last-Event-ID", in: "header", schema: { type: "integer" }, description: "Wins over after." },
        ],
        responses: {
          200: { description: "text/event-stream", content: { "text/event-stream": { schema: { type: "string" } } } },
          400: { description: "after is not a non-negative integer", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/conversations/{conversationId}/files": {
      get: {
        tags: ["Files"],
        summary: "List the files a conversation holds",
        description: "Oldest first. The number the conversation may hold is maxFiles (files.maxFiles of its agent).",
        operationId: "listConversationFiles",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          200: { description: "The files", content: { "application/json": { schema: { $ref: "#/components/schemas/ListFilesResponse" } } } },
          403: { description: "Not the caller's conversation", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/files": {
      post: {
        tags: ["Files"],
        summary: "Upload a file",
        description:
          "Send either the file as itself - its bytes as the body, its own Content-Type, and ?name=<file name>&conversationId=<id> in the query " +
          "(optionally &mimeType= to override the header) - or the JSON form with the file as base64. The file belongs to the caller and, with " +
          "conversationId, to that conversation: it counts against the agent's files.maxFiles, is checked against its maxFileSize and allowedMimeTypes, " +
          "and is deleted with the conversation or when files.retentionDays have passed.",
        operationId: "uploadFile",
        parameters: [
          { name: "name", in: "query", schema: { type: "string" }, description: "The file's name (raw upload)." },
          { name: "conversationId", in: "query", schema: { type: "string" }, description: "The conversation the file is for (raw upload)." },
          { name: "mimeType", in: "query", schema: { type: "string" }, description: "Overrides the Content-Type header (raw upload)." },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UploadFileRequest" },
            },
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
              description: "The file's bytes. Any other Content-Type than JSON works the same (image/png, application/pdf, text/plain, ...).",
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
            description: "Validation error: no file, no name, an empty file, or a file over the size limit (details.reason: file_too_large)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          403: {
            description: "The agent takes no files (attachments_disabled), or the conversation is not the caller's",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: {
            description: "The conversation already holds files.maxFiles files (too_many_files)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          413: { description: "Request body too large", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          415: {
            description: "The agent does not accept this type of file (unsupported_file_type)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
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
        description:
          "Served as a download (Content-Disposition: attachment, nosniff, Cache-Control: private). ?disposition=inline shows a picture, PDF or plain text in place; " +
          "other types (HTML, SVG, ...) are only ever downloads. A file the caller did not upload is a 404.",
        operationId: "downloadFile",
        parameters: [
          {
            name: "fileId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          { name: "disposition", in: "query", schema: { type: "string", enum: ["inline", "attachment"], default: "attachment" } },
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
              enum: ["pending", "running", "completed", "failed", "waiting_for_input", "cancelled"],
            },
            description: "Filter by task status",
          },
          {
            name: "conversationId",
            in: "query",
            schema: { type: "string" },
            description: "Filter by the conversation the task runs in",
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
    "/tasks/{taskId}/cancel": {
      post: {
        tags: ["Tasks"],
        summary: "Cancel a task",
        description:
          "Stops the turn the task is running (or cancels the actions it waits on) and marks the task cancelled. " +
          "A task that has completed or failed cannot be cancelled (409 task_finished); cancelling a cancelled task is a no-op.",
        operationId: "cancelTask",
        parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "The cancelled task", content: { "application/json": { schema: { type: "object", properties: { task: { $ref: "#/components/schemas/Task" } } } } } },
          202: { description: "Cancellation requested; the run is still winding down or runs on another node" },
          404: { description: "Task not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "task_finished", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
