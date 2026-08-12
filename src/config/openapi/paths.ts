import { openApiParameters, openApiResponses } from "./schemas.js";
import { optBody, reqBody } from "./helpers.js";

const leadFilters = [
  openApiParameters.CountyQuery,
  openApiParameters.LeadTypeQuery,
  openApiParameters.StatusQuery,
  openApiParameters.FromDateQuery,
  openApiParameters.ToDateQuery,
];

const authSecurity = [{ ApiKeyAuth: [] }, { BearerAuth: [] }];
const userJwtSecurity = [{ UserJwtAuth: [] }];

const v1AuthSignup = {
  tags: ["Auth"],
  summary: "Register a new user",
  description:
    "Creates a user in PostgreSQL and returns a JWT. Admin is auto-seeded from `ADMIN_EMAIL` on first startup.",
  operationId: "signupUser",
  requestBody: reqBody({
    "application/json": { schema: { $ref: "#/components/schemas/SignupBody" } },
  }),
  responses: {
    "201": {
      description: "Account created",
      content: {
        "application/json": {
          schema: {
            allOf: [
              { $ref: "#/components/schemas/ApiSuccessEnvelope" },
              {
                type: "object",
                properties: {
                  message: { type: "string", example: "Account created" },
                  data: { $ref: "#/components/schemas/AuthTokenData" },
                },
              },
            ],
          },
        },
      },
    },
    "400": openApiResponses.BadRequest,
    "409": openApiResponses.Conflict,
  },
};

const v1AuthLogin = {
  tags: ["Auth"],
  summary: "Sign in",
  description: "Validates email/password and returns a JWT for `Authorization: Bearer` headers.",
  operationId: "loginUser",
  requestBody: reqBody({
    "application/json": { schema: { $ref: "#/components/schemas/LoginBody" } },
  }),
  responses: {
    "200": {
      description: "Login successful",
      content: {
        "application/json": {
          schema: {
            allOf: [
              { $ref: "#/components/schemas/ApiSuccessEnvelope" },
              {
                type: "object",
                properties: {
                  message: { type: "string", example: "Login successful" },
                  data: { $ref: "#/components/schemas/AuthTokenData" },
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
};

const v1AuthMe = {
  tags: ["Auth"],
  summary: "Current user profile",
  description: "Returns the authenticated user from the JWT.",
  operationId: "getCurrentUser",
  security: userJwtSecurity,
  responses: {
    "200": {
      description: "Current user",
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
                      user: { $ref: "#/components/schemas/PublicUser" },
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
};

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
  "/api/v1/auth/signup": { post: v1AuthSignup },
  "/api/v1/auth/login": { post: v1AuthLogin },
  "/api/v1/auth/me": { get: v1AuthMe },
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
      requestBody: reqBody({
        "application/json": {
          schema: { $ref: "#/components/schemas/UpdateLeadBody" },
        },
      }),
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
        "404": openApiResponses.NotFound,
      },
    },
  },
  "/api/v1/leads/{id}/skip-trace": {
    post: {
      tags: ["Leads"],
      summary: "Skip trace a lead",
      description:
        "Calls Tracerfy (or configured SKIP_TRACE_API_URL). Requires skip_trace_key in settings.",
      operationId: "skipTraceLead",
      security: authSecurity,
      parameters: [openApiParameters.LeadIdParam],
      responses: {
        "200": {
          description: "Skip trace completed",
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
                          phone: { type: "string", nullable: true },
                          email: { type: "string", nullable: true },
                          mailing: { type: "string", nullable: true },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "404": openApiResponses.NotFound,
        "400": openApiResponses.BadRequest,
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
      description:
        "Partial update. Send `••••••••••••••••` to keep existing secret values unchanged.",
      operationId: "saveSettings",
      security: authSecurity,
      requestBody: reqBody({
        "application/json": {
          schema: { $ref: "#/components/schemas/SettingsUpdate" },
        },
      }),
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
      requestBody: optBody({
        "application/json": {
          schema: { $ref: "#/components/schemas/TestEmailBody" },
        },
      }),
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
      description:
        "Starts an asynchronous scrape job. Returns immediately while scraping continues in background.",
      operationId: "triggerScrape",
      security: authSecurity,
      requestBody: optBody({
        "application/json": {
          schema: { $ref: "#/components/schemas/ScrapeTriggerBody" },
        },
      }),
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
  "/api/v1/scrape/schedule": {
    get: {
      tags: ["Scrape"],
      summary: "Get daily scrape schedule state",
      description: "Returns whether the automatic 9:00 AM PT daily scrape is paused.",
      operationId: "getScrapeSchedule",
      responses: {
        "200": {
          description: "Daily scrape schedule state",
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
                          paused: { type: "boolean", example: false },
                          cron: { type: "string", example: "0 9 * * *" },
                          timezone: { type: "string", example: "America/Los_Angeles" },
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
    post: {
      tags: ["Scrape"],
      summary: "Pause or resume the daily scrape",
      description:
        "Pauses (`paused: true`) or resumes (`paused: false`) the automatic 9:00 AM PT run. Manual scrapes are unaffected.",
      operationId: "setScrapeSchedule",
      security: authSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["paused"],
              properties: { paused: { type: "boolean", example: true } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated daily scrape schedule state",
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
                          ok: { type: "boolean", example: true },
                          paused: { type: "boolean", example: true },
                          message: { type: "string", example: "Daily scrape paused" },
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
      requestBody: optBody({
        "application/json": {
          schema: { $ref: "#/components/schemas/HistoricalScrapeBody" },
        },
      }),
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
      description:
        "Permanently deletes leads matching at least one filter. Requires authentication.",
      operationId: "deleteLeads",
      security: authSecurity,
      requestBody: reqBody({
        "application/json": {
          schema: { $ref: "#/components/schemas/AdminDeleteBody" },
        },
      }),
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
  "/api/v1/admin/scrape/validate": {
    post: {
      tags: ["Admin"],
      summary: "QA dry-run scrape for one county",
      description:
        "Runs scrapers + assessor enrichment for a county without saving leads. Use for production QA.",
      operationId: "validateCountyScrape",
      security: authSecurity,
      requestBody: reqBody({
        "application/json": {
          schema: {
            type: "object",
            required: ["county", "state"],
            properties: {
              county: { type: "string" },
              state: { type: "string", minLength: 2, maxLength: 2 },
              lead_type: { type: "string" },
              days_back: { type: "integer", minimum: 1, maximum: 90 },
            },
          },
        },
      }),
      responses: {
        "200": {
          description: "Validation result with sample leads",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/ValidateScrapeResult" },
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
  "/api/v1/admin/enrich": {
    post: {
      tags: ["Admin"],
      summary: "Re-run assessor enrichment on existing leads",
      description:
        "Queries county assessor records for leads missing owner name, property address, or mailing address. Updates matching rows in the database.",
      operationId: "enrichExistingLeads",
      security: authSecurity,
      requestBody: optBody({
        "application/json": {
          schema: {
            type: "object",
            properties: {
              county: { type: "string" },
              state: { type: "string", minLength: 2, maxLength: 2 },
              limit: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
            },
          },
        },
      }),
      responses: {
        "200": {
          description: "Enrichment run complete",
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
                          processed: { type: "integer" },
                          updated: { type: "integer" },
                          stillMissingOwner: { type: "integer" },
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
} as const;

export { openApiResponses };
