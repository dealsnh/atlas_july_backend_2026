// @ts-nocheck
import { unionLeadTypes } from "../config/county-lead-types.js";
import { Lead, CountyConfig } from "./base.js";
import * as missouri from "./missouri.js";
import * as alabama from "./alabama.js";
import * as ohio from "./ohio.js";
import { scrapePublicSearchLeads } from "./publicsearch-leads.js";
import { scrapeRollDerived } from "./roll-leads.js";

const STATE_WIDE_TIMEOUT_MS = 90_000;

/** Roll-derived leads (Out-of-State Owner, Probate/estate) for roll-backed counties. */
async function scrapeRollDerivedForCounty(
  county: CountyConfig,
  onProgress: ((msg: string) => void) | undefined,
  errors: string[],
): Promise<Lead[]> {
  const name = county.name || (county as { county?: string }).county || "";
  try {
    const leads = await scrapeRollDerived(name, county.state, county.leadTypes ?? []);
    if (leads.length) onProgress?.(`✓ roll-derived ${name} ${county.state}: ${leads.length} leads`);
    return leads;
  } catch (e) {
    const msg = `Error scraping roll-derived ${name} ${county.state}: ${(e as Error).message}`;
    errors.push(msg);
    onProgress?.(`✗ ${msg}`);
    return [];
  }
}

function countyName(county: CountyConfig): string {
  return county.name || (county as { county?: string }).county || "";
}

async function withTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  ms = STATE_WIDE_TIMEOUT_MS,
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

async function runStateWideScrapers(
  fns: Array<[string, () => Promise<Lead[]>]>,
  onProgress: ((msg: string) => void) | undefined,
  errors: string[],
  stateLeads: Lead[],
): Promise<void> {
  for (const [label, fn] of fns) {
    try {
      onProgress?.(`Scraping ${label}...`);
      const leads = await withTimeout(label, fn);
      stateLeads.push(...leads);
      onProgress?.(`✓ ${label}: ${leads.length} leads`);
    } catch (e) {
      const msg = `Error scraping ${label}: ${(e as Error).message}`;
      errors.push(msg);
      onProgress?.(`✗ ${msg}`);
    }
  }
}

function stateWideScrapers(
  state: string,
  fromDate: string,
  toDate: string,
): Array<[string, string, () => Promise<Lead[]>]> {
  if (state === "AL") {
    return [
      ["AL Bankruptcy", "Bankruptcy", () => alabama.scrapeBankruptcy(fromDate, toDate)],
      [
        "AL Code Violations",
        "Code Violation",
        () => alabama.scrapeCodeViolations(fromDate, toDate),
      ],
      ["AL Divorce/Eviction", "Divorce", () => alabama.scrapeDivorce(fromDate, toDate)],
      [
        "AL Out-of-State Owners",
        "Out-of-State Owner",
        () => alabama.scrapeOutOfStateOwners(fromDate, toDate),
      ],
      [
        "AL Vacant/Abandoned",
        "Vacant/Abandoned",
        () => alabama.scrapeVacantAbandoned(fromDate, toDate),
      ],
    ];
  }
  if (state === "OH") {
    return [
      ["OH Bankruptcy", "Bankruptcy", () => ohio.scrapeBankruptcy(fromDate, toDate)],
      ["OH Obituaries", "Obituary", () => ohio.scrapeObituaries(fromDate, toDate)],
      ["OH Code Violations", "Code Violation", () => ohio.scrapeCodeViolations(fromDate, toDate)],
      ["OH Divorce/Eviction", "Divorce", () => ohio.scrapeDivorce(fromDate, toDate)],
      [
        "OH Out-of-State Owners",
        "Out-of-State Owner",
        () => ohio.scrapeOutOfStateOwners(fromDate, toDate),
      ],
      [
        "OH Vacant/Abandoned",
        "Vacant/Abandoned",
        () => ohio.scrapeVacantAbandoned(fromDate, toDate),
      ],
    ];
  }
  return [];
}

async function runConfiguredStateWideScrapers(
  state: string,
  stateCounties: CountyConfig[],
  fromDate: string,
  toDate: string,
  onProgress: ((msg: string) => void) | undefined,
  errors: string[],
): Promise<Lead[]> {
  const requested = new Set(unionLeadTypes(stateCounties));
  const scrapers = stateWideScrapers(state, fromDate, toDate).filter(([, leadType]) =>
    requested.has(leadType),
  );
  if (!scrapers.length) return [];

  const wideLeads: Lead[] = [];
  await runStateWideScrapers(
    scrapers.map(([label, , fn]) => [label, fn]),
    onProgress,
    errors,
    wideLeads,
  );
  return wideLeads;
}

