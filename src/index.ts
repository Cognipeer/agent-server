/**
 * @cognipeer/agent-server
 *
 * REST API server infrastructure for AI agents.
 * Supports agent-sdk and custom implementations with multiple storage backends.
 */

// Core exports
export { AgentServer, createAgentServer } from "./server.js";
export type { RouteContext, RouteResult, RouteRequest, AgentRegistrationOptions } from "./server.js";
export {
  getRequestContext,
  runWithRequestContext,
  parseCookies,
} from "./context.js";

// Type exports
export type {
  // Message types
  ContentPart,
  Message,
  MessageFeedback,
  ToolCall,
  FileAttachment,

  // Conversation types
  Conversation,
  ConversationWithMessages,

  // Task types
  Task,
  TaskResult,
  TaskStatus,
  TaskComment,

  // Request context
  RequestContext,
  ContextRequest,

  // Agent types
  AgentInfo,
  AgentModelOption,
  AgentInfoMetadata,
  AgentExperience,
  ResolvedExperience,
  ConversationStarter,
  TurnMode,
  AgentHandler,
  ProcessMessageParams,
  ProcessMessageResult,
  AgentRegistration,

  // Host-backed agents
  HostAgent,
  HostAgentDefinition,
  HostEvent,
  HostFiles,
  HostRunIo,
  HostInvokeInput,
  HostResolveInput,
  HostCancelInput,
  HostCancelReason,
  HostTurnResult,
  FeedbackEvent,

  // Storage provider types
  StorageProvider,
  StorageCapabilities,
  EventStore,
  ConversationEvent,
  NewConversationEvent,
  ListEventsParams,
  EventPage,
  EventSummary,
  Lease,
  AcquireLeaseParams,
  AcquireLeaseResult,
  RenewLeaseParams,
  ReleaseLeaseParams,
  ListExpiredLeasesParams,
  CreateConversationParams,
  GetConversationsParams,
  UpdateConversationParams,
  CreateMessageParams,
  GetMessagesParams,
  SaveFileParams,
  ListFilesParams,
  PurgeExpiredFilesParams,
  CreateTaskParams,
  GetTasksParams,
  UpdateTaskParams,
  CreateTaskResultParams,
  AddTaskCommentParams,
  FileRecord,
  PaginatedResult,

  // Auth provider types
  AuthProvider,
  AuthResult,
  AuthUser,

  // File storage types
  FileStorageProvider,

  // Configuration types
  AgentServerConfig,
  TitleGenerationConfig,
  TitleInput,
  TitleResult,
  FeedbackConfig,
  ExportConfig,
  ExportLabels,
  RateLimitOperation,
  RateLimitRequest,
  RateLimitDecision,
  AuditEntry,
  AuthConfig,
  SwaggerConfig,
  CorsConfig,
  RequestLimits,

  // Request/Response types
  SendMessageRequest,
  SendMessageResponse,
  RegenerateMessageRequest,
  EditMessageRequest,
  FeedbackRequest,
  FeedbackResponse,
  BulkDeleteRequest,
  BulkDeleteResponse,
  ResolveActionRequest,
  ResolveActionResponse,
  PendingAction,
  ActionResolution,
  UserQuestion,
  UserQuestionOption,
  MessageStatus,
  TurnWarning,
  ResolveActionParams,
  AgentCapabilities,
  AgentHitlConfig,
  HitlConfig,
  ActionSnapshot,
  ActionStatus,
  SessionBudget,
  ModelPricing,
  PricingFn,
  BudgetChange,
  UsageInfo,
  UpdateMessageParams,
  UpdateConversationRequest,
  ContinueConversationRequest,
  RememberedToolsResponse,
  AttachmentsCapability,
  FilesConfig,
  AgentFilesConfig,
  ExtractTextFile,
  ListFilesResponse,
  StopReason,
  RuntimeStatus,
  ConversationRuntime,
  RuntimeError,
  MessageSnapshotFrame,
  RunsConfig,
  ListEventsResponse,
  WireEvent,
  CancelConversationResponse,
  ListAgentsResponse,
  ServerFeatures,
  ConversationSearchMatch,
  ListConversationsResponse,
  GetConversationResponse,
  MessagesPage,
  CreateConversationRequest,
  CreateConversationResponse,
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

  // Stream event types (SSE)
  StreamEvent,
  StreamEventBase,
  StreamStartEvent,
  StreamTextEvent,
  StreamThinkingEvent,
  ReasoningEffort,
  StreamToolCallEvent,
  StreamToolResultEvent,
  StreamProgressEvent,
  StreamErrorEvent,
  StreamActionRequiredEvent,
  StreamActionResolvedEvent,
  StreamDoneEvent,
  StreamTitleEvent,
} from "./types.js";

