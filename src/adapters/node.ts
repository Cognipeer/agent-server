/**
 * Node.js HTTP adapter for Agent Server
 *
 * Framework-agnostic handler for raw `IncomingMessage` / `ServerResponse`
 * (node:http, Fastify's `reply.raw`, connect-style stacks). Handles token auth,
 * `resolveContext`, JSON bodies, CORS and SSE streaming with backpressure.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentServer, RouteResult } from "../server.js";
import type { AuthUser } from "../types.js";
import { isRawUploadRequest, isUnsupportedUploadRequest, trimTrailingSlashes } from "../files/config.js";

export interface NodeHandlerOptions {
  /**
   * URL prefix the server is reachable under; stripped before routing.
   * Defaults to the server's own `basePath`. Use "" when a proxy/router already
   * stripped the prefix. Ignored for calls that pass `overrides.path`.
   */
  basePath?: string;

  /**
   * Maximum request body in bytes. Defaults to `limits.maxBodySize`, or - when
   * unset - enough for a base64 upload of the largest file an agent accepts
   * (`server.maxUploadBytes()`; 10 MiB by default).
   */
  maxBodyBytes?: number;
}

/** Per-call overrides for hosts that already did some of the work (e.g. Fastify). */
export interface NodeHandlerOverrides {
  /** Route path relative to the server (no base path), e.g. "/conversations". */
  path?: string;
  /**
   * Already-parsed body. When the key is present (even with value `undefined`)
   * the request stream is NOT read - required when a framework has consumed it.
   */
  body?: unknown;
  /** Params of the dynamic mount prefix, surfaced as `ContextRequest.mountParams`. */
  mountParams?: Record<string, string>;
  /** Native request object for `ContextRequest.raw` (defaults to the IncomingMessage). */
  raw?: unknown;
  /**
   * Answer with this error instead of routing the request, through the usual CORS
   * headers and `{ error: { code, message } }` envelope. For hosts whose framework
   * refused the request before the handler ran (Fastify: a body over its limit).
   */
  error?: { statusCode?: number; code?: string; message?: string };
}

/**
 * Resolves to `true` when the request was handled, `false` when its path is
 * outside the configured base path (nothing was written - let the next
 * handler take over).
 */
export type NodeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  overrides?: NodeHandlerOverrides
) => Promise<boolean>;

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function matchesExclude(pattern: string, routePath: string): boolean {
  if (pattern.includes("*")) {
    return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(routePath);
  }
  return routePath === pattern;
}

function parseQuery(searchParams: URLSearchParams): Record<string, string | string[] | undefined> {
  const query: Record<string, string | string[] | undefined> = {};
  searchParams.forEach((value, key) => {
    const existing = query[key];
    query[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  });
  return query;
}

/**
 * A body the host framework already read. Fastify gives an object by default,
 * but apps commonly register a JSON content-type parser that keeps the raw
 * string (or a Buffer) - decode those the same way a body read from the stream
 * is decoded, instead of handing the route a string it cannot read fields from.
 */
function normalizeProvidedBody(body: unknown): unknown {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : undefined;
  if (text === undefined) return body;
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw { statusCode: 400, code: "VALIDATION_ERROR", message: "Invalid JSON body" };
  }
}

/** The request body as bytes, refused (413) as soon as it is over `limit`. */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw { statusCode: 413, code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds ${limit} bytes` };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > limit) {
      throw { statusCode: 413, code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds ${limit} bytes` };
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const raw = await readRawBody(req, limit);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw { statusCode: 400, code: "VALIDATION_ERROR", message: "Invalid JSON body" };
  }
}

/**
 * Create a handler that serves an AgentServer on plain Node HTTP objects.
 *
 * ```ts
 * const handle = createNodeHandler(server);
 * http.createServer(async (req, res) => {
 *   if (!(await handle(req, res))) { res.statusCode = 404; res.end(); }
 * });
 * ```
 */
