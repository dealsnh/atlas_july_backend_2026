import type { Request, Response } from "express";
import { getLeadStats } from "../services/leads.service.js";
import { getLastScrapeTimeValue } from "../services/scrape.service.js";

export function getStatsHandler(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: { ...getLeadStats(), lastScrapeTime: getLastScrapeTimeValue() },
  });
}
