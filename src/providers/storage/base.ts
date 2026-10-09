/**
 * Base Storage Provider - abstract class with common utilities
 */

import { nanoid } from "nanoid";
import type {
  StorageProvider,
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
  RequestContext,
} from "../../types.js";

/**
 * Abstract base class for storage providers
 * Provides common utilities and enforces interface contract
 */
export abstract class BaseStorageProvider implements StorageProvider {
  protected _connected = false;

  // ============================================================================
  // Abstract methods to be implemented by concrete providers
  // ============================================================================

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  // Conversations
  protected abstract _createConversation(
    id: string,
    params: CreateConversationParams,
    ctx?: RequestContext
  ): Promise<Conversation>;
  protected abstract _getConversation(id: string, ctx?: RequestContext): Promise<Conversation | null>;
  protected abstract _getConversations(
    params: GetConversationsParams,
    ctx?: RequestContext
  ): Promise<PaginatedResult<Conversation>>;
  protected abstract _updateConversation(
    id: string,
    params: UpdateConversationParams,
    ctx?: RequestContext
  ): Promise<Conversation>;
  protected abstract _deleteConversation(id: string, ctx?: RequestContext): Promise<void>;

  // Messages
  protected abstract _createMessage(
    id: string,
    params: CreateMessageParams,
    ctx?: RequestContext
  ): Promise<Message>;
  protected abstract _getMessages(
    conversationId: string,
    params?: GetMessagesParams,
    ctx?: RequestContext
  ): Promise<PaginatedResult<Message>>;
  protected abstract _getMessage(id: string, ctx?: RequestContext): Promise<Message | null>;
  protected abstract _deleteMessage(id: string, ctx?: RequestContext): Promise<void>;

  // Files
  protected abstract _saveFile(
    id: string,
    params: SaveFileParams & { storageKey: string; size: number },
    ctx?: RequestContext
  ): Promise<FileRecord>;
  protected abstract _getFile(id: string, ctx?: RequestContext): Promise<FileRecord | null>;
  protected abstract _getFileContent(id: string, ctx?: RequestContext): Promise<Buffer | null>;
  protected abstract _deleteFile(id: string, ctx?: RequestContext): Promise<void>;

  // Tasks
  protected abstract _createTask(
    id: string,
    params: CreateTaskParams,
    ctx?: RequestContext
  ): Promise<Task>;
  protected abstract _getTask(id: string, ctx?: RequestContext): Promise<Task | null>;
  protected abstract _getTasks(
    params: GetTasksParams,
    ctx?: RequestContext
  ): Promise<PaginatedResult<Task>>;
  protected abstract _updateTask(
    id: string,
    params: UpdateTaskParams,
    ctx?: RequestContext
  ): Promise<Task>;
  protected abstract _deleteTask(id: string, ctx?: RequestContext): Promise<void>;

  // Task Results
  protected abstract _createTaskResult(
    id: string,
    params: CreateTaskResultParams,
    ctx?: RequestContext
  ): Promise<TaskResult>;
  protected abstract _getTaskResult(taskId: string, ctx?: RequestContext): Promise<TaskResult | null>;

  // ============================================================================
  // Public interface implementation
  // ============================================================================

  isConnected(): boolean {
    return this._connected;
  }

  protected ensureConnected(): void {
    if (!this._connected) {
      throw new Error("Storage provider is not connected");
    }
  }

  async createConversation(params: CreateConversationParams, ctx?: RequestContext): Promise<Conversation> {
    this.ensureConnected();
    const id = this.generateId("conv");
    return this._createConversation(id, params, ctx);
  }

  async getConversation(id: string, ctx?: RequestContext): Promise<Conversation | null> {
    this.ensureConnected();
    return this._getConversation(id, ctx);
  }

  async getConversations(
    params: GetConversationsParams,
    ctx?: RequestContext
  ): Promise<PaginatedResult<Conversation>> {
    this.ensureConnected();
    return this._getConversations(params, ctx);
  }

