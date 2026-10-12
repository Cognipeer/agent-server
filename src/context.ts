/**
 * Per-request context helpers.
 *
 * The context itself is resolved by `config.resolveContext` (see types.ts) and is
 * passed explicitly to handlers and storage calls. As a convenience for code that
 * runs deep inside an agent (tools, middleware) it is also available through
 * `getRequestContext()`, backed by AsyncLocalStorage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "./types.js";

const store = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` as the ambient request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The request context of the request currently being served (if any). */
export function getRequestContext(): RequestContext | undefined {
  return store.getStore();
}

/**
 * Bind an SSE generator to a context. An async generator's body executes in the
 * caller's async context (whoever calls `next()`), so without this the agent
 * invocation that is started lazily by the stream would lose the context.
 */
export async function* bindStreamToContext<T>(
  gen: AsyncGenerator<T, void, unknown>,
  ctx: RequestContext
): AsyncGenerator<T, void, unknown> {
  try {
    while (true) {
      const step = await store.run(ctx, () => gen.next());
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // Consumer stopped early (client disconnect): let the source clean up.
    await gen.return?.();
  }
}

/** Parse a `Cookie` request header into a name -> value map. */
export function parseCookies(header: string | string[] | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Normalise header bags (plain object, Fetch Headers) to lower-cased keys. */
export function normalizeHeaders(
  headers:
    | Record<string, string | string[] | undefined>
    | { forEach(cb: (value: string, key: string) => void): void }
    | undefined
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  if (!headers) return out;
  if (typeof (headers as { forEach?: unknown }).forEach === "function") {
    (headers as { forEach(cb: (value: string, key: string) => void): void }).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}
