import dotenv from "dotenv";
dotenv.config({ override: true });

import { initDb, closeDb } from "../db/connection.js";
import { validateCountyScrape } from "../services/scrape.service.js";
import { isLeadSaveable } from "../services/enrichment.service.js";

async function main(): Promise<void> {
  await initDb();

  const counties = [
    { county: "Jackson", state: "MO" },
    { county: "Hamilton", state: "OH" },
    { county: "Jefferson", state: "AL", lead_type: "FSBO" },
  ];

  for (const c of counties) {
    const r = await validateCountyScrape({ ...c, days_back: 7 });
    const sample = r.sample.slice(0, 2).map((s) => ({
      lead_type: s.lead_type,
      owner: s.owner_name,
      address: s.address,
      mailing: s.mailing_address,
      saveable: isLeadSaveable(s),
    }));
    console.log(JSON.stringify({ ...c, total: r.total, saveable: r.saveable, sample }, null, 2));
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
