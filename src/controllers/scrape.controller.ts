import type { Request, Response } from "express";
import { normalizeLeadType } from "../config/county-lead-types.js";
import { getScrapeRuns } from "../repositories/scrape-runs.repository.js";
import {
  buildCountyConfigs,
  DAILY_CRON_EXPRESSION,
  DAILY_CRON_TIMEZONE,
  getDateRange,
  getScrapeStatus,
  runScrapeJob,
  startScrapeJob,
  type ScrapeFilter,
} from "../services/scrape.service.js";
import { isDailyScrapePaused, setDailyScrapePaused } from "../services/settings.service.js";
import { ApiError } from "../utils/api-error.js";
import { successResponse } from "../utils/api-response.js";

export function getScrapeStatusHandler(_req: Request, res: Response): void {
  successResponse(res, 200, undefined, getScrapeStatus());
}

export async function getScrapeRunsHandler(_req: Request, res: Response): Promise<void> {
  successResponse(res, 200, undefined, { runs: await getScrapeRuns(200) });
}

export async function getScrapeScheduleHandler(_req: Request, res: Response): Promise<void> {
  const paused = await isDailyScrapePaused();
  successResponse(res, 200, undefined, {
    paused,
    cron: DAILY_CRON_EXPRESSION,
    timezone: DAILY_CRON_TIMEZONE,
  });
}

export async function setScrapeScheduleHandler(req: Request, res: Response): Promise<void> {
  const { paused } = req.body as { paused: boolean };
  await setDailyScrapePaused(paused);

  successResponse(res, 200, undefined, {
    ok: true,
    paused,
    message: paused ? "Daily scrape paused" : "Daily scrape resumed",
  });
}

export function triggerScrapeHandler(req: Request, res: Response): void {
  const status = getScrapeStatus();
  if (status.in_progress) {
    throw ApiError.conflict("Scrape already in progress");
  }

  const body = req.body as {
    from_date?: string;
    to_date?: string;
    county?: string;
    state?: string;
    lead_type?: string;
  };
  const fromDate = body.from_date || getDateRange(1).fromDate;
  const toDate = body.to_date || getDateRange(0).toDate;

  const leadType =
    typeof body.lead_type === "string" && body.lead_type.trim()
      ? normalizeLeadType(body.lead_type)
      : undefined;
  const county = typeof body.county === "string" && body.county.trim() ? body.county : undefined;
  const state =
    typeof body.state === "string" && body.state.trim() ? body.state.trim().toUpperCase() : undefined;
  const filter: ScrapeFilter | undefined =
    leadType || county
      ? { county, state, leadTypes: leadType ? [leadType] : undefined }
      : undefined;

  if (filter && buildCountyConfigs(filter).length === 0) {
    throw ApiError.badRequest(
      `No configured scraper matches${county ? ` county "${county}"` : ""}${state ? ` in ${state}` : ""}${leadType ? ` lead type "${leadType}"` : ""}`,
    );
  }

  startScrapeJob(fromDate, toDate, filter);

  successResponse(res, 200, undefined, {
    ok: true,
    message: leadType ? `Scrape started (${leadType} only)` : "Scrape started",
    from_date: fromDate,
    to_date: toDate,
    lead_type: leadType,
    county,
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

  successResponse(res, 200, undefined, {
    ok: true,
    message: `Historical scrape started (${daysBack} days)`,
    from_date: fromDate,
    to_date: toDate,
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