export function createNodeHandler(server: AgentServer, options: NodeHandlerOptions = {}): NodeHandler {
  const config = server.getConfig();
  const base = trimTrailingSlashes(options.basePath ?? server.getBasePath());
  const maxBody =
    options.maxBodyBytes ??
    config.limits?.maxBodySize ??
    Math.ceil(server.maxUploadBytes() * 1.4) + 64 * 1024;

  const applyCors = (req: IncomingMessage, res: ServerResponse): void => {
    const cors = config.cors;
    if (!cors?.enabled) return;
    const origins = cors.origins ?? ["*"];
    const origin = req.headers.origin;
    if (origins.includes("*")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else {
      return;
    }
    res.setHeader("Access-Control-Allow-Methods", (cors.methods ?? ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]).join(", "));
    res.setHeader("Access-Control-Allow-Headers", (cors.headers ?? ["Content-Type", "Authorization", "Last-Event-ID"]).join(", "));
    // What a page on another origin may read from an answer: when to retry (429) and the name of a downloaded file
    res.setHeader("Access-Control-Expose-Headers", "Retry-After, Content-Disposition, Content-Length");
    res.setHeader("Access-Control-Max-Age", "86400");
  };

  const authenticate = async (req: IncomingMessage, routePath: string): Promise<AuthUser | undefined> => {
    const auth = config.auth;
    if (!auth?.enabled) return undefined;
    const excluded = (auth.excludeRoutes ?? []).some((pattern) => matchesExclude(pattern, routePath));
    if (excluded) return undefined;
    const header = req.headers[(auth.headerName || "authorization").toLowerCase()];
    const token = Array.isArray(header) ? header[0] : header;
    return (await server.authenticate(token)) ?? undefined;
  };

  const sendStream = async (res: ServerResponse, result: RouteResult): Promise<void> => {
    res.statusCode = result.status;
    for (const [key, value] of Object.entries(result.headers ?? {})) res.setHeader(key, value);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    res.once("close", () => {
      closed = true;
      // End the stream now: a follower may have nothing to say for a long time. The run it watched goes on.
      result.close?.();
    });
    // Gone before the stream could start: there will be no "close" event to tell us
    if (res.destroyed) {
      closed = true;
      result.close?.();
    }

    try {
      for await (const chunk of result.stream!) {
        // Client went away: leaving the loop calls stream.return() so the agent
        // generator can clean up instead of writing into a dead socket.
        if (closed) break;
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => {
            res.once("drain", resolve);
            res.once("close", resolve);
          });
        }
      }
    } catch (error) {
      console.error("[AgentServer] Stream error:", error);
    } finally {
      if (!res.writableEnded) res.end();
    }
  };

  return async (req, res, overrides = {}) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    let routePath: string;
    if (overrides.path !== undefined) {
      routePath = overrides.path || "/";
    } else {
      const pathname = url.pathname;
      if (base && pathname !== base && !pathname.startsWith(`${base}/`)) return false;
      routePath = base ? pathname.slice(base.length) || "/" : pathname;
    }

    try {
      applyCors(req, res);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return true;
      }

      if (overrides.error) throw overrides.error;

      const user = await authenticate(req, routePath);

      let body: unknown;
      // A file uploaded as itself (its own Content-Type, `?name=`) is a body of bytes, not JSON
      const rawUpload = isRawUploadRequest(req.method ?? "GET", routePath, req.headers["content-type"]);
      if (isUnsupportedUploadRequest(req.method ?? "GET", routePath, req.headers["content-type"])) {
        // (a form or multipart upload is turned away by the server with a 415; its body is not read)
        body = undefined;
      } else if ("body" in overrides) {
        // (a framework that already read it hands the bytes, or - for text/plain - a string)
        body = rawUpload && (Buffer.isBuffer(overrides.body) || typeof overrides.body === "string")
          ? Buffer.from(overrides.body as Buffer | string)
          : normalizeProvidedBody(overrides.body);
      } else if (rawUpload) {
        body = await readRawBody(req, maxBody);
      } else if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
        body = await readJsonBody(req, maxBody);
      }

      // A throttled/slow SSE consumer must not be delayed by Nagle batching.
      req.socket?.setNoDelay?.(true);

      const result = await server.handleRoute(req.method ?? "GET", routePath, {
        user,
        query: parseQuery(url.searchParams),
        body,
        headers: req.headers,
        url: req.url,
        mountParams: overrides.mountParams,
        raw: overrides.raw ?? req,
      });

      if (result.stream) {
        await sendStream(res, result);
        return true;
      }

      for (const [key, value] of Object.entries(result.headers ?? {})) res.setHeader(key, value);

      if (result.raw) {
        res.statusCode = result.status;
        res.setHeader("Content-Length", result.raw.length);
        res.end(result.raw);
      } else if (result.body !== undefined) {
        const type = String(res.getHeader("Content-Type") ?? "");
        if (type.includes("text/html") || type.includes("text/plain")) {
          res.statusCode = result.status;
          res.end(String(result.body));
        } else {
          writeJson(res, result.status, result.body);
        }
      } else {
        res.statusCode = result.status;
        res.end();
      }
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return true;
      }
      const err = error as { statusCode?: number; code?: string; message?: string };
      writeJson(
        res,
        err.statusCode || 500,
        errorBody(err.code || "INTERNAL_ERROR", err.message || "An unexpected error occurred")
      );
    }
    return true;
  };
}
