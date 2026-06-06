import compression from "compression";
import cors from "cors";
import express, { type Request } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env, isProduction } from "./config/env.js";
import { OPENAPI_DOCS_PATH } from "./config/openapi/index.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import docsRoutes from "./routes/docs.routes.js";
import routes from "./routes/index.js";
import { logger } from "./utils/logger.js";

function parseCorsOrigin(origin: string): boolean | string | string[] {
  if (origin === "*") return true;
  return origin.split(",").map((value) => value.trim());
}

export function createApp(): express.Application {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId,
      customSuccessMessage: (req: IncomingMessage, res: ServerResponse) =>
        `${req.method} ${req.url} ${res.statusCode}`,
      customErrorMessage: (req: IncomingMessage, res: ServerResponse) =>
        `${req.method} ${req.url} ${res.statusCode}`,
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:", "https:"],
              connectSrc: ["'self'"],
              fontSrc: ["'self'", "data:"],
            },
          }
        : false,
    }),
  );

  app.use(
    cors({
      origin: parseCorsOrigin(env.CORS_ORIGIN),
      credentials: true,
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use(docsRoutes);

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: isProduction ? 300 : 1000,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: { message: "Too many requests, please try again later." },
      },
    }),
  );

  app.get("/", (_req, res) => {
    res.json({
      success: true,
      data: {
        name: "Atlas County Scraper API",
        version: "1.0.0",
        docs: OPENAPI_DOCS_PATH,
        openapi: "/api/docs/openapi.json",
      },
    });
  });

  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
