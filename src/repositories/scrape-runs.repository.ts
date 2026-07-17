import { env } from "../config/env.js";
import { execute, query, queryOne } from "../db/query.js";
import type { ScrapeRun } from "../types/lead.js";

export async function logScrapeRun(fromDate: string, toDate: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    "INSERT INTO scrape_runs (county, state, lead_type) VALUES ($1, $2, $3) RETURNING id",
    ["ALL", "ALL", `${fromDate} → ${toDate}`],
  );
  return row?.id ?? 0;
}

export async function finishScrapeRun(
  id: number,
  leadsFound: number,
  error?: string,
  // Per-scraper result summary (e.g. "Hamilton OH=18 AL Bankruptcy=0 Jackson MO Tax Delinquent=ERR(...)").
  // Persisted in the existing `error` column on SUCCESS so a scraper that returned 0 — which writes no
  // raw_leads and is otherwise indistinguishable from "never dispatched" — is visible after the fact.
  // A real error takes precedence (and flips status to "error"); the summary only fills in when none.
  summary?: string,
): Promise<void> {
  await execute(
    `UPDATE scrape_runs
     SET finished_at = NOW(), status = $1, leads_found = $2, error = $3
     WHERE id = $4`,
    [error ? "error" : "success", leadsFound, error ?? summary ?? null, id],
  );
}

export async function getScrapeRuns(limit = 100): Promise<ScrapeRun[]> {
  return query<ScrapeRun>(
    `SELECT id, county, state, lead_type, started_at, finished_at, status, leads_found, error
     FROM scrape_runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit],
  );
}

export async function getKV(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>("SELECT value FROM settings WHERE key = $1", [
    `__kv_${key}`,
  ]);
  return row?.value ?? null;
}

export async function setKV(key: string, value: string): Promise<void> {
  await execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [`__kv_${key}`, value],
  );
}

export async function getLastScrapeTime(): Promise<string | null> {
  return getKV("last_scrape_time");
}

export async function setLastScrapeTime(value: string): Promise<void> {
  await setKV("last_scrape_time", value);
}

export async function isDbConnected(): Promise<boolean> {
  try {
    await queryOne("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export function getDbInfo(): { connected: boolean; url: string } {
  return {
    connected: false,
    url: env.DATABASE_URL.replace(/:[^:@/]+@/, ":****@"),
  };
}
