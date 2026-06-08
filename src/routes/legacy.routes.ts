import { Router, type IRouter } from "express";
import type { NextFunction, Request, Response } from "express";
import { clientConfig } from "../config/constants.js";
import { exportLeadsHandler } from "../controllers/leads.controller.js";
import { scrapeStreamHandler } from "../controllers/scrape.controller.js";
import {
  getLeadStats,
  importLeads,
  listLeads,
  patchLead,
  purgeLeads,
  seedDemoLeads,
  skipTraceLead,
} from "../services/leads.service.js";
import { getMaskedSettings, getRawSettings, updateSettings } from "../services/settings.service.js";
import { sendDailyReport } from "../services/email.service.js";
import {
  getDateRange,
  getLastScrapeTimeValue,
  getScrapeStatus,
  startScrapeJob,
} from "../services/scrape.service.js";
import { getScrapeRuns } from "../repositories/scrape-runs.repository.js";
import { authMiddleware } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  adminDeleteSchema,
  historicalScrapeSchema,
  importLeadsSchema,
  leadIdParamsSchema,
  leadsQuerySchema,
  scrapeTriggerSchema,
  settingsSchema,
  testEmailSchema,
  updateLeadSchema,
} from "../schemas/api.schema.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ApiError } from "../utils/api-error.js";

/**
 * Legacy /api/* routes — flat JSON responses for existing Atlas frontends
 * that have not migrated to /api/v1 envelope format.
 */

function unwrapListLeads(req: Request, res: Response, next: NextFunction): void {
  listLeads(req.query as Parameters<typeof listLeads>[0])
    .then((result) => res.json(result))
    .catch(next);
}

function unwrapStats(_req: Request, res: Response, next: NextFunction): void {
  Promise.all([getLeadStats(), getLastScrapeTimeValue()])
    .then(([stats, lastScrapeTime]) => res.json({ ...stats, lastScrapeTime }))
    .catch(next);
}

function legacySkipTrace(req: Request, res: Response, next: NextFunction): void {
  const id = req.params.id as string;
  getRawSettings()
    .then((settings) => {
      if (!settings.skip_trace_key) {
        res.status(400).json({
          success: false,
          error: "Easy Button Skip Trace API key not configured. Go to Settings to add it.",
        });
        return;
      }
      return skipTraceLead(id).then((result) => {
        res.json({
          success: true,
          phone: result.phone,
          email: result.email,
          mailing: result.mailing,
        });
      });
    })
    .catch((err) => {
      if (err instanceof ApiError) {
        res.status(err.statusCode).json({ success: false, error: err.message });
        return;
      }
      next(err);
    });
}

const router: IRouter = Router();

router.get("/leads", validate(leadsQuerySchema, "query"), asyncHandler(unwrapListLeads));
router.get("/leads/export", validate(leadsQuerySchema, "query"), asyncHandler(exportLeadsHandler));
router.patch(
  "/leads/:id",
  asyncHandler(authMiddleware),
  validate(leadIdParamsSchema, "params"),
  validate(updateLeadSchema),
  asyncHandler(async (req, res) => {
    await patchLead(req.params.id as string, req.body.status, req.body.notes);
    res.json({ ok: true });
  }),
);
router.post(
  "/leads/:id/skip-trace",
  asyncHandler(authMiddleware),
  validate(leadIdParamsSchema, "params"),
  legacySkipTrace,
);

router.get("/stats", asyncHandler(unwrapStats));
router.get("/config", (_req, res) => {
  res.json({ name: clientConfig.name, counties: clientConfig.counties });
});
router.get("/settings", asyncHandler(async (_req, res) => {
  res.json(await getMaskedSettings());
}));
router.post(
  "/settings",
  asyncHandler(authMiddleware),
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    await updateSettings(req.body as Record<string, unknown>);
    res.json({ ok: true });
  }),
);
router.post(
  "/settings/test-email",
  asyncHandler(authMiddleware),
  validate(testEmailSchema),
  asyncHandler(async (req, res) => {
    const settings = await getRawSettings();
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
    } catch (e) {
      const message = e instanceof Error ? e.message : "Email failed";
      res.status(500).json({ error: message });
    }
  }),
);

router.post(
  "/scrape",
  asyncHandler(authMiddleware),
  validate(scrapeTriggerSchema),
  asyncHandler(async (req, res) => {
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
  }),
);
router.get("/scrape/status", (_req, res) => res.json(getScrapeStatus()));
router.get(
  "/scrape/runs",
  asyncHandler(async (_req, res) => {
    res.json({ runs: await getScrapeRuns(200) });
  }),
);
router.get("/scrape/stream", asyncHandler(scrapeStreamHandler));
router.post(
  "/scrape/historical",
  asyncHandler(authMiddleware),
  validate(historicalScrapeSchema),
  asyncHandler(async (req, res) => {
    const status = getScrapeStatus();
    if (status.in_progress) {
      res.status(409).json({ error: "Scrape already in progress" });
      return;
    }
    const daysBack = Math.min((req.body as { days_back?: number }).days_back ?? 30, 90);
    const { fromDate, toDate } = getDateRange(daysBack);
    startScrapeJob(fromDate, toDate);
    res.json({
      ok: true,
      message: `Historical scrape started (${daysBack} days)`,
      from_date: fromDate,
      to_date: toDate,
    });
  }),
);

router.delete(
  "/admin/leads",
  asyncHandler(authMiddleware),
  validate(adminDeleteSchema),
  asyncHandler(async (req, res) => {
    const deleted = await purgeLeads(req.body);
    res.json({ ok: true, deleted });
  }),
);

router.post(
  "/import",
  asyncHandler(authMiddleware),
  validate(importLeadsSchema),
  asyncHandler(async (req, res) => {
    res.json(await importLeads(req.body as Array<Record<string, string | null>>));
  }),
);
router.post(
  "/seed",
  asyncHandler(authMiddleware),
  asyncHandler(async (_req, res) => {
    res.json(await seedDemoLeads());
  }),
);

export default router;
