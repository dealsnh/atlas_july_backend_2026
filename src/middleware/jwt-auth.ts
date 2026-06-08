import type { NextFunction, Request, Response } from "express";
import { getUserById } from "../services/auth.service.js";
import { ApiError } from "../utils/api-error.js";
import { verifyAccessToken } from "../utils/jwt.js";

function extractBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export async function jwtAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      next(ApiError.unauthorized("Missing or invalid authorization token"));
      return;
    }

    const payload = await verifyAccessToken(token);
    const user = await getUserById(payload.sub);
    req.user = user;
    req.authToken = token;
    next();
  } catch (error) {
    next(error);
  }
}
