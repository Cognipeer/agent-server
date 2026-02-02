/**
 * Express Adapter for Agent Server
 *
 * Provides middleware and router to integrate AgentServer with Express.js applications.
 */

import type { AgentServer } from "../server.js";
import type { AuthUser } from "../types.js";

// Express types - minimal to avoid requiring express as a dependency
interface Request {
  method: string;
  path: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
  user?: AuthUser;
}

interface Response {
  status(code: number): Response;
  json(body: unknown): Response;
  send(body: unknown): Response;
  set(headers: Record<string, string>): Response;
  write(chunk: string | Buffer): boolean;
  end(): void;
}

type NextFunction = (error?: unknown) => void;

type RequestHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

interface Router {
  use(handler: RequestHandler): Router;
  use(path: string, handler: RequestHandler): Router;
  get(path: string, ...handlers: RequestHandler[]): Router;
  post(path: string, ...handlers: RequestHandler[]): Router;
  patch(path: string, ...handlers: RequestHandler[]): Router;
  delete(path: string, ...handlers: RequestHandler[]): Router;
  all(path: string, ...handlers: RequestHandler[]): Router;
}

export interface ExpressAdapterOptions {
  /**
   * Custom error handler
   */
  errorHandler?: (error: unknown, req: Request, res: Response) => void;

  /**
   * Whether to parse JSON body automatically (default: true)
   * Set to false if you're using express.json() middleware
   */
  parseBody?: boolean;
}

/**
 * Create Express middleware that handles AgentServer routes
 */
export function createExpressMiddleware(
  server: AgentServer,
  options: ExpressAdapterOptions = {}
): RequestHandler {
  const basePath = server.getBasePath();
  const config = server.getConfig();

  return async (req, res, next) => {
    // Check if request is for our routes
    if (!req.path.startsWith(basePath) && !req.originalUrl.startsWith(basePath)) {
      return next();
    }

    try {
      // Authentication
      let user: AuthUser | undefined;
      if (config.auth?.enabled) {
        const headerName = config.auth.headerName || "authorization";
        const token = req.headers[headerName.toLowerCase()] as string | undefined;

        // Check if route is excluded
        const excludeRoutes = config.auth.excludeRoutes || [];
        const routePath = req.path.slice(basePath.length) || "/";
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
      const result = await server.handleRequest(req.method, req.path || req.originalUrl, {
        user,
        query: req.query as Record<string, string | string[] | undefined>,
        body: req.body,
      });

      // Set headers
      if (result.headers) {
        res.set(result.headers);
      }

      // Send response
      res.status(result.status);

      // Handle SSE streaming response
      if (result.stream) {
        // Ensure headers are set for SSE
        res.set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });

        // Stream the data
        try {
          for await (const chunk of result.stream) {
            res.write(chunk);
            // Flush if possible (for nginx buffering)
            if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
              (res as unknown as { flush: () => void }).flush();
            }
          }
        } catch (streamError) {
          console.error("Stream error:", streamError);
        } finally {
          res.end();
        }
        return;
      }

      if (result.raw) {
        res.send(result.raw);
      } else if (result.body !== undefined) {
        // Check if content type is HTML or plain text - use send instead of json
        const contentType = result.headers?.["Content-Type"] || result.headers?.["content-type"];
        if (contentType && (contentType.includes("text/html") || contentType.includes("text/plain"))) {
          res.send(result.body);
        } else {
          res.json(result.body);
        }
      } else {
        res.end();
      }
    } catch (error) {
      if (options.errorHandler) {
        options.errorHandler(error, req, res);
      } else {
        const err = error as { statusCode?: number; code?: string; message?: string };
        res.status(err.statusCode || 500).json({
          error: {
            code: err.code || "INTERNAL_ERROR",
            message: err.message || "An unexpected error occurred",
          },
        });
      }
    }
  };
}

/**
 * Create an Express Router with AgentServer routes
 */
export function createExpressRouter(
  server: AgentServer,
  options: ExpressAdapterOptions = {}
): RequestHandler {
  // Return middleware that handles all routes
  return createExpressMiddleware(server, options);
}

/**
 * Mount AgentServer on an Express app
 */
export function mountOnExpress(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: { use: (path: string, handler: RequestHandler) => void } | any,
  server: AgentServer,
  options: ExpressAdapterOptions = {}
): void {
  const basePath = server.getBasePath();
  app.use(basePath, createExpressMiddleware(server, options));
}

/**
 * Create CORS middleware for Express
 */
export function createCorsMiddleware(origins: string[] = ["*"]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    const allowedOrigin = origins.includes("*")
      ? "*"
      : origin && origins.includes(origin)
      ? origin
      : null;

    if (allowedOrigin) {
      res.set({
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}

// Re-export types
export type { Request, Response, NextFunction, RequestHandler, Router };
