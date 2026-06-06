import {
  BOOLEAN_STRING,
  LEAD_STATUSES,
  LEAD_TYPES,
  SCRAPE_RUN_STATUSES,
  US_STATE_CODES,
} from "../../config/api-enums.js";

export const openApiSchemas = {
  LeadStatus: {
    type: "string",
    enum: [...LEAD_STATUSES],
    description: "Lead workflow status",
  },
  LeadType: {
    type: "string",
    enum: [...LEAD_TYPES],
    description: "Category of motivated seller lead",
  },
  UsStateCode: {
    type: "string",
    enum: [...US_STATE_CODES],
    description: "US state code for scrape targets",
  },
  ScrapeRunStatus: {
    type: "string",
    enum: [...SCRAPE_RUN_STATUSES],
  },
  BooleanString: {
    type: "string",
    enum: [...BOOLEAN_STRING],
  },
  ApiSuccessEnvelope: {
    type: "object",
    required: ["success", "data"],
    properties: {
      success: { type: "boolean", example: true },
      data: { type: "object" },
    },
  },
  ApiErrorEnvelope: {
    type: "object",
    required: ["success", "error"],
    properties: {
      success: { type: "boolean", example: false },
      error: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", example: "Validation failed" },
          details: { type: "object", additionalProperties: true },
          stack: { type: "string" },
        },
      },
      requestId: { type: "string", format: "uuid" },
    },
  },
  Lead: {
    type: "object",
    required: ["id", "county", "state", "lead_type"],
    properties: {
      id: { type: "string", example: "MO-JACKSON-PREFC-001" },
      county: { type: "string", example: "Jackson" },
      state: { $ref: "#/components/schemas/UsStateCode" },
      lead_type: { $ref: "#/components/schemas/LeadType" },
      owner_name: { type: "string", nullable: true },
      address: { type: "string", nullable: true },
      city: { type: "string", nullable: true },
      zip: { type: "string", nullable: true },
      mailing_address: { type: "string", nullable: true },
      mailing_city: { type: "string", nullable: true },
      mailing_state: { type: "string", nullable: true },
      mailing_zip: { type: "string", nullable: true },
      case_number: { type: "string", nullable: true },
      filing_date: { type: "string", format: "date", nullable: true },
      assessed_value: { type: "string", nullable: true },
      tax_year: { type: "string", nullable: true },
      lender: { type: "string", nullable: true },
      loan_amount: { type: "string", nullable: true },
      sale_date: { type: "string", nullable: true },
      sale_amount: { type: "string", nullable: true },
      description: { type: "string", nullable: true },
      source_url: { type: "string", format: "uri", nullable: true },
      raw_data: { type: "string", nullable: true },
      status: { $ref: "#/components/schemas/LeadStatus" },
      notes: { type: "string", nullable: true },
      skip_traced: { oneOf: [{ type: "integer" }, { type: "boolean" }] },
      st_phone: { type: "string", nullable: true },
      st_email: { type: "string", nullable: true },
      st_mailing: { type: "string", nullable: true },
      scraped_at: { type: "string", format: "date-time" },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  LeadListData: {
    type: "object",
    required: ["leads", "total"],
    properties: {
      leads: { type: "array", items: { $ref: "#/components/schemas/Lead" } },
      total: { type: "integer", example: 42 },
    },
  },
  LeadStats: {
    type: "object",
    properties: {
      total: { type: "integer", example: 1200 },
      today: { type: "integer", example: 15 },
      byType: {
        type: "array",
        items: {
          type: "object",
          properties: {
            lead_type: { $ref: "#/components/schemas/LeadType" },
            count: { type: "integer" },
          },
        },
      },
      byCounty: {
        type: "array",
        items: {
          type: "object",
          properties: {
            county: { type: "string" },
            count: { type: "integer" },
          },
        },
      },
      lastRun: { type: "string", format: "date-time", nullable: true },
      lastScrapeTime: { type: "string", format: "date-time", nullable: true },
    },
  },
  ClientConfig: {
    type: "object",
    properties: {
      name: { type: "string", example: "Atlas" },
      counties: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            county: { type: "string" },
            state: { type: "string", enum: [...US_STATE_CODES] },
          },
        },
      },
    },
  },
  SettingsMasked: {
    type: "object",
    properties: {
      smtp_host: { type: "string" },
      smtp_port: { type: "string", example: "587" },
      smtp_user: { type: "string" },
      smtp_pass: { type: "string", description: "Masked when set", example: "••••••••••••••••" },
      smtp_from: { type: "string" },
      email_recipients: { type: "string", description: "Comma-separated emails" },
      scraper_api_key: { type: "string" },
      skip_trace_key: { type: "string" },
      auto_skip_trace: { type: "string", enum: [...BOOLEAN_STRING] },
      bright_data_user: { type: "string" },
      bright_data_pass: { type: "string" },
      attom_api_key: { type: "string" },
      smtp_configured: { type: "boolean" },
      scraper_api_configured: { type: "boolean" },
      skip_trace_configured: { type: "boolean" },
      bright_data_configured: { type: "boolean" },
      attom_configured: { type: "boolean" },
    },
  },
  SettingsUpdate: {
    type: "object",
    additionalProperties: false,
    properties: {
      smtp_host: { type: "string" },
      smtp_port: { type: "string" },
      smtp_user: { type: "string" },
      smtp_pass: { type: "string" },
      smtp_from: { type: "string" },
      email_recipients: { type: "string" },
      scraper_api_key: { type: "string" },
      skip_trace_key: { type: "string" },
      auto_skip_trace: { type: "string", enum: [...BOOLEAN_STRING] },
      bright_data_user: { type: "string" },
      bright_data_pass: { type: "string" },
      attom_api_key: { type: "string" },
    },
  },
  ScrapeStatus: {
    type: "object",
    properties: {
      in_progress: { type: "boolean" },
      log: { type: "array", items: { type: "string" } },
    },
  },
  ScrapeRun: {
    type: "object",
    properties: {
      id: { type: "integer" },
      county: { type: "string" },
      state: { type: "string" },
      lead_type: { type: "string" },
      started_at: { type: "string", format: "date-time" },
      finished_at: { type: "string", format: "date-time", nullable: true },
      status: { $ref: "#/components/schemas/ScrapeRunStatus" },
      leads_found: { type: "integer" },
      error: { type: "string", nullable: true },
    },
  },
  UpdateLeadBody: {
    type: "object",
    required: ["status"],
    properties: {
      status: { $ref: "#/components/schemas/LeadStatus" },
      notes: { type: "string" },
    },
  },
  ScrapeTriggerBody: {
    type: "object",
    properties: {
      from_date: { type: "string", format: "date", example: "2026-01-01" },
      to_date: { type: "string", format: "date", example: "2026-01-07" },
    },
  },
  HistoricalScrapeBody: {
    type: "object",
    properties: {
      days_back: { type: "integer", minimum: 1, maximum: 90, default: 30, example: 30 },
    },
  },
  TestEmailBody: {
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
    },
  },
  AdminDeleteBody: {
    type: "object",
    properties: {
      county: { type: "string" },
      source_url: { type: "string", format: "uri" },
      owner_name_contains: { type: "string" },
    },
    description: "At least one filter field is required.",
  },
  ImportResult: {
    type: "object",
    properties: {
      inserted: { type: "integer" },
      skipped: { type: "integer" },
      total: { type: "integer" },
    },
  },
  OkResponse: {
    type: "object",
    properties: {
      ok: { type: "boolean", example: true },
    },
  },
} as const;

