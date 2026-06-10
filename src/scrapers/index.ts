// @ts-nocheck
import { unionLeadTypes } from "../config/county-lead-types.js";
import { Lead, CountyConfig } from "./base.js";
import * as missouri from "./missouri.js";
import * as wisconsin from "./wisconsin.js";
import * as alabama from "./alabama.js";
import * as ohio from "./ohio.js";
import * as southCarolina from "./south_carolina.js";
import { scrapePublicSearchLeads } from "./publicsearch-leads.js";

const STATE_WIDE_TIMEOUT_MS = 90_000;

function countyName(county: CountyConfig): string {
  return county.name || (county as { county?: string }).county || "";
}

async function withTimeout<T>(label: string, fn: () => Promise<T>, ms = STATE_WIDE_TIMEOUT_MS): Promise<T> {
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
      ["AL Code Violations", "Code Violation", () => alabama.scrapeCodeViolations(fromDate, toDate)],
      ["AL Divorce/Eviction", "Divorce", () => alabama.scrapeDivorce(fromDate, toDate)],
      ["AL Out-of-State Owners", "Out-of-State Owner", () => alabama.scrapeOutOfStateOwners(fromDate, toDate)],
      ["AL Vacant/Abandoned", "Vacant/Abandoned", () => alabama.scrapeVacantAbandoned(fromDate, toDate)],
    ];
  }
  if (state === "OH") {
    return [
      ["OH Bankruptcy", "Bankruptcy", () => ohio.scrapeBankruptcy(fromDate, toDate)],
      ["OH Obituaries", "Obituary", () => ohio.scrapeObituaries(fromDate, toDate)],
      ["OH Code Violations", "Code Violation", () => ohio.scrapeCodeViolations(fromDate, toDate)],
      ["OH Divorce/Eviction", "Divorce", () => ohio.scrapeDivorce(fromDate, toDate)],
      ["OH Out-of-State Owners", "Out-of-State Owner", () => ohio.scrapeOutOfStateOwners(fromDate, toDate)],
      ["OH Vacant/Abandoned", "Vacant/Abandoned", () => ohio.scrapeVacantAbandoned(fromDate, toDate)],
    ];
  }
  if (state === "SC") {
    return [
      ["SC Bankruptcy", "Bankruptcy", () => southCarolina.scrapeBankruptcy(fromDate, toDate)],
      ["SC Obituaries", "Obituary", () => southCarolina.scrapeObituaries(fromDate, toDate)],
      ["SC FSBO", "FSBO", () => southCarolina.scrapeFSBO(fromDate, toDate)],
      ["SC Code Violations", "Code Violation", () => southCarolina.scrapeCodeViolations(fromDate, toDate)],
      ["SC Divorce/Eviction", "Divorce", () => southCarolina.scrapeDivorce(fromDate, toDate)],
      ["SC Out-of-State Owners", "Out-of-State Owner", () => southCarolina.scrapeOutOfStateOwners(fromDate, toDate)],
      ["SC Vacant/Abandoned", "Vacant/Abandoned", () => southCarolina.scrapeVacantAbandoned(fromDate, toDate)],
    ];
  }
  if (state === "WI") {
    return [
      ["WI Obituaries", "Obituary", () => wisconsin.scrapeObituaries(fromDate, toDate)],
      ["WI FSBO", "FSBO", () => wisconsin.scrapeFSBO(fromDate, toDate)],
      ["WI Bankruptcy", "Bankruptcy", () => wisconsin.scrapeBankruptcy(fromDate, toDate)],
      ["WI Code Violations", "Code Violation", () => wisconsin.scrapeCodeViolations(fromDate, toDate)],
      ["WI Divorce/Eviction", "Divorce", () => wisconsin.scrapeDivorce(fromDate, toDate)],
      ["WI Out-of-State Owners", "Out-of-State Owner", () => wisconsin.scrapeOutOfStateOwners(fromDate, toDate)],
      ["WI Vacant/Abandoned", "Vacant/Abandoned", () => wisconsin.scrapeVacantAbandoned(fromDate, toDate)],
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
  stateLeads: Lead[],
): Promise<void> {
  const requested = new Set(unionLeadTypes(stateCounties));
  const scrapers = stateWideScrapers(state, fromDate, toDate).filter(([, leadType]) =>
    requested.has(leadType),
  );
  if (!scrapers.length) return;

  await runStateWideScrapers(
    scrapers.map(([label, , fn]) => [label, fn]),
    onProgress,
    errors,
    stateLeads,
  );
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
    const stateLeads: Lead[] = [];

    if (state === "MO") {
      for (const county of stateCounties) {
        const name = countyName(county);
        const types = county.leadTypes ?? [];
        try {
          onProgress?.(`Scraping ${name}, MO (${types.join(", ")})...`);
          const leads = await missouri.scrapeCounty(name, fromDate, toDate, types);
          allLeads.push(...leads);
          stateLeads.push(...leads);
          onProgress?.(`✓ ${name} MO: ${leads.length} leads`);
          if (leads.length) await onLeadsBatch?.(leads);
        } catch (e) {
          const msg = `Error scraping ${name} MO: ${(e as Error).message}`;
          errors.push(msg);
          onProgress?.(`✗ ${msg}`);
        }
      }
      continue;
    }

    if (state === "WI") {
      for (const county of stateCounties) {
        const name = countyName(county);
        const types = county.leadTypes ?? [];
        try {
          onProgress?.(`Scraping ${name}, WI (${types.join(", ")})...`);
          const leads = await wisconsin.scrapeCounty(name, fromDate, toDate, types);
          allLeads.push(...leads);
          stateLeads.push(...leads);
          onProgress?.(`✓ ${name} WI: ${leads.length} leads`);
        } catch (e) {
          const msg = `Error scraping ${name} WI: ${(e as Error).message}`;
          errors.push(msg);
          onProgress?.(`✗ ${msg}`);
        }
      }

      const beforeWide = stateLeads.length;
      await runConfiguredStateWideScrapers(
        state,
        stateCounties,
        fromDate,
        toDate,
        onProgress,
        errors,
        stateLeads,
      );
      allLeads.push(...stateLeads.slice(beforeWide));
      if (stateLeads.length) await onLeadsBatch?.(stateLeads);
      continue;
    }

    for (const county of stateCounties) {
      const name = countyName(county);
      const types = county.leadTypes ?? [];
      try {
        onProgress?.(`Scraping ${name}, ${county.state} (${types.join(", ")})...`);
        let leads: Lead[] = [];

        if (state === "AL") {
          leads = await alabama.scrapeAlabama(name, fromDate, toDate, types);
        } else if (state === "OH") {
          leads = await ohio.scrapeOhio(name, fromDate, toDate, types);
        } else if (state === "SC") {
          leads = await southCarolina.scrapeSC(name, fromDate, toDate, types);
        } else {
          const msg = `No scraper registered for ${name}, ${county.state}`;
          errors.push(msg);
          onProgress?.(`✗ ${msg}`);
          continue;
        }

        allLeads.push(...leads);
        stateLeads.push(...leads);
        onProgress?.(`✓ ${name} ${county.state}: ${leads.length} leads`);

        if (county.publicsearch_slug && county.publicsearch_state) {
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
            allLeads.push(...psLeads);
            stateLeads.push(...psLeads);
            onProgress?.(`✓ publicsearch ${name}: ${psLeads.length} leads`);
          } catch (e) {
            const msg = `Error scraping publicsearch ${name}: ${(e as Error).message}`;
            errors.push(msg);
            onProgress?.(`✗ ${msg}`);
          }
        }
      } catch (e) {
        const msg = `Error scraping ${name} ${county.state}: ${(e as Error).message}`;
        errors.push(msg);
        onProgress?.(`✗ ${msg}`);
      }
    }

    const beforeWide = stateLeads.length;
    await runConfiguredStateWideScrapers(
      state,
      stateCounties,
      fromDate,
      toDate,
      onProgress,
      errors,
      stateLeads,
    );
    allLeads.push(...stateLeads.slice(beforeWide));

    if (stateLeads.length) await onLeadsBatch?.(stateLeads);
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
  const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  return { fromDate, toDate };
}
