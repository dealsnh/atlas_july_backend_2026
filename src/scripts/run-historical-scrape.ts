/**
 * Run a full historical scrape (all CLIENT_COUNTIES) and persist leads.
 * Usage: pnpm exec tsx src/scripts/run-historical-scrape.ts
 *        DAYS_BACK=90 pnpm exec tsx src/scripts/run-historical-scrape.ts
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

import { closeDb, initDb } from "../db/connection.js";
import { getDateRange, runScrapeJob } from "../services/scrape.service.js";
import { syncRuntimeConfig } from "../services/settings.service.js";

async function main(): Promise<void> {
  const daysBack = Math.min(parseInt(process.env.DAYS_BACK ?? "90", 10) || 90, 90);
  const { fromDate, toDate } = getDateRange(daysBack);

  console.log(`\nHistorical scrape: ${fromDate} → ${toDate} (${daysBack} days)\n`);

  await initDb();
  await syncRuntimeConfig();

  const newLeads = await runScrapeJob(fromDate, toDate);
  console.log(`\n✓ Done — ${newLeads} new leads saved\n`);

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
