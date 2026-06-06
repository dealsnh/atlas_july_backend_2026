import { getDb } from "../db/connection.js";
import { env } from "../config/env.js";
import type { ScrapeRun } from "../types/lead.js";

export function logScrapeRun(fromDate: string, toDate: string): number {
  const result = getDb()
    .prepare("INSERT INTO scrape_runs (county, state, lead_type) VALUES (?, ?, ?)")
    .run("ALL", "ALL", `${fromDate} → ${toDate}`);
  return Number(result.lastInsertRowid);
}

export function finishScrapeRun(id: number, leadsFound: number, error?: string): void {
  getDb()
    .prepare(
      "UPDATE scrape_runs SET finished_at = datetime('now'), status = ?, leads_found = ?, error = ? WHERE id = ?",
    )
    .run(error ? "error" : "success", leadsFound, error ?? null, id);
}

export function getScrapeRuns(limit = 100): ScrapeRun[] {
  return getDb()
    .prepare(
      `SELECT id, county, state, lead_type, started_at, finished_at, status, leads_found, error
       FROM scrape_runs
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(limit) as ScrapeRun[];
}

export function getKV(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`__kv_${key}`) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKV(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(`__kv_${key}`, value);
}

export function getLastScrapeTime(): string | null {
  return getKV("last_scrape_time");
}

export function setLastScrapeTime(value: string): void {
  setKV("last_scrape_time", value);
}

export function isDbConnected(): boolean {
  try {
    getDb().prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export function getDbInfo(): { connected: boolean; path: string } {
  return {
    connected: isDbConnected(),
    path: env.RAILWAY_VOLUME_MOUNT_PATH || "data/atlas.db",
  };
}
