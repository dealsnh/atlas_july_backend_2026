import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, isTest } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { MIGRATIONS, SCHEMA_SQL } from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDbDir(): string {
  if (isTest) {
    return path.join(__dirname, "..", "..", "data-test");
  }
  return env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "..", "..", "data");
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbDir = resolveDbDir();
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, "atlas.db");
  dbInstance = new Database(dbPath);

  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  dbInstance.exec(SCHEMA_SQL);

  for (const sql of MIGRATIONS) {
    try {
      dbInstance.exec(sql);
    } catch {
      // column already exists
    }
  }

  logger.info({ dbPath }, "SQLite database initialized");
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function isDbReady(): boolean {
  try {
    getDb().prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export function resetDbForTests(): void {
  closeDb();
  const dbDir = resolveDbDir();
  const dbPath = path.join(dbDir, "atlas.db");
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
}
