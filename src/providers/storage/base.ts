/**
 * Base Storage Provider - abstract class with common utilities
 */

import { nanoid } from "nanoid";
import type {
  StorageProvider,
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
    params: CreateConversationParams
  ): Promise<Conversation>;
  protected abstract _getConversation(id: string): Promise<Conversation | null>;
  protected abstract _getConversations(
    params: GetConversationsParams
  ): Promise<PaginatedResult<Conversation>>;
  protected abstract _updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation>;
  protected abstract _deleteConversation(id: string): Promise<void>;

  // Messages
  protected abstract _createMessage(
    id: string,
    params: CreateMessageParams
  ): Promise<Message>;
  protected abstract _getMessages(
    conversationId: string,
    params?: GetMessagesParams
  ): Promise<PaginatedResult<Message>>;
  protected abstract _getMessage(id: string): Promise<Message | null>;
  protected abstract _deleteMessage(id: string): Promise<void>;

  // Files
  protected abstract _saveFile(
    id: string,
    params: SaveFileParams & { storageKey: string; size: number }
  ): Promise<FileRecord>;
  protected abstract _getFile(id: string): Promise<FileRecord | null>;
  protected abstract _getFileContent(id: string): Promise<Buffer | null>;
  protected abstract _deleteFile(id: string): Promise<void>;

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

  async createConversation(params: CreateConversationParams): Promise<Conversation> {
    this.ensureConnected();
    const id = this.generateId("conv");
    return this._createConversation(id, params);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    this.ensureConnected();
    return this._getConversation(id);
  }

  async getConversations(
    params: GetConversationsParams
  ): Promise<PaginatedResult<Conversation>> {
    this.ensureConnected();
    return this._getConversations(params);
  }

  async updateConversation(
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    this.ensureConnected();
    return this._updateConversation(id, params);
  }

  async deleteConversation(id: string): Promise<void> {
    this.ensureConnected();
    return this._deleteConversation(id);
  }

  async createMessage(params: CreateMessageParams): Promise<Message> {
    this.ensureConnected();
    const id = this.generateId("msg");
    return this._createMessage(id, params);
  }

  async getMessages(
    conversationId: string,
    params?: GetMessagesParams
  ): Promise<PaginatedResult<Message>> {
    this.ensureConnected();
    return this._getMessages(conversationId, params);
  }

  async getMessage(id: string): Promise<Message | null> {
    this.ensureConnected();
    return this._getMessage(id);
  }

  async deleteMessage(id: string): Promise<void> {
    this.ensureConnected();
    return this._deleteMessage(id);
  }

  async saveFile(params: SaveFileParams): Promise<FileRecord> {
    this.ensureConnected();
    const id = this.generateId("file");
    const storageKey = this.generateStorageKey(params.name);
    const size = params.content.length;
    return this._saveFile(id, { ...params, storageKey, size });
  }

  async getFile(id: string): Promise<FileRecord | null> {
    this.ensureConnected();
    return this._getFile(id);
  }

  async getFileContent(id: string): Promise<Buffer | null> {
    this.ensureConnected();
    return this._getFileContent(id);
  }

  async deleteFile(id: string): Promise<void> {
    this.ensureConnected();
    return this._deleteFile(id);
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
