/**
 * Remove leads saved with placeholder owners (pre-enrichment fix cleanup).
 * Usage: pnpm exec tsx src/scripts/reconcile-placeholder-leads.ts
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

import { initDb, closeDb } from "../db/connection.js";
import { deleteLeadsByFilter } from "../repositories/leads.repository.js";
import { enrichExistingLeads } from "../services/enrichment.service.js";

async function main(): Promise<void> {
  await initDb();

  console.log(
    "\n1. Purging placeholder-owner leads (FSBO Seller, Unknown Craigslist, Tax Sale...)...\n",
  );
  const patterns = ["FSBO Seller", "Unknown (Craigslist)", "Clay County Tax Sale", "Tax Sale"];
  let purged = 0;
  for (const p of patterns) {
    const n = await deleteLeadsByFilter({ owner_name_contains: p });
    if (n > 0) console.log(`  Deleted ${n} leads matching "${p}"`);
    purged += n;
  }
  console.log(`\n  Total purged: ${purged}\n`);

  console.log("2. Re-enriching remaining leads missing owner/address/mailing...\n");
  const enriched = await enrichExistingLeads({ limit: 2000 });
  console.log(
    `  Processed: ${enriched.processed}, updated: ${enriched.updated}, still missing owner: ${enriched.stillMissingOwner}\n`,
  );

  await closeDb();
  console.log("Done.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
