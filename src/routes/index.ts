import { Router, type IRouter } from "express";
import v1Routes from "./api/v1/index.js";

const router: IRouter = Router();

router.use(v1Routes);

export default router;
