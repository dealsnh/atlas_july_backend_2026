import type { Request, Response } from "express";
import { exportLeadsCsv, listLeads, patchLead } from "../services/leads.service.js";
import { ApiError } from "../utils/api-error.js";
import { successResponse } from "../utils/api-response.js";

export async function listLeadsHandler(req: Request, res: Response): Promise<void> {
  const result = await listLeads(req.query as Parameters<typeof listLeads>[0]);
  successResponse(res, 200, undefined, result);
}

export async function exportLeadsHandler(req: Request, res: Response): Promise<void> {
  const csv = await exportLeadsCsv(req.query as Parameters<typeof exportLeadsCsv>[0]);
  const date = new Date().toISOString().split("T")[0];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="atlas-leads-${date}.csv"`);
  res.send(csv);
}

export async function updateLeadHandler(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const { status, notes } = req.body as { status: string; notes?: string };
  await patchLead(id, status, notes);
  successResponse(res, 200, undefined, { ok: true });
}

export async function skipTraceHandler(_req: Request, _res: Response): Promise<void> {
  throw ApiError.notImplemented("Skip trace is disabled for now.");
}
