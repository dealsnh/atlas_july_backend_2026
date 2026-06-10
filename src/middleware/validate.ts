import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { ApiError } from "../utils/api-error.js";

type RequestPart = "body" | "query" | "params";

export function validate<T>(schema: ZodType<T>, part: RequestPart = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[part]);

    if (!result.success) {
      next(ApiError.badRequest("Validation failed", result.error.flatten().fieldErrors));
      return;
    }

    req[part] = result.data as never;
    next();
  };
}
