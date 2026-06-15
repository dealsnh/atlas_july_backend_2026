/**
 * County × lead-type status report for Tina Phase 1.
 * Usage: pnpm report:counties
 *        DAYS_BACK=30 pnpm report:counties
 *        OUTPUT=reports/tina-status.csv pnpm report:counties
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import dotenv from "dotenv";

dotenv.config({ override: true });

import { closeDb, initDb } from "../db/connection.js";
import { COUNTY_DEFAULT_LEAD_TYPES } from "../config/county-lead-types.js";
import { validateCountyScrape } from "../services/scrape.service.js";
import { syncRuntimeConfig } from "../services/settings.service.js";

const DAYS_BACK = Math.min(parseInt(process.env.DAYS_BACK ?? "30", 10) || 30, 90);
const OUTPUT = process.env.OUTPUT ?? "reports/tina-county-status.csv";

type Status = "PASS" | "SCRAPE_ONLY" | "FAIL" | "ERROR";

function parseCountyKey(key: string): { county: string; state: string } {
  const [state, county] = key.split(":");
  if (!state || !county) throw new Error(`Invalid county key: ${key}`);
  return { county, state };
}

function classify(
  total: number,
  saveable: number,
  errors: string[],
): { status: Status; notes: string } {
  if (errors.length) {
    return { status: "ERROR", notes: errors.slice(0, 2).join("; ") };
  }
  if (saveable > 0) return { status: "PASS", notes: "" };
  if (total > 0) return { status: "SCRAPE_ONLY", notes: "scraped but not saveable after enrichment" };
  return { status: "FAIL", notes: "zero scraped rows" };
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function main(): Promise<void> {
  await initDb();
  await syncRuntimeConfig();

  const rows: string[] = [
    "county,state,lead_type,scraped_total,saveable,errors,status,notes",
  ];

  let pass = 0;
  let fail = 0;
  const entries = Object.entries(COUNTY_DEFAULT_LEAD_TYPES);

  console.log(`\nCounty status report (${entries.length} counties, ${DAYS_BACK}-day window)\n`);

  for (const [key, leadTypes] of entries) {
    const { county, state } = parseCountyKey(key);
    for (const lead_type of leadTypes) {
      process.stdout.write(`  … ${county} ${state} / ${lead_type}`);
      try {
        const result = await validateCountyScrape({
          county,
          state,
          lead_type,
          days_back: DAYS_BACK,
        });
        const { status, notes } = classify(result.total, result.saveable, result.errors);
        if (status === "PASS") pass++;
        if (status === "FAIL" || status === "ERROR") fail++;

        const line = [
          county,
          state,
          lead_type,
          String(result.total),
          String(result.saveable),
          String(result.errors.length),
          status,
          notes,
        ]
          .map(csvEscape)
          .join(",");
        rows.push(line);
        process.stdout.write(
          `\r${status.padEnd(11)} ${county} ${state} | ${lead_type} total=${result.total} saveable=${result.saveable}\n`,
        );
      } catch (e) {
        fail++;
        const msg = (e as Error).message;
        rows.push(
          [county, state, lead_type, "0", "0", "1", "ERROR", msg].map(csvEscape).join(","),
        );
        process.stdout.write(`\rERROR       ${county} ${state} | ${lead_type} — ${msg}\n`);
      }
    }
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, rows.join("\n") + "\n", "utf8");

  console.log(`\n=== ${pass}/${rows.length - 1} PASS, ${fail} FAIL/ERROR ===`);
  console.log(`Wrote ${OUTPUT}\n`);

  await closeDb();
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
