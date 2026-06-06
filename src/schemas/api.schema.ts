import { z } from "zod";

export const leadsQuerySchema = z.object({
  county: z.string().optional(),
  lead_type: z.string().optional(),
  status: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const updateLeadSchema = z.object({
  status: z.string().min(1),
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
    auto_skip_trace: z.string().optional(),
    bright_data_user: z.string().optional(),
    bright_data_pass: z.string().optional(),
    attom_api_key: z.string().optional(),
  })
  .strict();

export const testEmailSchema = z.object({
  email: z.string().email().optional(),
});

export const scrapeTriggerSchema = z.object({
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export const historicalScrapeSchema = z.object({
  days_back: z.coerce.number().int().positive().max(90).optional(),
});

export const adminDeleteSchema = z
  .object({
    county: z.string().optional(),
    source_url: z.string().optional(),
    owner_name_contains: z.string().optional(),
  })
  .refine((data) => data.county || data.source_url || data.owner_name_contains, {
    message: "Must provide at least one filter: county, source_url, or owner_name_contains",
  });

export const importLeadsSchema = z.array(z.record(z.string(), z.unknown())).min(1);