// Constants of the chat experience
export { DEFAULT_FEEDBACK_REASONS, MAX_STARTERS, REASONING_EFFORTS } from "./types.js";

// Error exports
export {
  AgentServerError,
  NotFoundError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  StorageLimitError,
} from "./types.js";

// Files: what an agent reads attachments with, and the settings around them
export { createSessionFileTools, SESSION_FILE_TOOL_NAMES } from "./files/tools.js";
export type { SessionFileTool, SessionFileToolsOptions } from "./files/tools.js";
export {
  withSessionImages,
  createImageAwareTokenCounter,
  isSessionImageModel,
  IMAGE_TOKENS,
} from "./files/images.js";
export type { WithSessionImagesOptions } from "./files/images.js";
export {
  FILES_DEFAULTS,
  SESSION_FILES_LIST_TOOL,
  SESSION_FILES_READ_TOOL,
  SESSION_FILES_VIEW_IMAGE_TOOL,
  isRawUploadRequest,
  isUnsupportedUploadRequest,
} from "./files/config.js";
export { defaultExtractText } from "./files/extract.js";

// Usage and budgets
export { costEstimatorFromPricing } from "./usage.js";
export { toJsonSchema } from "./schema.js";

// Host-backed agents (for hosts that resolve their agents per request: return this from `config.agents`)
export { hostAgentRegistration } from "./host.js";

// Run lifecycle and the event log
export { EVENT_TYPES, MemoryEventLog, nextStopReason } from "./events.js";
export type { MemoryEventLogOptions } from "./events.js";

// Storage provider exports
export { BaseStorageProvider } from "./providers/storage/base.js";
export type { EventQuery, StoredEventInput } from "./providers/storage/base.js";
export {
  PostgresStorageProvider,
  createPostgresProvider,
} from "./providers/storage/postgres.js";
export type { PostgresConfig } from "./providers/storage/postgres.js";
export {
  MongoDBStorageProvider,
  createMongoDBProvider,
} from "./providers/storage/mongodb.js";
export type { MongoDBConfig } from "./providers/storage/mongodb.js";
export {
  InMemoryStorageProvider,
  createInMemoryProvider,
} from "./providers/storage/memory.js";
export type { InMemoryConfig } from "./providers/storage/memory.js";
export {
  SQLiteStorageProvider,
  createSQLiteProvider,
} from "./providers/storage/sqlite.js";
export type { SQLiteConfig } from "./providers/storage/sqlite.js";

// Auth provider exports
export {
  TokenAuthProvider,
  JWTAuthProvider,
  createTokenAuthProvider,
  createJWTAuthProvider,
} from "./providers/auth/token.js";
export type { TokenAuthConfig, JWTAuthConfig } from "./providers/auth/token.js";

// AI provider exports
export {
  invokeChatCompletions,
  streamChatCompletions,
  invokeResponsesApi,
  streamResponsesApi,
} from "./providers/ai/index.js";
export type {
  ChatCompletionsConfig,
  ChatCompletionsResult,
  ChatCompletionsStreamEvent,
  ResponsesApiConfig,
  ResponsesApiResult,
  ResponsesApiStreamEvent,
} from "./providers/ai/index.js";

// Adapter exports
export {
  createExpressMiddleware,
  createExpressRouter,
  mountOnExpress,
  createCorsMiddleware,
} from "./adapters/express.js";
export type { ExpressAdapterOptions } from "./adapters/express.js";

export {
  createNextHandler,
  createNextRouteHandlers,
  createNextMiddleware,
} from "./adapters/next.js";
export type { NextAdapterOptions } from "./adapters/next.js";

export { createNodeHandler } from "./adapters/node.js";
export type {
  NodeHandler,
  NodeHandlerOptions,
  NodeHandlerOverrides,
} from "./adapters/node.js";

// Swagger exports
export { generateOpenAPISpec, generateSwaggerHTML } from "./swagger.js";
export type { OpenAPISpec } from "./swagger.js";
