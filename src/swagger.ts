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

/**
 * Every machine-readable `error.code` the server answers with, in the HTTP status it comes with. The `Error` schema
 * lists them, and test/docs.test.ts holds this list, the code and docs/guide/error-handling.md to each other.
 */
export const ERROR_CODES: ReadonlyArray<{ code: string; status: number; meaning: string }> = [
  { code: "VALIDATION_ERROR", status: 400, meaning: "The request is malformed or breaks a limit (details.reason says which, e.g. file_too_large)" },
  { code: "INVALID_REQUEST", status: 400, meaning: "A task comment that is not valid" },
  { code: "invalid_budget", status: 400, meaning: "Not a budget, or one at or below what the conversation has already spent" },
  { code: "budget_unavailable", status: 400, meaning: "The agent has no pricing, so a budget cannot be counted against" },
  { code: "invalid_approved_args", status: 400, meaning: "The edited arguments are not accepted by the tool's schema" },
  { code: "AUTHENTICATION_ERROR", status: 401, meaning: "Missing or invalid credentials" },
  { code: "identity_required", status: 401, meaning: "Listing needs to know who is asking (see allowAnonymousList)" },
  { code: "budget_reached", status: 402, meaning: "The conversation's budget is used up; raise it to carry on" },
  { code: "FORBIDDEN", status: 403, meaning: "The conversation, task or file belongs to someone else" },
  { code: "AUTHORIZATION_ERROR", status: 403, meaning: "A host's own AuthorizationError (access denied)" },
  { code: "action_forbidden", status: 403, meaning: "hitl.authorizeResolve says you may not answer this request" },
  { code: "budget_forbidden", status: 403, meaning: "Raising or removing a budget needs the authorizeBudget option" },
  { code: "attachments_disabled", status: 403, meaning: "The agent does not take attachments" },
  { code: "NOT_FOUND", status: 404, meaning: "The agent, conversation, message, task, file or tool does not exist (or is not yours)" },
  { code: "action_pending", status: 409, meaning: "A message or continue while a request is open (details.pendingActionIds)" },
  { code: "action_not_pending", status: 409, meaning: "The action is unknown, already answered, or cannot be resumed" },
  { code: "conversation_busy", status: 409, meaning: "A turn is already running in the conversation (details.activeRunId)" },
  { code: "conversation_conflict", status: 409, meaning: "The conversation kept changing under the request; try again" },
  { code: "lease_lost", status: 409, meaning: "Another node took the conversation over while the turn ran" },
  { code: "nothing_to_continue", status: 409, meaning: "No turn was stopped by the budget" },
  { code: "task_busy", status: 409, meaning: "The task is running or waits on an action" },
  { code: "task_finished", status: 409, meaning: "The task has already completed or failed" },
  { code: "too_many_files", status: 409, meaning: "The conversation already holds as many files as the agent allows" },
  { code: "action_expired", status: 410, meaning: "The approval or question lapsed (expiresAt)" },
  { code: "PAYLOAD_TOO_LARGE", status: 413, meaning: "The request body is over the body limit" },
  { code: "STORAGE_LIMIT_EXCEEDED", status: 413, meaning: "The storage provider cannot hold this much" },
  { code: "unsupported_file_type", status: 415, meaning: "The file's type is not one the agent accepts" },
  { code: "unsupported_media_type", status: 415, meaning: "An upload sent as multipart/form-data or a form (send the raw bytes with ?name=, or the JSON form)" },
  { code: "INTERNAL_ERROR", status: 500, meaning: "Anything unexpected (the text is generic with maskServerErrors)" },
  { code: "budget_misconfigured", status: 500, meaning: "The agent has a budget but no pricing" },
  { code: "invalid_host_result", status: 500, meaning: "A host agent returned something the server cannot use" },
];

