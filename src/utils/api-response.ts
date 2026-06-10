import type { NextFunction, Request, Response } from "express";
import type { Options } from "express-rate-limit";

/**
 * Standard JSON helpers for Express handlers.
 * Matches API shape: { success: boolean, message?, data?, ... }.
 */

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages?: number;
};

export function errorResponse(
  res: Response,
  statusCode: number,
  message: string,
  extras: Record<string, unknown> = {},
): Response {
  return res.status(statusCode).json({
    success: false,
    message,
    ...extras,
  });
}

export function createRateLimitHandler(message: string) {
  return (_req: Request, res: Response, _next: NextFunction, options?: Options): Response => {
    const status = options && typeof options.statusCode === "number" ? options.statusCode : 429;
    return errorResponse(res, status, message);
  };
}

export function successResponse(
  res: Response,
  statusCode: number,
  message?: string | null,
  data?: unknown,
): Response {
  const payload: Record<string, unknown> = { success: true };
  if (message !== undefined && message !== null && message !== "") {
    payload.message = message;
  }
  if (data !== undefined) {
    payload.data = data;
  }
  return res.status(statusCode).json(payload);
}

export function successResponsePaginated<T>(
  res: Response,
  statusCode: number,
  message: string | null | undefined,
  items: T[],
  meta: PaginationMeta,
): Response {
  const { page, limit, total } = meta;
  const totalPages =
    meta.totalPages !== undefined
      ? meta.totalPages
      : Math.ceil(total / limit) || (total > 0 ? 1 : 0);

  const payload: Record<string, unknown> = {
    success: true,
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
  if (message !== undefined && message !== null && message !== "") {
    payload.message = message;
  }
  return res.status(statusCode).json(payload);
}
