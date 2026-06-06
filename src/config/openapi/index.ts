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
      version: "1.0.0",
      description: [
        "Production REST API for the Atlas county lead scraper platform.",
        "",
        "## Authentication",
        "Protected endpoints require an API key in production:",
        "- Header: `x-api-key: <API_KEY>`",
        "- Or: `Authorization: Bearer <API_KEY>`",
        "",
        "In development, auth is skipped when `API_KEY` is not set.",
        "",
        "## Response format (v1)",
        "All `/api/v1/*` endpoints return:",
        "```json",
        '{ "success": true, "data": { ... } }',
        "```",
        "Errors return `{ success: false, error: { message, details? }, requestId }`.",
        "",
        "## Legacy API",
        "Flat-response mirrors exist at `/api/*` (without the envelope) for frontend compatibility.",
      ].join("\n"),
      contact: {
        name: "Atlas Lead Engine",
      },
      license: {
        name: "MIT",
      },
    },
    servers: [
      { url: defaultServer, description: "Current environment" },
      { url: "http://localhost:3001", description: "Local development" },
    ],
    tags: [
      { name: "Health", description: "Liveness and readiness probes" },
      { name: "Config", description: "Client configuration" },
      { name: "Leads", description: "Lead CRUD, import, export, skip trace" },
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
          description: "Same API key as Bearer token",
        },
      },
      schemas: openApiSchemas,
    },
  };
}

export type OpenApiSpec = ReturnType<typeof buildOpenApiSpec>;

export const openApiSpec = buildOpenApiSpec();
