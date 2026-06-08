import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { seedAdminUserIfNeeded } from "../services/auth.service.js";
import { CLEANUP_JUNK_LEADS_SQL, SCHEMA_SQL } from "./schema.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("Database not initialized — call initDb() first");
  }
  return pool;
}

export async function initDb(): Promise<void> {
  if (pool) return;

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    max: env.DATABASE_POOL_SIZE,
  });

  await pool.query(SCHEMA_SQL);

  const cleanup = await pool.query(CLEANUP_JUNK_LEADS_SQL);
  if (cleanup.rowCount && cleanup.rowCount > 0) {
    logger.info({ deleted: cleanup.rowCount }, "Cleaned junk leads missing address and owner");
  }

  logger.info("PostgreSQL database initialized");
  await seedAdminUserIfNeeded();
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function isDbReady(): Promise<boolean> {
  try {
    if (!pool) return false;
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function resetDbForTests(): Promise<void> {
  await initDb();
  await getPool().query(
    "TRUNCATE TABLE leads, scrape_runs, settings, users RESTART IDENTITY CASCADE",
  );
}
