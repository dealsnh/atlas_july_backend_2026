import type { Request, Response } from "express";
import { getLeadStats } from "../services/leads.service.js";
import { countPendingRawLeads, getPendingRawByCounty } from "../repositories/raw-leads.repository.js";
import { getLastScrapeTimeValue } from "../services/scrape.service.js";
import { successResponse } from "../utils/api-response.js";

export async function getStatsHandler(_req: Request, res: Response): Promise<void> {
  const stats = await getLeadStats();
  const pending_raw = await countPendingRawLeads({});
  const pendingByCounty = await getPendingRawByCounty();
  successResponse(res, 200, undefined, {
    ...stats,
    pending_raw,
    pendingByCounty,
    lastScrapeTime: await getLastScrapeTimeValue(),
  });
}