const errorCodeList = () =>
  ERROR_CODES.map((entry) => `- \`${entry.code}\` (${entry.status}): ${entry.meaning}`).join("\n");

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
        retentionDays: {
          type: "integer",
          minimum: 0,
          description: "How long an uploaded file is kept, in days from the upload (0: until its conversation is deleted).",
        },
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
        continuable: {
          type: "boolean",
          description:
            "Whether POST .../continue has a turn to carry on: the budget cut a turn short in the middle and its state is kept. Present wherever runtime is. " +
            "It stays true after the budget is raised or removed (the raise only makes room) until the turn is continued or a new message gives it up; " +
            "false for a turn that finished its answer before the limit (raising the budget then only reopens the conversation), and while a turn runs or waits on a person. " +
            "While the budget is still used up, continue answers 402 budget_reached.",
        },
        budget: {
          $ref: "#/components/schemas/SessionBudget",
          description: "The conversation's spend limit, when it has one (its own, or the agent's default).",
        },
        spentUsd: {
          type: "number",
          description: "What the conversation's turns cost so far, in USD. Counted when the agent has a pricing function.",
        },
        rememberedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tools the person asked not to be asked about again in this conversation (GET / DELETE .../remembered-tools).",
        },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "agentId", "createdAt", "updatedAt"],
    },
    SessionBudget: {
      type: "object",
      description:
        "A spend limit for one conversation. Reaching it ends the turn that crossed it (stopReason budget_reached) and event budget.reached; " +
        "every further message is refused with 402 budget_reached until the limit is raised.",
      properties: {
        maxCostUsd: { type: "number", exclusiveMinimum: 0, description: "Largest total cost of the conversation's turns, in USD." },
        onReach: {
          type: "string",
          enum: ["pause", "stop"],
          default: "pause",
          description:
            "pause: the conversation waits (runtime.status budget_paused); raise the budget and POST .../continue carries the stopped turn on (the conversation's continuable says there is one; a turn that finished its answer before the limit is not continuable, the raise only reopens). " +
            "stop: it ends (runtime.status idle) and nothing is kept to carry on from.",
        },
      },
      required: ["maxCostUsd"],
    },
    UsageInfo: {
      type: "object",
      description:
        "What a turn used. An agent-sdk agent's usage is turned into the totals of this turn alone: a turn resumed after an approval counts only what it used after the resume.",
      properties: {
        inputTokens: { type: "integer" },
        outputTokens: { type: "integer" },
        totalTokens: { type: "integer" },
        cachedInputTokens: { type: "integer", description: "Input tokens the provider served from its cache (included in inputTokens)." },
        costUsd: { type: "number", description: "What the turn cost, in USD, when the agent's models are priced (the server's pricing option)." },
      },
    },
    ActionSnapshot: {
      type: "object",
      description:
        "An action on the paused assistant message (metadata.pendingActions): the PendingAction as it was asked, plus how it ended. " +
        "status is pending while it waits, resolved (approved, denied or answered - see resolution), cancelled (withdrawn by a new message " +
        "or POST .../cancel) or expired (it lapsed under hitl.onTimeout: cancel).",
      allOf: [{ $ref: "#/components/schemas/PendingAction" }],
      properties: {
        status: { type: "string", enum: ["pending", "resolved", "cancelled", "expired"] },
        resolution: { type: "object", additionalProperties: true, description: "What was answered (the ActionResolution)." },
        resolvedBy: { type: "string", description: "The user id, system:timeout for a request that lapsed, system for a withdrawn one." },
        resolvedAt: { type: "string", format: "date-time" },
      },
      required: ["status"],
    },
    UpdateConversationRequest: {
      type: "object",
      properties: {
        title: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
        budget: {
          oneOf: [{ $ref: "#/components/schemas/SessionBudget" }, { type: "null" }],
          description:
            "Sets the conversation's spend limit; null removes it. Lowering it is the owner's to do; raising or removing it goes through the " +
            "authorizeBudget option (403 budget_forbidden when it is not set). It must be above what the conversation has spent (400 invalid_budget).",
        },
      },
    },
    ContinueConversationRequest: {
      type: "object",
      properties: {
        stream: { type: "boolean", default: false, description: "Stream the continuation as SSE." },
      },
    },
    RememberedToolsResponse: {
      type: "object",
      properties: { tools: { type: "array", items: { type: "string" } } },
      required: ["tools"],
    },
    ConversationRuntime: {
      type: "object",
      description:
        "Where the conversation is in its run lifecycle. Returned by GET /conversations and GET /conversations/{id}; computed, never stored.",
      properties: {
        status: {
          type: "string",
          enum: ["idle", "running", "requires_action", "budget_paused"],
          description:
            "running: a turn is executing (on this or another node). requires_action: it waits on pendingActionIds. " +
            "budget_paused: the last turn stopped on the budget - the budget is still used up, or the turn was cut short and waits for POST .../continue " +
            "(it stays budget_paused after a raise until it is continued or a new message gives it up; see the conversation's continuable).",
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
        error: {
          type: "object",
          description:
            "Why the last turn ended with stopReason `error`, from its `session.error` event. A run whose process died is closed as " +
            "`run_interrupted`: the conversation then holds the person's message and no answer, and this tells a client why. Absent otherwise.",
          properties: {
            code: { type: "string", description: "`run_interrupted`, or the code of the failure (INTERNAL_ERROR, a host's own code, ...)." },
            message: { type: "string" },
          },
          required: ["code", "message"],
        },
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
        budget: {
          oneOf: [{ $ref: "#/components/schemas/SessionBudget" }, { type: "null" }],
          description:
            "A spend limit for this conversation (null: none). Without one it starts with the agent's. Above the default needs authorizeBudget (403 budget_forbidden).",
        },
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
        usage: { $ref: "#/components/schemas/UsageInfo" },
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
        budget: { $ref: "#/components/schemas/SessionBudget" },
        spentUsd: { type: "number", description: "What the conversation has spent after this turn (only with a budget)." },
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
        summary: { type: "string", description: "A one-line description of what approving does." },
        args: { type: "object", additionalProperties: true },
        argsSchema: {
          type: "object",
          additionalProperties: true,
          description:
            "JSON Schema of the tool's arguments, when the server knows it (an agent-sdk tool's schema; a host agent can set it). " +
            "A client that lets the person edit `args` validates the edit against it. approvedArgs is checked against the tool's schema either way (400 invalid_approved_args).",
        },
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
                    preview: { type: "string", description: "A code or ASCII preview shown while the option is focused." },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["question"],
          },
        },
        allowFreeText: { type: "boolean" },
        expiresAt: {
          type: "string",
          format: "date-time",
          description:
            "When the request lapses (the agent's own, else now + hitl.timeoutMinutes; absent when the timeout is 0). After it the action " +
            "answers 410 action_expired and hitl.onTimeout decides what happens.",
        },
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
        usage: { $ref: "#/components/schemas/UsageInfo" },
        status: { type: "string", enum: ["completed", "requires_action", "incomplete", "cancelled"] },
        pendingActions: { type: "array", items: { $ref: "#/components/schemas/PendingAction" } },
        warnings: { type: "array", items: { $ref: "#/components/schemas/TurnWarning" } },
        stopReason: { $ref: "#/components/schemas/StopReason" },
        runId: { type: "string" },
        budget: { $ref: "#/components/schemas/SessionBudget" },
        spentUsd: { type: "number" },
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
            code: {
              type: "string",
              description: `Machine-readable code. The ones the server answers with (a host can add its own):\n\n${errorCodeList()}`,
            },
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
        usage: { $ref: "#/components/schemas/UsageInfo" },
        status: { type: "string", enum: ["completed", "requires_action", "incomplete", "cancelled"] },
        pendingActions: { type: "array", items: { $ref: "#/components/schemas/PendingAction" } },
        warnings: { type: "array", items: { $ref: "#/components/schemas/TurnWarning" } },
        stopReason: { $ref: "#/components/schemas/StopReason" },
        runId: { type: "string" },
        budget: { $ref: "#/components/schemas/SessionBudget" },
        spentUsd: { type: "number" },
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
            expired: { type: "boolean", description: "The request lapsed and hitl.onTimeout answered it." },
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
            description:
              "Filter by user ID. If not provided, uses the authenticated user ID. With resolveContext the resolved user is used and this is ignored. A request that names no user is refused (401 identity_required) unless the server sets allowAnonymousList.",
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
          401: {
            description:
              "identity_required: the request names no user, and listing without one would list everyone's conversations (set allowAnonymousList on a single-user server). AUTHENTICATION_ERROR: missing or invalid credentials.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
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
            description: "Validation error (invalid_budget: not a budget; budget_unavailable: the agent has no pricing)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          403: {
            description: "budget_forbidden: a budget above the default needs the authorizeBudget option",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
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
              schema: { $ref: "#/components/schemas/UpdateConversationRequest" },
            },
          },
        },
        responses: {
          200: {
            description:
              "Conversation updated (with its runtime and continuable when the budget was changed: continuable true means a stopped turn waits for POST .../continue)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Conversation" },
              },
            },
          },
          400: {
            description: "invalid_budget: not a budget, or not above what the conversation has spent. budget_unavailable: the agent has no pricing.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          403: {
            description: "Not your conversation, or budget_forbidden: raising or removing a budget needs the authorizeBudget option.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
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
          402: {
            description:
              "budget_reached: the conversation's budget is used up (details.spentUsd / maxCostUsd / onReach). Nothing was stored; raise the budget (PATCH /conversations/{id}).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
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
          402: {
            description: "budget_reached: this answer would let the agent run again, and the conversation's budget is used up. Nothing was recorded.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          403: {
            description: "Not your conversation (or, with hitl.authorizeResolve, action_forbidden: you may not answer this request)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          404: {
            description: "Conversation not found, or the agent cannot resolve actions",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          409: {
            description:
              "action_not_pending: unknown or already resolved action. conversation_busy: a turn is already running in the conversation " +
              "(an answer that meets another answer waits for it up to hitl.resolveWaitMs first).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          410: {
            description: "action_expired: the request lapsed (expiresAt). It is handled by the expiry sweep, per hitl.onTimeout.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/conversations/{conversationId}/continue": {
      post: {
        tags: ["Runs"],
        summary: "Carry on a turn the conversation's budget stopped",
        description:
          "Resumes the agent from the state the budget stopped it in, with no new message (JSON, or SSE when stream is true). Raise the budget " +
          "first (PATCH /conversations/{id}; the conversation's continuable says a stopped turn waits). 402 budget_reached while it is still used up; 409 action_pending while the conversation waits on a " +
          "person; 409 nothing_to_continue when no turn was stopped by the budget (onReach: stop keeps nothing to carry on from, and a turn that " +
          "only crossed the budget finished its answer).",
        operationId: "continueConversation",
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ContinueConversationRequest" } } },
        },
        responses: {
          200: {
            description: "The continuation; JSON, or text/event-stream when stream is true",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ResolveActionResponse" } } },
          },
          402: { description: "budget_reached", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          403: { description: "Not your conversation", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: {
            description: "conversation_busy, action_pending or nothing_to_continue",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/conversations/{conversationId}/remembered-tools": {
      get: {
        tags: ["Messages"],
        summary: "Tools approved \"for the session\"",
        description:
          "The tools whose approval the person chose to remember (rememberForSession): later calls of them in this conversation run without asking, " +
          "and are logged as action.resolved with resolved_by remembered.",
        operationId: "listRememberedTools",
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "The tools", content: { "application/json": { schema: { $ref: "#/components/schemas/RememberedToolsResponse" } } } },
          403: { description: "Not your conversation", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/conversations/{conversationId}/remembered-tools/{tool}": {
      delete: {
        tags: ["Messages"],
        summary: "Forget a remembered tool: it asks for approval again",
        operationId: "revokeRememberedTool",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "tool", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "The tools that are still remembered", content: { "application/json": { schema: { $ref: "#/components/schemas/RememberedToolsResponse" } } } },
          403: { description: "Not your conversation", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found, or the tool is not remembered", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "Closing the stream never affects a run; reconnect with the last id. " +
          "When a run is active on the node that serves the stream, the first frame after `: open` is one `agent.message.snapshot` frame " +
          "(no id, not stored): `data: {\"type\":\"agent.message.snapshot\",\"data\":{\"run_id\":..., \"text\":<the answer streamed so far>, " +
          "\"user_message\":{\"id\",\"content\",\"files\"}|null}}`. A client that joins mid-run (a reload, a second window) seeds its answer bubble " +
          "- and the person's message, if its history does not have it yet - from it, and appends the deltas that follow. " +
          "It is sent unless `types` is given and names neither agent.message.snapshot nor agent.message.delta.",
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
            description: "File uploaded: the record wrapped as `{ file }` (GET /files/{fileId} answers the record itself)",
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
            description: "The agent does not accept this type of file (unsupported_file_type), or the upload is a multipart / form request (unsupported_media_type)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/files/{fileId}": {
      get: {
        tags: ["Files"],
        summary: "Get file metadata",
        description:
          "Answers the file record itself - not wrapped. (The upload answers the same record as `{ file }`.) A file the caller did not upload, " +
          "or whose conversation they cannot open, is a 404.",
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
          401: {
            description: "identity_required: the request names no user (see GET /conversations). AUTHENTICATION_ERROR: missing or invalid credentials.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
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
