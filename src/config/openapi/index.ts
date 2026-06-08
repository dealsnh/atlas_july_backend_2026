import { env } from "../env.js";
import { openApiPaths } from "./paths.js";
import { openApiSchemas } from "./schemas.js";

export const OPENAPI_DOCS_PATH = "/api/docs";
export const OPENAPI_JSON_PATH = "/api/docs/openapi.json";

export function buildOpenApiSpec(serverUrl?: string) {
  const port = env.PORT;
  const defaultServer = serverUrl ?? `http://localhost:${port}`;

  return {
    openapi: "3.0.3",
    info: {
      title: "Atlas County Scraper API",
      version: "1.2.0",
      description:
        "Production REST API for the Atlas county lead scraper platform (Tina / National Houses). " +
        "All routes are under `/api/v1/*`. Counties and branding are configured via server env (`CLIENT_*`).",
      contact: {
        name: "Atlas Lead Engine",
      },
    },
    servers: [
      { url: defaultServer, description: "Current environment" },
      { url: "https://web-production-871d9.up.railway.app", description: "Railway production" },
      { url: "http://localhost:3001", description: "Local development" },
    ],
    tags: [
      { name: "Health", description: "Liveness and readiness probes" },
      { name: "Auth", description: "User signup, login, and session (JWT)" },
      { name: "Leads", description: "Lead list, export, status updates, skip trace" },
      { name: "Stats", description: "Dashboard statistics" },
      { name: "Settings", description: "SMTP, scraper keys, email recipients" },
      { name: "Scrape", description: "Scrape orchestration and job history" },
      { name: "Admin", description: "Administrative operations" },
    ],
    paths: openApiPaths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "API key set via `API_KEY` environment variable",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Key",
          description: "Service API key (`API_KEY` env) for machine-to-machine access",
        },
        UserJwtAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "User JWT from login — also accepted on protected routes via `authMiddleware`",
        },
      },
      schemas: openApiSchemas,
    },
  };
}

export type OpenApiSpec = ReturnType<typeof buildOpenApiSpec>;

export const openApiSpec = buildOpenApiSpec();
