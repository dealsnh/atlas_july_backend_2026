import type { Request, Response } from "express";
import { exportLeadsCsv, listLeads, patchLead, skipTraceLead } from "../services/leads.service.js";
import { getRawSettings } from "../services/settings.service.js";
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

export async function skipTraceHandler(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const settings = await getRawSettings();
  if (!settings.skip_trace_key) {
    throw ApiError.badRequest(
      "Easy Button Skip Trace API key not configured. Go to Settings to add it.",
    );
  }

  const result = await skipTraceLead(id);
  successResponse(res, 200, undefined, {
    ok: true,
    phone: result.phone,
    email: result.email,
    mailing: result.mailing,
  });
}
