/**
 * In-Memory Storage Provider
 *
 * Lightweight storage provider for development and testing.
 * Data is stored in memory and will be lost when the process exits.
 *
 * Records are copied on the way in and out, so mutating a returned object never
 * changes what is stored.
 */

import { BaseStorageProvider, type EventQuery, type StoredEventInput } from "./base.js";
import { NotFoundError, StorageLimitError } from "../../types.js";
import { MemoryEventLog } from "../../events.js";
import { MAX_BUFFER_BYTES, buildSearchMatch, escapeRegex, messageSearchText, pageResult, searchTerm } from "./shared.js";
import type {
  AcquireLeaseParams,
  AcquireLeaseResult,
  ConversationEvent,
  EventSummary,
  Lease,
  ReleaseLeaseParams,
  RenewLeaseParams,
  RequestContext,
  Conversation,
  ConversationSearchMatch,
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
  UpdateMessageParams,
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
  private eventLog = new MemoryEventLog();
  private leases: Map<string, Lease> = new Map();

  constructor(config: InMemoryConfig = {}) {
    super();
    this.config = config;
  }

  capabilities(): StorageCapabilities {
    return {
      ...super.capabilities(),
      maxFileBytes: Math.min(this.config.maxFileStorage || DEFAULT_MAX_FILE_STORAGE, MAX_BUFFER_BYTES),
      atomicUpdate: true,
      events: true,
      leases: true,
      fileIndex: true,
      actionDeadlines: true,
      pinnedFirst: true,
      search: true,
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
    this.eventLog.clear();
    this.leases.clear();
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
      version: 0,
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
    if (params.actionDueBefore) {
      const before = params.actionDueBefore.getTime();
      conversations = conversations.filter((c) => c.actionDueAt !== undefined && c.actionDueAt.getTime() <= before);
    }

    // Search: the title or a user / assistant message contains the text; most recently updated first
    const needle = searchTerm(params.search);
    const matches = new Map<string, ConversationSearchMatch | undefined>();
    if (needle) {
      const found = new RegExp(escapeRegex(needle), "i");
      conversations = conversations.filter((c) => {
        const message = (this.messages.get(c.id) ?? []).find(
          (m) => (m.role === "user" || m.role === "assistant") && found.test(messageSearchText(m.content))
        );
        const inTitle = c.title !== undefined && found.test(c.title);
        if (!inTitle && !message) return false;
        matches.set(c.id, buildSearchMatch(c.title, needle, message));
        return true;
      });
    }

    // Sort: a search lists by last activity; the conversations whose actions lapsed first when asked for those, else by time
    if (needle) {
      this.sortByTime(conversations, (c) => c.updatedAt.getTime(), -1);
    } else if (params.actionDueBefore) {
      this.sortByTime(conversations, (c) => c.actionDueAt!.getTime(), 1);
    } else {
      const orderBy = params.orderBy === "updatedAt" ? "updatedAt" : "createdAt";
      this.sortByTime(conversations, (c) => c[orderBy].getTime(), params.order === "asc" ? 1 : -1);
      if (params.pinnedFirst) {
        // (a stable partition: each group keeps the order above)
        const pinned = conversations.filter((c) => c.metadata?.pinned === true);
        conversations = [...pinned, ...conversations.filter((c) => c.metadata?.pinned !== true)];
      }
    }

    const total = conversations.length;

    // Paginate
    const data = conversations
      .slice(normalized.offset, normalized.offset + normalized.limit)
      .map((c) => (matches.get(c.id) ? { ...copy(c), searchMatch: matches.get(c.id) } : copy(c)));

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
      actionDueAt:
        params.actionDueAt === undefined ? conversation.actionDueAt : params.actionDueAt === null ? undefined : params.actionDueAt,
      updatedAt: new Date(),
      version: (conversation.version ?? 0) + 1,
    };

    this.conversations.set(id, updated);
    return copy(updated);
  }

  protected async _updateConversationIf(
    id: string,
    ifVersion: number,
    params: UpdateConversationParams
  ): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new NotFoundError("Conversation", id);
    // (nothing awaits between the check and the write, so no other update can come in between)
    if ((conversation.version ?? 0) !== ifVersion) return null;
    return this._updateConversation(id, params);
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
    this.eventLog.deleteConversation(id);
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

  protected async _updateMessage(id: string, params: UpdateMessageParams): Promise<Message> {
    const conversationId = this.messageOwner.get(id);
    const message = conversationId ? this.messages.get(conversationId)?.find((m) => m.id === id) : undefined;
    if (!message) throw new NotFoundError("Message", id);
    if (params.content !== undefined) message.content = params.content;
    if (params.metadata !== undefined) message.metadata = params.metadata;
    message.updatedAt = new Date();
    return copy(message);
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
      userId: params.userId,
      agentId: params.agentId,
      expiresAt: params.expiresAt,
      metadata: params.metadata || {},
      createdAt: now,
    };

    this.files.set(id, file);
    this.seq(id);
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
    this.seqs.delete(id);
  }

  protected async _listFiles(params: {
    conversationId: string;
    limit: number;
    offset: number;
    order: "asc" | "desc";
  }): Promise<PaginatedResult<FileRecord>> {
    const rows = [...(this.conversationFiles.get(params.conversationId) ?? [])]
      .map((id) => this.files.get(id))
      .filter((file): file is FileRecord => !!file);
    // Oldest first, insertion order breaking ties between files saved in the same millisecond
    this.sortByTime(rows, (f) => f.createdAt.getTime(), params.order === "desc" ? -1 : 1);
    const data = rows.slice(params.offset, params.offset + params.limit).map(copy);
    return pageResult(data, rows.length, params.limit, params.offset);
  }

  protected async _purgeExpiredFiles(params: { before: Date; limit: number }): Promise<number> {
    const due = [...this.files.values()]
      .filter((file) => file.expiresAt && file.expiresAt.getTime() <= params.before.getTime())
      .sort(
        (a, b) =>
          a.expiresAt!.getTime() - b.expiresAt!.getTime() || (this.seqs.get(a.id) ?? 0) - (this.seqs.get(b.id) ?? 0)
      )
      .slice(0, params.limit);
    for (const file of due) this.removeFile(file.id);
    return due.length;
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
      conversationId: params.conversationId,
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
    if (params.conversationId) {
      tasks = tasks.filter((t) => t.conversationId === params.conversationId);
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
      conversationId: params.conversationId !== undefined ? params.conversationId : task.conversationId,
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
  // Events
  // ============================================================================

  protected async _appendEvents(
    conversationId: string,
    events: StoredEventInput[],
    ctx?: RequestContext
  ): Promise<ConversationEvent[]> {
    if (!this.conversations.has(conversationId)) throw new NotFoundError("Conversation", conversationId);
    return this.eventLog.append(conversationId, events, ctx);
  }

  protected async _listEvents(
    conversationId: string,
    query: EventQuery,
    ctx?: RequestContext
  ): Promise<ConversationEvent[]> {
    return (await this.eventLog.list(conversationId, query, ctx)).events;
  }

  protected async _eventSummaries(
    conversationIds: string[],
    ctx?: RequestContext
  ): Promise<Record<string, EventSummary>> {
    return this.eventLog.summary(conversationIds, ctx);
  }

  protected async _pruneEvents(before: Date, ctx?: RequestContext): Promise<number> {
    return this.eventLog.prune(before, ctx);
  }

  // ============================================================================
  // Leases
  // ============================================================================

  private copyLease(lease: Lease): Lease {
    return structuredClone(lease);
  }

  protected async _acquireLease(
    params: AcquireLeaseParams & { now: Date; expiresAt: Date }
  ): Promise<AcquireLeaseResult> {
    const current = this.leases.get(params.key);
    const live = current && current.expiresAt.getTime() > params.now.getTime();
    if (current && live && current.owner !== params.owner) {
      return { acquired: false, lease: this.copyLease(current) };
    }
    const lease: Lease = {
      key: params.key,
      owner: params.owner,
      expiresAt: params.expiresAt,
      data: params.data ?? {},
      cancelRequested: false,
    };
    this.leases.set(params.key, lease);
    // An expired lease is the residue of a holder that died
    const takenOver = current && !live ? this.copyLease(current) : undefined;
    return { acquired: true, lease: this.copyLease(lease), ...(takenOver ? { takenOver } : {}) };
  }

  protected async _renewLease(params: RenewLeaseParams & { now: Date; expiresAt: Date }): Promise<Lease | null> {
    const current = this.leases.get(params.key);
    if (!current || current.owner !== params.owner || current.expiresAt.getTime() <= params.now.getTime()) {
      return null;
    }
    current.expiresAt = params.expiresAt;
    return this.copyLease(current);
  }

  protected async _releaseLease(params: ReleaseLeaseParams): Promise<boolean> {
    const current = this.leases.get(params.key);
    if (!current || current.owner !== params.owner) return false;
    this.leases.delete(params.key);
    return true;
  }

  protected async _getLeases(keys: string[], now: Date): Promise<Lease[]> {
    return keys
      .map((key) => this.leases.get(key))
      .filter((lease): lease is Lease => !!lease && lease.expiresAt.getTime() > now.getTime())
      .map((lease) => this.copyLease(lease));
  }

  protected async _markLeaseCancel(key: string, now: Date): Promise<boolean> {
    const current = this.leases.get(key);
    if (!current || current.expiresAt.getTime() <= now.getTime()) return false;
    current.cancelRequested = true;
    return true;
  }

  protected async _listExpiredLeases(params: { prefix?: string; limit: number; now: Date }): Promise<Lease[]> {
    return [...this.leases.values()]
      .filter((l) => l.expiresAt.getTime() <= params.now.getTime() && (!params.prefix || l.key.startsWith(params.prefix)))
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.key.localeCompare(b.key))
      .slice(0, params.limit)
      .map((lease) => this.copyLease(lease));
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
