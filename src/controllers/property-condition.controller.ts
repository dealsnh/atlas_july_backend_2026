import type { Request, Response } from "express";
import { analyzeProperty } from "../services/property-condition.service.js";
import { successResponse } from "../utils/api-response.js";

export async function analyzePropertyConditionHandler(req: Request, res: Response): Promise<void> {
  const { address } = req.body as { address: string };
  const result = await analyzeProperty(address);
  successResponse(res, 200, undefined, result);
}
