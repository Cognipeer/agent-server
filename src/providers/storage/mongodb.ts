/**
 * MongoDB Storage Provider
 *
 * File content lives in GridFS (bucket `<prefix>files`), so a file is not bound
 * by the 16 MiB document limit; content written by older versions in the
 * `<prefix>file_contents` collection is still read. Conversation state stays
 * inside the conversation document and is therefore limited (`maxStateBytes`,
 * 12 MiB by default).
 */

import { BaseStorageProvider } from "./base.js";
import { NotFoundError, StorageLimitError } from "../../types.js";
import { MAX_BUFFER_BYTES, jsonBytes, nextSeq, pageResult, toBuffer } from "./shared.js";
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
  findOne(filter: object, options?: object): Promise<T | null>;
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
const SUPERSEDED_INDEXES: Record<"conversations" | "messages" | "tasks", string[]> = {
  conversations: ["agentId_1", "userId_1", "createdAt_-1"],
  messages: ["conversationId_1", "conversationId_1_createdAt_1"],
  tasks: ["agentId_1", "userId_1", "status_1", "createdAt_-1"],
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

    const messages = this.db.collection(this.collections.messages);
    await messages.createIndex({ conversationId: 1, createdAt: 1, seq: 1 });

    const files = this.db.collection(this.collections.files);
    await files.createIndex({ conversationId: 1 });
    await files.createIndex({ messageId: 1 });
    await files.createIndex({ storageKey: 1 }, { unique: true });

    const tasks = this.db.collection(this.collections.tasks);
    await tasks.createIndex({ agentId: 1, createdAt: -1, seq: -1 });
    await tasks.createIndex({ userId: 1, createdAt: -1, seq: -1 });
    await tasks.createIndex({ status: 1, createdAt: -1, seq: -1 });
    await tasks.createIndex({ createdAt: -1, seq: -1 });

    const taskResults = this.db.collection(this.collections.taskResults);
    await taskResults.createIndex({ taskId: 1 }, { unique: true });

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

    const collection = this.db.collection<MongoConversation>(this.collections.conversations);

    // Get total count
    const total = await collection.countDocuments(filter);

    // Get paginated results
    const docs = await collection
      .find(filter)
      .sort({ [orderBy]: order, seq: order })
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

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (params.title !== undefined) update.title = params.title;
    if (params.metadata !== undefined) update.metadata = params.metadata;
    if (params.state !== undefined) update.state = params.state;

    const result = await this.guarded(() =>
      this.db!.collection<MongoConversation>(this.collections.conversations).updateOne(
        { _id: id },
        { $set: update }
      )
    );

    if (result.matchedCount === 0) {
      throw new NotFoundError("Conversation", id);
    }

    const updated = await this._getConversation(id);
    if (!updated) throw new NotFoundError("Conversation", id);
    return updated;
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
    await this.putBlob(params.storageKey, params.name, params.content);
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
        metadata: params.metadata || {},
        createdAt: now,
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
      metadata: doc.metadata,
      createdAt: doc.createdAt,
    };
  }

  private mapTask(doc: MongoTask): Task {
    return {
      id: doc._id as string,
      agentId: doc.agentId,
      userId: doc.userId || undefined,
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
  metadata: Record<string, unknown>;
  createdAt: Date;
}

interface MongoFileContent {
  _id: string;
  content: unknown;
}

interface MongoTask {
  _id: string;
  agentId: string;
  userId: string | null;
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
