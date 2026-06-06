import type { Request, Response } from "express";
import { getScrapeRuns } from "../repositories/scrape-runs.repository.js";
import {
  getDateRange,
  getScrapeStatus,
  runScrapeJob,
  startScrapeJob,
} from "../services/scrape.service.js";
import { ApiError } from "../utils/api-error.js";

export function getScrapeStatusHandler(_req: Request, res: Response): void {
  res.json({ success: true, data: getScrapeStatus() });
}

export function getScrapeRunsHandler(_req: Request, res: Response): void {
  res.json({ success: true, data: { runs: getScrapeRuns(200) } });
}

export function triggerScrapeHandler(req: Request, res: Response): void {
  const status = getScrapeStatus();
  if (status.in_progress) {
    throw ApiError.conflict("Scrape already in progress");
  }

  const body = req.body as { from_date?: string; to_date?: string };
  const fromDate = body.from_date || getDateRange(1).fromDate;
  const toDate = body.to_date || getDateRange(0).toDate;

  startScrapeJob(fromDate, toDate);

  res.json({
    success: true,
    data: { ok: true, message: "Scrape started", from_date: fromDate, to_date: toDate },
  });
}

export function triggerHistoricalScrapeHandler(req: Request, res: Response): void {
  const status = getScrapeStatus();
  if (status.in_progress) {
    throw ApiError.conflict("Scrape already in progress");
  }

  const daysBack = Math.min((req.body as { days_back?: number }).days_back ?? 30, 90);
  const { fromDate, toDate } = getDateRange(daysBack);

  startScrapeJob(fromDate, toDate);

  res.json({
    success: true,
    data: {
      ok: true,
      message: `Historical scrape started (${daysBack} days)`,
      from_date: fromDate,
      to_date: toDate,
    },
  });
}

export function scrapeStreamHandler(req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const writeStatus = () => {
    const status = getScrapeStatus();
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  };

  writeStatus();
  const interval = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(interval);
      return;
    }
    writeStatus();
  }, 1000);

  req.on("close", () => clearInterval(interval));
}

export { runScrapeJob };
