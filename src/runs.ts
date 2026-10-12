/**
 * Runs: a turn (a message or a resolved action) executes as a run that is independent of the HTTP
 * request that started it.
 *
 *  - {@link ActiveRun} is the in-process handle: an AbortController for cancellation, an ordered
 *    output (event log + live fan-out) and the subscribers that want the legacy `stream.*` frames.
 *    A connection that goes away only unsubscribes; the run goes on and persists its result.
 *  - {@link EventBus} fans stored events and text chunks out to the followers of a conversation
 *    (`GET /conversations/:id/events/stream`) on this node.
 *  - {@link LeaseKeeper} holds a storage lease for the lifetime of a run and renews it.
 */

import { nanoid } from "nanoid";
import { truncateEventData } from "./events.js";
import type {
  ConversationEvent,
  FileAttachment,
  Lease,
  MessageSnapshotFrame,
  MessageStatus,
  NewConversationEvent,
  RequestContext,
  SessionBudget,
  StopReason,
  StorageProvider,
  UsageInfo,
} from "./types.js";

export type RunKind = "message" | "resolve" | "continue";

/** Why a run started, as `session.status_running` reports it. */
export type RunTrigger = "message" | "resume" | "timeout";

/** Why a run was asked to stop. */
export type CancelReason = "user" | "remote" | "lease_lost" | "deleted" | "shutdown";

// ----------------------------------------------------------------------------
// Bus
// ----------------------------------------------------------------------------

export type BusItem =
  | { kind: "event"; event: ConversationEvent }
  /** A chunk of model text: live only, never stored. `seq` is the log cursor when it was produced. */
  | { kind: "delta"; text: string; runId?: string; seq: number }
  /** The conversation was deleted: followers end. */
  | { kind: "closed" };

/** In-process fan-out of what runs on this node write, per conversation. */
export class EventBus {
  private listeners = new Map<string, Set<(item: BusItem) => void>>();

  subscribe(conversationId: string, listener: (item: BusItem) => void): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0 && this.listeners.get(conversationId) === set) this.listeners.delete(conversationId);
    };
  }

  publish(conversationId: string, item: BusItem): void {
    for (const listener of [...(this.listeners.get(conversationId) ?? [])]) {
      try {
        listener(item);
      } catch (error) {
        console.error("[AgentServer] Event listener failed:", error);
      }
    }
  }

  hasListeners(conversationId: string): boolean {
    return (this.listeners.get(conversationId)?.size ?? 0) > 0;
  }
}

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------

/** What a run hands the connection that started it: legacy `stream.*` frames, then the end. */
export type RunItem = { kind: "frame"; frame: Record<string, unknown> } | { kind: "end" };

export interface EmitSpec {
  /** Events to store (one append, in this order) and publish to followers. */
  events?: Array<{ type: string; data: Record<string, unknown> }>;
  /** A chunk of model text for followers: live only. */
  delta?: string;
  /** Legacy `stream.*` frame(s) for the starting connection, given the event-log cursor. */
  frame?: (seq: number) => Record<string, unknown> | Array<Record<string, unknown>>;
}

/** What a finished turn reports to whoever started it. */
export interface TurnOutcome {
  userMessage?: import("./types.js").Message;
  assistant?: import("./types.js").Message;
  content: string;
  usage?: UsageInfo;
  /** The conversation's budget and what it has spent after the turn, when it has a budget. */
  budget?: SessionBudget;
  spentUsd?: number;
  /** The legacy status: absent when the turn simply completed. */
  status?: MessageStatus;
  stopReason: StopReason;
  pendingActions: import("./types.js").PendingAction[];
  warnings?: import("./types.js").TurnWarning[];
  conversationTitle?: string;
  /** Set when the turn failed: the caller of a non-streaming request throws it. */
  error?: unknown;
  /** What a custom handler returned in `metadata` (tasks read `waitingForInput` from it). */
  handlerMetadata?: Record<string, unknown>;
  /** A resolve that left other actions open: no turn ran. */
  partial?: boolean;
}

