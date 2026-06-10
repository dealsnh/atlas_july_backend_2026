import { env } from "./env.js";

export interface ClientCounty {
  name: string;
  county: string;
  state: string;
  /** Lead types to scrape for this county (see LEAD_TYPES in api-enums.ts). */
  lead_types?: string[];
  /** publicsearch.us subdomain slug (e.g. "jackson") */
  publicsearch_slug?: string;
  /** publicsearch.us state code (e.g. "mo") */
  publicsearch_state?: string;
}

export interface ClientConfig {
  name: string;
  email: string;
  counties: ClientCounty[];
}

function parseLeadTypes(entry: Record<string, unknown>): string[] | undefined {
  const raw = entry.lead_types ?? entry.leadTypes;
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
}

function parseCounties(raw: string): ClientCounty[] {
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];

    return parsed.map((entry) => ({
      name: String(entry.name || entry.county || ""),
      county: String(entry.name || entry.county || ""),
      state: String(entry.state || ""),
      lead_types: parseLeadTypes(entry),
      publicsearch_slug: entry.publicsearch_slug ? String(entry.publicsearch_slug) : undefined,
      publicsearch_state: entry.publicsearch_state ? String(entry.publicsearch_state) : undefined,
    }));
  } catch {
    return [];
  }
}

export const clientConfig: ClientConfig = {
  name: env.CLIENT_NAME,
  email: env.CLIENT_EMAIL,
  counties: parseCounties(env.CLIENT_COUNTIES),
};

export const API_PREFIX = "/api/v1";
