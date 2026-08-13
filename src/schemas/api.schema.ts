import { z } from "zod";
import { BOOLEAN_STRING, LEAD_STATUSES, LEAD_TYPES } from "../config/api-enums.js";

export const leadsQuerySchema = z.object({
  county: z.string().optional(),
  // County names are not unique across states — the client tracks both Hamilton OH
  // and Hamilton TN — so county alone would mix two counties' leads in one view.
  state: z.string().length(2).optional(),
  lead_type: z.enum(LEAD_TYPES).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  include_pending: z.enum(["true", "false"]).optional(),
});

export const updateLeadSchema = z.object({
  status: z.enum(LEAD_STATUSES),
  notes: z.string().optional(),
});

export const leadIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const settingsSchema = z
  .object({
    smtp_host: z.string().optional(),
    smtp_port: z.string().optional(),
    smtp_user: z.string().optional(),
    smtp_pass: z.string().optional(),
    smtp_from: z.string().optional(),
    email_recipients: z.string().optional(),
    scraper_api_key: z.string().optional(),
    skip_trace_key: z.string().optional(),
    auto_skip_trace: z.enum(BOOLEAN_STRING).optional(),
    bright_data_user: z.string().optional(),
    bright_data_pass: z.string().optional(),
    attom_api_key: z.string().optional(),
    daily_scrape_paused: z.enum(BOOLEAN_STRING).optional(),
  })
  .strict();

export const scrapeScheduleSchema = z.object({
  paused: z.boolean(),
});

export const testEmailSchema = z.object({
  email: z.string().email().optional(),
});

export const scrapeTriggerSchema = z.object({
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  county: z.string().optional(),
  /** Disambiguates a targeted scrape when the county name exists in two states. */
  state: z.string().length(2).optional(),
  lead_type: z.string().optional(),
});

export const historicalScrapeSchema = z.object({
  days_back: z.coerce.number().int().positive().max(90).optional(),
});

export const adminDeleteSchema = z
  .object({
    county: z.string().optional(),
    /** Narrows a by-county delete to one state — Hamilton exists in both OH and TN. */
    state: z.string().length(2).optional(),
    source_url: z.string().optional(),
    owner_name_contains: z.string().optional(),
  })
  .refine((data) => data.county || data.source_url || data.owner_name_contains, {
    message: "Must provide at least one filter: county, source_url, or owner_name_contains",
  });

export const validateScrapeSchema = z.object({
  county: z.string().min(1),
  state: z.string().length(2),
  lead_type: z.enum(LEAD_TYPES).optional(),
  days_back: z.coerce.number().int().positive().max(90).optional(),
});

export const enrichLeadsSchema = z.object({
  county: z.string().optional(),
  state: z.string().length(2).optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});