async function scrapePublicSearchForCounty(
  county: CountyConfig,
  fromDate: string,
  toDate: string,
  onProgress: ((msg: string) => void) | undefined,
  errors: string[],
): Promise<Lead[]> {
  const name = countyName(county);
  const types = county.leadTypes ?? [];
  if (!county.publicsearch_slug || !county.publicsearch_state) return [];

  try {
    onProgress?.(`Scraping ${name} via publicsearch.us (${types.join(", ")})...`);
    const psLeads = await scrapePublicSearchLeads(
      name,
      county.state,
      county.publicsearch_slug,
      county.publicsearch_state,
      fromDate,
      toDate,
      types,
    );
    onProgress?.(`✓ publicsearch ${name}: ${psLeads.length} leads`);
    return psLeads;
  } catch (e) {
    const msg = `Error scraping publicsearch ${name}: ${(e as Error).message}`;
    errors.push(msg);
    onProgress?.(`✗ ${msg}`);
    return [];
  }
}

// Run all scrapers for the configured counties
export async function runAllScrapers(
  counties: CountyConfig[],
  fromDate: string,
  toDate: string,
  onProgress?: (msg: string) => void,
  onLeadsBatch?: (leads: Lead[]) => Promise<void>,
): Promise<{ leads: Lead[]; errors: string[] }> {
  const allLeads: Lead[] = [];
  const errors: string[] = [];

  const stateGroups = new Map<string, CountyConfig[]>();
  for (const county of counties) {
    const key = county.state;
    if (!stateGroups.has(key)) stateGroups.set(key, []);
    stateGroups.get(key)!.push(county);
  }

  for (const [state, stateCounties] of Array.from(stateGroups)) {
    if (state === "MO") {
      for (const county of stateCounties) {
        const name = countyName(county);
        const types = county.leadTypes ?? [];
        try {
          onProgress?.(`Scraping ${name}, MO (${types.join(", ")})...`);
          const leads = await missouri.scrapeCounty(name, fromDate, toDate, types, errors);
          allLeads.push(...leads);
          onProgress?.(`✓ ${name} MO: ${leads.length} leads`);
          if (leads.length) await onLeadsBatch?.(leads);

          const psLeads = await scrapePublicSearchForCounty(
            county,
            fromDate,
            toDate,
            onProgress,
            errors,
          );
          if (psLeads.length) {
            allLeads.push(...psLeads);
            await onLeadsBatch?.(psLeads);
          }

          const rollLeads = await scrapeRollDerivedForCounty(county, onProgress, errors);
          if (rollLeads.length) {
            allLeads.push(...rollLeads);
            await onLeadsBatch?.(rollLeads);
          }
        } catch (e) {
          const msg = `Error scraping ${name} MO: ${(e as Error).message}`;
          errors.push(msg);
          onProgress?.(`✗ ${msg}`);
        }
      }
      continue;
    }

    for (const county of stateCounties) {
      const name = countyName(county);
      const types = county.leadTypes ?? [];
      const countyLeads: Lead[] = [];
      try {
        onProgress?.(`Scraping ${name}, ${county.state} (${types.join(", ")})...`);
        let leads: Lead[] = [];

        if (state === "AL") {
          leads = await alabama.scrapeAlabama(name, fromDate, toDate, types, errors);
        } else if (state === "OH") {
          leads = await ohio.scrapeOhio(name, fromDate, toDate, types, errors);
        } else {
          const msg = `No scraper registered for ${name}, ${county.state}`;
          errors.push(msg);
          onProgress?.(`✗ ${msg}`);
          continue;
        }

        countyLeads.push(...leads);
        allLeads.push(...leads);
        onProgress?.(`✓ ${name} ${county.state}: ${leads.length} leads`);

        const psLeads = await scrapePublicSearchForCounty(
          county,
          fromDate,
          toDate,
          onProgress,
          errors,
        );
        countyLeads.push(...psLeads);
        allLeads.push(...psLeads);

        const rollLeads = await scrapeRollDerivedForCounty(county, onProgress, errors);
        countyLeads.push(...rollLeads);
        allLeads.push(...rollLeads);

        if (countyLeads.length) await onLeadsBatch?.(countyLeads);
      } catch (e) {
        const msg = `Error scraping ${name} ${county.state}: ${(e as Error).message}`;
        errors.push(msg);
        onProgress?.(`✗ ${msg}`);
      }
    }

    const wideLeads = await runConfiguredStateWideScrapers(
      state,
      stateCounties,
      fromDate,
      toDate,
      onProgress,
      errors,
    );
    allLeads.push(...wideLeads);
    if (wideLeads.length) await onLeadsBatch?.(wideLeads);
  }

  return { leads: allLeads, errors };
}

export function getDefaultDateRange(): { fromDate: string; toDate: string } {
  const toDate = new Date().toISOString().split("T")[0];
  const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  return { fromDate, toDate };
}

export function getDateRange(daysBack: number): { fromDate: string; toDate: string } {
  const toDate = new Date().toISOString().split("T")[0];
  const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  return { fromDate, toDate };
}
