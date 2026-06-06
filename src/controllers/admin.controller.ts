import type { Request, Response } from "express";
import { purgeLeads } from "../services/leads.service.js";

export function deleteLeadsHandler(req: Request, res: Response): void {
  const body = req.body as {
    county?: string;
    source_url?: string;
    owner_name_contains?: string;
  };
  const deleted = purgeLeads(body);
  res.json({ success: true, data: { ok: true, deleted } });
}
