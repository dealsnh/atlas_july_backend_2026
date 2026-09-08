import { Router, type IRouter } from "express";
import {
  exportLeadsHandler,
  listLeadsHandler,
  skipTraceHandler,
  updateLeadHandler,
} from "../../../controllers/leads.controller.js";
import { authMiddleware } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import {
  leadIdParamsSchema,
  leadsQuerySchema,
  updateLeadSchema,
} from "../../../schemas/api.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.get(
  "/",
  asyncHandler(authMiddleware),
  validate(leadsQuerySchema, "query"),
  asyncHandler(listLeadsHandler),
);
router.get(
  "/export",
  asyncHandler(authMiddleware),
  validate(leadsQuerySchema, "query"),
  asyncHandler(exportLeadsHandler),
);
router.patch(
  "/:id",
  asyncHandler(authMiddleware),
  validate(leadIdParamsSchema, "params"),
  validate(updateLeadSchema),
  asyncHandler(updateLeadHandler),
);
router.post(
  "/:id/skip-trace",
  asyncHandler(authMiddleware),
  validate(leadIdParamsSchema, "params"),
  asyncHandler(skipTraceHandler),
);

export default router;
