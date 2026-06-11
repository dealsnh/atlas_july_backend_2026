/**
 * Remove leads saved with placeholder owners (pre-enrichment fix cleanup).
 * Usage: pnpm exec tsx src/scripts/reconcile-placeholder-leads.ts
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

import { initDb, closeDb } from "../db/connection.js";
import { deleteLeadsByFilter } from "../repositories/leads.repository.js";
import { enrichExistingLeads } from "../services/enrichment.service.js";
import { findLeadById } from "../repositories/leads.repository.js";
import { getRawSettings } from "../services/settings.service.js";
import { skipTraceLeadsBatch } from "../services/skip-trace.service.js";

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

  console.log("2. Re-enriching remaining leads missing owner/contact...\n");
  const enriched = await enrichExistingLeads({ limit: 2000 });
  console.log(
    `  Processed: ${enriched.processed}, updated: ${enriched.updated}, still missing owner: ${enriched.stillMissingOwner}\n`,
  );

  const settings = await getRawSettings();
  if (settings.skip_trace_key) {
    console.log("3. Skip tracing enriched leads without contact info...\n");
    const { findLeadsNeedingEnrichment } = await import("../repositories/leads.repository.js");
    const needContact = await findLeadsNeedingEnrichment({ limit: 100 });
    const ids = needContact
      .filter((l) => l.owner_name && l.owner_name.length >= 2)
      .map((l) => l.id);
    if (ids.length) {
      const { traced, failed } = await skipTraceLeadsBatch(
        ids.slice(0, 50),
        findLeadById,
        settings.skip_trace_key,
        (msg) => console.log(`  ${msg}`),
      );
      console.log(`\n  Skip trace: ${traced} traced, ${failed} failed\n`);
    }
  }

  await closeDb();
  console.log("Done.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
