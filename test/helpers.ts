import http from "node:http";
import type { AddressInfo } from "node:net";
import { createInMemoryProvider } from "../src/index.js";
import type { StorageProvider } from "../src/index.js";

export async function memoryStorage(): Promise<StorageProvider> {
  const storage = createInMemoryProvider();
  await storage.connect();
  return storage;
}

/** Wrap every method of a storage provider and record the trailing ctx argument. */
export function spyStorage(inner: StorageProvider): { storage: StorageProvider; calls: Array<{ method: string; ctx: unknown }> } {
  const calls: Array<{ method: string; ctx: unknown }> = [];
  const storage = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (["connect", "disconnect", "isConnected", "capabilities"].includes(prop)) return value.bind(target);
      return (...args: unknown[]) => {
        calls.push({ method: prop, ctx: args[args.length - 1] });
        return value.apply(target, args);
      };
    },
  });
  return { storage, calls };
}

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

export function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)) as SseEvent);
}

export async function listen(server: http.Server): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Minimal agent-sdk-shaped agent. */
export function fakeSdkAgent(
  run: (
    params: { messages: Array<{ role: string; content: string }> },
    config?: {
      stream?: boolean;
      context?: unknown;
      onStream?: (chunk: { text: string; isFinal?: boolean }) => void;
    }
  ) => Promise<{ content: string }>
) {
  return { invoke: run };
}

// ---------------------------------------------------------------------------
// Runs, events and followers
// ---------------------------------------------------------------------------

/** A promise somebody else settles: holds an agent mid-turn until the test says go. */
export function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Polls until `check` returns something truthy (or throws less), up to `ms`. */
export async function eventually<T>(check: () => T | Promise<T>, ms = 4000, what = "condition"): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface EventFrame {
  id?: number;
  event?: string;
  data?: any;
  /** `: ping`, `: open` */
  comment?: string;
}

/** One SSE frame (`id:` / `event:` / `data:` lines or a `:` comment). */
export function parseEventFrame(chunk: string): EventFrame {
  const frame: EventFrame = {};
  for (const line of chunk.split("\n")) {
    if (line.startsWith(":")) frame.comment = line.slice(1).trim();
    else if (line.startsWith("id: ")) frame.id = Number(line.slice(4));
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
  }
  return frame;
}

/** Consumes a route's SSE stream in the background and lets a test wait for what it has seen. */
export class Follower {
  frames: EventFrame[] = [];
  ended = false;
  private failure?: unknown;

  constructor(public result: { stream?: AsyncGenerator<string, void, unknown>; close?: () => void }) {
    void this.pump();
  }

  private async pump() {
    try {
      for await (const chunk of this.result.stream!) this.frames.push(parseEventFrame(chunk));
    } catch (error) {
      this.failure = error;
    } finally {
      this.ended = true;
    }
  }

  /** The stored events seen so far (frames with an id). */
  get events() {
    return this.frames.filter((f) => f.id !== undefined).map((f) => f.data as { seq: number; type: string; data: any; run_id?: string });
  }

  get types() {
    return this.events.map((e) => e.type);
  }

  async until(check: (follower: Follower) => boolean, ms = 4000, what = "the stream to show it") {
    await eventually(() => {
      if (this.failure) throw this.failure;
      return check(this);
    }, ms, what);
  }

  close() {
    this.result.close?.();
  }
}
