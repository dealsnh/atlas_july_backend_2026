import dotenv from "dotenv";

dotenv.config({ override: true });

import { getDateRange } from "../scrapers/index.js";
import * as missouri from "../scrapers/missouri.js";
import * as alabama from "../scrapers/alabama.js";

async function test(
  label: string,
  fn: () => Promise<{ lead_type: string; owner_name: string | null }[]>,
) {
  const leads = await fn();
  const saveable = leads.filter((l) => (l.owner_name || "").trim().length >= 2);
  const byType: Record<string, number> = {};
  for (const l of leads) byType[l.lead_type] = (byType[l.lead_type] ?? 0) + 1;
  console.log(
    `${label}: raw=${leads.length} saveable=${saveable.length} types=${JSON.stringify(byType)}`,
  );
}

async function main(): Promise<void> {
  process.env.SCRAPER_API_KEY = "";
  const { fromDate, toDate } = getDateRange(90);
  console.log(`Window: ${fromDate} → ${toDate}\n`);

  await test("Clay MO", () => missouri.scrapeCounty("Clay", fromDate, toDate));
  await test("Platte MO", () => missouri.scrapeCounty("Platte", fromDate, toDate));
  await test("Cass MO", () => missouri.scrapeCounty("Cass", fromDate, toDate));
  await test("Jefferson AL", () => alabama.scrapeAlabama("Jefferson", fromDate, toDate));
  await test("Shelby AL", () => alabama.scrapeAlabama("Shelby", fromDate, toDate));
  await test("Morgan AL", () => alabama.scrapeAlabama("Morgan", fromDate, toDate));
  await test("Limestone AL", () => alabama.scrapeAlabama("Limestone", fromDate, toDate));
  await test("Montgomery AL", () => alabama.scrapeAlabama("Montgomery", fromDate, toDate));
  await test("Autauga AL", () => alabama.scrapeAlabama("Autauga", fromDate, toDate));
  await test("Elmore AL", () => alabama.scrapeAlabama("Elmore", fromDate, toDate));
}

main().catch(console.error);
