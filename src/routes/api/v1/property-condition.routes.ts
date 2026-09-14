import { Router, type IRouter } from "express";
import { analyzePropertyConditionHandler } from "../../../controllers/property-condition.controller.js";
import { authMiddleware } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import { propertyConditionAnalyzeSchema } from "../../../schemas/api.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.post(
  "/analyze",
  asyncHandler(authMiddleware),
  validate(propertyConditionAnalyzeSchema),
  asyncHandler(analyzePropertyConditionHandler),
);

export default router;
