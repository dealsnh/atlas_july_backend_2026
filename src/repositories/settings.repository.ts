import { getDb } from "../db/connection.js";
import { env } from "../config/env.js";
import type { AppSettings } from "../types/settings.js";

export function getSettings(): AppSettings {
  const rows = getDb()
    .prepare("SELECT key, value FROM settings")
    .all() as Array<{ key: string; value: string }>;
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
    skip_trace_key: stored.skip_trace_key ?? env.SKIP_TRACE_KEY ?? "",
    auto_skip_trace: stored.auto_skip_trace ?? "false",
    bright_data_user: stored.bright_data_user ?? env.BRIGHT_DATA_USER ?? "",
    bright_data_pass: stored.bright_data_pass ?? env.BRIGHT_DATA_PASS ?? "",
    attom_api_key: stored.attom_api_key ?? env.ATTOM_API_KEY ?? "",
  };
}

export function saveSettings(partial: Partial<AppSettings>): void {
  const db = getDb();
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const saveMany = db.transaction((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) upsert.run(key, value);
  });
  saveMany(Object.entries(partial) as Array<[string, string]>);
}
