import type { Request, Response } from "express";
import {
  exportLeadsCsv,
  importLeads,
  listLeads,
  patchLead,
  seedDemoLeads,
} from "../services/leads.service.js";
import { getRawSettings } from "../services/settings.service.js";
import { ApiError } from "../utils/api-error.js";

export async function listLeadsHandler(req: Request, res: Response): Promise<void> {
  const result = await listLeads(req.query as Parameters<typeof listLeads>[0]);
  res.json({ success: true, data: result });
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
  res.json({ success: true, data: { ok: true } });
}

export async function importLeadsHandler(req: Request, res: Response): Promise<void> {
  const result = await importLeads(req.body as Array<Record<string, string | null>>);
  res.json({ success: true, data: result });
}

export async function seedLeadsHandler(_req: Request, res: Response): Promise<void> {
  const result = await seedDemoLeads();
  res.json({ success: true, data: result });
}

export async function skipTraceHandler(_req: Request, _res: Response): Promise<void> {
  const settings = await getRawSettings();
  if (!settings.skip_trace_key) {
    throw ApiError.badRequest(
      "Easy Button Skip Trace API key not configured. Go to Settings to add it.",
    );
  }
  throw ApiError.notImplemented(
    "Easy Button Skip Trace API endpoint not yet wired up. Contact your Atlas administrator.",
  );
}
