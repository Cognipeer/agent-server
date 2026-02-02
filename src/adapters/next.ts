/**
 * Next.js Adapter for Agent Server
 *
 * Provides route handlers and middleware for Next.js App Router.
 */

import type { AgentServer } from "../server.js";
import type { AuthUser } from "../types.js";

// Next.js types - minimal to avoid requiring next as a dependency
interface NextRequest {
  method: string;
  url: string;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
  nextUrl: {
    pathname: string;
    searchParams: URLSearchParams;
  };
}

interface NextResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

type NextResponse = {
  json(body: unknown, init?: NextResponseInit): NextResponse;
  new (body: string | Buffer | null, init?: NextResponseInit): NextResponse;
};

export interface NextAdapterOptions {
  /**
   * Custom error handler
   */
  errorHandler?: (
    error: unknown,
    request: NextRequest
  ) => Response | Promise<Response>;
}

/**
 * Create a Next.js App Router handler for AgentServer
 *
 * Usage in app/api/[...path]/route.ts:
 * ```typescript
 * import { createNextHandler } from '@cognipeer/agent-server/next';
 *
 * const server = createAgentServer({ ... });
 * const handler = createNextHandler(server);
 *
 * export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
 * ```
 */
export function createNextHandler(
  server: AgentServer,
  options: NextAdapterOptions = {}
): (request: NextRequest, context?: { params?: Record<string, string> }) => Promise<Response> {
  const basePath = server.getBasePath();
  const config = server.getConfig();

  return async (request, _context) => {
    try {
      const url = new URL(request.url);
      let path = url.pathname;

      // Remove basePath prefix if present
      if (path.startsWith(basePath)) {
        // Keep the full path for route matching
      }

      // Parse query params
      const query: Record<string, string | string[] | undefined> = {};
      url.searchParams.forEach((value, key) => {
        const existing = query[key];
        if (existing) {
          query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
        } else {
          query[key] = value;
        }
      });

      // Parse body for POST/PATCH requests
      let body: unknown;
      if (request.method === "POST" || request.method === "PATCH") {
        try {
          body = await request.json();
        } catch {
          // No body or not JSON
        }
      }

      // Authentication
      let user: AuthUser | undefined;
      if (config.auth?.enabled) {
        const headerName = config.auth.headerName || "authorization";
        const token = request.headers.get(headerName) ?? undefined;

        // Check if route is excluded
        const excludeRoutes = config.auth.excludeRoutes || [];
        const routePath = path.slice(basePath.length) || "/";
        const isExcluded = excludeRoutes.some((pattern) => {
          if (pattern.includes("*")) {
            const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
            return regex.test(routePath);
          }
          return routePath === pattern;
        });

        if (!isExcluded) {
          const authResult = await server.authenticate(token);
          if (authResult) {
            user = authResult;
          }
        }
      }

      // Handle request
      const result = await server.handleRequest(request.method, path, {
        user,
        query,
        body,
      });

      // Build response headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(result.headers || {}),
      };

      // Handle streaming response
      if (result.stream) {
        const streamHeaders: Record<string, string> = {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...(result.headers || {}),
        };

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of result.stream!) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        });

        return new Response(stream, {
          status: result.status,
          headers: streamHeaders,
        });
      }

      // Return response
      if (result.raw) {
        return new Response(result.raw, {
          status: result.status,
          headers,
        });
      }

      if (result.body !== undefined) {
        // Check if response is HTML (for Swagger UI)
        const contentType = result.headers?.["Content-Type"];
        if (contentType?.includes("text/html")) {
          return new Response(result.body as string, {
            status: result.status,
            headers,
          });
        }

        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers,
        });
      }

      return new Response(null, {
        status: result.status,
        headers,
      });
    } catch (error) {
      if (options.errorHandler) {
        return options.errorHandler(error, request);
      }

      const err = error as { statusCode?: number; code?: string; message?: string };
      return new Response(
        JSON.stringify({
          error: {
            code: err.code || "INTERNAL_ERROR",
            message: err.message || "An unexpected error occurred",
          },
        }),
        {
          status: err.statusCode || 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  };
}

/**
 * Create Next.js route handlers object for easy export
 *
 * Usage in app/api/[...path]/route.ts:
 * ```typescript
 * import { createNextRouteHandlers } from '@cognipeer/agent-server/next';
 *
 * const server = createAgentServer({ ... });
 * export const { GET, POST, PATCH, DELETE } = createNextRouteHandlers(server);
 * ```
 */
export function createNextRouteHandlers(
  server: AgentServer,
  options: NextAdapterOptions = {}
): {
  GET: (request: NextRequest) => Promise<Response>;
  POST: (request: NextRequest) => Promise<Response>;
  PATCH: (request: NextRequest) => Promise<Response>;
  DELETE: (request: NextRequest) => Promise<Response>;
  OPTIONS: (request: NextRequest) => Promise<Response>;
} {
  const handler = createNextHandler(server, options);
  const config = server.getConfig();

  const optionsHandler = async (_request: NextRequest): Promise<Response> => {
    const corsConfig = config.cors;
    const headers: Record<string, string> = {};

    if (corsConfig?.enabled) {
      headers["Access-Control-Allow-Origin"] = corsConfig.origins?.join(", ") || "*";
      headers["Access-Control-Allow-Methods"] =
        corsConfig.methods?.join(", ") || "GET, POST, PATCH, DELETE, OPTIONS";
      headers["Access-Control-Allow-Headers"] =
        corsConfig.headers?.join(", ") || "Content-Type, Authorization";
      headers["Access-Control-Max-Age"] = "86400";
    }

    return new Response(null, { status: 204, headers });
  };

  return {
    GET: handler,
    POST: handler,
    PATCH: handler,
    DELETE: handler,
    OPTIONS: optionsHandler,
  };
}

/**
 * Next.js middleware helper for authentication
 */
export function createNextMiddleware(
  server: AgentServer
): (request: NextRequest) => Promise<Response | null> {
  const basePath = server.getBasePath();
  const config = server.getConfig();

  return async (request) => {
    const url = new URL(request.url);

    // Only handle requests to our basePath
    if (!url.pathname.startsWith(basePath)) {
      return null;
    }

    // CORS preflight
    if (request.method === "OPTIONS" && config.cors?.enabled) {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Origin": config.cors.origins?.join(", ") || "*",
        "Access-Control-Allow-Methods":
          config.cors.methods?.join(", ") || "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          config.cors.headers?.join(", ") || "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      };

      return new Response(null, { status: 204, headers });
    }

    // Authentication check
    if (config.auth?.enabled && config.auth.provider) {
      const headerName = config.auth.headerName || "authorization";
      const token = request.headers.get(headerName);

      const excludeRoutes = config.auth.excludeRoutes || [];
      const routePath = url.pathname.slice(basePath.length) || "/";
      const isExcluded = excludeRoutes.some((pattern) => {
        if (pattern.includes("*")) {
          const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
          return regex.test(routePath);
        }
        return routePath === pattern;
      });

      if (!isExcluded && !token) {
        return new Response(
          JSON.stringify({
            error: {
              code: "AUTHENTICATION_ERROR",
              message: "Authentication required",
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Continue to route handler
    return null;
  };
}

// Re-export types
export type { NextRequest, NextResponse };
