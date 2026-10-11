/**
 * MongoDB Storage Provider
 *
 * File content lives in GridFS (bucket `<prefix>files`), so a file is not bound
 * by the 16 MiB document limit; content written by older versions in the
 * `<prefix>file_contents` collection is still read. Conversation state stays
 * inside the conversation document and is therefore limited (`maxStateBytes`,
 * 12 MiB by default).
 */

import { BaseStorageProvider, type EventQuery, type StoredEventInput } from "./base.js";
import { NotFoundError, StorageLimitError } from "../../types.js";
import { nextStopReason } from "../../events.js";
import { MAX_BUFFER_BYTES, jsonBytes, nextSeq, pageResult, toBuffer } from "./shared.js";
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

// MongoDB types - we import dynamically to avoid requiring mongodb when not used
interface MongoClient {
  connect(): Promise<MongoClient>;
  close(): Promise<void>;
  db(name?: string): Db;
}

interface Db {
  collection<T = Document>(name: string): Collection<T>;
}

interface Collection<T = Document> {
  insertOne(doc: T): Promise<{ insertedId: unknown }>;
  insertMany(docs: T[], options?: object): Promise<{ insertedCount: number }>;
  findOne(filter: object, options?: object): Promise<T | null>;
  findOneAndUpdate(filter: object, update: object, options?: object): Promise<T | null>;
  find(filter: object, options?: object): FindCursor<T>;
  updateOne(
    filter: object,
    update: object,
    options?: object
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }>;
  updateMany(filter: object, update: object): Promise<{ matchedCount: number }>;
  deleteOne(filter: object): Promise<{ deletedCount: number }>;
  deleteMany(filter: object): Promise<{ deletedCount: number }>;
  countDocuments(filter?: object): Promise<number>;
  createIndex(keys: object, options?: object): Promise<string>;
  dropIndex(name: string): Promise<unknown>;
}

interface FindCursor<T> {
  sort(sort: object): FindCursor<T>;
  skip(n: number): FindCursor<T>;
  limit(n: number): FindCursor<T>;
  toArray(): Promise<T[]>;
}

interface Document {
  _id?: unknown;
  [key: string]: unknown;
}

interface GridFSBucket {
  openUploadStreamWithId(id: unknown, filename: string): NodeJS.WritableStream;
  openDownloadStream(id: unknown): AsyncIterable<Buffer>;
  find(filter: object): FindCursor<{ _id: unknown }>;
  delete(id: unknown): Promise<void>;
}

export interface MongoDBConfig {
  /**
   * Connection string (e.g., "mongodb://localhost:27017/mydb")
   */
  connectionString: string;

  /**
   * Database name (if not in connection string)
   */
  database?: string;

  /**
   * Collection prefix (default: "agent_server_")
   */
  collectionPrefix?: string;

  /**
   * Auto-create indexes on connect (default: true)
   */
  autoIndex?: boolean;

  /**
   * Largest conversation state, in bytes, the provider stores (default: 12 MiB). The
   * state lives in the conversation document, which MongoDB caps at 16 MiB; the server does
   * not pause a turn whose state would not fit. At most 15 MiB.
   */
  maxStateBytes?: number;
}

const DEFAULT_MAX_STATE_BYTES = 12 * 1024 * 1024;
/** A document is 16 MiB; the rest of a conversation (title, metadata, ...) needs room next to its state. */
const HARD_MAX_STATE_BYTES = 15 * 1024 * 1024;

/** Indexes made by older versions that a longer index with the same leading keys now covers. */
const SUPERSEDED_INDEXES: Record<"conversations" | "messages" | "tasks" | "files", string[]> = {
  conversations: ["agentId_1", "userId_1", "createdAt_-1"],
  messages: ["conversationId_1", "conversationId_1_createdAt_1"],
  tasks: ["agentId_1", "userId_1", "status_1", "createdAt_-1"],
  files: ["conversationId_1"],
};

export class MongoDBStorageProvider extends BaseStorageProvider {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private bucket: GridFSBucket | null = null;
  private bsonSize: (doc: object) => number = jsonBytes;
  private config: MongoDBConfig;
  private collectionPrefix: string;
  private maxStateBytes: number;

  constructor(config: MongoDBConfig) {
    super();
    this.config = config;
    this.collectionPrefix = config.collectionPrefix || "agent_server_";
    this.maxStateBytes = config.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
  }

  capabilities(): StorageCapabilities {
    return {
      ...super.capabilities(),
      // GridFS: bounded only by what one Buffer can hold
      maxFileBytes: MAX_BUFFER_BYTES,
      maxStateBytes: this.maxStateBytes,
      atomicUpdate: true,
      events: true,
      leases: true,
      fileIndex: true,
      actionDeadlines: true,
    };
  }

  // ============================================================================
  // Collection names
  // ============================================================================

  private get collections() {
    return {
      conversations: `${this.collectionPrefix}conversations`,
      messages: `${this.collectionPrefix}messages`,
      files: `${this.collectionPrefix}files`,
      /** Legacy content store (pre-GridFS); still read, no longer written. */
      fileContents: `${this.collectionPrefix}file_contents`,
      tasks: `${this.collectionPrefix}tasks`,
      taskResults: `${this.collectionPrefix}task_results`,
      events: `${this.collectionPrefix}events`,
      eventStreams: `${this.collectionPrefix}event_streams`,
      leases: `${this.collectionPrefix}leases`,
    };
  }