export interface RunDeps {
  conversationId: string;
  kind: RunKind;
  trigger: RunTrigger;
  /** Whether the starting request asked for a streamed answer (the model is invoked streaming). */
  streaming: boolean;
  append: (events: NewConversationEvent[]) => Promise<ConversationEvent[]>;
  bus: EventBus;
  maxEventDataBytes: number;
}

export class ActiveRun {
  readonly id = `run_${nanoid(16)}`;
  readonly conversationId: string;
  readonly kind: RunKind;
  readonly trigger: RunTrigger;
  readonly streaming: boolean;
  readonly startedAt = new Date();
  readonly controller = new AbortController();

  /** Why the run was asked to stop (the first reason wins). */
  cancelReason?: CancelReason;
  /** Another node took the conversation over: this run must not write any more. */
  leaseLost = false;
  /** The task whose conversation this run works in, if any. */
  taskId?: string;
  /** The newest event-log cursor this run has seen. */
  lastSeq = 0;
  /**
   * The model text this run has streamed so far. Kept in step with what followers are sent (updated in the same step that
   * publishes a delta), so a follower that subscribes and reads this in one go misses nothing and sees nothing twice.
   */
  streamedText = "";
  /** The message this run answers, once it is stored (message runs only). */
  userMessage?: { id: string; content: string; files: FileAttachment[] };
  /** Resolves when the run has finished, persisted and released the conversation. Never rejects. */
  done: Promise<TurnOutcome> = Promise.resolve({ content: "", stopReason: "error", pendingActions: [] });
  /** Resolves once the run has given the conversation back - also for a run that never got to start. */
  readonly released: Promise<void>;
  lease?: LeaseKeeper;

  private subscribers = new Set<(item: RunItem) => void>();
  private chain: Promise<void> = Promise.resolve();
  private warned = false;
  private finished = false;
  private release!: () => void;

  constructor(private deps: RunDeps) {
    this.conversationId = deps.conversationId;
    this.kind = deps.kind;
    this.trigger = deps.trigger;
    this.streaming = deps.streaming;
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  /** Asks the run to stop. Idempotent. */
  cancel(reason: CancelReason): void {
    if (!this.cancelReason) this.cancelReason = reason;
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  /** Receives the legacy frames the run produces from now on. Returns the unsubscribe. */
  subscribe(listener: (item: RunItem) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /**
   * Queues output. Everything goes through one ordered chain, so stored events, followers' text and
   * the starting connection's frames keep the order they were produced in even though storing an event is
   * asynchronous. A failing append is logged and does not stop the turn: the event log reports the run, it
   * is not what the run depends on.
   */
  emit(spec: EmitSpec): void {
    // An agent that was abandoned after a cancellation may still report: the run is over, its log is closed
    if (this.finished) return;
    this.chain = this.chain.then(async () => {
      let seq = this.lastSeq;
      if (spec.events?.length && !this.leaseLost) {
        try {
          const stored = await this.deps.append(
            spec.events.map((event) => ({
              type: event.type,
              data: truncateEventData(event.data, this.deps.maxEventDataBytes),
              runId: this.id,
            }))
          );
          for (const event of stored) {
            this.deps.bus.publish(this.conversationId, { kind: "event", event });
          }
          if (stored.length > 0) seq = this.lastSeq = stored[stored.length - 1]!.seq;
        } catch (error) {
          if (!this.warned) {
            this.warned = true;
            console.error(`[AgentServer] Could not store events of run ${this.id}:`, error);
          }
        }
      }
      if (spec.delta !== undefined && spec.delta !== "") {
        this.streamedText += spec.delta;
        this.deps.bus.publish(this.conversationId, { kind: "delta", text: spec.delta, runId: this.id, seq });
      }
      if (spec.frame && this.subscribers.size > 0) {
        const made = spec.frame(seq);
        for (const frame of Array.isArray(made) ? made : [made]) {
          for (const subscriber of [...this.subscribers]) subscriber({ kind: "frame", frame });
        }
      }
    });
  }

  /** What a follower that joins now is told first (see {@link MessageSnapshotFrame}). Read it in the same step as subscribing. */
  snapshot(): MessageSnapshotFrame["data"] {
    return { run_id: this.id, text: this.streamedText, user_message: this.userMessage ?? null };
  }

  /** Resolves when everything queued so far has been stored and delivered. */
  flush(): Promise<void> {
    return this.chain;
  }

  /** Tells the starting connection(s) there is nothing more. */
  end(): void {
    this.finished = true;
    for (const subscriber of [...this.subscribers]) subscriber({ kind: "end" });
    this.subscribers.clear();
    this.release();
  }

  /**
   * Waits for `work`, but gives up on it `graceMs` after the run was cancelled: a model call or a
   * handler that ignores the signal must not hold the conversation forever. The abandoned work's
   * eventual result (or failure) is dropped.
   */
  raceCancel<T>(work: Promise<T>, graceMs: number): Promise<{ value: T } | { abandoned: true }> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const onAbort = () => {
        timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          resolve({ abandoned: true });
        }, graceMs);
      };
      if (this.signal.aborted) onAbort();
      else this.signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          this.signal.removeEventListener("abort", onAbort);
          resolve({ value });
        },
        (error) => {
          if (finished) return; // abandoned: nobody is listening any more
          finished = true;
          if (timer) clearTimeout(timer);
          this.signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }
}

