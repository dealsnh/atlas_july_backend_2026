import { Router, type IRouter } from "express";
import v1Routes from "./api/v1/index.js";
import legacyRoutes from "./legacy.routes.js";

const router: IRouter = Router();

router.use("/api/v1", v1Routes);
router.use("/api", legacyRoutes);

export default router;
