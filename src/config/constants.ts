import { env } from "./env.js";

export interface ClientCounty {
  name: string;
  county: string;
  state: string;
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

function parseCounties(raw: string): ClientCounty[] {
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, string>>;
    if (!Array.isArray(parsed)) return [];

    return parsed.map((entry) => ({
      name: entry.name || entry.county || "",
      county: entry.name || entry.county || "",
      state: entry.state || "",
      publicsearch_slug: entry.publicsearch_slug,
      publicsearch_state: entry.publicsearch_state,
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
