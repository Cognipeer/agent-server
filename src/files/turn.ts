/**
 * What a running turn knows about its conversation's files, available to code that runs deep inside the
 * agent - the `session_files_*` tools and the `withSessionImages` model wrapper - through AsyncLocalStorage.
 * The host builds those once, when it builds the agent; they find out which conversation they serve here.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { FileRecord } from "../types.js";
import type { ResolvedFilesConfig } from "./config.js";
import type { ImageSource } from "./images.js";

export interface TurnFiles {
  conversationId: string;
  cfg: ResolvedFilesConfig;
  /** The files the conversation holds, oldest first. */
  list(): Promise<FileRecord[]>;
  /** A file of THIS conversation, else null. */
  find(fileId: string): Promise<FileRecord | null>;
  /** The text of a file, as the agent is given it; null when it has none. */
  text(record: FileRecord): Promise<string | null>;
  /** The bytes of a file; null when they are gone. */
  bytes(record: FileRecord): Promise<Buffer | null>;
  /** The conversation's images, for the model call. */
  images: ImageSource;
  /** The agent has `session_files_view_image` (and its model resolves references), so notes may point at it. */
  viewImageTool: boolean;
}

const store = new AsyncLocalStorage<TurnFiles>();

export function runWithTurnFiles<T>(turn: TurnFiles, fn: () => T): T {
  return store.run(turn, fn);
}

/** The files of the turn being run on this async path, if any. */
export function currentTurnFiles(): TurnFiles | undefined {
  return store.getStore();
}
