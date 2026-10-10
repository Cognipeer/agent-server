/**
 * The conversation event log: vocabulary, wire shapes, and the in-memory log that backs
 * providers without a durable one.
 *
 * Event types and `data` follow the Console client wire (snake_case), so a client written for
 * Console's session events reads an agent-server conversation the same way.
 */

import { Buffer } from "node:buffer";
import type {
  ConversationEvent,
  EventPage,
  EventStore,
  EventSummary,
  ListEventsParams,
  NewConversationEvent,
  PendingAction,
  WireEvent,
} from "./types.js";

/** Event types the server writes. A client must ignore the ones it does not know. */
export const EVENT_TYPES = {
  userMessage: "user.message",
  statusRunning: "session.status_running",
  toolUse: "agent.tool_use",
  toolResult: "agent.tool_result",
  message: "agent.message",
  messageDelta: "agent.message.delta",
  actionRequired: "action.required",
  actionResolved: "action.resolved",
  usage: "session.usage",
  statusIdle: "session.status_idle",
  workDone: "session.work_done",
  error: "session.error",
  budgetReached: "budget.reached",
} as const;

export const DEFAULT_EVENT_PAGE = 100;
export const MAX_EVENT_PAGE = 1000;

// ----------------------------------------------------------------------------
// snake_case (the Console client wire)
// ----------------------------------------------------------------------------

/** `toolCallId` -> `tool_call_id`. Already-snake keys pass through. */
export function toSnakeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Keys whose value is somebody else's data (tool arguments, free-form answers): never re-keyed. */
const OPAQUE_KEYS = new Set(["args", "answers"]);

/** Every object key snake_cased, depth first; values of `args` / `answers` are left as they are. */
export function toSnakeCaseDeep<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => toSnakeCaseDeep(item)) as unknown as T;
  if (typeof value !== "object" || value === null || value instanceof Date) return value as T;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[toSnakeKey(key)] = OPAQUE_KEYS.has(key) ? inner : toSnakeCaseDeep(inner);
  }
  return out as T;
}

/** A pending action as the `action.required` event describes it. */
export function actionRequiredData(action: PendingAction): Record<string, unknown> {
  if (action.type === "tool_approval") {
    return {
      action_id: action.id,
      kind: action.type,
      tool_name: action.toolName,
      ...(action.toolCallId ? { tool_call_id: action.toolCallId } : {}),
      ...(action.title ? { title: action.title } : {}),
      ...(action.summary ? { summary: action.summary } : {}),
      ...(action.args !== undefined ? { args: action.args } : {}),
      ...(action.expiresAt ? { expires_at: action.expiresAt } : {}),
    };
  }
  return {
    action_id: action.id,
    kind: action.type,
    questions: toSnakeCaseDeep<unknown[]>(action.questions),
    ...(action.allowFreeText !== undefined ? { allow_free_text: action.allowFreeText } : {}),
    ...(action.expiresAt ? { expires_at: action.expiresAt } : {}),
  };
}

/** A stored event as the API returns it. */
export function wireEvent(event: ConversationEvent): WireEvent {
  return {
    seq: event.seq,
    type: event.type,
    data: event.data,
    ...(event.runId ? { run_id: event.runId } : {}),
    created_at: new Date(event.createdAt).toISOString(),
  };
}

// ----------------------------------------------------------------------------
// Size cap
// ----------------------------------------------------------------------------

const utf8 = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "");

/** `text` cut to at most `maxBytes` of UTF-8 (never in the middle of a character), with an ellipsis. */
function cutText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - 3);
  let cut = Buffer.from(text).subarray(0, budget).toString("utf8");
  // a character split at the boundary decodes to U+FFFD at the end
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/**
 * `data` within `maxBytes` of JSON. Anything bigger is cut: long strings are shortened, and objects /
 * arrays that are still too large are replaced by `{ "_truncated": true }`; the result carries
 * `_truncated: true`. The complete content stays where it lives (the stored message).
 */
export function truncateEventData(data: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (utf8(data) <= maxBytes) return data;
  const entries = Object.entries(data);
  const share = Math.max(64, Math.floor(maxBytes / Math.max(1, entries.length)) - 32);
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (typeof value === "string") out[key] = cutText(value, share);
    else if (value !== null && typeof value === "object" && utf8(value) > share) out[key] = { _truncated: true };
    else out[key] = value;
  }
  out._truncated = true;
  // Many small keys can still add up: drop from the back until it fits
  while (utf8(out) > maxBytes && Object.keys(out).length > 1) {
    const keys = Object.keys(out).filter((k) => k !== "_truncated");
    if (keys.length === 0) break;
    delete out[keys[keys.length - 1]!];
  }
  return out;
}

