import dotenv from "dotenv";

if (process.env.NODE_ENV !== "test") {
  dotenv.config({ override: true });
}
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  CLIENT_NAME: z.string().default("Atlas"),
  CLIENT_EMAIL: z.string().default(""),
  CLIENT_COUNTIES: z.string().default("[]"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  SCRAPER_API_KEY: z.string().optional(),
  BRIGHT_DATA_USER: z.string().optional(),
  BRIGHT_DATA_PASS: z.string().optional(),
  ATTOM_API_KEY: z.string().optional(),
  SKIP_TRACE_KEY: z.string().optional(),
  SKIP_TRACE_API_URL: z.string().url().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default("587"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  API_KEY: z.string().optional(),
  JWT_SECRET: z.string().min(16).optional(),
  JWT_EXPIRES_IN: z.string().default("7d"),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
export const isTest = env.NODE_ENV === "test";

export type Env = typeof env;