export const openApiParameters = {
  CountyQuery: {
    name: "county",
    in: "query",
    schema: { type: "string" },
    description: "Filter by county name",
  },
  LeadTypeQuery: {
    name: "lead_type",
    in: "query",
    schema: { $ref: "#/components/schemas/LeadType" },
    description: "Filter by lead type",
  },
  StatusQuery: {
    name: "status",
    in: "query",
    schema: { $ref: "#/components/schemas/LeadStatus" },
    description: "Filter by lead status",
  },
  FromDateQuery: {
    name: "from_date",
    in: "query",
    schema: { type: "string", format: "date" },
  },
  ToDateQuery: {
    name: "to_date",
    in: "query",
    schema: { type: "string", format: "date" },
  },
  LimitQuery: {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 5000, default: 100 },
  },
  OffsetQuery: {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
  LeadIdParam: {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Lead ID",
  },
} as const;

export const openApiResponses = {
  BadRequest: {
    description: "Validation error",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ApiErrorEnvelope" },
      },
    },
  },
  Unauthorized: {
    description: "Missing or invalid API key",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ApiErrorEnvelope" },
      },
    },
  },
  NotFound: {
    description: "Resource not found",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ApiErrorEnvelope" },
      },
    },
  },
  Conflict: {
    description: "Conflict (e.g. scrape already in progress)",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ApiErrorEnvelope" },
      },
    },
  },
  NotImplemented: {
    description: "Feature not yet implemented",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ApiErrorEnvelope" },
      },
    },
  },
} as const;