  /** GridFS bucket name. Its collections are `<bucket>.files` and `<bucket>.chunks`, apart from `<prefix>files`. */
  private get bucketName(): string {
    return `${this.collectionPrefix}files`;
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    if (this._connected) return;

    let client: MongoClient | null = null;
    try {
      if (!Number.isInteger(this.maxStateBytes) || this.maxStateBytes < 1 || this.maxStateBytes > HARD_MAX_STATE_BYTES) {
        throw new Error(
          `maxStateBytes must be an integer between 1 and ${HARD_MAX_STATE_BYTES} (a MongoDB document is limited to 16 MiB)`
        );
      }

      // Dynamic import of mongodb
      const mongodb = (await import("mongodb" as any)) as any;
      const MongoClientClass = mongodb.MongoClient;

      // undefined fields are left out (not stored as null); binary comes back as Buffer
      client = new MongoClientClass(this.config.connectionString, {
        ignoreUndefined: true,
        promoteBuffers: true,
      }) as MongoClient;
      await client.connect();
      this.client = client;

      // Get database
      const dbName = this.config.database;
      this.db = dbName ? client.db(dbName) : client.db();
      this.bucket = new mongodb.GridFSBucket(this.db, { bucketName: this.bucketName }) as GridFSBucket;
      const calculate = (mongodb.BSON ?? mongodb).calculateObjectSize as ((doc: object) => number) | undefined;
      if (calculate) this.bsonSize = calculate;

      // Create indexes if enabled
      if (this.config.autoIndex !== false) {
        await this.createIndexes();
      }

      this._connected = true;
    } catch (error) {
      await client?.close().catch(() => undefined);
      this.client = null;
      this.db = null;
      this.bucket = null;
      throw new Error(`Failed to connect to MongoDB: ${(error as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.bucket = null;
    }
    this._connected = false;
  }

  private async createIndexes(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Lists are ordered by time with the insertion sequence breaking ties, so the sort keys are indexed together.
    const conversations = this.db.collection(this.collections.conversations);
    await conversations.createIndex({ agentId: 1, createdAt: -1, seq: -1 });
    await conversations.createIndex({ userId: 1, createdAt: -1, seq: -1 });
    await conversations.createIndex({ createdAt: -1, seq: -1 });
    await conversations.createIndex({ updatedAt: -1, seq: -1 });
    // The expiry sweep only looks at conversations that wait on an action with a deadline
    await conversations.createIndex({ actionDueAt: 1 }, { partialFilterExpression: { actionDueAt: { $type: "date" } } });

    const messages = this.db.collection(this.collections.messages);
    await messages.createIndex({ conversationId: 1, createdAt: 1, seq: 1 });

    const files = this.db.collection(this.collections.files);
    await files.createIndex({ conversationId: 1, createdAt: 1, seq: 1 });
    await files.createIndex({ messageId: 1 });
    // The retention sweep only looks at files that expire
    await files.createIndex({ expiresAt: 1 }, { partialFilterExpression: { expiresAt: { $type: "date" } } });
    await files.createIndex({ storageKey: 1 }, { unique: true });

    const tasks = this.db.collection(this.collections.tasks);
    await tasks.createIndex({ agentId: 1, createdAt: -1, seq: -1 });
    await tasks.createIndex({ userId: 1, createdAt: -1, seq: -1 });
    await tasks.createIndex({ status: 1, createdAt: -1, seq: -1 });
    await tasks.createIndex({ createdAt: -1, seq: -1 });

    await tasks.createIndex({ conversationId: 1 });

    const taskResults = this.db.collection(this.collections.taskResults);
    await taskResults.createIndex({ taskId: 1 }, { unique: true });

    // The event log: (conversationId, seq) is the identity; createdAt serves pruning
    const events = this.db.collection(this.collections.events);
    await events.createIndex({ conversationId: 1, seq: 1 }, { unique: true });
    await events.createIndex({ createdAt: 1 });
    const leases = this.db.collection(this.collections.leases);
    await leases.createIndex({ expiresAt: 1 });

    // The indexes above cover these older, shorter ones; keeping both only slows writes.
    for (const [collection, names] of Object.entries(SUPERSEDED_INDEXES) as Array<
      [keyof typeof SUPERSEDED_INDEXES, string[]]
    >) {
      for (const name of names) {
        await this.db
          .collection(this.collections[collection])
          .dropIndex(name)
          .catch((error: { code?: number }) => {
            // 27 IndexNotFound, 26 NamespaceNotFound: nothing to drop
            if (error?.code !== 27 && error?.code !== 26) throw error;
          });
      }
    }
  }

  /**
   * Turns the driver's "document too large" failures into the typed 413. Past the limit the
   * driver fails in its own serializer (a RangeError about a buffer offset); just under it the
   * server answers BSONObjectTooLarge / "object to insert too large".
   */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const failure = error as { code?: number | string; message?: string };
      const message = failure?.message ?? "";
      if (
        failure?.code === 10334 ||
        (failure?.code === "ERR_OUT_OF_RANGE" && /offset/.test(message)) ||
        /BSONObj size|too large|exceeds maximum/i.test(message)
      ) {
        throw new StorageLimitError("The record is too large to store in one MongoDB document (16 MiB)");
      }
      throw error;
    }
  }

  private assertStateFits(state: Record<string, unknown> | undefined): void {
    if (state === undefined) return;
    const bytes = this.bsonSize({ state });
    if (bytes > this.maxStateBytes) {
      throw new StorageLimitError(
        `The conversation state is ${bytes} bytes, over the ${this.maxStateBytes} byte limit of this MongoDB provider`,
        { bytes, maxBytes: this.maxStateBytes }
      );
    }
  }

  // ============================================================================
  // Conversations
  // ============================================================================

  protected async _createConversation(
    id: string,
    params: CreateConversationParams
  ): Promise<Conversation> {
    if (!this.db) throw new Error("Database not initialized");
    this.assertStateFits(params.state);

    const now = new Date();
    const doc: MongoConversation = {
      _id: id,
      agentId: params.agentId,
      userId: params.userId || null,
      title: params.title || null,
      metadata: params.metadata || {},
      state: params.state || {},
      createdAt: now,
      updatedAt: now,
      version: 0,
      seq: nextSeq(),
    };

    await this.guarded(() =>
      this.db!.collection<MongoConversation>(this.collections.conversations).insertOne(doc)
    );

    return this.mapConversation(doc);
  }

  protected async _getConversation(id: string): Promise<Conversation | null> {
    if (!this.db) throw new Error("Database not initialized");

    const doc = await this.db
      .collection<MongoConversation>(this.collections.conversations)
      .findOne({ _id: id });

    return doc ? this.mapConversation(doc) : null;
  }

  protected async _getConversations(
    params: GetConversationsParams
  ): Promise<PaginatedResult<Conversation>> {
    if (!this.db) throw new Error("Database not initialized");

    const normalized = this.normalizeParams(params, { limit: 20, offset: 0 });
    const orderBy = params.orderBy === "updatedAt" ? "updatedAt" : "createdAt";
    const order = params.order === "asc" ? 1 : -1;

    const filter: Record<string, unknown> = {};
    if (params.agentId) filter.agentId = params.agentId;
    if (params.userId) filter.userId = params.userId;
    if (params.actionDueBefore) filter.actionDueAt = { $type: "date", $lte: params.actionDueBefore };

    const collection = this.db.collection<MongoConversation>(this.collections.conversations);

    // Get total count
    const total = await collection.countDocuments(filter);

    // Get paginated results
    const docs = await collection
      .find(filter)
      .sort(params.actionDueBefore ? { actionDueAt: 1, seq: 1 } : { [orderBy]: order, seq: order })
      .skip(normalized.offset)
      .limit(normalized.limit)
      .toArray();

    return pageResult(
      docs.map((doc) => this.mapConversation(doc)),
      total,
      normalized.limit,
      normalized.offset
    );
  }

  protected async _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    if (!this.db) throw new Error("Database not initialized");
    this.assertStateFits(params.state);

    const result = await this.guarded(() =>
      this.db!.collection<MongoConversation>(this.collections.conversations).updateOne(
        { _id: id },
        this.conversationUpdate(params)
      )
    );

    if (result.matchedCount === 0) {
      throw new NotFoundError("Conversation", id);
    }

    const updated = await this._getConversation(id);
    if (!updated) throw new NotFoundError("Conversation", id);
    return updated;
  }

  /** The update document of a conversation update (every update bumps `version`). */
  private conversationUpdate(params: UpdateConversationParams): Record<string, unknown> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (params.title !== undefined) set.title = params.title;
    if (params.metadata !== undefined) set.metadata = params.metadata;
    if (params.state !== undefined) set.state = params.state;
    const update: Record<string, unknown> = { $inc: { version: 1 } };
    if (params.actionDueAt instanceof Date) set.actionDueAt = params.actionDueAt;
    else if (params.actionDueAt === null) update.$unset = { actionDueAt: "" };
    update.$set = set;
    return update;
  }

  protected async _updateConversationIf(
    id: string,
    ifVersion: number,
    params: UpdateConversationParams
  ): Promise<Conversation | null> {
    if (!this.db) throw new Error("Database not initialized");
    this.assertStateFits(params.state);

    // A conversation written before versions existed has none: that is version 0
    const versionIs = ifVersion === 0 ? { $or: [{ version: 0 }, { version: { $exists: false } }] } : { version: ifVersion };
    const collection = this.db.collection<MongoConversation>(this.collections.conversations);
    const doc = await this.guarded(() =>
      collection.findOneAndUpdate({ _id: id, ...versionIs }, this.conversationUpdate(params), { returnDocument: "after" })
    );
    if (doc) return this.mapConversation(doc);
    if (!(await collection.findOne({ _id: id }, { projection: { _id: 1 } }))) throw new NotFoundError("Conversation", id);
    return null;
  }

  protected async _deleteConversation(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Its files first (content, then records), the conversation last: a failure part-way leaves
    // a conversation that can simply be deleted again.
    const files = this.db.collection<MongoFile>(this.collections.files);
    const owned = await files.find({ conversationId: id }, { projection: { storageKey: 1 } }).toArray();
    for (let i = 0; i < owned.length; i += 8) {
      await Promise.all(owned.slice(i, i + 8).map((file) => this.removeBlob(file.storageKey)));
    }
    await files.deleteMany({ conversationId: id });

    await this.db
      .collection<MongoMessage>(this.collections.messages)
      .deleteMany({ conversationId: id });

    await this.db.collection(this.collections.events).deleteMany({ conversationId: id });
    await this.db.collection(this.collections.eventStreams).deleteOne({ _id: id });

    await this.db
      .collection<MongoConversation>(this.collections.conversations)
      .deleteOne({ _id: id });
  }

  // ============================================================================
  // Messages
  // ============================================================================

  protected async _createMessage(id: string, params: CreateMessageParams): Promise<Message> {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date();

    // A new message is activity on the conversation; no match = no such conversation, nothing is stored
    const touched = await this.db
      .collection<MongoConversation>(this.collections.conversations)
      .updateOne({ _id: params.conversationId }, { $set: { updatedAt: now } });
    if (touched.matchedCount === 0) throw new NotFoundError("Conversation", params.conversationId);

    const doc: MongoMessage = {
      _id: id,
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      name: params.name || null,
      toolCalls: params.toolCalls || null,
      toolCallId: params.toolCallId || null,
      files: params.files || [],
      metadata: params.metadata || {},
      createdAt: now,
      updatedAt: now,
      seq: nextSeq(),
    };

    await this.guarded(() =>
      this.db!.collection<MongoMessage>(this.collections.messages).insertOne(doc)
    );

    return this.mapMessage(doc);
  }

  protected async _getMessages(
    conversationId: string,
    params?: GetMessagesParams
  ): Promise<PaginatedResult<Message>> {
    if (!this.db) throw new Error("Database not initialized");

    const normalized = this.normalizeParams(params || {}, { limit: 100, offset: 0 });
    const order = params?.order === "desc" ? -1 : 1;

    const collection = this.db.collection<MongoMessage>(this.collections.messages);

    // Only messages older / newer than the cursor message, by (createdAt, insertion sequence)
    const filter: Record<string, unknown> = { conversationId };
    const cursor = params?.before ?? params?.after;
    if (cursor) {
      const at = await collection.findOne(
        { _id: cursor, conversationId },
        { projection: { createdAt: 1, seq: 1 } }
      );
      if (!at) throw new NotFoundError("Message", cursor);
      const op = params?.before ? "$lt" : "$gt";
      filter.$or = [
        { createdAt: { [op]: at.createdAt } },
        { createdAt: at.createdAt, seq: { [op]: at.seq ?? 0 } },
      ];
    }

    // Get total count
    const total = await collection.countDocuments(filter);

    // Get paginated results
    const docs = await collection
      .find(filter)
      .sort({ createdAt: order, seq: order })
      .skip(normalized.offset)
      .limit(normalized.limit)
      .toArray();

    return pageResult(
      docs.map((doc) => this.mapMessage(doc)),
      total,
      normalized.limit,
      normalized.offset
    );
  }

  protected async _getMessage(id: string): Promise<Message | null> {
    if (!this.db) throw new Error("Database not initialized");

    const doc = await this.db
      .collection<MongoMessage>(this.collections.messages)
      .findOne({ _id: id });

    return doc ? this.mapMessage(doc) : null;
  }

  protected async _updateMessage(id: string, params: UpdateMessageParams): Promise<Message> {
    if (!this.db) throw new Error("Database not initialized");
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (params.content !== undefined) set.content = params.content;
    if (params.metadata !== undefined) set.metadata = params.metadata;
    const collection = this.db.collection<MongoMessage>(this.collections.messages);
    const result = await this.guarded(() => collection.updateOne({ _id: id }, { $set: set }));
    if (result.matchedCount === 0) throw new NotFoundError("Message", id);
    const doc = await collection.findOne({ _id: id });
    if (!doc) throw new NotFoundError("Message", id);
    return this.mapMessage(doc);
  }

  protected async _deleteMessage(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    await this.db.collection<MongoMessage>(this.collections.messages).deleteOne({ _id: id });
    // Its files stay with the conversation, just no longer on a message
    await this.db
      .collection<MongoFile>(this.collections.files)
      .updateMany({ messageId: id }, { $set: { messageId: null } });
  }

  // ============================================================================
  // Files
  // ============================================================================

  protected async _saveFile(
    id: string,
    params: SaveFileParams & { storageKey: string; size: number }
  ): Promise<FileRecord> {
    if (!this.db) throw new Error("Database not initialized");

    if (params.conversationId) {
      const found = await this.db
        .collection<MongoConversation>(this.collections.conversations)
        .findOne({ _id: params.conversationId }, { projection: { _id: 1 } });
      if (!found) throw new NotFoundError("Conversation", params.conversationId);
    }

    // Content first, then the record that points at it. A refused record takes its content back
    // out, so a failed save leaves no orphan blob behind.
    try {
      await this.putBlob(params.storageKey, params.name, params.content);
    } catch (error) {
      // A failure part-way through leaves chunks under this id without a file document; they are deleted by id
      // (deleting what was never completed is a no-op)
      await this.removeBlob(params.storageKey).catch(() => undefined);
      throw error;
    }
    try {
      const now = new Date();
      const doc: MongoFile = {
        _id: id,
        name: params.name,
        mimeType: params.mimeType,
        size: params.size,
        storageKey: params.storageKey,
        conversationId: params.conversationId || null,
        messageId: params.messageId || null,
        userId: params.userId || null,
        agentId: params.agentId || null,
        expiresAt: params.expiresAt ?? null,
        metadata: params.metadata || {},
        createdAt: now,
        seq: nextSeq(),
      };
      await this.db.collection<MongoFile>(this.collections.files).insertOne(doc);
      return this.mapFile(doc);
    } catch (error) {
      await this.removeBlob(params.storageKey).catch(() => undefined);
      throw error;
    }
  }

  protected async _getFile(id: string): Promise<FileRecord | null> {
    if (!this.db) throw new Error("Database not initialized");

    const doc = await this.db.collection<MongoFile>(this.collections.files).findOne({ _id: id });

    return doc ? this.mapFile(doc) : null;
  }

  protected async _getFileContent(id: string): Promise<Buffer | null> {
    if (!this.db) throw new Error("Database not initialized");

    // First get the storage key
    const file = await this.db
      .collection<MongoFile>(this.collections.files)
      .findOne({ _id: id }, { projection: { storageKey: 1 } });

    if (!file) return null;

    return this.getBlob(file.storageKey);
  }

  protected async _deleteFile(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Get storage key first
    const file = await this.db
      .collection<MongoFile>(this.collections.files)
      .findOne({ _id: id }, { projection: { storageKey: 1 } });

    if (file) {
      // Content first: a failure part-way leaves a record that can be deleted again
      await this.removeBlob(file.storageKey);
      await this.db.collection<MongoFile>(this.collections.files).deleteOne({ _id: id });
    }
  }

  protected async _listFiles(params: {
    conversationId: string;
    limit: number;
    offset: number;
    order: "asc" | "desc";
  }): Promise<PaginatedResult<FileRecord>> {
    if (!this.db) throw new Error("Database not initialized");
    const collection = this.db.collection<MongoFile>(this.collections.files);
    const filter = { conversationId: params.conversationId };
    const order = params.order === "desc" ? -1 : 1;

    const total = await collection.countDocuments(filter);
    const docs = await collection
      .find(filter)
      .sort({ createdAt: order, seq: order })
      .skip(params.offset)
      .limit(params.limit)
      .toArray();
    return pageResult(docs.map((doc) => this.mapFile(doc)), total, params.limit, params.offset);
  }

  protected async _purgeExpiredFiles(params: { before: Date; limit: number }): Promise<number> {
    if (!this.db) throw new Error("Database not initialized");
    const collection = this.db.collection<MongoFile>(this.collections.files);

    const due = await collection
      .find({ expiresAt: { $lte: params.before } }, { projection: { storageKey: 1 } })
      .sort({ expiresAt: 1 })
      .limit(params.limit)
      .toArray();
    let purged = 0;
    for (const file of due) {
      // Content first: a failure part-way leaves a record that is purged again by the next sweep.
      // Another node purging the same file is harmless: deleting what is gone is a no-op.
      await this.removeBlob(file.storageKey);
      const { deletedCount } = await collection.deleteOne({ _id: file._id });
      purged += deletedCount;
    }
    return purged;
  }

  // ---- file content (GridFS, with a read fallback to the legacy collection) ----

  private async putBlob(storageKey: string, filename: string, content: Buffer): Promise<void> {
    if (!this.bucket) throw new Error("Database not initialized");
    const stream = this.bucket.openUploadStreamWithId(storageKey, filename);
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.once("finish", () => resolve());
      stream.end(content);
    });
  }

  private async getBlob(storageKey: string): Promise<Buffer | null> {
    if (!this.bucket || !this.db) throw new Error("Database not initialized");

    const stored = await this.bucket.find({ _id: storageKey }).limit(1).toArray();
    if (stored.length > 0) {
      const chunks: Buffer[] = [];
      for await (const chunk of this.bucket.openDownloadStream(storageKey)) chunks.push(chunk);
      return Buffer.concat(chunks);
    }

    // Written before GridFS: the whole file in one document
    const legacy = await this.db
      .collection<MongoFileContent>(this.collections.fileContents)
      .findOne({ _id: storageKey });
    return legacy ? toBuffer(legacy.content) : null;
  }

  private async removeBlob(storageKey: string): Promise<void> {
    if (!this.bucket || !this.db) throw new Error("Database not initialized");

    await this.bucket.delete(storageKey).catch((error: Error) => {
      // Already gone (or never in GridFS): nothing to delete. Driver 6 says "FileNotFound: file <id>
      // was not found", driver 7 "File not found for id <id>".
      if (!/FileNotFound|File not found|was not found/i.test(`${error?.name} ${error?.message}`)) throw error;
    });
    await this.db
      .collection<MongoFileContent>(this.collections.fileContents)
      .deleteOne({ _id: storageKey });
  }

  // ============================================================================
  // Tasks
  // ============================================================================

  protected async _createTask(
    id: string,
    params: CreateTaskParams
  ): Promise<Task> {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date();
    const doc: MongoTask = {
      _id: id,
      agentId: params.agentId,
      userId: params.userId || null,
      conversationId: params.conversationId || null,
      status: "pending",
      callbackUrl: params.callbackUrl || null,
      input: params.input,
      files: params.files || [],
      comments: [],
      metadata: params.metadata || {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      error: null,
      seq: nextSeq(),
    };

    await this.guarded(() => this.db!.collection<MongoTask>(this.collections.tasks).insertOne(doc));
    return this.mapTask(doc);
  }

  protected async _getTask(id: string): Promise<Task | null> {
    if (!this.db) throw new Error("Database not initialized");

    const doc = await this.db
      .collection<MongoTask>(this.collections.tasks)
      .findOne({ _id: id });

    return doc ? this.mapTask(doc) : null;
  }

  protected async _getTasks(
    params: GetTasksParams
  ): Promise<PaginatedResult<Task>> {
    if (!this.db) throw new Error("Database not initialized");

    const normalized = this.normalizeParams(params, { limit: 20, offset: 0 });

    // Build filter
    const filter: Record<string, unknown> = {};
    if (params.agentId) filter.agentId = params.agentId;
    if (params.userId) filter.userId = params.userId;
    if (params.status) filter.status = params.status;
    if (params.conversationId) filter.conversationId = params.conversationId;

    // Get total count
    const total = await this.db
      .collection<MongoTask>(this.collections.tasks)
      .countDocuments(filter);

    // Get paginated data
    const orderBy = params.orderBy === "updatedAt" ? "updatedAt" : "createdAt";
    const order = params.order === "asc" ? 1 : -1;

    const docs = await this.db
      .collection<MongoTask>(this.collections.tasks)
      .find(filter)
      .sort({ [orderBy]: order, seq: order })
      .skip(normalized.offset)
      .limit(normalized.limit)
      .toArray();

    return pageResult(
      docs.map((doc) => this.mapTask(doc)),
      total,
      normalized.limit,
      normalized.offset
    );
  }

  protected async _updateTask(
    id: string,
    params: UpdateTaskParams
  ): Promise<Task> {
    if (!this.db) throw new Error("Database not initialized");

    const update: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (params.status !== undefined) update.status = params.status;
    if (params.conversationId !== undefined) update.conversationId = params.conversationId;
    if (params.startedAt !== undefined) update.startedAt = params.startedAt;
    if (params.completedAt !== undefined) update.completedAt = params.completedAt;
    if (params.error !== undefined) update.error = params.error;
    if (params.metadata !== undefined) update.metadata = params.metadata;
    if (params.comments !== undefined) update.comments = params.comments;

    const result = await this.guarded(() =>
      this.db!.collection<MongoTask>(this.collections.tasks).updateOne({ _id: id }, { $set: update })
    );

    // matchedCount: an update that changes nothing still found the task
    if (result.matchedCount === 0) {
      throw new NotFoundError("Task", id);
    }

    const doc = await this.db
      .collection<MongoTask>(this.collections.tasks)
      .findOne({ _id: id });

    if (!doc) throw new NotFoundError("Task", id);

    return this.mapTask(doc);
  }

  protected async _deleteTask(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Delete task result first
    await this.db
      .collection<MongoTaskResult>(this.collections.taskResults)
      .deleteOne({ taskId: id });

    // Delete task
    await this.db.collection<MongoTask>(this.collections.tasks).deleteOne({ _id: id });
  }

  // ============================================================================
  // Task Results
  // ============================================================================

  protected async _createTaskResult(
    id: string,
    params: CreateTaskResultParams
  ): Promise<TaskResult> {
    if (!this.db) throw new Error("Database not initialized");

    const task = await this.db
      .collection<MongoTask>(this.collections.tasks)
      .findOne({ _id: params.taskId }, { projection: { _id: 1 } });
    if (!task) throw new NotFoundError("Task", params.taskId);

    // One result per task: a second one replaces the first (and keeps its id)
    const results = this.db.collection<MongoTaskResult>(this.collections.taskResults);
    const replace = () =>
      results.updateOne(
        { taskId: params.taskId },
        {
          $set: {
            content: params.content,
            files: params.files || [],
            metadata: params.metadata || {},
            usage: params.usage || null,
            createdAt: new Date(),
          },
          $setOnInsert: { _id: id },
        },
        { upsert: true }
      );
    try {
      await this.guarded(replace);
    } catch (error) {
      // Two writers upserting the same task at once: the loser retries as a plain update
      if ((error as { code?: number }).code !== 11000) throw error;
      await this.guarded(replace);
    }

    const doc = await results.findOne({ taskId: params.taskId });
    if (!doc) throw new NotFoundError("Task", params.taskId);
    return this.mapTaskResult(doc);
  }

  protected async _getTaskResult(taskId: string): Promise<TaskResult | null> {
    if (!this.db) throw new Error("Database not initialized");

    const doc = await this.db
      .collection<MongoTaskResult>(this.collections.taskResults)
      .findOne({ taskId });

    return doc ? this.mapTaskResult(doc) : null;
  }

  // ============================================================================
  // Events
  // ============================================================================

  protected async _appendEvents(
    conversationId: string,
    events: StoredEventInput[]
  ): Promise<ConversationEvent[]> {
    if (!this.db) throw new Error("Database not initialized");

    const exists = await this.db
      .collection<MongoConversation>(this.collections.conversations)
      .findOne({ _id: conversationId }, { projection: { _id: 1 } });
    if (!exists) throw new NotFoundError("Conversation", conversationId);

    // The counter document hands out the sequence numbers atomically: a run of numbers is reserved
    // with one $inc, so two appenders never get the same one, and the unique index backs that up.
    const streams = this.db.collection<MongoEventStream>(this.collections.eventStreams);
    const reserved = await streams.findOneAndUpdate(
      { _id: conversationId },
      {
        $inc: { lastSeq: events.length },
        $set: { updatedAt: events[events.length - 1]!.createdAt },
        // (nothing is stored yet for a stream that starts now)
        $setOnInsert: { committedSeq: 0 },
      },
      { upsert: true, returnDocument: "after" }
    );
    if (!reserved) throw new Error("The event counter could not be reserved");
    const first = reserved.lastSeq - events.length + 1;

    const docs: MongoEvent[] = events.map((event, i) => ({
      conversationId,
      seq: first + i,
      type: event.type,
      data: event.data,
      runId: event.runId ?? null,
      createdAt: event.createdAt,
    }));
    await this.guarded(() => this.db!.collection<MongoEvent>(this.collections.events).insertMany(docs));

    // The events are stored now: `committedSeq` moves up to them (the reservation above ran ahead of the insert, and a reader of the
    // summary must not be told about a number whose event is not there yet). What the last finished turn stopped for goes with it;
    // the appender of a conversation is its run, so no race there.
    const stopReason = nextStopReason(reserved.stopReason, events) ?? null;
    await streams.updateOne(
      { _id: conversationId },
      {
        $max: { committedSeq: first + events.length - 1 },
        ...(stopReason !== (reserved.stopReason ?? null) ? { $set: { stopReason } } : {}),
      }
    );

    return docs.map((doc) => this.mapEvent(doc));
  }

  protected async _listEvents(conversationId: string, query: EventQuery): Promise<ConversationEvent[]> {
    if (!this.db) throw new Error("Database not initialized");

    const seq: Record<string, number> = { $gt: query.after };
    if (query.before !== undefined) seq.$lt = query.before;
    const filter: Record<string, unknown> = { conversationId, seq };
    if (query.types?.length) filter.type = { $in: query.types };

    const docs = await this.db
      .collection<MongoEvent>(this.collections.events)
      .find(filter)
      .sort({ seq: query.order === "desc" ? -1 : 1 })
      .limit(query.limit)
      .toArray();
    return docs.map((doc) => this.mapEvent(doc));
  }

  protected async _eventSummaries(conversationIds: string[]): Promise<Record<string, EventSummary>> {
    if (!this.db) throw new Error("Database not initialized");
    const docs = await this.db
      .collection<MongoEventStream>(this.collections.eventStreams)
      .find({ _id: { $in: conversationIds } })
      .toArray();
    const out: Record<string, EventSummary> = {};
    for (const doc of docs) {
      // (the newest STORED event: `lastSeq` counts the numbers handed out, which can be ahead for the length of an insert, and for good
      // after one that failed; a stream written before `committedSeq` existed has only `lastSeq`)
      const lastSeq = doc.committedSeq ?? doc.lastSeq;
      if (lastSeq === 0 && !doc.stopReason) continue; // (reserved, not stored yet: nothing to report)
      out[doc._id] = { lastSeq, ...(doc.stopReason ? { stopReason: doc.stopReason } : {}) };
    }
    return out;
  }

  protected async _pruneEvents(before: Date): Promise<number> {
    if (!this.db) throw new Error("Database not initialized");
    const result = await this.db.collection<MongoEvent>(this.collections.events).deleteMany({ createdAt: { $lt: before } });
    return result.deletedCount;
  }

  private mapEvent(doc: MongoEvent): ConversationEvent {
    return {
      conversationId: doc.conversationId,
      seq: doc.seq,
      type: doc.type,
      data: doc.data,
      runId: doc.runId || undefined,
      createdAt: doc.createdAt,
    };
  }

  // ============================================================================
  // Leases
  // ============================================================================

  private mapLease(doc: MongoLease): Lease {
    return {
      key: doc._id,
      owner: doc.owner,
      expiresAt: doc.expiresAt,
      data: doc.data ?? {},
      cancelRequested: doc.cancelRequested === true,
    };
  }

  protected async _acquireLease(
    params: AcquireLeaseParams & { now: Date; expiresAt: Date },
    _ctx?: RequestContext
  ): Promise<AcquireLeaseResult> {
    if (!this.db) throw new Error("Database not initialized");
    const leases = this.db.collection<MongoLease>(this.collections.leases);

    // Takes the lease when it is free, expired, or already ours. The upsert of a key somebody else
    // holds would insert a second document with the same _id: the duplicate-key error is the "held" answer.
    let previous: MongoLease | null;
    try {
      previous = await leases.findOneAndUpdate(
        { _id: params.key, $or: [{ expiresAt: { $lte: params.now } }, { owner: params.owner }] },
        {
          $set: {
            owner: params.owner,
            expiresAt: params.expiresAt,
            data: params.data ?? {},
            cancelRequested: false,
          },
        },
        { upsert: true, returnDocument: "before" }
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const held = await leases.findOne({ _id: params.key });
      // Released between the two calls: ask again
      if (!held) return this._acquireLease(params);
      return { acquired: false, lease: this.mapLease(held) };
    }

    const lease: Lease = {
      key: params.key,
      owner: params.owner,
      expiresAt: params.expiresAt,
      data: params.data ?? {},
      cancelRequested: false,
    };
    // An expired lease is the residue of a holder that died
    return previous && previous.expiresAt.getTime() <= params.now.getTime()
      ? { acquired: true, lease, takenOver: this.mapLease(previous) }
      : { acquired: true, lease };
  }

  protected async _renewLease(params: RenewLeaseParams & { now: Date; expiresAt: Date }): Promise<Lease | null> {
    if (!this.db) throw new Error("Database not initialized");
    const doc = await this.db.collection<MongoLease>(this.collections.leases).findOneAndUpdate(
      { _id: params.key, owner: params.owner, expiresAt: { $gt: params.now } },
      { $set: { expiresAt: params.expiresAt } },
      { returnDocument: "after" }
    );
    return doc ? this.mapLease(doc) : null;
  }

  protected async _releaseLease(params: ReleaseLeaseParams): Promise<boolean> {
    if (!this.db) throw new Error("Database not initialized");
    const result = await this.db
      .collection<MongoLease>(this.collections.leases)
      .deleteOne({ _id: params.key, owner: params.owner });
    return result.deletedCount > 0;
  }

  protected async _getLeases(keys: string[], now: Date): Promise<Lease[]> {
    if (!this.db) throw new Error("Database not initialized");
    const docs = await this.db
      .collection<MongoLease>(this.collections.leases)
      .find({ _id: { $in: keys }, expiresAt: { $gt: now } })
      .toArray();
    return docs.map((doc) => this.mapLease(doc));
  }

  protected async _markLeaseCancel(key: string, now: Date): Promise<boolean> {
    if (!this.db) throw new Error("Database not initialized");
    const result = await this.db
      .collection<MongoLease>(this.collections.leases)
      .updateOne({ _id: key, expiresAt: { $gt: now } }, { $set: { cancelRequested: true } });
    return result.matchedCount > 0;
  }

  protected async _listExpiredLeases(params: { prefix?: string; limit: number; now: Date }): Promise<Lease[]> {
    if (!this.db) throw new Error("Database not initialized");
    const filter: Record<string, unknown> = { expiresAt: { $lte: params.now } };
    if (params.prefix) filter._id = { $regex: `^${params.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` };
    const docs = await this.db
      .collection<MongoLease>(this.collections.leases)
      .find(filter)
      .sort({ expiresAt: 1, _id: 1 })
      .limit(params.limit)
      .toArray();
    return docs.map((doc) => this.mapLease(doc));
  }

  // ============================================================================
  // Mappers
  // ============================================================================

  private mapConversation(doc: MongoConversation): Conversation {
    return {
      id: doc._id as string,
      agentId: doc.agentId,
      userId: doc.userId || undefined,
      title: doc.title || undefined,
      metadata: doc.metadata,
      state: doc.state,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      version: doc.version ?? 0,
      actionDueAt: doc.actionDueAt ?? undefined,
    };
  }

  private mapMessage(doc: MongoMessage): Message {
    return {
      id: doc._id as string,
      conversationId: doc.conversationId,
      role: doc.role,
      content: doc.content,
      name: doc.name || undefined,
      toolCalls: doc.toolCalls || undefined,
      toolCallId: doc.toolCallId || undefined,
      files: doc.files?.length > 0 ? doc.files : undefined,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  private mapFile(doc: MongoFile): FileRecord {
    return {
      id: doc._id as string,
      name: doc.name,
      mimeType: doc.mimeType,
      size: doc.size,
      storageKey: doc.storageKey,
      conversationId: doc.conversationId || undefined,
      messageId: doc.messageId || undefined,
      userId: doc.userId || undefined,
      agentId: doc.agentId || undefined,
      expiresAt: doc.expiresAt ? new Date(doc.expiresAt) : undefined,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
    };
  }

  private mapTask(doc: MongoTask): Task {
    return {
      id: doc._id as string,
      agentId: doc.agentId,
      userId: doc.userId || undefined,
      conversationId: doc.conversationId || undefined,
      status: doc.status,
      callbackUrl: doc.callbackUrl || undefined,
      input: doc.input,
      files: doc.files?.length > 0 ? doc.files : undefined,
      comments: doc.comments ?? [],
      metadata: doc.metadata,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      startedAt: doc.startedAt || undefined,
      completedAt: doc.completedAt || undefined,
      error: doc.error || undefined,
    };
  }

  private mapTaskResult(doc: MongoTaskResult): TaskResult {
    return {
      id: doc._id as string,
      taskId: doc.taskId,
      content: doc.content,
      files: doc.files?.length > 0 ? doc.files : undefined,
      metadata: doc.metadata,
      usage: doc.usage || undefined,
      createdAt: doc.createdAt,
    };
  }
}

// ============================================================================
// Internal MongoDB document types
// ============================================================================

interface MongoConversation {
  _id: string;
  agentId: string;
  userId: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /** Bumped by every update (compare-and-set); absent on documents written before it existed. */
  version?: number;
  /** When the earliest pending action lapses. */
  actionDueAt?: Date;
  /** Insertion sequence: breaks ties between rows created in the same millisecond. */
  seq?: number;
}

interface MongoMessage {
  _id: string;
  conversationId: string;
  role: Message["role"];
  content: string | Message["content"];
  name: string | null;
  toolCalls: Message["toolCalls"] | null;
  toolCallId: string | null;
  files: NonNullable<Message["files"]>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  seq?: number;
}

interface MongoFile {
  _id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  conversationId: string | null;
  messageId: string | null;
  userId?: string | null;
  agentId?: string | null;
  expiresAt?: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  /** Insertion sequence: breaks ties between files saved in one millisecond. */
  seq?: number;
}

interface MongoFileContent {
  _id: string;
  content: unknown;
}

interface MongoTask {
  _id: string;
  agentId: string;
  userId: string | null;
  conversationId?: string | null;
  status: Task["status"];
  callbackUrl: string | null;
  input: string;
  files: NonNullable<Task["files"]>;
  comments?: NonNullable<Task["comments"]>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  seq?: number;
}

interface MongoEvent {
  conversationId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  runId: string | null;
  createdAt: Date;
}

interface MongoEventStream {
  _id: string;
  /** The last sequence number handed out (reserved before the events are inserted). */
  lastSeq: number;
  /** The newest sequence number whose event is stored. */
  committedSeq?: number;
  stopReason?: string | null;
  updatedAt: Date;
}

interface MongoLease {
  _id: string;
  owner: string;
  expiresAt: Date;
  data?: Record<string, unknown>;
  cancelRequested?: boolean;
}

interface MongoTaskResult {
  _id: string;
  taskId: string;
  content: string;
  files: NonNullable<TaskResult["files"]>;
  metadata: Record<string, unknown>;
  usage: TaskResult["usage"] | null;
  createdAt: Date;
}

// Export factory function
export function createMongoDBProvider(config: MongoDBConfig): MongoDBStorageProvider {
  return new MongoDBStorageProvider(config);
}
