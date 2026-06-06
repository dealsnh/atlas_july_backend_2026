import type { Request, Response } from "express";
import { clientConfig } from "../config/constants.js";
import { env } from "../config/env.js";
import { isDbReady } from "../db/connection.js";

export function getHealth(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
}

export async function getReady(_req: Request, res: Response): Promise<void> {
  const dbReady = await isDbReady();
  res.status(dbReady ? 200 : 503).json({
    success: dbReady,
    data: {
      status: dbReady ? "ready" : "not_ready",
      environment: env.NODE_ENV,
      client: clientConfig.name,
      database: dbReady ? "connected" : "disconnected",
    },
  });
}

export function getConfig(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: {
      name: clientConfig.name,
      counties: clientConfig.counties,
    },
  });
}
