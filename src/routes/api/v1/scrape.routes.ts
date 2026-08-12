import { Router, type IRouter } from "express";
import {
  getScrapeRunsHandler,
  getScrapeScheduleHandler,
  getScrapeStatusHandler,
  scrapeStreamHandler,
  setScrapeScheduleHandler,
  triggerHistoricalScrapeHandler,
  triggerScrapeHandler,
} from "../../../controllers/scrape.controller.js";
import { authMiddleware } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import {
  historicalScrapeSchema,
  scrapeScheduleSchema,
  scrapeTriggerSchema,
} from "../../../schemas/api.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.post(
  "/",
  asyncHandler(authMiddleware),
  validate(scrapeTriggerSchema),
  asyncHandler(triggerScrapeHandler),
);
router.get("/status", asyncHandler(getScrapeStatusHandler));
router.get("/schedule", asyncHandler(getScrapeScheduleHandler));
router.post(
  "/schedule",
  asyncHandler(authMiddleware),
  validate(scrapeScheduleSchema),
  asyncHandler(setScrapeScheduleHandler),
);
router.get("/stream", asyncHandler(scrapeStreamHandler));
router.get("/runs", asyncHandler(getScrapeRunsHandler));
router.post(
  "/historical",
  asyncHandler(authMiddleware),
  validate(historicalScrapeSchema),
  asyncHandler(triggerHistoricalScrapeHandler),
);

export default router;