  async updateConversation(
    id: string,
    params: UpdateConversationParams,
    ctx?: RequestContext
  ): Promise<Conversation> {
    this.ensureConnected();
    return this._updateConversation(id, params, ctx);
  }

  async deleteConversation(id: string, ctx?: RequestContext): Promise<void> {
    this.ensureConnected();
    return this._deleteConversation(id, ctx);
  }

  async createMessage(params: CreateMessageParams, ctx?: RequestContext): Promise<Message> {
    this.ensureConnected();
    const id = this.generateId("msg");
    return this._createMessage(id, params, ctx);
  }

  async getMessages(
    conversationId: string,
    params?: GetMessagesParams,
    ctx?: RequestContext
  ): Promise<PaginatedResult<Message>> {
    this.ensureConnected();
    return this._getMessages(conversationId, params, ctx);
  }

  async getMessage(id: string, ctx?: RequestContext): Promise<Message | null> {
    this.ensureConnected();
    return this._getMessage(id, ctx);
  }

  async deleteMessage(id: string, ctx?: RequestContext): Promise<void> {
    this.ensureConnected();
    return this._deleteMessage(id, ctx);
  }

  async saveFile(params: SaveFileParams, ctx?: RequestContext): Promise<FileRecord> {
    this.ensureConnected();
    const id = this.generateId("file");
    const storageKey = this.generateStorageKey(params.name);
    const size = params.content.length;
    return this._saveFile(id, { ...params, storageKey, size }, ctx);
  }

  async getFile(id: string, ctx?: RequestContext): Promise<FileRecord | null> {
    this.ensureConnected();
    return this._getFile(id, ctx);
  }

  async getFileContent(id: string, ctx?: RequestContext): Promise<Buffer | null> {
    this.ensureConnected();
    return this._getFileContent(id, ctx);
  }

  async deleteFile(id: string, ctx?: RequestContext): Promise<void> {
    this.ensureConnected();
    return this._deleteFile(id, ctx);
  }

  async createTask(params: CreateTaskParams, ctx?: RequestContext): Promise<Task> {
    this.ensureConnected();
    const id = this.generateId("task");
    return this._createTask(id, params, ctx);
  }

  async getTask(id: string, ctx?: RequestContext): Promise<Task | null> {
    this.ensureConnected();
    return this._getTask(id, ctx);
  }

  async getTasks(params: GetTasksParams, ctx?: RequestContext): Promise<PaginatedResult<Task>> {
    this.ensureConnected();
    return this._getTasks(params, ctx);
  }

  async updateTask(id: string, params: UpdateTaskParams, ctx?: RequestContext): Promise<Task> {
    this.ensureConnected();
    return this._updateTask(id, params, ctx);
  }

  async deleteTask(id: string, ctx?: RequestContext): Promise<void> {
    this.ensureConnected();
    return this._deleteTask(id, ctx);
  }

  async createTaskResult(params: CreateTaskResultParams, ctx?: RequestContext): Promise<TaskResult> {
    this.ensureConnected();
    const id = this.generateId("taskres");
    return this._createTaskResult(id, params, ctx);
  }

  async getTaskResult(taskId: string, ctx?: RequestContext): Promise<TaskResult | null> {
    this.ensureConnected();
    return this._getTaskResult(taskId, ctx);
  }

  // ============================================================================
  // Utility methods
  // ============================================================================

  protected generateId(prefix: string): string {
    return `${prefix}_${nanoid(21)}`;
  }

  protected generateStorageKey(filename: string): string {
    const ext = filename.includes(".") ? filename.split(".").pop() : "";
    const key = nanoid(32);
    return ext ? `${key}.${ext}` : key;
  }

  protected normalizeParams<T extends { limit?: number; offset?: number }>(
    params: T,
    defaults: { limit: number; offset: number }
  ): T & { limit: number; offset: number } {
    return {
      ...params,
      limit: params.limit ?? defaults.limit,
      offset: params.offset ?? defaults.offset,
    };
  }
}
