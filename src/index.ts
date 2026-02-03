/**
 * @cognipeer/agent-server
 *
 * REST API server infrastructure for AI agents.
 * Supports agent-sdk and custom implementations with multiple storage backends.
 */

// Core exports
export { AgentServer, createAgentServer } from "./server.js";
export type { RouteContext, RouteResult } from "./server.js";

// Type exports
export type {
  // Message types
  ContentPart,
  Message,
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

  // Agent types
  AgentInfo,
  AgentHandler,
  ProcessMessageParams,
  ProcessMessageResult,
  AgentRegistration,

  // Storage provider types
  StorageProvider,
  CreateConversationParams,
  GetConversationsParams,
  UpdateConversationParams,
  CreateMessageParams,
  GetMessagesParams,
  SaveFileParams,
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
  AuthConfig,
  SwaggerConfig,
  CorsConfig,
  RequestLimits,

  // Request/Response types
  SendMessageRequest,
  SendMessageResponse,
  ListAgentsResponse,
  ListConversationsResponse,
  GetConversationResponse,
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
  StreamToolCallEvent,
  StreamToolResultEvent,
  StreamProgressEvent,
  StreamErrorEvent,
  StreamDoneEvent,
} from "./types.js";

// Error exports
export {
  AgentServerError,
  NotFoundError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
} from "./types.js";

// Storage provider exports
export { BaseStorageProvider } from "./providers/storage/base.js";
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

// Auth provider exports
export {
  TokenAuthProvider,
  JWTAuthProvider,
  createTokenAuthProvider,
  createJWTAuthProvider,
} from "./providers/auth/token.js";
export type { TokenAuthConfig, JWTAuthConfig } from "./providers/auth/token.js";

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

// Swagger exports
export { generateOpenAPISpec, generateSwaggerHTML } from "./swagger.js";
export type { OpenAPISpec } from "./swagger.js";
