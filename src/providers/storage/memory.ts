/**
 * In-Memory Storage Provider
 *
 * Lightweight storage provider for development and testing.
 * Data is stored in memory and will be lost when the process exits.
 *
 * Records are copied on the way in and out, so mutating a returned object never
 * changes what is stored.
 */

import { BaseStorageProvider } from "./base.js";
import { NotFoundError, StorageLimitError } from "../../types.js";
import { MAX_BUFFER_BYTES, pageResult } from "./shared.js";
import type {
  Conversation,
  Message,
  FileRecord,
  Task,
  TaskResult,
  StorageCapabilities,
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
   * Maximum total file storage in bytes (default: 100MB). Also the largest single file.
   */
  maxFileStorage?: number;
}

const DEFAULT_MAX_FILE_STORAGE = 100 * 1024 * 1024;

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryStorageProvider extends BaseStorageProvider {
  private config: InMemoryConfig;
  private conversations: Map<string, Conversation> = new Map();
  /** Insertion order, the tie-break between rows created in the same millisecond. */
  private seqs: Map<string, number> = new Map();
  private seqCounter = 0;
  private messages: Map<string, Message[]> = new Map(); // conversationId -> messages in insertion order
  private messageOwner: Map<string, string> = new Map(); // messageId -> conversationId
  private files: Map<string, FileRecord> = new Map();
  private conversationFiles: Map<string, Set<string>> = new Map(); // conversationId -> file ids
  private fileContents: Map<string, Buffer> = new Map(); // storageKey -> content
  private totalFileSize = 0;
  private tasks: Map<string, Task> = new Map();
  private taskResults: Map<string, TaskResult> = new Map(); // taskId -> result

  constructor(config: InMemoryConfig = {}) {
    super();
    this.config = config;
  }

  capabilities(): StorageCapabilities {
    return {
      ...super.capabilities(),
      maxFileBytes: Math.min(this.config.maxFileStorage || DEFAULT_MAX_FILE_STORAGE, MAX_BUFFER_BYTES),
    };
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
    this.seqs.clear();
    this.messages.clear();
    this.messageOwner.clear();
    this.files.clear();
    this.conversationFiles.clear();
    this.fileContents.clear();
    this.tasks.clear();
    this.taskResults.clear();
    this.totalFileSize = 0;
  }

  private seq(id: string): number {
    this.seqs.set(id, ++this.seqCounter);
    return this.seqCounter;
  }

  /** Newest-first / oldest-first with insertion order breaking ties, like `ORDER BY created_at, rowid`. */
  private sortByTime<T extends { id: string }>(
    rows: T[],
    key: (row: T) => number,
    direction: 1 | -1
  ): T[] {
    return rows.sort(
      (a, b) =>
        (key(a) - key(b)) * direction || ((this.seqs.get(a.id) ?? 0) - (this.seqs.get(b.id) ?? 0)) * direction
    );
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
      throw new StorageLimitError(
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
    this.seq(id);

    return copy(conversation);
  }

  protected async _getConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    return conversation ? copy(conversation) : null;
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
    this.sortByTime(conversations, (c) => c[orderBy].getTime(), params.order === "asc" ? 1 : -1);

    const total = conversations.length;

    // Paginate
    const data = conversations
      .slice(normalized.offset, normalized.offset + normalized.limit)
      .map(copy);

    return pageResult(data, total, normalized.limit, normalized.offset);
  }

  protected async _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      throw new NotFoundError("Conversation", id);
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
    return copy(updated);
  }

  protected async _deleteConversation(id: string): Promise<void> {
    // Files first (the conversation's own, attached to a message or not), then the rest
    for (const fileId of [...(this.conversationFiles.get(id) ?? [])]) {
      this.removeFile(fileId);
    }
    this.conversationFiles.delete(id);

    for (const message of this.messages.get(id) ?? []) {
      this.messageOwner.delete(message.id);
      this.seqs.delete(message.id);
    }
    this.messages.delete(id);
    this.conversations.delete(id);
    this.seqs.delete(id);
  }

  // ============================================================================
  // Messages
  // ============================================================================

  protected async _createMessage(
    id: string,
    params: CreateMessageParams
  ): Promise<Message> {
    const conversation = this.conversations.get(params.conversationId);
    const conversationMessages = this.messages.get(params.conversationId);
    if (!conversation || !conversationMessages) {
      throw new NotFoundError("Conversation", params.conversationId);
    }

    // Check max messages limit
    if (
      this.config.maxMessagesPerConversation &&
      conversationMessages.length >= this.config.maxMessagesPerConversation
    ) {
      throw new StorageLimitError(
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
    this.messageOwner.set(id, params.conversationId);
    this.seq(id);

    // A new message is activity on the conversation
    conversation.updatedAt = now;

    return copy(message);
  }

  protected async _getMessages(
    conversationId: string,
    params?: GetMessagesParams
  ): Promise<PaginatedResult<Message>> {
    const normalized = this.normalizeParams(params || {}, {
      limit: 100,
      offset: 0,
    });

    // Insertion order is chronological order: the tie-break for equal timestamps.
    let rows = [...(this.messages.get(conversationId) ?? [])].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (this.seqs.get(a.id) ?? 0) - (this.seqs.get(b.id) ?? 0)
    );

    const cursor = params?.before ?? params?.after;
    if (cursor) {
      const position = rows.findIndex((m) => m.id === cursor);
      if (position === -1) throw new NotFoundError("Message", cursor);
      rows = params?.before ? rows.slice(0, position) : rows.slice(position + 1);
    }
    if (params?.order === "desc") rows.reverse();

    const total = rows.length;

    // Paginate
    const data = rows.slice(normalized.offset, normalized.offset + normalized.limit).map(copy);

    return pageResult(data, total, normalized.limit, normalized.offset);
  }

  protected async _getMessage(id: string): Promise<Message | null> {
    const conversationId = this.messageOwner.get(id);
    const message = conversationId
      ? this.messages.get(conversationId)?.find((m) => m.id === id)
      : undefined;
    return message ? copy(message) : null;
  }

  protected async _deleteMessage(id: string): Promise<void> {
    const conversationId = this.messageOwner.get(id);
    const messages = conversationId ? this.messages.get(conversationId) : undefined;
    const index = messages ? messages.findIndex((m) => m.id === id) : -1;
    if (!messages || index === -1) return;

    // Its files stay with the conversation, just no longer on a message
    for (const file of this.files.values()) {
      if (file.messageId === id) file.messageId = undefined;
    }
    messages.splice(index, 1);
    this.messageOwner.delete(id);
    this.seqs.delete(id);
  }

  // ============================================================================
  // Files
  // ============================================================================

  protected async _saveFile(
    id: string,
    params: SaveFileParams & { storageKey: string; size: number }
  ): Promise<FileRecord> {
    if (params.conversationId && !this.conversations.has(params.conversationId)) {
      throw new NotFoundError("Conversation", params.conversationId);
    }

    // Check max file storage limit
    const maxStorage = this.config.maxFileStorage || DEFAULT_MAX_FILE_STORAGE;
    if (this.totalFileSize + params.size > maxStorage) {
      throw new StorageLimitError(`Maximum file storage limit reached: ${maxStorage} bytes`, {
        maxBytes: maxStorage,
      });
    }

    // Save file content (a copy: the caller keeps its buffer)
    this.fileContents.set(params.storageKey, Buffer.from(params.content));
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
    if (params.conversationId) {
      const set = this.conversationFiles.get(params.conversationId) ?? new Set<string>();
      set.add(id);
      this.conversationFiles.set(params.conversationId, set);
    }
    return copy(file);
  }

  protected async _getFile(id: string): Promise<FileRecord | null> {
    const file = this.files.get(id);
    return file ? copy(file) : null;
  }

  protected async _getFileContent(id: string): Promise<Buffer | null> {
    const file = this.files.get(id);
    if (!file) return null;
    const content = this.fileContents.get(file.storageKey);
    return content ? Buffer.from(content) : null;
  }

  protected async _deleteFile(id: string): Promise<void> {
    this.removeFile(id);
  }

  private removeFile(id: string): void {
    const file = this.files.get(id);
    if (!file) return;
    const content = this.fileContents.get(file.storageKey);
    if (content) {
      this.totalFileSize -= content.length;
      this.fileContents.delete(file.storageKey);
    }
    if (file.conversationId) this.conversationFiles.get(file.conversationId)?.delete(id);
    this.files.delete(id);
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
      comments: [],
      metadata: params.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);
    this.seq(id);
    return copy(task);
  }

  protected async _getTask(id: string): Promise<Task | null> {
    const task = this.tasks.get(id);
    return task ? copy(task) : null;
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
    this.sortByTime(tasks, (t) => t[orderBy].getTime(), params.order === "asc" ? 1 : -1);

    const total = tasks.length;

    // Paginate
    const data = tasks.slice(normalized.offset, normalized.offset + normalized.limit).map(copy);

    return pageResult(data, total, normalized.limit, normalized.offset);
  }

  protected async _updateTask(
    id: string,
    params: UpdateTaskParams
  ): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new NotFoundError("Task", id);
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
    return copy(updated);
  }

  protected async _deleteTask(id: string): Promise<void> {
    // Delete task result if exists
    this.taskResults.delete(id);
    this.tasks.delete(id);
    this.seqs.delete(id);
  }

  // ============================================================================
  // Task Results
  // ============================================================================

  protected async _createTaskResult(
    id: string,
    params: CreateTaskResultParams
  ): Promise<TaskResult> {
    if (!this.tasks.has(params.taskId)) {
      throw new NotFoundError("Task", params.taskId);
    }

    const result: TaskResult = {
      // A replaced result keeps its id
      id: this.taskResults.get(params.taskId)?.id ?? id,
      taskId: params.taskId,
      content: params.content,
      files: params.files,
      metadata: params.metadata || {},
      usage: params.usage,
      createdAt: new Date(),
    };

    this.taskResults.set(params.taskId, result);
    return copy(result);
  }

  protected async _getTaskResult(taskId: string): Promise<TaskResult | null> {
    const result = this.taskResults.get(taskId);
    return result ? copy(result) : null;
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
