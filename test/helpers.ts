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
