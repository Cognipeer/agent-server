/**
 * Fastify adapter for Agent Server
 *
 * Mounts an AgentServer under a (possibly parameterised) Fastify prefix by
 * delegating to the Node handler. Fastify has already parsed the JSON body by
 * the time our route runs, so the parsed body is handed over instead of
 * re-reading the (consumed) stream. Fastify stays an optional peer dependency:
 * only structural types are used here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentServer } from "../server.js";
import { createNodeHandler, type NodeHandlerOptions, type NodeHandlerOverrides } from "./node.js";

interface FastifyRequestLike {
  raw: IncomingMessage;
  body?: unknown;
  params?: unknown;
  /** The route's resolved options (Fastify >= 4.10); `bodyLimit` includes Fastify's own default */
  routeOptions?: { bodyLimit?: number };
}

interface FastifyReplyLike {
  hijack(): unknown;
  send(payload?: unknown): unknown;
  raw: ServerResponse;
  getHeaders(): Record<string, number | string | string[] | undefined>;
}

interface FastifyErrorLike {
  code?: string;
}

interface FastifyScopeLike {
  route(opts: {
    method: string | string[];
    url: string;
    bodyLimit?: number;
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void>;
  }): unknown;
  setErrorHandler?(
    handler: (error: FastifyErrorLike, request: FastifyRequestLike, reply: FastifyReplyLike) => unknown
  ): unknown;
}

export type AgentServerFastifyPlugin = (scope: FastifyScopeLike, opts?: unknown) => Promise<void>;

export interface FastifyAdapterOptions extends Omit<NodeHandlerOptions, "basePath"> {
  /**
   * Fastify's own body size limit for the mounted routes (default: Fastify's
   * 1MiB). Raise it when clients upload base64 files through the chat.
   */
  bodyLimit?: number;
  /**
   * Body limit of `POST /files` ALONE. A file travels base64 in JSON, so this is
   * about a third above the biggest file you accept; every other route keeps
   * `bodyLimit`. Leave unset to serve uploads under `bodyLimit` like any route.
   */
  uploadBodyLimit?: number;
}

const METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"];

/**
 * Fastify plugin serving the AgentServer. Register it with a prefix; route paths
 * are resolved relative to that prefix, so the prefix may contain parameters
 * (they reach `resolveContext` as `req.mountParams`).
 *
 * ```ts
 * app.register(createFastifyPlugin(server), { prefix: "/api/portal/:portalKey" });
 * ```
 */
export function createFastifyPlugin(
  server: AgentServer,
  options: FastifyAdapterOptions = {}
): AgentServerFastifyPlugin {
  // The prefix is decided by Fastify at registration time, so the Node handler
  // must not strip anything itself - we hand it the already-relative path.
  const handle = createNodeHandler(server, { ...options, basePath: "" });

  const handler = async (
    request: FastifyRequestLike,
    reply: FastifyReplyLike,
    fixedPath?: string,
    error?: NodeHandlerOverrides["error"]
  ): Promise<void> => {
    const { "*": rest, ...params } = (request.params ?? {}) as Record<string, unknown>;
    const mountParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) mountParams[key] = String(value);

    // We write on the raw socket (needed for SSE); Fastify must not also reply.
    reply.hijack();
    // Headers set by earlier hooks (CORS plugins, request ids) live on the reply
    // and would be lost once hijacked - carry them over.
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(key, value);
    }

    await handle(request.raw, reply.raw, {
      path: fixedPath ?? `/${typeof rest === "string" ? rest : ""}`,
      body: request.body,
      mountParams,
      raw: request,
      ...(error ? { error } : {}),
    });
  };

  return async (scope) => {
    // A body over the limit is refused by Fastify before any route runs, in Fastify's own
    // error shape. Answer it in ours (413 PAYLOAD_TOO_LARGE, same as the Node handler); every
    // other error goes on to the app's own error handling.
    scope.setErrorHandler?.((error, request, reply) => {
      if (error.code !== "FST_ERR_CTP_BODY_TOO_LARGE") {
        reply.send(error);
        return;
      }
      const limit = request.routeOptions?.bodyLimit ?? options.bodyLimit;
      return handler(request, reply, undefined, {
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: limit ? `Request body exceeds ${limit} bytes` : "Request body is too large",
      });
    });
    for (const url of ["/", "/*"]) {
      scope.route({ method: METHODS, url, bodyLimit: options.bodyLimit, handler });
    }
    // The static route wins over `/*` for exactly this path, so the bigger limit never reaches another route.
    if (options.uploadBodyLimit !== undefined) {
      scope.route({
        method: "POST",
        url: "/files",
        bodyLimit: options.uploadBodyLimit,
        handler: (request, reply) => handler(request, reply, "/files"),
      });
    }
  };
}

/**
 * Convenience wrapper: `app.register(plugin, { prefix })`.
 */
export function mountOnFastify(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: { register: (plugin: any, opts?: any) => unknown },
  server: AgentServer,
  options: FastifyAdapterOptions & { prefix: string }
): unknown {
  const { prefix, ...rest } = options;
  return app.register(createFastifyPlugin(server, rest), { prefix });
}
