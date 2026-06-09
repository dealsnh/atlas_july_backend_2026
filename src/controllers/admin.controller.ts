import type { Request, Response } from "express";
import { enrichExistingLeads } from "../services/enrichment.service.js";
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

/** Re-run county assessor enrichment on existing DB leads missing owner/address/mailing. */
export async function enrichLeadsHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as { county?: string; state?: string; limit?: number };
  const result = await enrichExistingLeads(body);
  successResponse(res, 200, undefined, { ok: true, ...result });
}
