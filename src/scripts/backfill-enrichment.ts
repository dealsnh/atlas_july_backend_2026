/**
 * Backfill assessor enrichment on existing portal leads.
 * Usage: pnpm exec tsx src/scripts/backfill-enrichment.ts
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

import { initDb, closeDb } from "../db/connection.js";
import {
  countLeadsNeedingEnrichment,
  enrichExistingLeads,
} from "../services/enrichment.service.js";

const BATCH = 500;
const MAX_ROUNDS = 20;

async function main(): Promise<void> {
  await initDb();

  const before = await countLeadsNeedingEnrichment({});
  console.log(`\nLeads needing enrichment: ${before}\n`);

  let totalUpdated = 0;
  let totalProcessed = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const remaining = await countLeadsNeedingEnrichment({});
    if (remaining === 0) break;

    console.log(`Round ${round}: ${remaining} leads remaining...`);
    const result = await enrichExistingLeads({ limit: BATCH });
    totalUpdated += result.updated;
    totalProcessed += result.processed;

    console.log(
      `  processed=${result.processed} updated=${result.updated} stillIncomplete=${result.stillIncomplete}`,
    );
    console.log(
      `  missing owner=${result.stillMissingOwner} address=${result.stillMissingAddress} mailing=${result.stillMissingMailing}`,
    );

    if (result.processed === 0) break;
  }

  const after = await countLeadsNeedingEnrichment({});
  console.log(`\nDone. Updated ${totalUpdated} leads (${totalProcessed} processed).`);
  console.log(`Remaining needing enrichment: ${after}\n`);

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
