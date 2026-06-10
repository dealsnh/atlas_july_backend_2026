import { lookupByAddress } from "../scrapers/assessor.js";
import { scrapeAlabama } from "../scrapers/alabama.js";
import { scrapeCounty as scrapeMissouri } from "../scrapers/missouri.js";
import { scrapeOhio } from "../scrapers/ohio.js";

async function main(): Promise<void> {
  const from = "2026-05-20";
  const to = "2026-06-06";

  const ham = await lookupByAddress("2334 KEMPER LN", "Hamilton", "OH");
  console.log("Hamilton lookup", ham);

  const code = await scrapeOhio("Hamilton", from, to, ["Code Violation"]);
  console.log(
    "Hamilton code",
    code.length,
    "saveable",
    code.filter((l) => l.owner_name?.trim()).length,
    code[0]?.owner_name?.slice(0, 40),
  );

  const madTax = await scrapeAlabama("Madison", from, to, ["Tax Delinquent"]);
  console.log("Madison tax", madTax.length, madTax[0]?.owner_name?.slice(0, 40));

  const madSher = await scrapeAlabama("Madison", from, to, ["Sheriff Sale"]);
  console.log("Madison sheriff", madSher.length, madSher[0]?.owner_name?.slice(0, 40));

  const jackTax = await scrapeMissouri("Jackson", from, to, ["Tax Delinquent"]);
  console.log("Jackson tax", jackTax.length, jackTax[0]?.owner_name?.slice(0, 40));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