// ----------------------------------------------------------------------------
// Lease
// ----------------------------------------------------------------------------

export interface LeaseKeeperOptions {
  storage: StorageProvider;
  key: string;
  owner: string;
  ttlMs: number;
  ctx?: RequestContext;
  /** Someone asked the holder to stop (another node, through `markLeaseCancel`). */
  onCancelRequested?: () => void;
  /** The lease could not be renewed: it expired and someone else may hold it now. */
  onLost?: () => void;
}

/** Renews a lease while its holder is alive and gives it back at the end. */
export class LeaseKeeper {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private renewing = false;

  constructor(private options: LeaseKeeperOptions) {}

  start(): void {
    // Often enough to survive a missed beat, rarely enough to be cheap
    const every = Math.max(100, Math.min(Math.floor(this.options.ttlMs / 3), 5000));
    this.timer = setInterval(() => void this.renew(), every);
    this.timer.unref?.();
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.renewing) return;
    this.renewing = true;
    try {
      const { storage, key, owner, ttlMs, ctx } = this.options;
      const lease: Lease | null = (await storage.renewLease?.({ key, owner, ttlMs }, ctx)) ?? null;
      if (this.stopped) return;
      if (!lease) {
        this.stopped = true;
        clearInterval(this.timer);
        this.options.onLost?.();
      } else if (lease.cancelRequested) {
        this.options.onCancelRequested?.();
      }
    } catch (error) {
      // A storage hiccup: the next beat tries again; the lease holds for ttl
      if (!this.stopped && this.storeIsUp(error)) {
        console.error(`[AgentServer] Could not renew the lease ${this.options.key}:`, error);
      }
    } finally {
      this.renewing = false;
    }
  }

  /** Stops renewing and releases the lease. */
  async stop(): Promise<void> {
    const wasStopped = this.stopped;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (wasStopped) return; // lost: not ours to release
    const { storage, key, owner, ctx } = this.options;
    try {
      await storage.releaseLease?.({ key, owner }, ctx);
    } catch (error) {
      // (a lease that is not released expires by itself)
      if (this.storeIsUp(error)) console.error(`[AgentServer] Could not release the lease ${key}:`, error);
    }
  }

  /** The store going away under us (shutdown) is not worth a log line. */
  private storeIsUp(error: unknown): boolean {
    return this.options.storage.isConnected() && !/closed|not connected|disconnect/i.test((error as Error)?.message ?? "");
  }
}
