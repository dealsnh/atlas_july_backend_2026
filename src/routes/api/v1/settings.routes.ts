import { Router, type IRouter } from "express";
import {
  getSettingsHandler,
  saveSettingsHandler,
  testEmailHandler,
} from "../../../controllers/settings.controller.js";
import { authMiddleware } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import { settingsSchema, testEmailSchema } from "../../../schemas/api.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.get("/", asyncHandler(getSettingsHandler));
router.post(
  "/",
  asyncHandler(authMiddleware),
  validate(settingsSchema),
  asyncHandler(saveSettingsHandler),
);
router.post(
  "/test-email",
  asyncHandler(authMiddleware),
  validate(testEmailSchema),
  asyncHandler(testEmailHandler),
);

export default router;
