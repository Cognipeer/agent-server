/**
 * Helpers the built-in storage providers share: what "the same record" means
 * across memory, SQLite, PostgreSQL and MongoDB.
 */

import { Buffer, constants } from "node:buffer";
import { StorageLimitError } from "../../types.js";
import type { ConversationSearchMatch, PaginatedResult, TaskComment } from "../../types.js";

/** Largest `Buffer` Node can hold; the file API passes whole files as one Buffer. */
export const MAX_BUFFER_BYTES = constants.MAX_LENGTH;

/**
 * Deep copy through JSON: `undefined` fields are dropped and `Date`s become ISO
 * strings, which is what the SQL providers store anyway. Doing it for every
 * provider keeps a value reading back the same wherever it was written.
 */
export function jsonClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** UTF-8 bytes of a value's JSON, the unit of `StorageCapabilities.maxStateBytes`. */
export function jsonBytes(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
}

/**
 * {@link jsonClone} that also refuses a value over `maxBytes` (a conversation
 * state the provider cannot hold) with a typed 413 instead of a driver error.
 */
export function jsonCloneWithin<T>(value: T, maxBytes: number, what: string): T {
  if (value === undefined) return value;
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) {
    throw new StorageLimitError(
      `The ${what} is ${bytes} bytes, over the ${maxBytes} byte limit of this storage provider`,
      { bytes, maxBytes }
    );
  }
  return JSON.parse(text) as T;
}

let lastSeq = 0;

/**
 * Insertion sequence for providers without an auto-increment (MongoDB):
 * strictly increasing within the process and ordered by time across restarts.
 * It breaks ties between rows created in the same millisecond.
 */
export function nextSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
  return lastSeq;
}

export function pageResult<T>(data: T[], total: number, limit: number, offset: number): PaginatedResult<T> {
  return { data, total, limit, offset, hasMore: offset + data.length < total };
}

/** Bytes of whatever a driver hands back (Buffer, BSON Binary, Uint8Array) as a `Buffer`. */
export function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const inner = (value as { buffer?: unknown } | null)?.buffer;
  if (inner instanceof Uint8Array) return Buffer.from(inner.buffer, inner.byteOffset, inner.byteLength);
  throw new Error("Stored file content is not binary data");
}

/** Comments read back from JSON have string dates; the API type says `Date`. */
export function reviveComments(comments: TaskComment[] | undefined): TaskComment[] {
  return (comments ?? []).map((c) => ({ ...c, createdAt: new Date(c.createdAt) }));
}

/** `undefined` for `null` / empty-string columns, which every provider stores differently. */
export const optional = <T>(value: T | null | undefined): T | undefined =>
  value === null || value === undefined || (value as unknown) === "" ? undefined : value;

// ---- conversation search ----

/** Longest `searchMatch.snippet`. */
export const SNIPPET_MAX = 160;

/** The text of `getConversations({ search })` once trimmed; `undefined` when there is nothing to look for. */
export const searchTerm = (search: string | undefined): string | undefined => search?.trim() || undefined;

/** `text` for a `LIKE` pattern that must match it literally (with `ESCAPE '\'`). */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, "\\$&");

/** `text` for a regular expression that must match it literally. */
export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text a person sees in a message: a string as is, otherwise its `text` parts joined by a space. */
export function messageSearchText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (p && p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join(" ");
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * A window of at most {@link SNIPPET_MAX} characters around the first (case-insensitive) occurrence of `needle` in `text`,
 * whitespace collapsed, `…` at a cut end. `undefined` when `text` does not contain it.
 */
export function searchSnippet(text: string, needle: string): string | undefined {
  const flat = collapse(text);
  const target = collapse(needle);
  const hit = target ? new RegExp(escapeRegex(target), "i").exec(flat) : null;
  if (!hit) return undefined;
  if (flat.length <= SNIPPET_MAX) return flat;
  const start = Math.max(0, hit.index - 40);
  const end = Math.min(flat.length, start + SNIPPET_MAX);
  const pre = start > 0 ? "…" : "";
  let body = flat.slice(start, end);
  let cut = end < flat.length;
  if (pre.length + body.length + (cut ? 1 : 0) > SNIPPET_MAX) {
    body = body.slice(0, SNIPPET_MAX - pre.length - 1);
    cut = true;
  }
  return `${pre}${body}${cut ? "…" : ""}`;
}

/** Where a conversation matched: its title first, else the given (first matching) message. */
export function buildSearchMatch(
  title: string | undefined,
  needle: string,
  message?: { id: string; role: string; content: unknown }
): ConversationSearchMatch | undefined {
  const inTitle = title ? searchSnippet(title, needle) : undefined;
  if (inTitle) return { field: "title", snippet: inTitle };
  if (!message || (message.role !== "user" && message.role !== "assistant")) return undefined;
  const snippet = searchSnippet(messageSearchText(message.content), needle);
  return snippet ? { field: "message", messageId: message.id, role: message.role, snippet } : undefined;
}
