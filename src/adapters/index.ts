/**
 * Adapter exports
 */

export {
  createExpressMiddleware,
  createExpressRouter,
  mountOnExpress,
  createCorsMiddleware,
} from "./express.js";
export type { ExpressAdapterOptions, Request, Response, NextFunction, RequestHandler, Router } from "./express.js";

export {
  createNextHandler,
  createNextRouteHandlers,
  createNextMiddleware,
} from "./next.js";
export type { NextAdapterOptions, NextRequest, NextResponse } from "./next.js";
