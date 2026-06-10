import { Router, type IRouter } from "express";
import { loginHandler, meHandler, signupHandler } from "../../../controllers/auth.controller.js";
import { jwtAuthMiddleware } from "../../../middleware/jwt-auth.js";
import { validate } from "../../../middleware/validate.js";
import { loginSchema, signupSchema } from "../../../schemas/auth.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";

const router: IRouter = Router();

router.post("/signup", validate(signupSchema), asyncHandler(signupHandler));
router.post("/login", validate(loginSchema), asyncHandler(loginHandler));
router.get("/me", asyncHandler(jwtAuthMiddleware), asyncHandler(meHandler));

export default router;
