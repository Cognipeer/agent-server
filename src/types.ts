/**
 * Core types for agent-server
 */

// ============================================================================
// Message Types
// ============================================================================

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "file"; file: { id: string; name: string; mimeType: string; url?: string } }
  | { type: string; [key: string]: unknown };

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  storageKey?: string;
}

// ============================================================================
// Conversation Types
// ============================================================================

export interface Conversation {
  id: string;
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

// ============================================================================
// Agent Types
// ============================================================================

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Custom agent handler for non-SDK agents
 */
export interface AgentHandler {
  /**
   * Process a message and return a response
   */
  processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult>;
}

export interface ProcessMessageParams {
  conversationId: string;
  message: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ProcessMessageResult {
  content: string;
  files?: FileAttachment[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Agent registration - can be SDK agent or custom handler
 */
export interface AgentRegistration {
  info: AgentInfo;
  // SDK agent instance (optional)
  sdkAgent?: unknown;
  // Custom handler (optional)
  handler?: AgentHandler;
}

// ============================================================================
// Storage Provider Types
// ============================================================================

export interface StorageProvider {
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Conversations
  createConversation(params: CreateConversationParams): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  getConversations(params: GetConversationsParams): Promise<PaginatedResult<Conversation>>;
  updateConversation(id: string, params: UpdateConversationParams): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;

  // Messages
  createMessage(params: CreateMessageParams): Promise<Message>;
  getMessages(conversationId: string, params?: GetMessagesParams): Promise<PaginatedResult<Message>>;
  getMessage(id: string): Promise<Message | null>;
  deleteMessage(id: string): Promise<void>;

  // Files
  saveFile(params: SaveFileParams): Promise<FileRecord>;
  getFile(id: string): Promise<FileRecord | null>;
  getFileContent(id: string): Promise<Buffer | null>;
  deleteFile(id: string): Promise<void>;

  // Tasks
  createTask(params: CreateTaskParams): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  getTasks(params: GetTasksParams): Promise<PaginatedResult<Task>>;
  updateTask(id: string, params: UpdateTaskParams): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  // Task Results
  createTaskResult(params: CreateTaskResultParams): Promise<TaskResult>;
  getTaskResult(taskId: string): Promise<TaskResult | null>;
}

export interface CreateConversationParams {
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export interface GetConversationsParams {
  agentId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt";
  order?: "asc" | "desc";
}

export interface UpdateConversationParams {
  title?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export interface CreateMessageParams {
  conversationId: string;
  role: Message["role"];
  content: string | ContentPart[];
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
}

export interface GetMessagesParams {
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export interface SaveFileParams {
  name: string;
  mimeType: string;
  content: Buffer;
  conversationId?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface FileRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  conversationId?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ============================================================================
// Auth Provider Types
// ============================================================================

export interface AuthProvider {
  /**
   * Validate a token and return user info if valid
   */
  validateToken(token: string): Promise<AuthResult>;

  /**
   * Optional: Generate a token for a user
   */
  generateToken?(userId: string, metadata?: Record<string, unknown>): Promise<string>;

  /**
   * Optional: Revoke a token
   */
  revokeToken?(token: string): Promise<void>;
}

export interface AuthResult {
  valid: boolean;
  userId?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface AuthUser {
  id: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// File Storage Provider Types
// ============================================================================

export interface FileStorageProvider {
  /**
   * Save file content and return storage key
   */
  save(params: { name: string; content: Buffer; mimeType: string }): Promise<{ key: string; url?: string }>;

  /**
   * Get file content by storage key
   */
  get(key: string): Promise<Buffer | null>;

  /**
   * Delete file by storage key
   */
  delete(key: string): Promise<void>;

  /**
   * Get public URL for file (if supported)
   */
  getUrl?(key: string): Promise<string | null>;
}

// ============================================================================
// Server Configuration Types
// ============================================================================

export interface AgentServerConfig {
  /**
   * Base path for all API routes (e.g., "/api/agents")
   */
  basePath: string;

  /**
   * Storage provider instance
   */
  storage: StorageProvider;

  /**
   * Optional file storage provider (defaults to database storage)
   */
  fileStorage?: FileStorageProvider;

  /**
   * Authentication configuration
   */
  auth?: AuthConfig;

  /**
   * Swagger/OpenAPI configuration
   */
  swagger?: SwaggerConfig;

  /**
   * CORS configuration
   */
  cors?: CorsConfig;

  /**
   * Request limits
   */
  limits?: RequestLimits;
}

export interface AuthConfig {
  /**
   * Enable/disable authentication
   */
  enabled: boolean;

  /**
   * Auth provider instance
   */
  provider?: AuthProvider;

  /**
   * Custom function to resolve userId from request context
   * Used when auth is disabled or to override token-based userId
   */
  resolveUserId?: (ctx: { headers?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }) => string | undefined | Promise<string | undefined>;

  /**
   * Header name for token (default: "Authorization")
   */
  headerName?: string;

  /**
   * Token prefix (default: "Bearer ")
   */
  tokenPrefix?: string;

  /**
   * Routes to exclude from auth
   */
  excludeRoutes?: string[];
}

export interface SwaggerConfig {
  /**
   * Enable/disable Swagger UI
   */
  enabled: boolean;

  /**
   * Path for Swagger UI (default: "/docs")
   */
  path?: string;

  /**
   * API title
   */
  title?: string;

  /**
   * API version
   */
  version?: string;

  /**
   * API description
   */
  description?: string;
}

export interface CorsConfig {
  /**
   * Enable/disable CORS
   */
  enabled: boolean;

  /**
   * Allowed origins
   */
  origins?: string[];

  /**
   * Allowed methods
   */
  methods?: string[];

  /**
   * Allowed headers
   */
  headers?: string[];
}

export interface RequestLimits {
  /**
   * Maximum file upload size in bytes (default: 10MB)
   */
  maxFileSize?: number;

  /**
   * Maximum request body size in bytes (default: 1MB)
   */
  maxBodySize?: number;

  /**
   * Maximum number of files per request (default: 10)
   */
  maxFiles?: number;
}

// ============================================================================
// Request/Response Types
// ============================================================================

export interface SendMessageRequest {
  message: string;
  files?: Array<{
    name: string;
    content: string; // base64
    mimeType: string;
  }>;
  metadata?: Record<string, unknown>;
  /**
   * Enable streaming response via Server-Sent Events (SSE)
   */
  stream?: boolean;
}

export interface SendMessageResponse {
  message: Message;
  response: Message;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

// ============================================================================
// Stream Event Types (SSE)
// ============================================================================

/**
 * Base stream event
 */
export interface StreamEventBase {
  type: string;
  timestamp: number;
}

/**
 * Stream started event
 */
export interface StreamStartEvent extends StreamEventBase {
  type: "stream.start";
  conversationId: string;
  messageId: string;
}

/**
 * Text chunk event - partial response text
 */
export interface StreamTextEvent extends StreamEventBase {
  type: "stream.text";
  text: string;
  isFinal?: boolean;
}

/**
 * Tool call event - agent is calling a tool
 */
export interface StreamToolCallEvent extends StreamEventBase {
  type: "stream.tool_call";
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

/**
 * Tool result event - tool execution completed
 */
export interface StreamToolResultEvent extends StreamEventBase {
  type: "stream.tool_result";
  toolName: string;
  toolCallId: string;
  result: unknown;
}

/**
 * Progress event - status update
 */
export interface StreamProgressEvent extends StreamEventBase {
  type: "stream.progress";
  stage?: string;
  message?: string;
  percent?: number;
}

/**
 * Error event - an error occurred
 */
export interface StreamErrorEvent extends StreamEventBase {
  type: "stream.error";
  error: string;
  code?: string;
}

/**
 * Stream completed event
 */
export interface StreamDoneEvent extends StreamEventBase {
  type: "stream.done";
  conversationId: string;
  messageId: string;
  content: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/**
 * All stream event types
 */
export type StreamEvent =
  | StreamStartEvent
  | StreamTextEvent
  | StreamToolCallEvent
  | StreamToolResultEvent
  | StreamProgressEvent
  | StreamErrorEvent
  | StreamDoneEvent;

export interface ListAgentsResponse {
  agents: AgentInfo[];
}

export interface ListConversationsResponse {
  conversations: Conversation[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface GetConversationResponse {
  conversation: Conversation;
  messages: Message[];
}

export interface CreateConversationRequest {
  agentId: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationResponse {
  conversation: Conversation;
}

export interface UploadFileRequest {
  file: {
    name: string;
    content: string; // base64
    mimeType: string;
  };
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface UploadFileResponse {
  file: FileRecord;
}

// ============================================================================
// Error Types
// ============================================================================

export class AgentServerError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AgentServerError";
  }
}

export class NotFoundError extends AgentServerError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
  }
}

export class ValidationError extends AgentServerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, details);
  }
}

export class AuthenticationError extends AgentServerError {
  constructor(message: string = "Authentication required") {
    super(message, "AUTHENTICATION_ERROR", 401);
  }
}

export class AuthorizationError extends AgentServerError {
  constructor(message: string = "Access denied") {
    super(message, "AUTHORIZATION_ERROR", 403);
  }
}

// ============================================================================
// Task Types
// ============================================================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "waiting_for_input";

export interface TaskComment {
  id: string;
  taskId: string;
  role: "agent" | "user";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface Task {
  id: string;
  agentId: string;
  userId?: string;
  status: TaskStatus;
  callbackUrl?: string;
  input: string;
  files?: FileAttachment[];
  comments?: TaskComment[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface TaskResult {
  id: string;
  taskId: string;
  content: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  createdAt: Date;
}

export interface CreateTaskParams {
  agentId: string;
  userId?: string;
  input: string;
  files?: FileAttachment[];
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface GetTasksParams {
  agentId?: string;
  userId?: string;
  status?: TaskStatus;
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt";
  order?: "asc" | "desc";
}

export interface UpdateTaskParams {
  status?: TaskStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  metadata?: Record<string, unknown>;
  comments?: TaskComment[];
}

export interface AddTaskCommentParams {
  taskId: string;
  role: "agent" | "user";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskResultParams {
  taskId: string;
  content: string;
  files?: FileAttachment[];
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

// ============================================================================
// Task Request/Response Types
// ============================================================================

export interface CreateTaskRequest {
  agentId: string;
  input: string;
  files?: Array<{
    name: string;
    content: string; // base64
    mimeType: string;
  }>;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskResponse {
  task: Task;
}

export interface ListTasksResponse {
  tasks: Task[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface GetTaskResponse {
  task: Task;
  result?: TaskResult;
}

export interface GetTaskStatusResponse {
  taskId: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface GetTaskResultResponse {
  result: TaskResult;
}

export interface AddTaskCommentRequest {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AddTaskCommentResponse {
  comment: TaskComment;
  task: Task;
}

export interface GetTaskCommentsResponse {
  comments: TaskComment[];
  total: number;
}

