import type { Request, Response } from "express";
import { enrichExistingLeads } from "../services/enrichment.service.js";
import { purgeLeads } from "../services/leads.service.js";
import { validateCountyScrape } from "../services/scrape.service.js";
import {
  countRawLeadsForRun,
  getLatestScrapeRunId,
  getRawLeadStatsByCounty,
  listRawLeads,
} from "../repositories/raw-leads.repository.js";
import { deleteLeadsByFilter } from "../repositories/leads.repository.js";
import { successResponse } from "../utils/api-response.js";

export async function deleteLeadsHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    county?: string;
    state?: string;
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

/** Purge placeholder-owner leads and re-enrich remaining rows. */
export async function reconcileLeadsHandler(_req: Request, res: Response): Promise<void> {
  const patterns = ["FSBO Seller", "Unknown (Craigslist)", "Clay County Tax Sale", "Tax Sale"];
  let purged = 0;
  for (const p of patterns) {
    purged += await deleteLeadsByFilter({ owner_name_contains: p });
  }
  const enriched = await enrichExistingLeads({ limit: 2000 });
  successResponse(res, 200, undefined, { ok: true, purged, ...enriched });
}

/** List scraped rows with promote/reject status (audit for client). */
export async function listRawLeadsHandler(req: Request, res: Response): Promise<void> {
  const q = req.query as {
    scrape_run_id?: string;
    county?: string;
    state?: string;
    promoted?: string;
    limit?: string;
    offset?: string;
  };
  let runId = q.scrape_run_id ? parseInt(q.scrape_run_id, 10) : undefined;
  if (!runId || Number.isNaN(runId)) {
    runId = (await getLatestScrapeRunId()) ?? undefined;
  }
  const promoted =
    q.promoted === "true" ? true : q.promoted === "false" ? false : undefined;

  const result = await listRawLeads({
    scrape_run_id: runId,
    county: q.county,
    state: q.state,
    promoted,
    limit: q.limit ? parseInt(q.limit, 10) : 50,
    offset: q.offset ? parseInt(q.offset, 10) : 0,
  });

  successResponse(res, 200, undefined, {
    scrape_run_id: runId ?? null,
    ...result,
  });
}

/** Per-county scraped vs saved vs rejected for a scrape run. */
export async function rawLeadStatsHandler(req: Request, res: Response): Promise<void> {
  const q = req.query as { scrape_run_id?: string };
  let runId = q.scrape_run_id ? parseInt(q.scrape_run_id, 10) : undefined;
  if (!runId || Number.isNaN(runId)) {
    runId = (await getLatestScrapeRunId()) ?? undefined;
  }
  if (!runId) {
    successResponse(res, 200, undefined, { scrape_run_id: null, totals: null, by_county: [] });
    return;
  }

  const totals = await countRawLeadsForRun(runId);
  const byCounty = await getRawLeadStatsByCounty(runId);
  successResponse(res, 200, undefined, { scrape_run_id: runId, totals, by_county: byCounty });
}
