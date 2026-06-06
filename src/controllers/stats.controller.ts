import type { Request, Response } from "express";
import { getLeadStats } from "../services/leads.service.js";
import { getLastScrapeTimeValue } from "../services/scrape.service.js";
import { successResponse } from "../utils/api-response.js";

export async function getStatsHandler(_req: Request, res: Response): Promise<void> {
  successResponse(res, 200, undefined, {
    ...(await getLeadStats()),
    lastScrapeTime: await getLastScrapeTimeValue(),
  });
}
