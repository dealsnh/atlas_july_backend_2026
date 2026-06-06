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
import { authMiddleware } from "../../middleware/auth.js";
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
  authMiddleware,
  validate(leadIdParamsSchema, "params"),
  validate(updateLeadSchema),
  asyncHandler(legacyUpdateLead),
);
router.post(
  "/leads/:id/skip-trace",
  authMiddleware,
  validate(leadIdParamsSchema, "params"),
  asyncHandler(legacySkipTrace),
);

router.get("/stats", asyncHandler(legacyStats));
router.get("/config", asyncHandler(legacyConfig));

router.get("/settings", asyncHandler(legacyGetSettings));
router.post("/settings", authMiddleware, validate(settingsSchema), asyncHandler(legacySaveSettings));
router.post(
  "/settings/test-email",
  authMiddleware,
  validate(testEmailSchema),
  asyncHandler(legacyTestEmail),
);

router.post("/scrape", authMiddleware, validate(scrapeTriggerSchema), asyncHandler(legacyTriggerScrape));
router.get("/scrape/status", asyncHandler(legacyScrapeStatus));
router.get("/scrape/stream", asyncHandler(legacyScrapeStream));
router.get("/scrape/runs", asyncHandler(legacyScrapeRuns));
router.post(
  "/scrape/historical",
  authMiddleware,
  validate(historicalScrapeSchema),
  asyncHandler(legacyHistoricalScrape),
);

router.post("/import", authMiddleware, validate(importLeadsSchema), asyncHandler(legacyImport));
router.post("/seed", authMiddleware, asyncHandler(legacySeed));

router.delete(
  "/admin/leads",
  authMiddleware,
  validate(adminDeleteSchema),
  asyncHandler(legacyDeleteLeads),
);

export default router;
