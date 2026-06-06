import { Router, type IRouter } from "express";
import { getConfig, getHealth, getReady } from "../../../controllers/health.controller.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.get("/health", asyncHandler(getHealth));
router.get("/ready", asyncHandler(getReady));
router.get("/config", asyncHandler(getConfig));

export default router;
