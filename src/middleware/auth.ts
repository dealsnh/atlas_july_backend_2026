import type { NextFunction, Request, Response } from "express";
import { env, isProduction } from "../config/env.js";
import { ApiError } from "../utils/api-error.js";

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!isProduction && !env.API_KEY) {
    next();
    return;
  }

  const headerKey = req.header("x-api-key");
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = headerKey || bearer;

  if (!env.API_KEY) {
    next(ApiError.internal("API_KEY is not configured"));
    return;
  }

  if (!provided || provided !== env.API_KEY) {
    next(ApiError.unauthorized("Invalid or missing API key"));
    return;
  }

  next();
}
