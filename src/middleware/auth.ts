import type { NextFunction, Request, Response } from "express";
import { env, isProduction } from "../config/env.js";
import { getUserById } from "../services/auth.service.js";
import { ApiError } from "../utils/api-error.js";
import { verifyAccessToken } from "../utils/jwt.js";

function extractBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/** Accepts service API key or user JWT on protected routes. */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!isProduction && !env.API_KEY) {
      next();
      return;
    }

    const headerKey = req.header("x-api-key");
    if (headerKey && env.API_KEY && headerKey === env.API_KEY) {
      next();
      return;
    }

    const bearer = extractBearerToken(req);
    if (bearer && env.API_KEY && bearer === env.API_KEY) {
      next();
      return;
    }

    if (bearer && env.JWT_SECRET) {
      const payload = await verifyAccessToken(bearer);
      req.user = await getUserById(payload.sub);
      req.authToken = bearer;
      next();
      return;
    }

    if (!env.API_KEY && !env.JWT_SECRET) {
      next(ApiError.internal("API_KEY or JWT_SECRET must be configured"));
      return;
    }

    next(ApiError.unauthorized("Invalid or missing authorization"));
  } catch (error) {
    next(error);
  }
}
