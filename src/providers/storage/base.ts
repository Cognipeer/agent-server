/**
 * Base Storage Provider - abstract class with common utilities
 */

import { nanoid } from "nanoid";
import { NotFoundError, StorageLimitError, ValidationError } from "../../types.js";
import { clampLimit } from "../../events.js";
import {
  MAX_BUFFER_BYTES,
  jsonClone,
  jsonCloneWithin,
  optional,
  reviveComments,
} from "./shared.js";
import type {
  StorageCapabilities,
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
  ConversationEvent,
  EventPage,
  EventStore,
  EventSummary,
  ListEventsParams,
  NewConversationEvent,
  AcquireLeaseParams,
  AcquireLeaseResult,
  RenewLeaseParams,
  ReleaseLeaseParams,
  ListExpiredLeasesParams,
  Lease,
} from "../../types.js";

/** The longest key / owner / event type / run id a provider is asked to store. */
export const MAX_KEY_LENGTH = 128;
const MAX_EVENT_BATCH = 1000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

/** What a provider's `_listEvents` is asked for (already clamped; `limit` includes one extra row for `hasMore`). */
export interface EventQuery {
  after: number;
  before?: number;
  types?: string[];
  limit: number;
  order: "asc" | "desc";
}

export type StoredEventInput = NewConversationEvent & { data: Record<string, unknown>; createdAt: Date };

/**
 * Abstract base class for storage providers
 * Provides common utilities and enforces interface contract
 *
 * Besides the connected check and id generation it makes every provider read
 * back the same record: JSON fields are cloned through JSON on the way in
 * (no `undefined`, `Date`s as ISO strings), `files: []` reads as `undefined`,
 * absent `userId` / `title` / `name` read as `undefined`, task comments come
 * back with `Date`s, and files / state over the provider's capabilities are
 * refused with a 413 `StorageLimitError`.
 */
export abstract class BaseStorageProvider implements StorageProvider {
  protected _connected = false;

  /**
   * What this provider can hold. The default says "bounded only by memory";
   * the built-in providers override it with their real limits.
   */
  capabilities(): StorageCapabilities {
    return {
      maxFileBytes: MAX_BUFFER_BYTES,
      maxStateBytes: Number.MAX_SAFE_INTEGER,
      atomicUpdate: false,
      events: false,
      leases: false,
    };
  }

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

  // Events and leases are optional. A provider that implements the hooks below gets the validated,
  // normalised public `events` / lease methods from this class and should report
  // `capabilities().events` / `.leases`.
  protected _appendEvents?(
    conversationId: string,
    events: StoredEventInput[],
    ctx?: RequestContext
  ): Promise<ConversationEvent[]>;
  protected _listEvents?(
    conversationId: string,
    query: EventQuery,
    ctx?: RequestContext
  ): Promise<ConversationEvent[]>;
  protected _eventSummaries?(
    conversationIds: string[],
    ctx?: RequestContext
  ): Promise<Record<string, EventSummary>>;
  protected _pruneEvents?(before: Date, ctx?: RequestContext): Promise<number>;

