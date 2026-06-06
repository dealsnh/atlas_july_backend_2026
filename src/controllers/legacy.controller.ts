/**
 * Legacy API handlers — return flat responses matching the monolith
 * so the existing frontend works without changes.
 */
import type { Request, Response } from "express";
import { clientConfig } from "../config/constants.js";
import { getScrapeRuns } from "../repositories/scrape-runs.repository.js";
import {
  exportLeadsCsv,
  getLeadStats,
  importLeads,
  listLeads,
  patchLead,
  purgeLeads,
  seedDemoLeads,
} from "../services/leads.service.js";
import { sendDailyReport } from "../services/email.service.js";
import {
  getDateRange,
  getLastScrapeTimeValue,
  getScrapeStatus,
  startScrapeJob,
} from "../services/scrape.service.js";
import {
  getMaskedSettings,
  getRawSettings,
  updateSettings,
} from "../services/settings.service.js";

export function legacyListLeads(req: Request, res: Response): void {
  const result = listLeads(req.query as Parameters<typeof listLeads>[0]);
  res.json(result);
}

export function legacyExportLeads(req: Request, res: Response): void {
  const csv = exportLeadsCsv(req.query as Parameters<typeof exportLeadsCsv>[0]);
  const date = new Date().toISOString().split("T")[0];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="atlas-leads-${date}.csv"`);
  res.send(csv);
}

export function legacyUpdateLead(req: Request, res: Response): void {
  const id = req.params.id as string;
  const { status, notes } = req.body as { status: string; notes?: string };
  patchLead(id, status, notes);
  res.json({ ok: true });
}

export function legacyStats(_req: Request, res: Response): void {
  res.json({ ...getLeadStats(), lastScrapeTime: getLastScrapeTimeValue() });
}

export function legacyConfig(_req: Request, res: Response): void {
  res.json({ name: clientConfig.name, counties: clientConfig.counties });
}

export function legacyGetSettings(_req: Request, res: Response): void {
  res.json(getMaskedSettings());
}

export function legacySaveSettings(req: Request, res: Response): void {
  updateSettings(req.body as Record<string, unknown>);
  res.json({ ok: true });
}

export async function legacyTestEmail(req: Request, res: Response): Promise<void> {
  const settings = getRawSettings();
  const testRecipient =
    (req.body as { email?: string }).email ||
    settings.email_recipients?.split(",")[0]?.trim();

  if (!testRecipient) {
    res.status(400).json({ error: "No recipient email" });
    return;
  }

  if (
    !settings.smtp_host ||
    !settings.smtp_user ||
    !settings.smtp_pass ||
    settings.smtp_pass.startsWith("placeholder")
  ) {
    res.status(400).json({ error: "SMTP not configured" });
    return;
  }

  try {
    await sendDailyReport(
      testRecipient,
      clientConfig.name,
      [],
      new Date().toISOString().split("T")[0] ?? "",
      settings,
      true,
    );
    res.json({ ok: true, message: `Test email sent to ${testRecipient}` });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Email failed" });
  }
}

export async function legacySkipTrace(req: Request, res: Response): Promise<void> {
  const settings = getRawSettings();
  if (!settings.skip_trace_key) {
    res.status(400).json({
      success: false,
      error: "Easy Button Skip Trace API key not configured. Go to Settings to add it.",
    });
    return;
  }
  res.status(501).json({
    success: false,
    error: "Easy Button Skip Trace API endpoint not yet wired up. Contact your Atlas administrator.",
  });
}

export function legacyTriggerScrape(req: Request, res: Response): void {
  const status = getScrapeStatus();
  if (status.in_progress) {
    res.status(409).json({ error: "Scrape already in progress" });
    return;
  }

  const body = req.body as { from_date?: string; to_date?: string };
  const fromDate = body.from_date || getDateRange(1).fromDate;
  const toDate = body.to_date || getDateRange(0).toDate;
  startScrapeJob(fromDate, toDate);
  res.json({ ok: true, message: "Scrape started", from_date: fromDate, to_date: toDate });
}

export function legacyScrapeStatus(_req: Request, res: Response): void {
  res.json(getScrapeStatus());
}

export function legacyScrapeRuns(_req: Request, res: Response): void {
  res.json({ runs: getScrapeRuns(200) });
}

export function legacyHistoricalScrape(req: Request, res: Response): void {
  const status = getScrapeStatus();
  if (status.in_progress) {
    res.status(409).json({ error: "Scrape already in progress" });
    return;
  }

  const daysBack = Math.min(parseInt(String((req.body as { days_back?: number }).days_back ?? 30), 10), 90);
  const { fromDate, toDate } = getDateRange(daysBack);
  startScrapeJob(fromDate, toDate);
  res.json({
    ok: true,
    message: `Historical scrape started (${daysBack} days)`,
    from_date: fromDate,
    to_date: toDate,
  });
}

export function legacyImport(req: Request, res: Response): void {
  if (!Array.isArray(req.body)) {
    res.status(400).json({ error: "Expected array of leads" });
    return;
  }
  const result = importLeads(req.body as Array<Record<string, string | null>>);
  res.json({ ok: true, ...result });
}

export function legacySeed(_req: Request, res: Response): void {
  res.json(seedDemoLeads());
}

export function legacyDeleteLeads(req: Request, res: Response): void {
  const body = req.body as {
    county?: string;
    source_url?: string;
    owner_name_contains?: string;
  };
  if (!body.county && !body.source_url && !body.owner_name_contains) {
    res.status(400).json({
      error: "Must provide at least one filter: county, source_url, or owner_name_contains",
    });
    return;
  }
  res.json({ ok: true, deleted: purgeLeads(body) });
}

export { scrapeStreamHandler as legacyScrapeStream } from "./scrape.controller.js";
