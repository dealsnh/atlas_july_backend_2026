import { StatusCodes } from "http-status-codes";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    message: string,
    options?: { isOperational?: boolean; details?: unknown },
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.isOperational = options?.isOperational ?? true;
    this.details = options?.details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(StatusCodes.BAD_REQUEST, message, { details });
  }

  static notFound(message = "Resource not found"): ApiError {
    return new ApiError(StatusCodes.NOT_FOUND, message);
  }

  static internal(message = "Internal server error"): ApiError {
    return new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, message, {
      isOperational: false,
    });
  }
}