  protected _acquireLease?(
    params: AcquireLeaseParams & { now: Date; expiresAt: Date },
    ctx?: RequestContext
  ): Promise<AcquireLeaseResult>;
  protected _renewLease?(
    params: RenewLeaseParams & { now: Date; expiresAt: Date },
    ctx?: RequestContext
  ): Promise<Lease | null>;
  protected _releaseLease?(params: ReleaseLeaseParams, ctx?: RequestContext): Promise<boolean>;
  protected _getLeases?(keys: string[], now: Date, ctx?: RequestContext): Promise<Lease[]>;
  protected _markLeaseCancel?(key: string, now: Date, ctx?: RequestContext): Promise<boolean>;
  protected _listExpiredLeases?(
    params: { prefix?: string; limit: number; now: Date },
    ctx?: RequestContext
  ): Promise<Lease[]>;

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
    const clean: CreateConversationParams = {
      ...params,
      metadata: jsonClone(params.metadata),
      state: this.cleanState(params.state),
    };
    return normalizeConversation(await this._createConversation(id, clean, ctx));
  }

  async getConversation(id: string, ctx?: RequestContext): Promise<Conversation | null> {
    this.ensureConnected();
    const conversation = await this._getConversation(id, ctx);
    return conversation ? normalizeConversation(conversation) : null;
  }

  async getConversations(
    params: GetConversationsParams,
    ctx?: RequestContext
  ): Promise<PaginatedResult<Conversation>> {
    this.ensureConnected();
    const result = await this._getConversations(params, ctx);
    return { ...result, data: result.data.map(normalizeConversation) };
  }

  async updateConversation(
    id: string,
    params: UpdateConversationParams,
    ctx?: RequestContext
  ): Promise<Conversation> {
    this.ensureConnected();
    const clean: UpdateConversationParams = {
      ...params,
      metadata: jsonClone(params.metadata),
      state: this.cleanState(params.state),
    };
    return normalizeConversation(await this._updateConversation(id, clean, ctx));
  }

  async deleteConversation(id: string, ctx?: RequestContext): Promise<void> {
    this.ensureConnected();
    return this._deleteConversation(id, ctx);
  }

  async createMessage(params: CreateMessageParams, ctx?: RequestContext): Promise<Message> {
    this.ensureConnected();
    const id = this.generateId("msg");
    const clean: CreateMessageParams = {
      ...params,
      content: jsonClone(params.content),
      toolCalls: jsonClone(params.toolCalls),
      files: params.files?.length ? jsonClone(params.files) : undefined,
      metadata: jsonClone(params.metadata),
    };
    return normalizeMessage(await this._createMessage(id, clean, ctx));
  }

  async getMessages(
    conversationId: string,
    params?: GetMessagesParams,
    ctx?: RequestContext
  ): Promise<PaginatedResult<Message>> {
    this.ensureConnected();
    if (params?.before && params?.after) {
      throw new ValidationError("getMessages takes either `before` or `after`, not both");
    }
    const result = await this._getMessages(conversationId, params, ctx);
    return { ...result, data: result.data.map(normalizeMessage) };
  }

  async getMessage(id: string, ctx?: RequestContext): Promise<Message | null> {
    this.ensureConnected();
    const message = await this._getMessage(id, ctx);
    return message ? normalizeMessage(message) : null;
  }

  async deleteMessage(id: string, ctx?: RequestContext): Promise<void> {
    this.ensureConnected();
    return this._deleteMessage(id, ctx);
  }

  async saveFile(params: SaveFileParams, ctx?: RequestContext): Promise<FileRecord> {
    this.ensureConnected();
    const size = params.content.length;
    const { maxFileBytes } = this.capabilities();
    if (size > maxFileBytes) {
      throw new StorageLimitError(
        `The file is ${size} bytes, over the ${maxFileBytes} byte limit of this storage provider`,
        { bytes: size, maxBytes: maxFileBytes }
      );
    }
    // A file attached to a message belongs to that message's conversation, so it goes with it.
    let conversationId = params.conversationId;
    if (params.messageId) {
      const message = await this._getMessage(params.messageId, ctx);
      if (!message) throw new NotFoundError("Message", params.messageId);
      if (conversationId && conversationId !== message.conversationId) {
        throw new ValidationError("messageId belongs to another conversation than conversationId");
      }
      conversationId = message.conversationId;
    }
    const id = this.generateId("file");
    const storageKey = this.generateStorageKey(params.name);
    return normalizeFile(
      await this._saveFile(
        id,
        { ...params, conversationId, metadata: jsonClone(params.metadata), storageKey, size },
        ctx
      )
    );
  }

  async getFile(id: string, ctx?: RequestContext): Promise<FileRecord | null> {
    this.ensureConnected();
    const file = await this._getFile(id, ctx);
    return file ? normalizeFile(file) : null;
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
    const clean: CreateTaskParams = {
      ...params,
      files: params.files?.length ? jsonClone(params.files) : undefined,
      metadata: jsonClone(params.metadata),
    };
    return normalizeTask(await this._createTask(id, clean, ctx));
  }

  async getTask(id: string, ctx?: RequestContext): Promise<Task | null> {
    this.ensureConnected();
    const task = await this._getTask(id, ctx);
    return task ? normalizeTask(task) : null;
  }

  async getTasks(params: GetTasksParams, ctx?: RequestContext): Promise<PaginatedResult<Task>> {
    this.ensureConnected();
    const result = await this._getTasks(params, ctx);
    return { ...result, data: result.data.map(normalizeTask) };
  }

  async updateTask(id: string, params: UpdateTaskParams, ctx?: RequestContext): Promise<Task> {
    this.ensureConnected();
    const clean: UpdateTaskParams = {
      ...params,
      metadata: jsonClone(params.metadata),
      comments: jsonClone(params.comments),
    };
    return normalizeTask(await this._updateTask(id, clean, ctx));
  }

  async deleteTask(id: string, ctx?: RequestContext): Promise<void> {
    this.ensureConnected();
    return this._deleteTask(id, ctx);
  }

  /**
   * A task has at most one result: creating another replaces it (the
   * `waiting_for_input` cycle writes a partial result, then the final one).
   */
  async createTaskResult(params: CreateTaskResultParams, ctx?: RequestContext): Promise<TaskResult> {
    this.ensureConnected();
    const id = this.generateId("taskres");
    const clean: CreateTaskResultParams = {
      ...params,
      files: params.files?.length ? jsonClone(params.files) : undefined,
      metadata: jsonClone(params.metadata),
      usage: jsonClone(params.usage),
    };
    return normalizeTaskResult(await this._createTaskResult(id, clean, ctx));
  }

  async getTaskResult(taskId: string, ctx?: RequestContext): Promise<TaskResult | null> {
    this.ensureConnected();
    const result = await this._getTaskResult(taskId, ctx);
    return result ? normalizeTaskResult(result) : null;
  }

  // ============================================================================
  // Event log
  // ============================================================================

  private _eventStore?: EventStore;

  /** The event log, when the provider implements it. */
  get events(): EventStore | undefined {
    if (!this._appendEvents || !this._listEvents) return undefined;
    this._eventStore ??= {
      append: (conversationId, events, ctx) => this.appendEvents(conversationId, events, ctx),
      list: (conversationId, params, ctx) => this.listEvents(conversationId, params, ctx),
      summary: (ids, ctx) => this.eventSummaries(ids, ctx),
      prune: (before, ctx) => this.pruneEvents(before, ctx),
    };
    return this._eventStore;
  }

  private async appendEvents(
    conversationId: string,
    events: NewConversationEvent[],
    ctx?: RequestContext
  ): Promise<ConversationEvent[]> {
    this.ensureConnected();
    if (!Array.isArray(events) || events.length === 0) return [];
    if (events.length > MAX_EVENT_BATCH) {
      throw new ValidationError(`An append takes at most ${MAX_EVENT_BATCH} events`);
    }
    const now = new Date();
    const clean: StoredEventInput[] = events.map((event) => {
      if (typeof event?.type !== "string" || event.type.length === 0 || event.type.length > 64) {
        throw new ValidationError("An event type must be a string of 1 to 64 characters");
      }
      if (event.runId !== undefined && (typeof event.runId !== "string" || event.runId.length > 64)) {
        throw new ValidationError("An event runId must be a string of at most 64 characters");
      }
      const data = jsonClone(event.data ?? {});
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new ValidationError("An event data must be a JSON object");
      }
      return { type: event.type, data, runId: optional(event.runId), createdAt: now };
    });
    return (await this._appendEvents!(conversationId, clean, ctx)).map(normalizeEvent);
  }

  private async listEvents(
    conversationId: string,
    params: ListEventsParams = {},
    ctx?: RequestContext
  ): Promise<EventPage> {
    this.ensureConnected();
    const limit = clampLimit(params.limit);
    const after = Number.isFinite(params.after) && params.after! > 0 ? Math.floor(params.after!) : 0;
    const before = Number.isFinite(params.before) && params.before! > 0 ? Math.floor(params.before!) : undefined;
    const types = params.types?.filter((t) => typeof t === "string" && t.length > 0);
    const rows = await this._listEvents!(
      conversationId,
      {
        after,
        before,
        types: types?.length ? types : undefined,
        limit: limit + 1,
        order: params.order === "desc" ? "desc" : "asc",
      },
      ctx
    );
    const events = rows.slice(0, limit).map(normalizeEvent);
    return { events, hasMore: rows.length > limit, lastSeq: events.length > 0 ? events[events.length - 1]!.seq : after };
  }

  private async eventSummaries(
    conversationIds: string[],
    ctx?: RequestContext
  ): Promise<Record<string, EventSummary>> {
    this.ensureConnected();
    const ids = [...new Set(conversationIds)];
    if (ids.length === 0 || !this._eventSummaries) return {};
    return this._eventSummaries(ids, ctx);
  }

  private async pruneEvents(before: Date, ctx?: RequestContext): Promise<number> {
    this.ensureConnected();
    return this._pruneEvents ? this._pruneEvents(before, ctx) : 0;
  }

  // ============================================================================
  // Leases
  // ============================================================================

  private leaseUnsupported(): never {
    throw new Error("This storage provider does not support leases");
  }

  async acquireLease(params: AcquireLeaseParams, ctx?: RequestContext): Promise<AcquireLeaseResult> {
    this.ensureConnected();
    if (!this._acquireLease) this.leaseUnsupported();
    assertLeaseKey(params?.key, "key");
    assertLeaseKey(params?.owner, "owner");
    const ttl = assertLeaseTtl(params.ttlMs);
    const now = new Date();
    const result = await this._acquireLease!(
      { ...params, data: jsonClone(params.data), now, expiresAt: new Date(now.getTime() + ttl) },
      ctx
    );
    return result.acquired
      ? {
          acquired: true,
          lease: normalizeLease(result.lease),
          ...(result.takenOver ? { takenOver: normalizeLease(result.takenOver) } : {}),
        }
      : { acquired: false, lease: normalizeLease(result.lease) };
  }

  async renewLease(params: RenewLeaseParams, ctx?: RequestContext): Promise<Lease | null> {
    this.ensureConnected();
    if (!this._renewLease) this.leaseUnsupported();
    assertLeaseKey(params?.key, "key");
    assertLeaseKey(params?.owner, "owner");
    const ttl = assertLeaseTtl(params.ttlMs);
    const now = new Date();
    const lease = await this._renewLease!({ ...params, now, expiresAt: new Date(now.getTime() + ttl) }, ctx);
    return lease ? normalizeLease(lease) : null;
  }

  async releaseLease(params: ReleaseLeaseParams, ctx?: RequestContext): Promise<boolean> {
    this.ensureConnected();
    if (!this._releaseLease) this.leaseUnsupported();
    assertLeaseKey(params?.key, "key");
    assertLeaseKey(params?.owner, "owner");
    return this._releaseLease!(params, ctx);
  }

  async getLeases(keys: string[], ctx?: RequestContext): Promise<Lease[]> {
    this.ensureConnected();
    if (!this._getLeases) this.leaseUnsupported();
    const unique = [...new Set(keys)].filter((k) => typeof k === "string" && k.length > 0 && k.length <= MAX_KEY_LENGTH);
    if (unique.length === 0) return [];
    return (await this._getLeases!(unique, new Date(), ctx)).map(normalizeLease);
  }

  async markLeaseCancel(key: string, ctx?: RequestContext): Promise<boolean> {
    this.ensureConnected();
    if (!this._markLeaseCancel) this.leaseUnsupported();
    assertLeaseKey(key, "key");
    return this._markLeaseCancel!(key, new Date(), ctx);
  }

  async listExpiredLeases(params: ListExpiredLeasesParams = {}, ctx?: RequestContext): Promise<Lease[]> {
    this.ensureConnected();
    if (!this._listExpiredLeases) this.leaseUnsupported();
    const limit = params.limit && params.limit > 0 ? Math.min(Math.floor(params.limit), 1000) : 100;
    return (await this._listExpiredLeases!({ prefix: params.prefix, limit, now: new Date() }, ctx)).map(normalizeLease);
  }

  /** A conversation state as JSON, refused (413) when it is over what the provider holds. */
  private cleanState(state: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    return jsonCloneWithin(state, this.capabilities().maxStateBytes, "conversation state");
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

// ============================================================================
// Record normalisation (what every provider reads back)
// ============================================================================

function normalizeConversation(c: Conversation): Conversation {
  return {
    id: c.id,
    agentId: c.agentId,
    userId: optional(c.userId),
    title: optional(c.title),
    metadata: c.metadata ?? {},
    state: c.state ?? {},
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function normalizeMessage(m: Message): Message {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    name: optional(m.name),
    toolCalls: m.toolCalls ?? undefined,
    toolCallId: optional(m.toolCallId),
    files: m.files?.length ? m.files : undefined,
    metadata: m.metadata ?? {},
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function normalizeFile(f: FileRecord): FileRecord {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    storageKey: f.storageKey,
    conversationId: optional(f.conversationId),
    messageId: optional(f.messageId),
    metadata: f.metadata ?? {},
    createdAt: f.createdAt,
  };
}

function normalizeTask(t: Task): Task {
  return {
    id: t.id,
    agentId: t.agentId,
    userId: optional(t.userId),
    conversationId: optional(t.conversationId),
    status: t.status,
    callbackUrl: optional(t.callbackUrl),
    input: t.input,
    files: t.files?.length ? t.files : undefined,
    comments: reviveComments(t.comments),
    metadata: t.metadata ?? {},
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    startedAt: t.startedAt ?? undefined,
    completedAt: t.completedAt ?? undefined,
    error: optional(t.error),
  };
}

function normalizeTaskResult(r: TaskResult): TaskResult {
  return {
    id: r.id,
    taskId: r.taskId,
    content: r.content,
    files: r.files?.length ? r.files : undefined,
    metadata: r.metadata ?? {},
    usage: r.usage ?? undefined,
    createdAt: r.createdAt,
  };
}

function normalizeEvent(e: ConversationEvent): ConversationEvent {
  return {
    conversationId: e.conversationId,
    seq: Number(e.seq),
    type: e.type,
    data: e.data ?? {},
    runId: optional(e.runId),
    createdAt: new Date(e.createdAt),
  };
}

function normalizeLease(l: Lease): Lease {
  return {
    key: l.key,
    owner: l.owner,
    expiresAt: new Date(l.expiresAt),
    ...(l.data && Object.keys(l.data).length > 0 ? { data: l.data } : {}),
    ...(l.cancelRequested ? { cancelRequested: true } : {}),
  };
}

function assertLeaseKey(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`A lease ${field} must be a string of 1 to ${MAX_KEY_LENGTH} characters`);
  }
}

function assertLeaseTtl(ttlMs: unknown): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new ValidationError(`A lease ttlMs must be a number of milliseconds between 1 and ${MAX_LEASE_TTL_MS}`);
  }
  return Math.ceil(ttlMs);
}