// ----------------------------------------------------------------------------
// Summary semantics shared by every provider
// ----------------------------------------------------------------------------

/**
 * The `stopReason` of the log after `events`: the `stop_reason` of the newest `session.status_idle`,
 * cleared by a later `session.status_running`. One definition so every provider agrees.
 */
export function nextStopReason(
  previous: string | undefined | null,
  events: Array<{ type: string; data?: Record<string, unknown> }>
): string | undefined {
  let current = previous ?? undefined;
  for (const event of events) {
    if (event.type === EVENT_TYPES.statusRunning) current = undefined;
    else if (event.type === EVENT_TYPES.statusIdle) {
      const reason = event.data?.stop_reason;
      current = typeof reason === "string" ? reason : undefined;
    }
  }
  return current;
}

/** Clamps a requested page size into `1..max`. */
export function clampLimit(limit: number | undefined, fallback = DEFAULT_EVENT_PAGE, max = MAX_EVENT_PAGE): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return Math.min(fallback, max);
  return Math.min(Math.floor(limit), max);
}

// ----------------------------------------------------------------------------
// In-memory log
// ----------------------------------------------------------------------------

export interface MemoryEventLogOptions {
  /** Events kept per conversation; older ones are dropped (the sequence keeps counting). Unlimited by default. */
  maxPerConversation?: number;
}

interface MemoryStream {
  lastSeq: number;
  stopReason?: string;
  events: ConversationEvent[];
}

/**
 * An {@link EventStore} in memory. The in-memory storage provider keeps its log in one (unbounded);
 * the server uses a bounded one when the configured provider has none. Records are copied on the
 * way in and out.
 */
export class MemoryEventLog implements EventStore {
  private streams = new Map<string, MemoryStream>();

  constructor(private options: MemoryEventLogOptions = {}) {}

  async append(
    conversationId: string,
    events: NewConversationEvent[],
    _ctx?: unknown
  ): Promise<ConversationEvent[]> {
    let stream = this.streams.get(conversationId);
    if (!stream) {
      stream = { lastSeq: 0, events: [] };
      this.streams.set(conversationId, stream);
    }
    const now = new Date();
    const stored: ConversationEvent[] = events.map((event) => ({
      conversationId,
      seq: ++stream!.lastSeq,
      type: event.type,
      data: structuredClone(event.data ?? {}),
      runId: event.runId,
      createdAt: now,
    }));
    stream.events.push(...stored);
    stream.stopReason = nextStopReason(stream.stopReason, stored);
    const max = this.options.maxPerConversation;
    if (max && stream.events.length > max) stream.events.splice(0, stream.events.length - max);
    return stored.map(copyEvent);
  }

  async list(conversationId: string, params: ListEventsParams = {}, _ctx?: unknown): Promise<EventPage> {
    const limit = clampLimit(params.limit);
    const types = params.types?.length ? new Set(params.types) : undefined;
    const after = params.after ?? 0;
    const all = this.streams.get(conversationId)?.events ?? [];
    const matching = all.filter(
      (e) => e.seq > after && (params.before === undefined || e.seq < params.before) && (!types || types.has(e.type))
    );
    if (params.order === "desc") matching.reverse();
    const page = matching.slice(0, limit).map(copyEvent);
    return {
      events: page,
      hasMore: matching.length > limit,
      lastSeq: page.length > 0 ? page[page.length - 1]!.seq : after,
    };
  }

  async summary(conversationIds: string[], _ctx?: unknown): Promise<Record<string, EventSummary>> {
    const out: Record<string, EventSummary> = {};
    for (const id of conversationIds) {
      const stream = this.streams.get(id);
      if (stream) out[id] = { lastSeq: stream.lastSeq, ...(stream.stopReason ? { stopReason: stream.stopReason } : {}) };
    }
    return out;
  }

  async prune(before: Date, _ctx?: unknown): Promise<number> {
    let removed = 0;
    for (const stream of this.streams.values()) {
      const kept = stream.events.filter((e) => e.createdAt.getTime() >= before.getTime());
      removed += stream.events.length - kept.length;
      stream.events = kept;
    }
    return removed;
  }

  /** Forgets a conversation (its events and its sequence). */
  deleteConversation(conversationId: string): void {
    this.streams.delete(conversationId);
  }

  clear(): void {
    this.streams.clear();
  }
}

function copyEvent(event: ConversationEvent): ConversationEvent {
  return { ...event, data: structuredClone(event.data), createdAt: new Date(event.createdAt) };
}
