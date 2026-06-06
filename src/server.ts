import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { clientConfig } from "./config/constants.js";
import { env } from "./config/env.js";
import { closeDb, initDb } from "./db/connection.js";
import { startDailyCron } from "./services/scrape.service.js";
import { syncRuntimeConfig } from "./services/settings.service.js";
import { logger } from "./utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function startServer(): Promise<Server> {
  await initDb();
  await syncRuntimeConfig();

  const app = createApp();
  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(env.PORT, env.HOST, () => {
      logger.info(
        {
          host: env.HOST,
          port: env.PORT,
          environment: env.NODE_ENV,
          client: clientConfig.name,
          counties: clientConfig.counties.map((c) => `${c.name} ${c.state}`).join(", ") || "none",
          scraperApi: env.SCRAPER_API_KEY ? "configured" : "not set",
          database: env.DATABASE_URL.replace(/:[^:@/]+@/, ":****@"),
        },
        "Atlas backend server started",
      );
      startDailyCron();
      resolve();
    });
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    const forceExitTimer = setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    server.close(async (error) => {
      clearTimeout(forceExitTimer);

      if (error) {
        logger.error({ err: error }, "Error during server shutdown");
        process.exit(1);
      }

      await closeDb();
      logger.info("Server closed gracefully");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception");
    process.exit(1);
  });

  return server;
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  startServer().catch((error) => {
    logger.fatal({ err: error }, "Failed to start server");
    process.exit(1);
  });
}
