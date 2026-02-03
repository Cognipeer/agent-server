/**
 * In-Memory Storage Provider
 *
 * Lightweight storage provider for development and testing.
 * Data is stored in memory and will be lost when the process exits.
 */

import { BaseStorageProvider } from "./base.js";
import type {
  Conversation,
  Message,
  FileRecord,
  Task,
  TaskResult,
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
  PaginatedResult,
} from "../../types.js";

export interface InMemoryConfig {
  /**
   * Maximum number of conversations to store (default: unlimited)
   */
  maxConversations?: number;

  /**
   * Maximum number of messages per conversation (default: unlimited)
   */
  maxMessagesPerConversation?: number;

  /**
   * Maximum total file storage in bytes (default: 100MB)
   */
  maxFileStorage?: number;
}

export class InMemoryStorageProvider extends BaseStorageProvider {
  private config: InMemoryConfig;
  private conversations: Map<string, Conversation> = new Map();
  private messages: Map<string, Message[]> = new Map(); // conversationId -> messages
  private files: Map<string, FileRecord> = new Map();
  private fileContents: Map<string, Buffer> = new Map(); // storageKey -> content
  private totalFileSize = 0;
  private tasks: Map<string, Task> = new Map();
  private taskResults: Map<string, TaskResult> = new Map(); // taskId -> result

  constructor(config: InMemoryConfig = {}) {
    super();
    this.config = config;
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this.clear();
    this._connected = false;
  }

  /**
   * Clear all stored data
   */
  clear(): void {
    this.conversations.clear();
    this.messages.clear();
    this.files.clear();
    this.fileContents.clear();
    this.tasks.clear();
    this.taskResults.clear();
    this.totalFileSize = 0;
  }

  // ============================================================================
  // Conversations
  // ============================================================================

  protected async _createConversation(
    id: string,
    params: CreateConversationParams
  ): Promise<Conversation> {
    // Check max conversations limit
    if (
      this.config.maxConversations &&
      this.conversations.size >= this.config.maxConversations
    ) {
      throw new Error(
        `Maximum conversations limit reached: ${this.config.maxConversations}`
      );
    }

    const now = new Date();
    const conversation: Conversation = {
      id,
      agentId: params.agentId,
      userId: params.userId,
      title: params.title,
      metadata: params.metadata || {},
      state: params.state || {},
      createdAt: now,
      updatedAt: now,
    };

    this.conversations.set(id, conversation);
    this.messages.set(id, []);

    return conversation;
  }

