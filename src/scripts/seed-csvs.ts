/**
 * CSV seed script — import historical CSV data into SQLite.
 * Usage: pnpm seed [csv-directory]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/connection.js";
import { insertLeadIfNotExists } from "../repositories/leads.repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  getDb();
  const csvDir = process.argv[2] || path.join(__dirname, "..", "..", "seed-data");

  if (!fs.existsSync(csvDir)) {
    console.log(`[seed] No CSV directory found at ${csvDir}`);
    console.log("[seed] Create seed-data/ and add CSV files, or pass a path: pnpm seed /path/to/csvs");
    process.exit(0);
  }

  const files = fs.readdirSync(csvDir).filter((f) => f.endsWith(".csv"));
  if (files.length === 0) {
    console.log(`[seed] No CSV files in ${csvDir}`);
    process.exit(0);
  }

  let inserted = 0;
  let skipped = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(csvDir, file), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const headers = lines[0]?.split(",") ?? [];

    for (const line of lines.slice(1)) {
      const values = line.split(",");
      const row: Record<string, string | null> = {};
      headers.forEach((h, i) => {
        row[h.trim()] = values[i]?.trim() ?? null;
      });

      if (!row.id) continue;

      try {
        if (insertLeadIfNotExists(row)) inserted++;
        else skipped++;
      } catch {
        skipped++;
      }
    }
    console.log(`[seed] Processed ${file}`);
  }

  console.log(`[seed] Done: ${inserted} inserted, ${skipped} skipped`);
}

main().catch((error) => {
  console.error("[seed] Failed:", error);
  process.exit(1);
});
