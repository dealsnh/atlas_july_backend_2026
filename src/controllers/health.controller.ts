import type { Request, Response } from "express";
import { clientConfig } from "../config/constants.js";
import { env } from "../config/env.js";
import { isDbReady } from "../db/connection.js";
import { errorResponse, successResponse } from "../utils/api-response.js";

export function getHealth(_req: Request, res: Response): void {
  successResponse(res, 200, undefined, {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}

export async function getReady(_req: Request, res: Response): Promise<void> {
  const dbReady = await isDbReady();
  const data = {
    status: dbReady ? "ready" : "not_ready",
    environment: env.NODE_ENV,
    client: clientConfig.name,
    database: dbReady ? "connected" : "disconnected",
  };

  if (dbReady) {
    successResponse(res, 200, undefined, data);
    return;
  }

  errorResponse(res, 503, "Service not ready", { data });
}
