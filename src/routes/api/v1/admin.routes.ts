import { Router, type IRouter } from "express";
import { deleteLeadsHandler, validateScrapeHandler } from "../../../controllers/admin.controller.js";
import { authMiddleware } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import { adminDeleteSchema, validateScrapeSchema } from "../../../schemas/api.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.delete("/leads", asyncHandler(authMiddleware), validate(adminDeleteSchema), asyncHandler(deleteLeadsHandler));
router.post(
  "/scrape/validate",
  asyncHandler(authMiddleware),
  validate(validateScrapeSchema),
  asyncHandler(validateScrapeHandler),
);

export default router;
