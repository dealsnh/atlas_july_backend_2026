import {
  openApiParameters,
  openApiResponses,
} from "./schemas.js";

const leadFilters = [
  openApiParameters.CountyQuery,
  openApiParameters.LeadTypeQuery,
  openApiParameters.StatusQuery,
  openApiParameters.FromDateQuery,
  openApiParameters.ToDateQuery,
];

const authSecurity = [{ ApiKeyAuth: [] }, { BearerAuth: [] }];

export const openApiPaths = {
  "/": {
    get: {
      tags: ["Health"],
      summary: "API root metadata",
      operationId: "getRoot",
      responses: {
        "200": {
          description: "API name, version, and documentation links",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          name: { type: "string", example: "Atlas County Scraper API" },
                          version: { type: "string", example: "1.0.0" },
                          docs: { type: "string", example: "/api/docs" },
                          openapi: { type: "string", example: "/api/docs/openapi.json" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/health": {
    get: {
      tags: ["Health"],
      summary: "Liveness probe",
      description: "Returns server uptime and timestamp. No authentication required.",
      operationId: "getHealth",
      responses: {
        "200": {
          description: "Server is alive",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          status: { type: "string", example: "ok" },
                          uptime: { type: "number" },
                          timestamp: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/ready": {
    get: {
      tags: ["Health"],
      summary: "Readiness probe",
      description: "Checks database connectivity and environment readiness.",
      operationId: "getReady",
      responses: {
        "200": {
          description: "Service is ready",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          status: { type: "string", example: "ready" },
                          environment: { type: "string" },
                          client: { type: "string" },
                          database: { type: "string", enum: ["connected", "disconnected"] },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "503": {
          description: "Service not ready (database disconnected)",
        },
      },
    },
  },
  "/api/v1/config": {
    get: {
      tags: ["Config"],
      summary: "Get client configuration",
      operationId: "getConfig",
      responses: {
        "200": {
          description: "Client name and target counties",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/ClientConfig" } },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/leads": {
    get: {
      tags: ["Leads"],
      summary: "List leads",
      description: "Returns paginated leads with optional filters. Uses SQL LIMIT/OFFSET.",
      operationId: "listLeads",
      parameters: [...leadFilters, openApiParameters.LimitQuery, openApiParameters.OffsetQuery],
      responses: {
        "200": {
          description: "Paginated lead list",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/LeadListData" } },
                  },
                ],
              },
            },
          },
        },
        "400": openApiResponses.BadRequest,
      },
    },
  },
  "/api/v1/leads/export": {
    get: {
      tags: ["Leads"],
      summary: "Export leads as CSV",
      operationId: "exportLeads",
      parameters: leadFilters,
      responses: {
        "200": {
          description: "CSV file download",
          content: {
            "text/csv": {
              schema: { type: "string", format: "binary" },
            },
          },
          headers: {
            "Content-Disposition": {
              schema: { type: "string" },
              example: 'attachment; filename="atlas-leads-2026-01-01.csv"',
            },
          },
        },
      },
    },
  },
  "/api/v1/leads/{id}": {
    patch: {
      tags: ["Leads"],
      summary: "Update lead status",
      operationId: "updateLead",
      security: authSecurity,
      parameters: [openApiParameters.LeadIdParam],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UpdateLeadBody" },
          },
        },
      },
      responses: {
        "200": {
          description: "Lead updated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/OkResponse" } },
                  },
                ],
              },
            },
          },
        },
        "400": openApiResponses.BadRequest,
        "401": openApiResponses.Unauthorized,
      },
    },
  },
  "/api/v1/leads/{id}/skip-trace": {
    post: {
      tags: ["Leads"],
      summary: "Skip trace a lead",
      description: "Requires skip_trace_key in settings. Currently returns 501 until Easy Button API is wired.",
      operationId: "skipTraceLead",
      security: authSecurity,
      parameters: [openApiParameters.LeadIdParam],
      responses: {
        "501": openApiResponses.NotImplemented,
        "400": openApiResponses.BadRequest,
        "401": openApiResponses.Unauthorized,
      },
    },
  },
  "/api/v1/import": {
    post: {
      tags: ["Leads"],
      summary: "Bulk import leads",
      description: "Accepts an array of lead objects. Idempotent insert-if-not-exists.",
      operationId: "importLeads",
      security: authSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/components/schemas/Lead" },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Import summary",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/ImportResult" } },
                  },
                ],
              },
            },
          },
        },
        "400": openApiResponses.BadRequest,
        "401": openApiResponses.Unauthorized,
      },
    },
  },
  "/api/v1/seed": {
    post: {
      tags: ["Leads"],
      summary: "Seed demo leads",
      description: "Inserts 3 sample leads for development/demo. Requires authentication.",
      operationId: "seedLeads",
      security: authSecurity,
      responses: {
        "200": {
          description: "Seed result",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          inserted: { type: "integer" },
                          total: { type: "integer" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": openApiResponses.Unauthorized,
      },
    },
  },
  "/api/v1/stats": {
    get: {
      tags: ["Stats"],
      summary: "Dashboard statistics",
      operationId: "getStats",
      responses: {
        "200": {
          description: "Lead counts and scrape metadata",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/LeadStats" } },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/settings": {
    get: {
      tags: ["Settings"],
      summary: "Get settings",
      description: "Returns current settings with secrets masked.",
      operationId: "getSettings",
      responses: {
        "200": {
          description: "Masked settings",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/SettingsMasked" } },
                  },
                ],
              },
            },
          },
        },
      },
    },
    post: {
      tags: ["Settings"],
      summary: "Save settings",
      description: "Partial update. Send `••••••••••••••••` to keep existing secret values unchanged.",
      operationId: "saveSettings",
      security: authSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SettingsUpdate" },
          },
        },
      },
      responses: {
        "200": {
          description: "Settings saved",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/OkResponse" } },
                  },
                ],
              },
            },
          },
        },
        "400": openApiResponses.BadRequest,
        "401": openApiResponses.Unauthorized,
      },
    },
  },
  "/api/v1/settings/test-email": {
    post: {
      tags: ["Settings"],
      summary: "Send test email",
      operationId: "testEmail",
      security: authSecurity,
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TestEmailBody" },
          },
        },
      },
      responses: {
        "200": {
          description: "Test email sent",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          ok: { type: "boolean" },
                          message: { type: "string" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": openApiResponses.BadRequest,
        "401": openApiResponses.Unauthorized,
      },
    },
  },
  "/api/v1/scrape": {
    post: {
      tags: ["Scrape"],
      summary: "Trigger manual scrape",
      description: "Starts an asynchronous scrape job. Returns immediately while scraping continues in background.",
      operationId: "triggerScrape",
      security: authSecurity,
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ScrapeTriggerBody" },
          },
        },
      },
      responses: {
        "200": {
          description: "Scrape started",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          ok: { type: "boolean" },
                          message: { type: "string" },
                          from_date: { type: "string", format: "date" },
                          to_date: { type: "string", format: "date" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": openApiResponses.Unauthorized,
        "409": openApiResponses.Conflict,
      },
    },
  },
  "/api/v1/scrape/status": {
    get: {
      tags: ["Scrape"],
      summary: "Get scrape job status",
      operationId: "getScrapeStatus",
      responses: {
        "200": {
          description: "Current scrape progress",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/ScrapeStatus" } },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/scrape/stream": {
    get: {
      tags: ["Scrape"],
      summary: "Stream scrape progress (SSE)",
      description:
        "Server-Sent Events stream. Emits JSON `{ in_progress, log }` every second until scrape completes.",
      operationId: "scrapeStream",
      responses: {
        "200": {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                example: 'data: {"in_progress":true,"log":["Starting scrape..."]}\n\n',
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/scrape/runs": {
    get: {
      tags: ["Scrape"],
      summary: "Scrape run history",
      operationId: "getScrapeRuns",
      responses: {
        "200": {
          description: "Last 200 scrape runs",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          runs: {
                            type: "array",
                            items: { $ref: "#/components/schemas/ScrapeRun" },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/scrape/historical": {
    post: {
      tags: ["Scrape"],
      summary: "Trigger historical scrape",
      description: "Scrapes the last N days (max 90). Runs asynchronously.",
      operationId: "triggerHistoricalScrape",
      security: authSecurity,
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/HistoricalScrapeBody" },
          },
        },
      },
      responses: {
        "200": {
          description: "Historical scrape started",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          ok: { type: "boolean" },
                          message: { type: "string" },
                          from_date: { type: "string", format: "date" },
                          to_date: { type: "string", format: "date" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": openApiResponses.Unauthorized,
        "409": openApiResponses.Conflict,
      },
    },
  },
  "/api/v1/admin/leads": {
    delete: {
      tags: ["Admin"],
      summary: "Purge leads by filter",
      description: "Permanently deletes leads matching at least one filter. Requires authentication.",
      operationId: "deleteLeads",
      security: authSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AdminDeleteBody" },
          },
        },
      },
      responses: {
        "200": {
          description: "Leads deleted",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          ok: { type: "boolean" },
                          deleted: { type: "integer" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": openApiResponses.BadRequest,
        "401": openApiResponses.Unauthorized,
      },
    },
  },
} as const;

export { openApiResponses };
