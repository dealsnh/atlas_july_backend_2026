import { Router, type IRouter } from "express";
import { getHealth, getReady } from "../../../controllers/health.controller.js";
import { asyncHandler } from "../../../utils/async-handler.js";
import adminRoutes from "./admin.routes.js";
import authRoutes from "./auth.routes.js";
import leadsRoutes, { leadsMutatingRouter } from "./leads.routes.js";
import scrapeRoutes from "./scrape.routes.js";
import settingsRoutes, { configRouter } from "./settings.routes.js";
import statsRoutes from "./stats.routes.js";

const router: IRouter = Router();

router.get("/health", asyncHandler(getHealth));
router.get("/ready", asyncHandler(getReady));
router.use("/auth", authRoutes);
router.use("/config", configRouter);
router.use("/leads", leadsRoutes);
router.use("/stats", statsRoutes);
router.use("/settings", settingsRoutes);
router.use("/scrape", scrapeRoutes);
router.use("/admin", adminRoutes);
router.use("/", leadsMutatingRouter);

export default router;
