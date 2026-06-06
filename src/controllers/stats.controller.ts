import type { Request, Response } from "express";
import { getLeadStats } from "../services/leads.service.js";
import { getLastScrapeTimeValue } from "../services/scrape.service.js";

export async function getStatsHandler(_req: Request, res: Response): Promise<void> {
  res.json({
    success: true,
    data: { ...(await getLeadStats()), lastScrapeTime: await getLastScrapeTimeValue() },
  });
}
