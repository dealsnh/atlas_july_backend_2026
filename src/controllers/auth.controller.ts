import type { Request, Response } from "express";
import { loginUser, signupUser } from "../services/auth.service.js";
import { successResponse } from "../utils/api-response.js";

export async function signupHandler(req: Request, res: Response): Promise<void> {
  const result = await signupUser(req.body as { email: string; password: string; name?: string });
  successResponse(res, 201, "Account created", result);
}

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const result = await loginUser(req.body as { email: string; password: string });
  successResponse(res, 200, "Login successful", result);
}

export async function meHandler(req: Request, res: Response): Promise<void> {
  successResponse(res, 200, undefined, { user: req.user });
}
