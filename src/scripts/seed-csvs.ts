/**
 * CSV seed script — import historical CSV data into PostgreSQL.
 * Usage: pnpm seed [csv-directory]
 *
 * Maps each CSV's column layout to the leads table schema, generates stable IDs,
 * and uses ON CONFLICT DO NOTHING so it's safe to re-run without creating duplicates.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { closeDb, initDb } from "../db/connection.js";
import { insertLeadIfNotExists } from "../repositories/leads.repository.js";
import { query, queryOne } from "../db/query.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CUTOFF = new Date();
CUTOFF.setDate(CUTOFF.getDate() - 90);
const CUTOFF_STR = CUTOFF.toISOString().split("T")[0];

function isRecent(dateStr: string | null | undefined): boolean {
  if (!dateStr || dateStr.trim() === "") return true;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return true;
  return d >= CUTOFF;
}

function stableId(prefix: string, ...parts: Array<string | null | undefined>): string {
  const hash = createHash("md5").update(parts.join("|")).digest("hex").slice(0, 8);
  return `${prefix}-${hash}`.toUpperCase();
}

function clean(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  return s === "" || s === "NULL" || s === "null" || s === "N/A" ? null : s;
}

function toIsoDate(value: string | null): string {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function parseAddress(fullAddr: string | null): {
  address: string | null;
  city: string | null;
  zip: string | null;
} {
  if (!fullAddr) return { address: null, city: null, zip: null };
  const m = fullAddr.match(/^(.*?),\s*([^,]+),\s*[A-Z]{2}\s*(\d{5}(?:-\d{4})?)\s*$/);
  if (m) return { address: clean(m[1]), city: clean(m[2]), zip: clean(m[3]) };
  const m2 = fullAddr.match(/^(.*?)\s+([A-Z][A-Z\s]+)\s+[A-Z]{2}\s+(\d{5})\s*$/);
  if (m2) return { address: clean(m2[1]), city: clean(m2[2]?.trim()), zip: clean(m2[3]) };
  return { address: clean(fullAddr), city: null, zip: null };
}

async function readCsv(filePath: string): Promise<Array<Record<string, string>>> {
  const rows: Array<Record<string, string>> = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let headers: string[] | null = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuote = !inQuote;
      else if (ch === "," && !inQuote) {
        cols.push(cur);
        cur = "";
      } else cur += ch;
    }
    cols.push(cur);
    if (!headers) {
      headers = cols.map((h) => h.trim().replace(/^"|"$/g, ""));
      continue;
    }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] || "").trim().replace(/^"|"$/g, "");
    });
    rows.push(row);
  }
  return rows;
}

type LeadRecord = Record<string, string | null>;

async function insertBatch(records: LeadRecord[]): Promise<number> {
  let inserted = 0;
  let skippedOld = 0;

  for (const r of records) {
    if ((!r.address || r.address.length < 5) && (!r.owner_name || r.owner_name.length < 2)) {
      continue;
    }
    const dateToCheck = r.filing_date || r.scraped_at;
    if (!isRecent(dateToCheck)) {
      skippedOld++;
      continue;
    }
    if (await insertLeadIfNotExists(r)) inserted++;
  }

  if (skippedOld > 0) {
    console.log(`  (skipped ${skippedOld} records older than ${CUTOFF_STR})`);
  }
  return inserted;
}

async function importTinaLeads(filePath: string): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => ({
    id: clean(r.id) || stableId("TINA", r.county, r.lead_type, r.owner_name, r.address),
    county: clean(r.county) || "Unknown",
    state: clean(r.state) || "XX",
    lead_type: clean(r.lead_type) || "Unknown",
    owner_name: clean(r.owner_name),
    address: clean(r.address),
    city: clean(r.city),
    zip: clean(r.zip),
    mailing_address: clean(r.mailing_address),
    mailing_city: clean(r.mailing_city),
    mailing_state: clean(r.mailing_state),
    mailing_zip: clean(r.mailing_zip),
    case_number: clean(r.case_number),
    filing_date: clean(r.filing_date),
    assessed_value: clean(r.assessed_value),
    tax_year: clean(r.tax_year),
    lender: clean(r.lender),
    loan_amount: clean(r.loan_amount),
    sale_date: clean(r.sale_date),
    sale_amount: clean(r.sale_amount),
    description: clean(r.description),
    source_url: clean(r.source_url),
    raw_data: null,
    scraped_at: new Date().toISOString(),
  }));
  return insertBatch(records);
}

async function importJacksonCodeViolations(filePath: string): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => {
    const parsed = parseAddress(clean(r.final_address) || clean(r.source_address));
    return {
      id: stableId("MO-JAC-CV", r.case_number || r.pin || r.final_address),
      county: "Jackson",
      state: "MO",
      lead_type: "Code Violation",
      owner_name: clean(r.final_owner),
      address: parsed.address || clean(r.source_address),
      city: parsed.city,
      zip: clean(r.zip_code) || parsed.zip,
      mailing_address: null,
      mailing_city: null,
      mailing_state: null,
      mailing_zip: null,
      case_number: clean(r.case_number),
      filing_date: clean(r.date_found) || clean(r.scraped_date),
      assessed_value: null,
      tax_year: null,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: null,
      description: clean(r.violation_description) || clean(r.ordinance),
      source_url: clean(r.source_url),
      raw_data: JSON.stringify({
        vio_status: r.vio_status,
        chapter: r.chapter,
        detail: r.violation_detail,
      }),
      scraped_at: toIsoDate(clean(r.scraped_date)),
    };
  });
  return insertBatch(records);
}

async function importJacksonForeclosures(filePath: string): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => {
    const parsed = parseAddress(clean(r.final_address) || clean(r.source_address));
    return {
      id: stableId("MO-JAC-FC", r.suit_number || r.parcel_number || r.owner_name),
      county: "Jackson",
      state: "MO",
      lead_type: clean(r.lead_type) || "Foreclosure Auction",
      owner_name: clean(r.final_owner) || clean(r.owner_name),
      address: parsed.address || clean(r.source_address),
      city: parsed.city,
      zip: parsed.zip,
      mailing_address: null,
      mailing_city: null,
      mailing_state: null,
      mailing_zip: null,
      case_number: clean(r.suit_number),
      filing_date: clean(r.hearing_date) || clean(r.scraped_date),
      assessed_value: clean(r.market_value),
      tax_year: null,
      lender: null,
      loan_amount: clean(r.judgment_amount),
      sale_date: clean(r.date_sold),
      sale_amount: null,
      description: `Jackson County Foreclosure Auction — ${r.suit_number || ""}`,
      source_url: clean(r.source_url),
      raw_data: JSON.stringify({ parcel: r.parcel_number, purchaser: r.purchaser, sqft: r.sqft }),
      scraped_at: toIsoDate(clean(r.scraped_date)),
    };
  });
  return insertBatch(records);
}

async function importJacksonTaxDelinquent(filePath: string): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => {
    const parsed = parseAddress(
      clean(r.final_address) || clean(r.verified_address) || clean(r.source_address),
    );
    return {
      id: stableId("MO-JAC-DLT", r.suit_number || r.parcel_number || r.owner_name),
      county: "Jackson",
      state: "MO",
      lead_type: "Tax Delinquent",
      owner_name: clean(r.final_owner) || clean(r.verified_owner) || clean(r.owner_name),
      address: parsed.address || clean(r.source_address),
      city: parsed.city,
      zip: parsed.zip,
      mailing_address: null,
      mailing_city: null,
      mailing_state: null,
      mailing_zip: null,
      case_number: clean(r.suit_number),
      filing_date: clean(r.scraped_date),
      assessed_value: clean(r.market_value),
      tax_year: null,
      lender: null,
      loan_amount: clean(r.judgment_amount),
      sale_date: clean(r.date_sold),
      sale_amount: clean(r.purchase_price),
      description: `Jackson County Tax Delinquent — ${r.suit_number || r.parcel_number || ""}`,
      source_url: clean(r.source_url),
      raw_data: JSON.stringify({ parcel: r.parcel_number, legal: r.legal_description }),
      scraped_at: toIsoDate(clean(r.scraped_date)),
    };
  });
  return insertBatch(records);
}

async function importHamiltonTaxDelinquent(filePath: string): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => ({
    id: stableId("OH-HAM-DLT", r.parcel_id || `${r.owner_name ?? ""}${r.property_address ?? ""}`),
    county: "Hamilton",
    state: "OH",
    lead_type: "Tax Delinquent",
    owner_name: clean(r.owner_name),
    address: clean(r.property_address),
    city: clean(r.property_city),
    zip: clean(r.property_zip),
    mailing_address: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    case_number: clean(r.parcel_id),
    filing_date: clean(r.scraped_date),
    assessed_value: null,
    tax_year: null,
    lender: null,
    loan_amount: clean(r.unpaid_amount),
    sale_date: null,
    sale_amount: null,
    description: `Hamilton County OH Tax Delinquent — Parcel ${r.parcel_id || ""}`,
    source_url: null,
    raw_data: JSON.stringify({ property_class: r.property_class }),
    scraped_at: toIsoDate(clean(r.scraped_date)),
  }));
  return insertBatch(records);
}

async function importCassTaxDelinquent(filePath: string): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => ({
    id: stableId(
      "MO-CAS-DLT",
      r.parcel_id || r.account_number || `${r.owner_name ?? ""}${r.property_address ?? ""}`,
    ),
    county: "Cass",
    state: "MO",
    lead_type: "Tax Delinquent",
    owner_name: clean(r.owner_name),
    address: clean(r.property_address),
    city: clean(r.property_city),
    zip: clean(r.property_zip),
    mailing_address: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    case_number: clean(r.account_number),
    filing_date: clean(r.scraped_date),
    assessed_value: null,
    tax_year: null,
    lender: null,
    loan_amount: null,
    sale_date: null,
    sale_amount: null,
    description: `Cass County MO Tax Delinquent — ${r.parcel_id || r.account_number || ""}`,
    source_url: null,
    raw_data: JSON.stringify({
      parcel_id: r.parcel_id,
      legal: r.legal_description,
      subdivision: r.subdivision,
    }),
    scraped_at: toIsoDate(clean(r.scraped_date)),
  }));
  return insertBatch(records);
}

async function importClayTaxDelinquent(filePath: string): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => ({
    id: stableId(
      "MO-CLY-DLT",
      r.parcel_id || r.account_number || `${r.owner_name ?? ""}${r.property_address ?? ""}`,
    ),
    county: "Clay",
    state: "MO",
    lead_type: "Tax Delinquent",
    owner_name: clean(r.owner_name),
    address: clean(r.property_address),
    city: clean(r.property_city),
    zip: clean(r.property_zip),
    mailing_address: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    case_number: clean(r.account_number),
    filing_date: clean(r.scraped_date),
    assessed_value: null,
    tax_year: null,
    lender: null,
    loan_amount: null,
    sale_date: null,
    sale_amount: null,
    description: `Clay County MO Tax Delinquent — ${r.parcel_id || r.account_number || ""}`,
    source_url: null,
    raw_data: JSON.stringify({ parcel_id: r.parcel_id, legal: r.legal_description }),
    scraped_at: toIsoDate(clean(r.scraped_date)),
  }));
  return insertBatch(records);
}

async function importAlabamaJeffersonTaxDelinquent(
  filePath: string,
  subCounty: string,
): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => ({
    id: stableId(`AL-JEF-DLT-${subCounty.toUpperCase().slice(0, 3)}`, r.parcel_id || r.owner_name),
    county: "Jefferson",
    state: "AL",
    lead_type: "Tax Delinquent",
    owner_name: clean(r.owner_name),
    address: null,
    city: subCounty === "birmingham" ? "Birmingham" : "Bessemer",
    zip: null,
    mailing_address: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    case_number: clean(r.parcel_id),
    filing_date: clean(r.scraped_date),
    assessed_value: null,
    tax_year: clean(r.year),
    lender: null,
    loan_amount: clean(r.delinquent_amount),
    sale_date: null,
    sale_amount: null,
    description: `Jefferson County AL Tax Delinquent (${subCounty}) — ${r.parcel_id || ""} — Address lookup required`,
    source_url: clean(r.address_lookup_url),
    raw_data: JSON.stringify({ parcel_id_raw: r.parcel_id_raw, legal: r.legal_description }),
    scraped_at: toIsoDate(clean(r.scraped_date)),
  }));
  return insertBatch(records);
}

async function importAlabamaCountyTaxDelinquent(filePath: string, county: string): Promise<number> {
  const rows = await readCsv(filePath);
  if (rows.length === 0) return 0;
  const records = rows.map((r) => {
    const ownerName = clean(r.owner_name) || clean(r.Owner) || clean(r.NAME);
    const address =
      clean(r.property_address) || clean(r.address) || clean(r.Address) || clean(r.SITUS);
    const city = clean(r.property_city) || clean(r.city) || clean(r.City);
    const zip = clean(r.property_zip) || clean(r.zip) || clean(r.ZIP);
    const parcel = clean(r.parcel_id) || clean(r.parcel) || clean(r.PARCEL);
    const amount = clean(r.delinquent_amount) || clean(r.unpaid_amount) || clean(r.amount);
    return {
      id: stableId(
        `AL-${county.toUpperCase().slice(0, 3)}-DLT`,
        parcel || `${ownerName ?? ""}${address ?? ""}`,
      ),
      county,
      state: "AL",
      lead_type: "Tax Delinquent",
      owner_name: ownerName,
      address,
      city,
      zip,
      mailing_address: null,
      mailing_city: null,
      mailing_state: null,
      mailing_zip: null,
      case_number: parcel,
      filing_date: clean(r.scraped_date),
      assessed_value: null,
      tax_year: clean(r.year) || clean(r.tax_year),
      lender: null,
      loan_amount: amount,
      sale_date: null,
      sale_amount: null,
      description: `${county} County AL Tax Delinquent — ${parcel || ""}`,
      source_url: null,
      raw_data: JSON.stringify(r),
      scraped_at: toIsoDate(clean(r.scraped_date)),
    };
  });
  return insertBatch(records);
}

async function importJacksonDangerousBuildings(filePath: string): Promise<number> {
  const rows = await readCsv(filePath);
  const records = rows.map((r) => {
    const parsed = parseAddress(clean(r.final_address) || clean(r.source_address));
    return {
      id: stableId("MO-JAC-DB", r.case_number || r.pin || r.final_address),
      county: "Jackson",
      state: "MO",
      lead_type: clean(r.lead_type) || "Dangerous Building",
      owner_name: clean(r.final_owner),
      address: parsed.address || clean(r.source_address),
      city: parsed.city,
      zip: clean(r.zip_code) || parsed.zip,
      mailing_address: null,
      mailing_city: null,
      mailing_state: null,
      mailing_zip: null,
      case_number: clean(r.case_number),
      filing_date: clean(r.date_found) || clean(r.scraped_date),
      assessed_value: null,
      tax_year: null,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: null,
      description: clean(r.violation_description) || clean(r.lead_type),
      source_url: clean(r.source_url),
      raw_data: null,
      scraped_at: toIsoDate(clean(r.scraped_date)),
    };
  });
  return insertBatch(records);
}

function resolvePath(baseDir: string, filename: string): string | null {
  const full = path.join(baseDir, filename);
  return fs.existsSync(full) ? full : null;
}

async function main(): Promise<void> {
  await initDb();

  const csvDir =
    process.argv[2] || process.env.SEED_CSV_DIR || path.join(__dirname, "..", "..", "seed-data");
  console.log(`[seed] CSV directory: ${csvDir}`);
  console.log(`[seed] Only importing leads on or after ${CUTOFF_STR}`);

  const jobs: Array<{ name: string; fn: () => Promise<number> }> = [
    {
      name: "tina_leads_week",
      fn: () => {
        const p =
          resolvePath(csvDir, "tina_leads_week.csv") ||
          resolvePath(csvDir, "atlas_csvs/tina_leads_week.csv");
        return p ? importTinaLeads(p) : Promise.resolve(0);
      },
    },
    {
      name: "jackson_code_violations",
      fn: () => {
        const p = resolvePath(csvDir, "jackson_code_violations.csv");
        return p ? importJacksonCodeViolations(p) : Promise.resolve(0);
      },
    },
    {
      name: "jackson_code_violations_recent",
      fn: () => {
        const p = resolvePath(csvDir, "jackson_code_violations_recent.csv");
        return p ? importJacksonCodeViolations(p) : Promise.resolve(0);
      },
    },
    {
      name: "jackson_foreclosure_auctions",
      fn: () => {
        const p = resolvePath(csvDir, "jackson_foreclosure_auctions.csv");
        return p ? importJacksonForeclosures(p) : Promise.resolve(0);
      },
    },
    {
      name: "jackson_tax_delinquent",
      fn: () => {
        const p = resolvePath(csvDir, "jackson_tax_delinquent.csv");
        return p ? importJacksonTaxDelinquent(p) : Promise.resolve(0);
      },
    },
    {
      name: "jackson_dangerous_buildings",
      fn: () => {
        const p = resolvePath(csvDir, "jackson_dangerous_buildings.csv");
        return p ? importJacksonDangerousBuildings(p) : Promise.resolve(0);
      },
    },
    {
      name: "jackson_water_issues",
      fn: () => {
        const p = resolvePath(csvDir, "jackson_water_issues.csv");
        return p ? importJacksonDangerousBuildings(p) : Promise.resolve(0);
      },
    },
    {
      name: "hamilton_tax_delinquent",
      fn: () => {
        const p = resolvePath(csvDir, "hamilton_tax_delinquent.csv");
        return p ? importHamiltonTaxDelinquent(p) : Promise.resolve(0);
      },
    },
    {
      name: "hamilton_foreclosure_auctions",
      fn: () => {
        const p = resolvePath(csvDir, "hamilton_foreclosure_auctions.csv");
        return p ? importJacksonForeclosures(p) : Promise.resolve(0);
      },
    },
    {
      name: "cass_tax_delinquent",
      fn: () => {
        const p = resolvePath(csvDir, "cass_tax_delinquent.csv");
        return p ? importCassTaxDelinquent(p) : Promise.resolve(0);
      },
    },
    {
      name: "clay_tax_delinquent",
      fn: () => {
        const p = resolvePath(csvDir, "clay_tax_delinquent.csv");
        return p ? importClayTaxDelinquent(p) : Promise.resolve(0);
      },
    },
    {
      name: "al_jefferson_birmingham",
      fn: () => {
        const p = resolvePath(csvDir, "alabama_jefferson_birmingham_tax_delinquent.csv");
        return p ? importAlabamaJeffersonTaxDelinquent(p, "birmingham") : Promise.resolve(0);
      },
    },
    {
      name: "al_jefferson_bessemer",
      fn: () => {
        const p = resolvePath(csvDir, "alabama_jefferson_bessemer_tax_delinquent.csv");
        return p ? importAlabamaJeffersonTaxDelinquent(p, "bessemer") : Promise.resolve(0);
      },
    },
    {
      name: "al_madison",
      fn: () => {
        const p = resolvePath(csvDir, "alabama_madison_tax_delinquent.csv");
        return p ? importAlabamaCountyTaxDelinquent(p, "Madison") : Promise.resolve(0);
      },
    },
    {
      name: "al_morgan",
      fn: () => {
        const p = resolvePath(csvDir, "alabama_morgan_tax_delinquent.csv");
        return p ? importAlabamaCountyTaxDelinquent(p, "Morgan") : Promise.resolve(0);
      },
    },
    {
      name: "al_montgomery",
      fn: () => {
        const p = resolvePath(csvDir, "alabama_montgomery_tax_delinquent.csv");
        return p ? importAlabamaCountyTaxDelinquent(p, "Montgomery") : Promise.resolve(0);
      },
    },
    {
      name: "al_shelby",
      fn: () => {
        const p = resolvePath(csvDir, "alabama_shelby_tax_delinquent.csv");
        return p ? importAlabamaCountyTaxDelinquent(p, "Shelby") : Promise.resolve(0);
      },
    },
    {
      name: "al_limestone",
      fn: () => {
        const p = resolvePath(csvDir, "alabama_limestone_tax_delinquent.csv");
        return p ? importAlabamaCountyTaxDelinquent(p, "Limestone") : Promise.resolve(0);
      },
    },
  ];

  let totalInserted = 0;
  for (const job of jobs) {
    try {
      const n = await job.fn();
      if (n > 0) console.log(`[seed] ${job.name}: +${n} inserted`);
      else console.log(`[seed] ${job.name}: skipped (file missing or no new rows)`);
      totalInserted += n;
    } catch (e) {
      console.error(`[seed] ${job.name}: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const totalRow = await queryOne<{ c: string }>("SELECT COUNT(*)::int AS c FROM leads");
  console.log(
    `\n[seed] Done. Inserted ${totalInserted} new records. Total leads in DB: ${totalRow?.c ?? 0}`,
  );

  const breakdown = await query<{ county: string; state: string; lead_type: string; n: string }>(
    "SELECT county, state, lead_type, COUNT(*)::int AS n FROM leads GROUP BY county, state, lead_type ORDER BY county, lead_type",
  );
  console.log("\n[seed] Breakdown:");
  for (const row of breakdown) {
    console.log(`  ${row.county}, ${row.state} | ${row.lead_type}: ${row.n}`);
  }

  await closeDb();
}

main().catch(async (error) => {
  console.error("[seed] Failed:", error);
  await closeDb().catch(() => {});
  process.exit(1);
});
