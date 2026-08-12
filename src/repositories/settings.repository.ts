import { env } from "../config/env.js";
import { execute, query } from "../db/query.js";
import type { AppSettings } from "../types/settings.js";

export async function getSettings(): Promise<AppSettings> {
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings");
  const stored: Record<string, string> = {};
  for (const row of rows) stored[row.key] = row.value;

  return {
    smtp_host: stored.smtp_host ?? env.SMTP_HOST ?? "",
    smtp_port: stored.smtp_port ?? env.SMTP_PORT ?? "587",
    smtp_user: stored.smtp_user ?? env.SMTP_USER ?? "",
    smtp_pass: stored.smtp_pass ?? env.SMTP_PASS ?? "",
    smtp_from: stored.smtp_from ?? env.SMTP_FROM ?? "",
    email_recipients: stored.email_recipients ?? env.CLIENT_EMAIL ?? "",
    scraper_api_key: stored.scraper_api_key ?? env.SCRAPER_API_KEY ?? "",
    // Railway/env key wins when set — avoids stale DB key blocking Tracerfy deploys
    skip_trace_key: env.SKIP_TRACE_KEY || stored.skip_trace_key || "",
    auto_skip_trace: stored.auto_skip_trace ?? "false",
    bright_data_user: stored.bright_data_user ?? env.BRIGHT_DATA_USER ?? "",
    bright_data_pass: stored.bright_data_pass ?? env.BRIGHT_DATA_PASS ?? "",
    attom_api_key: stored.attom_api_key ?? env.ATTOM_API_KEY ?? "",
    daily_scrape_paused: stored.daily_scrape_paused ?? "false",
  };
}

export async function saveSettings(partial: Partial<AppSettings>): Promise<void> {
  for (const [key, value] of Object.entries(partial) as Array<[string, string]>) {
    await execute(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
}
