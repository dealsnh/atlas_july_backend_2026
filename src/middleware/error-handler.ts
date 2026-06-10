import type { NextFunction, Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { ApiError } from "../utils/api-error.js";
import { errorResponse } from "../utils/api-response.js";

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound("Route not found"));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  if (err instanceof ApiError) {
    errorResponse(res, err.statusCode, err.message, {
      requestId,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  const message = err instanceof Error ? err.message : "Internal server error";

  if (req.app.get("env") !== "production" && err instanceof Error) {
    errorResponse(res, StatusCodes.INTERNAL_SERVER_ERROR, message, {
      requestId,
      stack: err.stack,
    });
    return;
  }

  errorResponse(res, StatusCodes.INTERNAL_SERVER_ERROR, "Internal server error", {
    requestId,
  });
}
