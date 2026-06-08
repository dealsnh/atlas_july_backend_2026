import { clientConfig } from "../config/constants.js";
import { getSettings, saveSettings } from "../repositories/settings.repository.js";
import type { AppSettings } from "../types/settings.js";
import { SECRET_MASK, SETTINGS_KEYS } from "../types/settings.js";
import { logger } from "../utils/logger.js";

export async function syncRuntimeConfig(): Promise<void> {
  const settings = await getSettings();
  if (settings.scraper_api_key) process.env.SCRAPER_API_KEY = settings.scraper_api_key;
  if (settings.bright_data_user) process.env.BRIGHT_DATA_USER = settings.bright_data_user;
  if (settings.bright_data_pass) process.env.BRIGHT_DATA_PASS = settings.bright_data_pass;
  if (settings.attom_api_key) process.env.ATTOM_API_KEY = settings.attom_api_key;
  if (settings.skip_trace_key) process.env.SKIP_TRACE_KEY = settings.skip_trace_key;
  logger.debug("Runtime scraper config synced from settings");
}

export async function getMaskedSettings() {
  const s = await getSettings();
  const isPlaceholder = (v: string) => !v || v.startsWith("placeholder");

  return {
    smtp_host: s.smtp_host,
    smtp_port: s.smtp_port,
    smtp_user: s.smtp_user,
    smtp_pass: s.smtp_pass && !isPlaceholder(s.smtp_pass) ? SECRET_MASK : "",
    smtp_from: s.smtp_from,
    email_recipients: s.email_recipients,
    scraper_api_key: s.scraper_api_key ? SECRET_MASK : "",
    skip_trace_key: s.skip_trace_key ? SECRET_MASK : "",
    auto_skip_trace: s.auto_skip_trace,
    bright_data_user: s.bright_data_user || "",
    bright_data_pass: s.bright_data_pass ? SECRET_MASK : "",
    attom_api_key: s.attom_api_key ? SECRET_MASK : "",
    smtp_configured: !!(s.smtp_host && s.smtp_user && s.smtp_pass && !isPlaceholder(s.smtp_pass)),
    scraper_api_configured: !!s.scraper_api_key,
    skip_trace_configured: !!s.skip_trace_key,
    bright_data_configured: !!(s.bright_data_user && s.bright_data_pass),
    attom_configured: !!s.attom_api_key,
  };
}

export async function updateSettings(body: Record<string, unknown>): Promise<void> {
  const partial: Partial<AppSettings> = {};

  for (const key of SETTINGS_KEYS) {
    if (body[key] !== undefined && body[key] !== SECRET_MASK) {
      partial[key] = String(body[key]);
    }
  }

  await saveSettings(partial);
  await syncRuntimeConfig();
}

export async function getRawSettings(): Promise<AppSettings> {
  return getSettings();
}

export async function getEmailRecipients(): Promise<string[]> {
  const settings = await getSettings();
  const fromSettings = settings.email_recipients
    ? settings.email_recipients.split(",").map((e) => e.trim()).filter(Boolean)
    : [];
  if (fromSettings.length > 0) return fromSettings;
  return clientConfig.email ? [clientConfig.email] : [];
}

export function isSmtpReady(settings: AppSettings): boolean {
  return !!(
    settings.smtp_host &&
    settings.smtp_user &&
    settings.smtp_pass &&
    !settings.smtp_pass.startsWith("placeholder")
  );
}
