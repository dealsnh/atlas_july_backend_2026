export interface AppSettings {
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_pass: string;
  smtp_from: string;
  email_recipients: string;
  scraper_api_key: string;
  skip_trace_key: string;
  auto_skip_trace: string;
  bright_data_user: string;
  bright_data_pass: string;
  attom_api_key: string;
}

export type SettingsKey = keyof AppSettings;

export const SETTINGS_KEYS: SettingsKey[] = [
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_pass",
  "smtp_from",
  "email_recipients",
  "scraper_api_key",
  "skip_trace_key",
  "auto_skip_trace",
  "bright_data_user",
  "bright_data_pass",
  "attom_api_key",
];

export const SECRET_MASK = "••••••••••••••••";
