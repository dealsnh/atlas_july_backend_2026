import type { Request, Response } from "express";
import { purgeLeads } from "../services/leads.service.js";
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