  protected async _getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) || null;
  }

  protected async _getConversations(
    params: GetConversationsParams
  ): Promise<PaginatedResult<Conversation>> {
    const normalized = this.normalizeParams(params, { limit: 20, offset: 0 });

    // Filter conversations
    let conversations = Array.from(this.conversations.values());

    if (params.agentId) {
      conversations = conversations.filter((c) => c.agentId === params.agentId);
    }
    if (params.userId) {
      conversations = conversations.filter((c) => c.userId === params.userId);
    }

    // Sort
    const orderBy = params.orderBy === "updatedAt" ? "updatedAt" : "createdAt";
    const order = params.order === "asc" ? 1 : -1;
    conversations.sort((a, b) => {
      const aTime = a[orderBy].getTime();
      const bTime = b[orderBy].getTime();
      return (aTime - bTime) * order;
    });

    const total = conversations.length;

    // Paginate
    const data = conversations.slice(
      normalized.offset,
      normalized.offset + normalized.limit
    );

    return {
      data,
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + data.length < total,
    };
  }

  protected async _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      throw new Error(`Conversation not found: ${id}`);
    }

    const updated: Conversation = {
      ...conversation,
      title: params.title !== undefined ? params.title : conversation.title,
      metadata:
        params.metadata !== undefined ? params.metadata : conversation.metadata,
      state: params.state !== undefined ? params.state : conversation.state,
      updatedAt: new Date(),
    };

    this.conversations.set(id, updated);
    return updated;
  }

  protected async _deleteConversation(id: string): Promise<void> {
    // Delete all messages in conversation
    const conversationMessages = this.messages.get(id) || [];
    for (const msg of conversationMessages) {
      if (msg.files) {
        for (const file of msg.files) {
          await this._deleteFile(file.id);
        }
      }
    }

    this.messages.delete(id);
    this.conversations.delete(id);
  }

  // ============================================================================
  // Messages
  // ============================================================================

  protected async _createMessage(
    id: string,
    params: CreateMessageParams
  ): Promise<Message> {
    const conversationMessages = this.messages.get(params.conversationId);
    if (!conversationMessages) {
      throw new Error(`Conversation not found: ${params.conversationId}`);
    }

    // Check max messages limit
    if (
      this.config.maxMessagesPerConversation &&
      conversationMessages.length >= this.config.maxMessagesPerConversation
    ) {
      throw new Error(
        `Maximum messages per conversation limit reached: ${this.config.maxMessagesPerConversation}`
      );
    }

    const now = new Date();
    const message: Message = {
      id,
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      name: params.name,
      toolCalls: params.toolCalls,
      toolCallId: params.toolCallId,
      files: params.files,
      metadata: params.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    conversationMessages.push(message);

    // Update conversation updatedAt
    const conversation = this.conversations.get(params.conversationId);
    if (conversation) {
      conversation.updatedAt = now;
    }

    return message;
  }

  protected async _getMessages(
    conversationId: string,
    params?: GetMessagesParams
  ): Promise<PaginatedResult<Message>> {
    const normalized = this.normalizeParams(params || {}, {
      limit: 100,
      offset: 0,
    });

    const conversationMessages = this.messages.get(conversationId) || [];

    // Sort
    const order = params?.order === "desc" ? -1 : 1;
    const sorted = [...conversationMessages].sort((a, b) => {
      return (a.createdAt.getTime() - b.createdAt.getTime()) * order;
    });

    const total = sorted.length;

    // Paginate
    const data = sorted.slice(
      normalized.offset,
      normalized.offset + normalized.limit
    );

    return {
      data,
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + data.length < total,
    };
  }

  protected async _getMessage(id: string): Promise<Message | null> {
    for (const messages of this.messages.values()) {
      const message = messages.find((m) => m.id === id);
      if (message) return message;
    }
    return null;
  }

  protected async _deleteMessage(id: string): Promise<void> {
    for (const [conversationId, messages] of this.messages.entries()) {
      const index = messages.findIndex((m) => m.id === id);
      if (index !== -1) {
        const message = messages[index];
        // Delete associated files
        if (message.files) {
          for (const file of message.files) {
            await this._deleteFile(file.id);
          }
        }
        messages.splice(index, 1);
        this.messages.set(conversationId, messages);
        return;
      }
    }
  }

  // ============================================================================
  // Files
  // ============================================================================

  protected async _saveFile(
    id: string,
    params: SaveFileParams & { storageKey: string; size: number }
  ): Promise<FileRecord> {
    // Check max file storage limit
    const maxStorage = this.config.maxFileStorage || 100 * 1024 * 1024; // 100MB default
    if (this.totalFileSize + params.size > maxStorage) {
      throw new Error(`Maximum file storage limit reached: ${maxStorage} bytes`);
    }

    // Save file content
    this.fileContents.set(params.storageKey, params.content);
    this.totalFileSize += params.size;

    // Save file record
    const now = new Date();
    const file: FileRecord = {
      id,
      name: params.name,
      mimeType: params.mimeType,
      size: params.size,
      storageKey: params.storageKey,
      conversationId: params.conversationId,
      messageId: params.messageId,
      metadata: params.metadata || {},
      createdAt: now,
    };

    this.files.set(id, file);
    return file;
  }

  protected async _getFile(id: string): Promise<FileRecord | null> {
    return this.files.get(id) || null;
  }

  protected async _getFileContent(id: string): Promise<Buffer | null> {
    const file = this.files.get(id);
    if (!file) return null;
    return this.fileContents.get(file.storageKey) || null;
  }

  protected async _deleteFile(id: string): Promise<void> {
    const file = this.files.get(id);
    if (file) {
      const content = this.fileContents.get(file.storageKey);
      if (content) {
        this.totalFileSize -= content.length;
        this.fileContents.delete(file.storageKey);
      }
      this.files.delete(id);
    }
  }

  // ============================================================================
  // Tasks
  // ============================================================================

  protected async _createTask(
    id: string,
    params: CreateTaskParams
  ): Promise<Task> {
    const now = new Date();
    const task: Task = {
      id,
      agentId: params.agentId,
      userId: params.userId,
      status: "pending",
      callbackUrl: params.callbackUrl,
      input: params.input,
      files: params.files,
      metadata: params.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);
    return task;
  }

  protected async _getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) || null;
  }

  protected async _getTasks(
    params: GetTasksParams
  ): Promise<PaginatedResult<Task>> {
    const normalized = this.normalizeParams(params, { limit: 20, offset: 0 });

    // Filter tasks
    let tasks = Array.from(this.tasks.values());

    if (params.agentId) {
      tasks = tasks.filter((t) => t.agentId === params.agentId);
    }
    if (params.userId) {
      tasks = tasks.filter((t) => t.userId === params.userId);
    }
    if (params.status) {
      tasks = tasks.filter((t) => t.status === params.status);
    }

    // Sort
    const orderBy = params.orderBy === "updatedAt" ? "updatedAt" : "createdAt";
    const order = params.order === "asc" ? 1 : -1;
    tasks.sort((a, b) => {
      const aTime = a[orderBy].getTime();
      const bTime = b[orderBy].getTime();
      return (aTime - bTime) * order;
    });

    const total = tasks.length;

    // Paginate
    const data = tasks.slice(
      normalized.offset,
      normalized.offset + normalized.limit
    );

    return {
      data,
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + data.length < total,
    };
  }

  protected async _updateTask(
    id: string,
    params: UpdateTaskParams
  ): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const updated: Task = {
      ...task,
      status: params.status !== undefined ? params.status : task.status,
      startedAt: params.startedAt !== undefined ? params.startedAt : task.startedAt,
      completedAt: params.completedAt !== undefined ? params.completedAt : task.completedAt,
      error: params.error !== undefined ? params.error : task.error,
      metadata: params.metadata !== undefined ? params.metadata : task.metadata,
      comments: params.comments !== undefined ? params.comments : task.comments,
      updatedAt: new Date(),
    };

    this.tasks.set(id, updated);
    return updated;
  }

  protected async _deleteTask(id: string): Promise<void> {
    // Delete task result if exists
    this.taskResults.delete(id);
    this.tasks.delete(id);
  }

  // ============================================================================
  // Task Results
  // ============================================================================

  protected async _createTaskResult(
    id: string,
    params: CreateTaskResultParams
  ): Promise<TaskResult> {
    const now = new Date();
    const result: TaskResult = {
      id,
      taskId: params.taskId,
      content: params.content,
      files: params.files,
      metadata: params.metadata || {},
      usage: params.usage,
      createdAt: now,
    };

    this.taskResults.set(params.taskId, result);
    return result;
  }

  protected async _getTaskResult(taskId: string): Promise<TaskResult | null> {
    return this.taskResults.get(taskId) || null;
  }

  // ============================================================================
  // Stats
  // ============================================================================

  /**
   * Get storage statistics
   */
  getStats(): {
    conversationCount: number;
    messageCount: number;
    fileCount: number;
    totalFileSize: number;
  } {
    let messageCount = 0;
    for (const messages of this.messages.values()) {
      messageCount += messages.length;
    }

    return {
      conversationCount: this.conversations.size,
      messageCount,
      fileCount: this.files.size,
      totalFileSize: this.totalFileSize,
    };
  }
}

// Export factory function
export function createInMemoryProvider(
  config: InMemoryConfig = {}
): InMemoryStorageProvider {
  return new InMemoryStorageProvider(config);
}
