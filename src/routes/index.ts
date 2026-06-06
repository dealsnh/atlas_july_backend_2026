import { Router, type IRouter } from "express";
import legacyRoutes from "./api/legacy.routes.js";
import v1Routes from "./api/v1/index.js";

const router: IRouter = Router();

router.use("/api/v1", v1Routes);
router.use("/api", legacyRoutes);

export default router;
