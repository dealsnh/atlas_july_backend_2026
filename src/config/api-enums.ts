/** Shared API enums — single source of truth for validation + OpenAPI docs */

export const LEAD_STATUSES = ["new", "reviewed", "contacted", "skip"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_TYPES = [
  "Pre-Foreclosure",
  "Tax Delinquent",
  "Probate",
  "Sheriff Sale",
  "FSBO",
  "Obituary",
  "Code Violation",
  "Divorce",
  "Fire Damage",
  "Bankruptcy",
  "Lis Pendens",
  "Vacant/Abandoned",
  "Out-of-State Owner",
  "Water Shutoff",
  "Foreclosure",
  "Other",
] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

export const US_STATE_CODES = ["MO", "WI", "AL", "OH", "SC", "TX", "NY", "GA", "FL"] as const;
export type UsStateCode = (typeof US_STATE_CODES)[number];

export const SCRAPE_RUN_STATUSES = ["running", "success", "error"] as const;
export type ScrapeRunStatus = (typeof SCRAPE_RUN_STATUSES)[number];

export const BOOLEAN_STRING = ["true", "false"] as const;
