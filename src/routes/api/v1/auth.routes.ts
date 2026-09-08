import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import { loginHandler, meHandler, signupHandler } from "../../../controllers/auth.controller.js";
import { jwtAuthMiddleware } from "../../../middleware/jwt-auth.js";
import { validate } from "../../../middleware/validate.js";
import { loginSchema, signupSchema } from "../../../schemas/auth.schema.js";
import { asyncHandler } from "../../../utils/async-handler.js";
import { createRateLimitHandler } from "../../../utils/api-response.js";

const router: IRouter = Router();

/**
 * Keyed on IP + attempted email so a single account can't be brute-forced
 * from a large pool of IPs, and a single IP can't spray many accounts —
 * both are throttled independently of the general per-IP API limit in app.ts.
 */
function authAttemptKey(req: Request): string {
  const email =
    typeof req.body === "object" && req.body && typeof req.body.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  return `${req.ip}:${email}`;
}

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authAttemptKey,
  handler: createRateLimitHandler("Too many login attempts, please try again later."),
});

const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authAttemptKey,
  handler: createRateLimitHandler("Too many signup attempts, please try again later."),
});

router.post("/signup", signupRateLimiter, validate(signupSchema), asyncHandler(signupHandler));
router.post("/login", loginRateLimiter, validate(loginSchema), asyncHandler(loginHandler));
router.get("/me", asyncHandler(jwtAuthMiddleware), asyncHandler(meHandler));

export default router;
