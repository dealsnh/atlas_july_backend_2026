import type { Request, Response } from "express";
import { clientConfig } from "../config/constants.js";
import { env } from "../config/env.js";

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

export function getReady(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: {
      status: "ready",
      environment: env.NODE_ENV,
      client: clientConfig.name,
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
