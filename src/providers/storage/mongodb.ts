/**
 * MongoDB Storage Provider
 */

import { BaseStorageProvider } from "./base.js";
import type {
  Conversation,
  Message,
  FileRecord,
  CreateConversationParams,
  GetConversationsParams,
  UpdateConversationParams,
  CreateMessageParams,
  GetMessagesParams,
  SaveFileParams,
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
  findOne(filter: object): Promise<T | null>;
  find(filter: object): FindCursor<T>;
  updateOne(filter: object, update: object): Promise<{ modifiedCount: number }>;
  deleteOne(filter: object): Promise<{ deletedCount: number }>;
  deleteMany(filter: object): Promise<{ deletedCount: number }>;
  countDocuments(filter?: object): Promise<number>;
  createIndex(keys: object, options?: object): Promise<string>;
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
}

export class MongoDBStorageProvider extends BaseStorageProvider {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private config: MongoDBConfig;
  private collectionPrefix: string;

  constructor(config: MongoDBConfig) {
    super();
    this.config = config;
    this.collectionPrefix = config.collectionPrefix || "agent_server_";
  }

  // ============================================================================
  // Collection names
  // ============================================================================

  private get collections() {
    return {
      conversations: `${this.collectionPrefix}conversations`,
      messages: `${this.collectionPrefix}messages`,
      files: `${this.collectionPrefix}files`,
      fileContents: `${this.collectionPrefix}file_contents`,
    };
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    if (this._connected) return;

    try {
      // Dynamic import of mongodb
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mongodb = await import("mongodb" as any);
      const MongoClientClass = mongodb.MongoClient;

      const client: MongoClient = new MongoClientClass(this.config.connectionString);
      await client.connect();
      this.client = client;

      // Get database
      const dbName = this.config.database;
      this.db = dbName ? client.db(dbName) : client.db();

      // Create indexes if enabled
      if (this.config.autoIndex !== false) {
        await this.createIndexes();
      }

      this._connected = true;
    } catch (error) {
      throw new Error(`Failed to connect to MongoDB: ${(error as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
    this._connected = false;
  }

  private async createIndexes(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    const conversations = this.db.collection(this.collections.conversations);
    await conversations.createIndex({ agentId: 1 });
    await conversations.createIndex({ userId: 1 });
    await conversations.createIndex({ createdAt: -1 });

    const messages = this.db.collection(this.collections.messages);
    await messages.createIndex({ conversationId: 1 });
    await messages.createIndex({ conversationId: 1, createdAt: 1 });

    const files = this.db.collection(this.collections.files);
    await files.createIndex({ conversationId: 1 });
    await files.createIndex({ storageKey: 1 }, { unique: true });
  }

  // ============================================================================
  // Conversations
  // ============================================================================

  protected async _createConversation(
    id: string,
    params: CreateConversationParams
  ): Promise<Conversation> {
    if (!this.db) throw new Error("Database not initialized");

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
    };

    await this.db.collection<MongoConversation>(this.collections.conversations).insertOne(doc);

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
      .sort({ [orderBy]: order })
      .skip(normalized.offset)
      .limit(normalized.limit)
      .toArray();

    return {
      data: docs.map((doc) => this.mapConversation(doc)),
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + docs.length < total,
    };
  }

  protected async _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    if (!this.db) throw new Error("Database not initialized");

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (params.title !== undefined) update.title = params.title;
    if (params.metadata !== undefined) update.metadata = params.metadata;
    if (params.state !== undefined) update.state = params.state;

    const result = await this.db
      .collection<MongoConversation>(this.collections.conversations)
      .updateOne({ _id: id }, { $set: update });

    if (result.modifiedCount === 0) {
      // Check if document exists
      const exists = await this.db
        .collection<MongoConversation>(this.collections.conversations)
        .findOne({ _id: id });
      if (!exists) {
        throw new Error(`Conversation not found: ${id}`);
      }
    }

    const updated = await this._getConversation(id);
    if (!updated) throw new Error(`Conversation not found: ${id}`);
    return updated;
  }

  protected async _deleteConversation(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Delete all messages in conversation
    await this.db
      .collection<MongoMessage>(this.collections.messages)
      .deleteMany({ conversationId: id });

    // Delete conversation
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
    };

    await this.db.collection<MongoMessage>(this.collections.messages).insertOne(doc);

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

    // Get total count
    const total = await collection.countDocuments({ conversationId });

    // Get paginated results
    const docs = await collection
      .find({ conversationId })
      .sort({ createdAt: order })
      .skip(normalized.offset)
      .limit(normalized.limit)
      .toArray();

    return {
      data: docs.map((doc) => this.mapMessage(doc)),
      total,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: normalized.offset + docs.length < total,
    };
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
  }

  // ============================================================================
  // Files
  // ============================================================================

  protected async _saveFile(
    id: string,
    params: SaveFileParams & { storageKey: string; size: number }
  ): Promise<FileRecord> {
    if (!this.db) throw new Error("Database not initialized");

    // Save file content
    await this.db.collection<MongoFileContent>(this.collections.fileContents).insertOne({
      _id: params.storageKey,
      content: params.content,
    });

    // Save file metadata
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
      .findOne({ _id: id });

    if (!file) return null;

    // Then get the content
    const content = await this.db
      .collection<MongoFileContent>(this.collections.fileContents)
      .findOne({ _id: file.storageKey });

    return content?.content || null;
  }

  protected async _deleteFile(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Get storage key first
    const file = await this.db
      .collection<MongoFile>(this.collections.files)
      .findOne({ _id: id });

    if (file) {
      // Delete content
      await this.db
        .collection<MongoFileContent>(this.collections.fileContents)
        .deleteOne({ _id: file.storageKey });
      // Delete metadata
      await this.db.collection<MongoFile>(this.collections.files).deleteOne({ _id: id });
    }
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
      files: doc.files.length > 0 ? doc.files : undefined,
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
  content: Buffer;
}

// Export factory function
export function createMongoDBProvider(config: MongoDBConfig): MongoDBStorageProvider {
  return new MongoDBStorageProvider(config);
}
