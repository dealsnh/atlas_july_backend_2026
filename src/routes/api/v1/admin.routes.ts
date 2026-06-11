import { Router, type IRouter } from "express";
import {
  deleteLeadsHandler,
  enrichLeadsHandler,
  listRawLeadsHandler,
  rawLeadStatsHandler,
  reconcileLeadsHandler,
  validateScrapeHandler,
} from "../../../controllers/admin.controller.js";
import { authMiddleware } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import {
  adminDeleteSchema,
  enrichLeadsSchema,
  validateScrapeSchema,
} from "../../../schemas/api.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.delete(
  "/leads",
  asyncHandler(authMiddleware),
  validate(adminDeleteSchema),
  asyncHandler(deleteLeadsHandler),
);
router.post(
  "/scrape/validate",
  asyncHandler(authMiddleware),
  validate(validateScrapeSchema),
  asyncHandler(validateScrapeHandler),
);
router.post(
  "/enrich",
  asyncHandler(authMiddleware),
  validate(enrichLeadsSchema),
  asyncHandler(enrichLeadsHandler),
);
router.post("/reconcile", asyncHandler(authMiddleware), asyncHandler(reconcileLeadsHandler));
router.get("/raw-leads", asyncHandler(authMiddleware), asyncHandler(listRawLeadsHandler));
router.get("/raw-leads/stats", asyncHandler(authMiddleware), asyncHandler(rawLeadStatsHandler));

export default router;
