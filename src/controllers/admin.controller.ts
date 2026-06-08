import type { Request, Response } from "express";
import { purgeLeads } from "../services/leads.service.js";
import { validateCountyScrape } from "../services/scrape.service.js";
import { successResponse } from "../utils/api-response.js";

export async function deleteLeadsHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    county?: string;
    source_url?: string;
    owner_name_contains?: string;
  };
  const deleted = await purgeLeads(body);
  successResponse(res, 200, undefined, { ok: true, deleted });
}

/** QA dry-run: scrape + enrich one county without saving to DB. */
export async function validateScrapeHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    county: string;
    state: string;
    lead_type?: string;
    days_back?: number;
  };
  const result = await validateCountyScrape(body);
  successResponse(res, 200, undefined, result);
}
