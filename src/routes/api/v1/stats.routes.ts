import { Router, type IRouter } from "express";
import { getStatsHandler } from "../../../controllers/stats.controller.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.get("/", asyncHandler(getStatsHandler));

export default router;
