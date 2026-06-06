import { Router, type IRouter } from "express";
import {
  legacyConfig,
  legacyDeleteLeads,
  legacyExportLeads,
  legacyGetSettings,
  legacyHistoricalScrape,
  legacyImport,
  legacyListLeads,
  legacySaveSettings,
  legacyScrapeRuns,
  legacyScrapeStatus,
  legacyScrapeStream,
  legacySeed,
  legacySkipTrace,
  legacyStats,
  legacyTestEmail,
  legacyTriggerScrape,
  legacyUpdateLead,
} from "../../controllers/legacy.controller.js";
import { validate } from "../../middleware/validate.js";
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
} from "../../schemas/api.schema.js";
import { asyncHandler } from "../../utils/async-handler.js";

const router: IRouter = Router();

router.get("/leads", validate(leadsQuerySchema, "query"), asyncHandler(legacyListLeads));
router.get("/leads/export", validate(leadsQuerySchema, "query"), asyncHandler(legacyExportLeads));
router.patch(
  "/leads/:id",
  validate(leadIdParamsSchema, "params"),
  validate(updateLeadSchema),
  asyncHandler(legacyUpdateLead),
);
router.post(
  "/leads/:id/skip-trace",
  validate(leadIdParamsSchema, "params"),
  asyncHandler(legacySkipTrace),
);

router.get("/stats", asyncHandler(legacyStats));
router.get("/config", asyncHandler(legacyConfig));

router.get("/settings", asyncHandler(legacyGetSettings));
router.post("/settings", validate(settingsSchema), asyncHandler(legacySaveSettings));
router.post("/settings/test-email", validate(testEmailSchema), asyncHandler(legacyTestEmail));

router.post("/scrape", validate(scrapeTriggerSchema), asyncHandler(legacyTriggerScrape));
router.get("/scrape/status", asyncHandler(legacyScrapeStatus));
router.get("/scrape/stream", asyncHandler(legacyScrapeStream));
router.get("/scrape/runs", asyncHandler(legacyScrapeRuns));
router.post(
  "/scrape/historical",
  validate(historicalScrapeSchema),
  asyncHandler(legacyHistoricalScrape),
);

router.post("/import", validate(importLeadsSchema), asyncHandler(legacyImport));
router.post("/seed", asyncHandler(legacySeed));

router.delete("/admin/leads", validate(adminDeleteSchema), asyncHandler(legacyDeleteLeads));

export default router;
