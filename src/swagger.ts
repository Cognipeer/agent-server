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
  { code: "model_not_allowed", status: 400, meaning: "The request's model is not one of the agent's advertised models (details.allowed lists the keys)" },
  { code: "invalid_request", status: 400, meaning: "The search text q of GET /conversations is longer than 200 characters" },
  { code: "invalid_budget", status: 400, meaning: "Not a budget, or one at or below what the conversation has already spent" },
  { code: "budget_unavailable", status: 400, meaning: "The agent has no pricing, so a budget cannot be counted against" },
  { code: "invalid_approved_args", status: 400, meaning: "The edited arguments are not accepted by the tool's schema" },
  { code: "invalid_client_tool_result", status: 400, meaning: "The result of a client tool is larger than hitl.clientToolMaxOutputBytes (details.maxBytes)" },
  { code: "invalid_feedback", status: 400, meaning: "The rating, the reasons or the comment of a piece of feedback are not acceptable" },
  { code: "AUTHENTICATION_ERROR", status: 401, meaning: "Missing or invalid credentials" },
  { code: "identity_required", status: 401, meaning: "Listing needs to know who is asking (see allowAnonymousList)" },
  { code: "budget_reached", status: 402, meaning: "The conversation's budget is used up; raise it to carry on" },
  { code: "FORBIDDEN", status: 403, meaning: "The conversation, task or file belongs to someone else" },
  { code: "AUTHORIZATION_ERROR", status: 403, meaning: "A host's own AuthorizationError (access denied)" },
  { code: "action_forbidden", status: 403, meaning: "hitl.authorizeResolve says you may not answer this request" },
  { code: "budget_forbidden", status: 403, meaning: "Raising or removing a budget needs the authorizeBudget option" },
  { code: "attachments_disabled", status: 403, meaning: "The agent does not take attachments" },
  { code: "action_disabled", status: 403, meaning: "The agent's experience switches this action off (regenerate, edit, rename, pin ...), or the conversation's agent cannot be resolved any more (details.reason \"agent_unavailable\"); details.setting says which" },
  { code: "feedback_disabled", status: 403, meaning: "The agent does not take feedback on its answers (or cannot be resolved any more: details.reason \"agent_unavailable\")" },
  { code: "export_disabled", status: 403, meaning: "Downloading conversations (or including tool calls in the download) is switched off for the agent, or the agent cannot be resolved any more (details.reason \"agent_unavailable\")" },
  { code: "NOT_FOUND", status: 404, meaning: "The agent, conversation, message, task, file or tool does not exist (or is not yours)" },
  { code: "action_pending", status: 409, meaning: "A message or continue while a request is open (details.pendingActionIds)" },
  { code: "action_not_pending", status: 409, meaning: "The action is unknown, already answered, or cannot be resumed" },
  { code: "conversation_busy", status: 409, meaning: "A turn is already running in the conversation (details.activeRunId)" },
  { code: "invalid_message_target", status: 409, meaning: "The message is not one the action applies to: only the newest message can be regenerated, only a person's own message edited, only an answer rated (details.reason)" },
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
  { code: "rate_limited", status: 429, meaning: "The rateLimit hook refused the request; Retry-After and details.retryAfterSeconds say when to try again" },
  { code: "INTERNAL_ERROR", status: 500, meaning: "Anything unexpected (the text is generic with maskServerErrors)" },
  { code: "budget_misconfigured", status: 500, meaning: "The agent has a budget but no pricing" },
  { code: "invalid_host_result", status: 500, meaning: "A host agent returned something the server cannot use" },
  { code: "export_format_unsupported", status: 501, meaning: "format=pdf and the server has no export.renderPdf; use format=html&print=1 and save the page as PDF" },
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
            "Host data. Also carries enableFileUpload, maxFileSize, maxFiles, allowedFileTypes and acceptsImages (the keys the first chat-ui read; capabilities.attachments is the same information), " +
            "and what a chat client shows around the agent: welcome (Markdown), starters and experience (the switches the routes enforce). What the host put in metadata wins over what the server derives.",
          properties: {
            welcome: { type: "string", description: "Markdown shown on the empty state." },
            starters: { type: "array", maxItems: 6, items: { $ref: "#/components/schemas/ConversationStarter" } },
            experience: { $ref: "#/components/schemas/ResolvedExperience" },
          },
        },
        showReasoning: { type: "boolean", description: "Whether the agent's reasoning text is shown (default true). With false the server sends no `stream.thinking` frames." },
        models: {
          type: "array",
          description: "Models a caller may choose between per message (two or more). Send the key as `model` with a message.",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              default: { type: "boolean" },
            },
            required: ["key", "label", "default"],
          },
        },
        capabilities: {
          type: "object",
          description: "What the agent can do.",
          properties: {
            toolApproval: { type: "boolean", description: "The agent can pause to ask for approval before running a tool." },
            askUser: { type: "boolean", description: "The agent can pause to ask the user a question." },
            clientTools: { type: "boolean", description: "The agent can pause for a tool that runs in the page embedding the chat (client_tool pending actions)." },
            plan: { type: "boolean", description: "The agent may publish a plan (stream.plan frames, agent.plan events)." },
            attachments: { $ref: "#/components/schemas/AttachmentsCapability" },
          },
        },
      },
      required: ["id", "name"],
    },
    ConversationStarter: {
      type: "object",
      description: "A suggested first message on the empty state of a conversation.",
      properties: {
        text: { type: "string", maxLength: 500, description: "What is put in the composer (or sent, with autoSend)." },
        label: { type: "string", maxLength: 80, description: "What the chip shows instead of text." },
        autoSend: { type: "boolean", default: false, description: "Send text at once instead of only filling the composer." },
      },
      required: ["text"],
    },
    ResolvedExperience: {
      type: "object",
      description:
        "What the chat client offers around an agent, resolved from the server's experience option, the agent's own and the host's metadata. " +
        "The routes enforce the same switches (403 action_disabled, feedback_disabled, export_disabled).",
      properties: {
        messageActions: {
          type: "object",
          properties: { copy: { type: "boolean" }, regenerate: { type: "boolean" }, edit: { type: "boolean" } },
          required: ["copy", "regenerate", "edit"],
        },
        history: {
          type: "object",
          properties: { rename: { type: "boolean" }, pin: { type: "boolean" }, bulkDelete: { type: "boolean" } },
          required: ["rename", "pin", "bulkDelete"],
        },
        feedback: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            comments: { type: "boolean", description: "A free-text comment is accepted." },
            reasons: { type: "array", items: { type: "string" }, description: "The reason codes of a down rating." },
            maxCommentLength: { type: "integer", description: "0 when comments are not accepted." },
          },
          required: ["enabled", "comments", "reasons", "maxCommentLength"],
        },
        export: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            includeTools: { type: "boolean", description: "tools=1 is allowed." },
            formats: { type: "array", items: { type: "string", enum: ["md", "json", "html", "pdf"] }, description: "pdf is listed only when the server can render it." },
          },
          required: ["enabled", "includeTools", "formats"],
        },
        titles: { type: "boolean", description: "A title is generated after the first answer." },
      },
      required: ["messageActions", "history", "feedback", "export", "titles"],
    },
    MessageFeedback: {
      type: "object",
      description: "What a person said about an answer. One per message: a new rating replaces the old.",
      properties: {
        rating: { type: "string", enum: ["up", "down"] },
        reasons: { type: "array", items: { type: "string" }, description: "Why a down rating was given: codes from experience.feedback.reasons." },
        comment: { type: "string" },
        userId: { type: "string" },
        createdAt: { type: "string", format: "date-time", description: "The first rating of this message." },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["rating", "createdAt", "updatedAt"],
    },
    FeedbackRequest: {
      type: "object",
      properties: {
        rating: { type: "string", enum: ["up", "down"], nullable: true, description: "null withdraws the rating." },
        reasons: { type: "array", items: { type: "string" }, description: "Only with down; each one from experience.feedback.reasons." },
        comment: { type: "string", description: "At most experience.feedback.maxCommentLength characters." },
      },
      required: ["rating"],
    },
    FeedbackResponse: {
      type: "object",
      properties: {
        feedback: { oneOf: [{ $ref: "#/components/schemas/MessageFeedback" }, { type: "null" }], description: "The rating now on the message; null after a withdrawal." },
        messageId: { type: "string" },
      },
      required: ["feedback", "messageId"],
    },
    RegenerateMessageRequest: {
      type: "object",
      properties: {
        stream: { type: "boolean", default: false, description: "Stream the new answer as SSE." },
        metadata: { type: "object", additionalProperties: true, description: "Passed to the agent as the turn's metadata." },
        model: { type: "string", description: "One of the agent's `models` keys; 400 `model_not_allowed` otherwise. Default: the agent's own model." },
        reasoningEffort: { type: "string", enum: ["none", "minimal", "low", "medium", "high"], description: "How hard the model may think. 400 for any other value. Default: the agent's own setting." },
      },
    },
    EditMessageRequest: {
      type: "object",
      properties: {
        content: { type: "string", description: "The new text of the message (message is accepted as a synonym)." },
        message: { type: "string" },
        fileIds: { type: "array", items: { type: "string" }, description: "Files of the new message, by id. Omit both fileIds and files to keep the message's files; [] drops them (a file no remaining message carries is deleted)." },
        files: {
          type: "array",
          description: "Files sent inline, base64 (stored first, like POST .../messages).",
          items: {
            type: "object",
            properties: { name: { type: "string" }, content: { type: "string" }, mimeType: { type: "string" } },
            required: ["name", "content", "mimeType"],
          },
        },
        metadata: { type: "object", additionalProperties: true },
        model: { type: "string", description: "One of the agent's `models` keys; 400 `model_not_allowed` otherwise. Default: the agent's own model." },
        reasoningEffort: { type: "string", enum: ["none", "minimal", "low", "medium", "high"], description: "How hard the model may think. 400 for any other value. Default: the agent's own setting." },
        stream: { type: "boolean", default: false },
      },
    },
    BulkDeleteRequest: {
      type: "object",
      properties: { ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" }, description: "At most limits.maxBulkDelete (default 100)." } },
      required: ["ids"],
    },
    BulkDeleteResponse: {
      type: "object",
      properties: {
        results: {
          type: "array",
          description: "One per id, in the order sent. Someone else's conversation is not_found, like one that does not exist.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: ["deleted", "not_found", "busy", "error"] },
              message: { type: "string" },
            },
            required: ["id", "status"],
          },
        },
        deleted: { type: "integer" },
      },
      required: ["results", "deleted"],
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
        searchMatch: {
          type: "object",
          description: "Only in a search response (q): where the text was found.",
          properties: {
            field: { type: "string", enum: ["title", "message"] },
            messageId: { type: "string", description: "field message: the first matching message." },
            role: { type: "string", enum: ["user", "assistant"] },
            snippet: { type: "string", maxLength: 160, description: "Plain text around the first match, whitespace collapsed, … at a cut end." },
          },
          required: ["field", "snippet"],
        },
        pinned: {
          type: "boolean",
          description: "The person pinned the conversation (PATCH { pinned: true }); GET /conversations lists pinned ones first. Absent when it is not pinned.",
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
        title: { type: "string", maxLength: 200, description: "Renames the conversation (trimmed; an empty string clears the title; at most 200 characters)." },
        pinned: { type: "boolean", description: "Pins or unpins the conversation. Pins are the server's: they cannot be set or dropped through metadata." },
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
        "action.resolved, session.usage, session.status_idle, session.work_done, session.error, budget.reached, " +
        "agent.plan (the agent's plan as it stands: version?, operation? - write or update -, steps of id?, title and status) and agent.compaction (the agent condensed its earlier context: id?, at), session.truncated " +
        "(messages were removed: a regeneration dropped the answer it replaced, an edit dropped a message and everything after it; reload the history) " +
        "and session.title (a title was generated, with what making it used, tagged purpose: title). A client ignores the types it does not know.",
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
          description:
            "Assistant messages carry metadata.status and metadata.stopReason: how, and why, the turn ended. An answer that replaced an earlier one " +
            "(POST .../regenerate) carries metadata.regeneratedFrom and metadata.previousContent (what the earlier answers said, newest last, at most 5); " +
            "a user message that replaced another (POST .../edit) carries metadata.edited, metadata.editedFrom and metadata.previousContent.",
        },
        status: {
          type: "string",
          enum: ["completed", "requires_action", "incomplete", "cancelled"],
          description: "Assistant messages: how the turn that produced it ended (derived from metadata.status).",
        },
        feedback: {
          $ref: "#/components/schemas/MessageFeedback",
          description: "Assistant messages: the rating the owner gave the answer (derived from metadata.feedback). Absent when there is none.",
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
        model: { type: "string", description: "One of the agent's `models` keys; 400 `model_not_allowed` otherwise. Default: the agent's own model." },
        reasoningEffort: { type: "string", enum: ["none", "minimal", "low", "medium", "high"], description: "How hard the model may think. 400 for any other value. Default: the agent's own setting." },
        stream: {
          type: "boolean",
          default: false,
          description: "Enable streaming response via Server-Sent Events (SSE). When true, response is sent as text/event-stream.",
        },
        titleFrame: {
          type: "boolean",
          default: false,
          description:
            "Streaming only. The title generated for the first exchange comes as its own stream.title frame after stream.done, so the done frame (and the end of the turn) does not wait for the title model. Without it the title is in stream.done.",
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
      description:
        "Something the agent is waiting on: a tool approval, a user question, or a client tool - a tool that runs in the page embedding the chat " +
        "(the client shows no card; it hands toolName and args to the host page and answers with { type: client_tool, output | error }).",
      properties: {
        id: { type: "string" },
        type: { type: "string", enum: ["tool_approval", "user_question", "client_tool"] },
        timeoutSeconds: {
          type: "number",
          description: "client_tool: how long the page has to answer. The client enforces it (and answers with an error); expiresAt is the server's net under it.",
        },
        requestedAt: { type: "string", format: "date-time", description: "client_tool: when the server recorded the request." },
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
            {
              type: "object",
              description:
                "The result of a client tool: output (any JSON value, at most hitl.clientToolMaxOutputBytes - default 65536 - else 400 invalid_client_tool_result) " +
                "or error (a message the model reads: the page failed, timed out or has no such tool). One of the two is required.",
              properties: {
                type: { type: "string", enum: ["client_tool"] },
                output: {},
                error: { type: "string" },
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
        searchMode: {
          type: "string",
          enum: ["full", "title"],
          description: "Present when the request had q: full (titles and message text) or title (the storage cannot search messages).",
        },
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
    StreamThinkingEvent: {
      type: "object",
      description: "A chunk of the model's reasoning. Not part of the answer; not sent when the agent's `showReasoning` is false.",
      properties: {
        type: { type: "string", enum: ["stream.thinking"] },
        timestamp: { type: "integer" },
        seq: { type: "integer", description: "Event-log cursor at this frame." },
        thinking: { type: "string" },
      },
    },
    PlanStep: {
      type: "object",
      properties: {
        id: { oneOf: [{ type: "string" }, { type: "number" }], description: "The agent's own handle for the step." },
        title: { type: "string", maxLength: 500 },
        status: { type: "string", enum: ["not-started", "in-progress", "completed", "blocked"] },
      },
      required: ["title", "status"],
    },
    PlanSnapshot: {
      type: "object",
      description: "The agent's plan at one moment: every step, not a change. A later snapshot replaces the earlier one.",
      properties: {
        version: { type: "number", description: "Grows with every change the agent makes to the plan." },
        operation: {
          type: "string",
          enum: ["write", "update"],
          description:
            "What the agent did to get here: write wrote the plan out (it made the plan, or started over), update changed steps of the plan it had. " +
            "Lets a client tell plan created from plan updated while the turn runs. Left out when the agent does not say.",
        },
        steps: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/PlanStep" } },
      },
      required: ["steps"],
    },
    StreamPlanEvent: {
      type: "object",
      description: "The agent's plan as it stands now. Also stored as an agent.plan event, so a follower or a reload sees the same plan in the same place.",
      properties: {
        type: { type: "string", enum: ["stream.plan"] },
        timestamp: { type: "integer" },
        seq: { type: "integer", description: "Event-log cursor at this frame." },
        plan: { $ref: "#/components/schemas/PlanSnapshot" },
      },
    },
    StreamCompactionEvent: {
      type: "object",
      description:
        "The agent condensed its earlier context: a marker in the flow, with nothing of what was condensed. start is live only, done is also stored as " +
        "an agent.compaction event, skipped ends a start that found nothing to do. id pairs the frames of one pass.",
      properties: {
        type: { type: "string", enum: ["stream.compaction"] },
        timestamp: { type: "integer" },
        seq: { type: "integer", description: "Event-log cursor at this frame." },
        id: { type: "string" },
        phase: { type: "string", enum: ["start", "done", "skipped"] },
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
        files: { type: "array", items: { $ref: "#/components/schemas/FileAttachment" }, description: "The files the answer carries, as the stored message has them" },
        status: { type: "string", enum: ["completed", "requires_action", "incomplete", "cancelled"] },
        pendingActions: { type: "array", items: { $ref: "#/components/schemas/PendingAction" } },
        warnings: { type: "array", items: { $ref: "#/components/schemas/TurnWarning" } },
        stopReason: { $ref: "#/components/schemas/StopReason" },
        runId: { type: "string" },
        budget: { $ref: "#/components/schemas/SessionBudget" },
        spentUsd: { type: "number" },
      },
    },
    StreamTitleEvent: {
      type: "object",
      description: "The conversation's generated title, after stream.done (only for a request that set titleFrame)",
      properties: {
        type: { type: "string", enum: ["stream.title"] },
        timestamp: { type: "integer" },
        conversationId: { type: "string" },
        title: { type: "string" },
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
            type: { type: "string", enum: ["tool_approval", "user_question", "client_tool"] },
            decision: { type: "string", enum: ["allow", "deny"] },
            cancelled: { type: "boolean" },
            ok: { type: "boolean", description: "client_tool: false when the page reported an error (or never answered)." },
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

const ERR = { "application/json": { schema: { $ref: "#/components/schemas/Error" } } };

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
                    features: {
                      type: "object",
                      description: "What the server can do beyond the agents, so a client can adapt its UI.",
                      properties: {
                        conversationSearch: {
                          type: "string",
                          enum: ["full", "title"],
                          description: "GET /conversations?q=: full searches titles and message text, title only titles.",
                        },
                      },
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
          {
            name: "q",
            in: "query",
            description:
              "Search: conversations whose title or message text contains this text (case-insensitive, literal), newest activity first; orderBy, order and pinned do not apply. " +
              "Trimmed; under 2 characters is no search, over 200 answers 400 invalid_request. Hits carry searchMatch; searchMode says whether messages were searched (full) or only titles (title).",
            schema: { type: "string", minLength: 2, maxLength: 200 },
          },
          {
            name: "pinned",
            in: "query",
            description:
              "first (default): pinned conversations lead, each group in the requested order, across pages. none: ordered by time alone. " +
              "A storage provider that cannot order them across pages moves them to the top of the page it returned.",
            schema: { type: "string", enum: ["first", "none"], default: "first" },
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
    "/conversations/bulk-delete": {
      post: {
        tags: ["Conversations"],
        summary: "Delete several conversations at once",
        description:
          "Deletes the conversations in ids that belong to the caller, each judged by itself (a running turn is stopped first). Someone else's conversation is reported " +
          "as not_found, exactly like one that does not exist; one running on another node is busy. At most limits.maxBulkDelete ids (default 100).",
        operationId: "bulkDeleteConversations",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/BulkDeleteRequest" } } } },
        responses: {
          200: { description: "One result per id", content: { "application/json": { schema: { $ref: "#/components/schemas/BulkDeleteResponse" } } } },
          400: { description: "ids is not a list of 1 to maxBulkDelete conversation ids", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          429: { description: "rate_limited", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
    "/conversations/{conversationId}/messages/{messageId}/regenerate": {
      post: {
        tags: ["Messages"],
        summary: "Ask for the newest answer again",
        description:
          "Runs the turn again from the user message the newest answer replied to (the same agent, with the transcript cut back to that message) and replaces the answers " +
          "after it with the new one, which keeps what they said in metadata.previousContent (at most 5). A turn that failed and left no answer can be run again " +
          "by naming the user message. Goes through the run registry like a message: one turn at a time (409 conversation_busy), the budget (402), open approvals (409 action_pending). " +
          "The old answer is removed only once the new one is stored, so a failed turn loses nothing. Events: session.truncated, then the turn's own. " +
          "A host agent hears mode: regenerate and fromMessageId.",
        operationId: "regenerateMessage",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" }, description: "The newest message of the conversation: its latest answer (or an unanswered user message)." },
        ],
        requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/RegenerateMessageRequest" } } } },
        responses: {
          200: { description: "The new answer; JSON, or text/event-stream when stream is true", content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageResponse" } } } },
          402: { description: "budget_reached", content: ERR },
          403: { description: "Not your conversation, or action_disabled: the agent switched regenerating off", content: ERR },
          404: { description: "Conversation or message not found", content: ERR },
          409: { description: "invalid_message_target (not the newest message), conversation_busy or action_pending", content: ERR },
          429: { description: "rate_limited", content: ERR },
        },
      },
    },
    "/conversations/{conversationId}/messages/{messageId}/edit": {
      post: {
        tags: ["Messages"],
        summary: "Edit a message of the person and run the conversation again from it",
        description:
          "Stores the new text as a user message in place of the old one, removes the old message and everything after it, and runs a new turn. The new message carries " +
          "metadata.edited, editedFrom and previousContent. Its files are the old ones unless fileIds / files say otherwise; files no remaining message carries are deleted. " +
          "Goes through the run registry, the budget and the approvals like a message. Events: session.truncated, user.message (edited), then the turn's own. A host agent hears mode: edit and fromMessageId.",
        operationId: "editMessage",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" }, description: "A user message of the conversation." },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/EditMessageRequest" } } } },
        responses: {
          200: { description: "The new message and the answer; JSON, or text/event-stream when stream is true", content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageResponse" } } } },
          400: { description: "content is missing, or the files are not acceptable", content: ERR },
          402: { description: "budget_reached", content: ERR },
          403: { description: "Not your conversation, attachments_disabled, or action_disabled: the agent switched editing off", content: ERR },
          404: { description: "Conversation, message or file not found", content: ERR },
          409: { description: "invalid_message_target (not a user message), conversation_busy, action_pending or too_many_files", content: ERR },
          429: { description: "rate_limited", content: ERR },
        },
      },
    },
    "/conversations/{conversationId}/messages/{messageId}/feedback": {
      post: {
        tags: ["Messages"],
        summary: "Rate an answer",
        description:
          "Thumbs up or down on an answer, with reasons (down only) and a comment; one rating per message, a new one replaces the old, rating null withdraws it. " +
          "Stored on the message (metadata.feedback, shown as feedback), then the agent's feedback hook and the server's feedback.onFeedback hear it. " +
          "Needs no turn lease: a person can rate while another turn runs.",
        operationId: "rateMessage",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" }, description: "An assistant message of the conversation." },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/FeedbackRequest" } } } },
        responses: {
          200: { description: "The rating now on the message", content: { "application/json": { schema: { $ref: "#/components/schemas/FeedbackResponse" } } } },
          400: { description: "invalid_feedback: the rating, the reasons or the comment are not acceptable", content: ERR },
          403: { description: "Not your conversation, or feedback_disabled", content: ERR },
          404: { description: "Conversation or message not found", content: ERR },
          409: { description: "invalid_message_target: only an answer can be rated", content: ERR },
          429: { description: "rate_limited", content: ERR },
        },
      },
    },
    "/conversations/{conversationId}/export": {
      get: {
        tags: ["Conversations"],
        summary: "Download the conversation",
        description:
          "The conversation as a file: Markdown or JSON made by the server, a print-friendly HTML page (with print=1 it opens the browser's print dialog, i.e. Save as PDF), " +
          "or - when the server has export.renderPdf - a PDF. Tool calls (from the event log) are included only with tools=1 and only when allowed. " +
          "Messages are escaped text in the HTML; the page is served with a Content-Security-Policy that allows no network and, with print=1, exactly one script.",
        operationId: "exportConversation",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "format", in: "query", schema: { type: "string", enum: ["md", "json", "html", "pdf"], default: "md" } },
          { name: "tools", in: "query", description: "1 includes the tool calls of each answer (allowed by export.includeTools).", schema: { type: "string", enum: ["0", "1"], default: "0" } },
          { name: "locale", in: "query", description: "Language of the words in the file (en and tr are built in; export.labels adds more).", schema: { type: "string" } },
          { name: "print", in: "query", description: "format=html: open the print dialog when the page has loaded.", schema: { type: "string", enum: ["0", "1"], default: "0" } },
          { name: "disposition", in: "query", schema: { type: "string", enum: ["attachment", "inline"], default: "attachment" } },
        ],
        responses: {
          200: {
            description: "The file",
            content: {
              "text/markdown": { schema: { type: "string" } },
              "application/json": { schema: { type: "object", additionalProperties: true } },
              "text/html": { schema: { type: "string" } },
              "application/pdf": { schema: { type: "string", format: "binary" } },
            },
          },
          400: { description: "Unknown format", content: ERR },
          403: { description: "Not your conversation, or export_disabled", content: ERR },
          404: { description: "Conversation not found", content: ERR },
          429: { description: "rate_limited", content: ERR },
          501: { description: "export_format_unsupported: format=pdf and no export.renderPdf", content: ERR },
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
