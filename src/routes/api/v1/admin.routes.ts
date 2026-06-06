import { Router, type IRouter } from "express";
import { deleteLeadsHandler } from "../../../controllers/admin.controller.js";
import { authMiddleware } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import { adminDeleteSchema } from "../../../schemas/api.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.delete("/leads", authMiddleware, validate(adminDeleteSchema), asyncHandler(deleteLeadsHandler));

export default router;
