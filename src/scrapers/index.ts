// @ts-nocheck
import { Lead, CountyConfig } from "./base.js";
import * as missouri from "./missouri.js";
import * as wisconsin from "./wisconsin.js";
import * as alabama from "./alabama.js";
import * as ohio from "./ohio.js";
import * as southCarolina from "./south_carolina.js";
import { scrapePublicSearchLeads } from "./publicsearch-leads.js";

const STATE_WIDE_TIMEOUT_MS = 90_000;

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

  // Group counties by state
  const stateGroups = new Map<string, CountyConfig[]>();
  for (const county of counties) {
    const key = county.state;
    if (!stateGroups.has(key)) stateGroups.set(key, []);
    stateGroups.get(key)!.push(county);
  }

  for (const [state, stateCounties] of Array.from(stateGroups)) {
    // States with a single scrapeAll function (all 11 lead types)
    if (state === "MO") {
      try {
        const targeted =
          stateCounties.length === 1 &&
          stateCounties[0].leadTypes?.length > 0 &&
          stateCounties[0].leadTypes.length < 11;
        if (targeted) {
          const c = stateCounties[0];
          onProgress?.(
            `Scraping ${c.name}, MO (${c.leadTypes.join(", ")})...`,
          );
          const leads = await missouri.scrapeCounty(
            c.name,
            fromDate,
            toDate,
            c.leadTypes,
          );
          allLeads.push(...leads);
          onProgress?.(`✓ ${c.name} MO: ${leads.length} leads`);
          if (leads.length) await onLeadsBatch?.(leads);
        } else {
          onProgress?.(`Scraping Missouri (all 11 lead types)...`);
          const leads = await missouri.scrapeAll(fromDate, toDate);
          allLeads.push(...leads);
          onProgress?.(`✓ MO: ${leads.length} leads found`);
          if (leads.length) await onLeadsBatch?.(leads);
        }
      } catch (e) {
        const msg = `Error scraping MO: ${(e as Error).message}`;
        errors.push(msg);
        onProgress?.(`✗ ${msg}`);
      }
      continue;
    }
    if (state === "WI") {
      try {
        onProgress?.(`Scraping Wisconsin (all 11 lead types)...`);
        const leads = await wisconsin.scrapeAll(fromDate, toDate);
        allLeads.push(...leads);
        onProgress?.(`✓ WI: ${leads.length} leads found`);
        if (leads.length) await onLeadsBatch?.(leads);
      } catch (e) {
        const msg = `Error scraping WI: ${(e as Error).message}`;
        errors.push(msg);
        onProgress?.(`✗ ${msg}`);
      }
      continue;
    }

    const stateLeads: Lead[] = [];
    // States with county-by-county scrapers (AL, OH, SC)
    for (const county of stateCounties) {
      try {
        onProgress?.(`Scraping ${(county.name || (county as any).county || "")}, ${county.state} (all 11 lead types)...`);
        let leads: Lead[] = [];
        const countyName = county.name || (county as any).county || "";
        const leadTypes = county.leadTypes?.length ? county.leadTypes : undefined;
        if (state === "AL") {
          leads = await alabama.scrapeAlabama(countyName, fromDate, toDate, leadTypes);
        } else if (state === "OH") {
          leads = await ohio.scrapeOhio(countyName, fromDate, toDate, leadTypes);
        } else if (state === "SC") {
          leads = await southCarolina.scrapeSC((county.name || (county as any).county || ""), fromDate, toDate);
        } else {
          const msg = `No scraper registered for ${(county.name || (county as any).county || "")}, ${county.state}`;
          errors.push(msg);
          onProgress?.(`✗ ${msg}`);
          continue;
        }
        allLeads.push(...leads);
        stateLeads.push(...leads);
        onProgress?.(`✓ ${(county.name || (county as any).county || "")} ${county.state}: ${leads.length} leads`);

        if (county.publicsearch_slug && county.publicsearch_state) {
          try {
            onProgress?.(`Scraping ${county.name} via publicsearch.us...`);
            const psLeads = await scrapePublicSearchLeads(
              county.name || (county as any).county || "",
              county.state,
              county.publicsearch_slug,
              county.publicsearch_state,
              fromDate,
              toDate,
            );
            allLeads.push(...psLeads);
            stateLeads.push(...psLeads);
            onProgress?.(`✓ publicsearch ${county.name}: ${psLeads.length} leads`);
          } catch (e) {
            const msg = `Error scraping publicsearch ${county.name}: ${(e as Error).message}`;
            errors.push(msg);
            onProgress?.(`✗ ${msg}`);
          }
        }
      } catch (e) {
        const msg = `Error scraping ${(county.name || (county as any).county || "")} ${county.state}: ${(e as Error).message}`;
        errors.push(msg);
        onProgress?.(`✗ ${msg}`);
      }
    }

    // State-wide scrapers — skip when validate/scrape targets specific lead types only
    const isTargetedRun = stateCounties.some(
      (c) => c.leadTypes?.length > 0 && c.leadTypes.length < 11,
    );
    const beforeWide = stateLeads.length;
    if (!isTargetedRun && state === "AL") {
      await runStateWideScrapers(
        [
          ["AL Bankruptcy", () => alabama.scrapeBankruptcy(fromDate, toDate)],
          ["AL Code Violations", () => alabama.scrapeCodeViolations(fromDate, toDate)],
          ["AL Divorce/Eviction", () => alabama.scrapeDivorce(fromDate, toDate)],
          ["AL Out-of-State Owners", () => alabama.scrapeOutOfStateOwners(fromDate, toDate)],
          ["AL Vacant/Abandoned", () => alabama.scrapeVacantAbandoned(fromDate, toDate)],
        ],
        onProgress,
        errors,
        stateLeads,
      );
    } else if (!isTargetedRun && state === "OH") {
      await runStateWideScrapers(
        [
          ["OH Bankruptcy", () => ohio.scrapeBankruptcy(fromDate, toDate)],
          ["OH Obituaries", () => ohio.scrapeObituaries(fromDate, toDate)],
          ["OH Code Violations", () => ohio.scrapeCodeViolations(fromDate, toDate)],
          ["OH Divorce/Eviction", () => ohio.scrapeDivorce(fromDate, toDate)],
          ["OH Out-of-State Owners", () => ohio.scrapeOutOfStateOwners(fromDate, toDate)],
          ["OH Vacant/Abandoned", () => ohio.scrapeVacantAbandoned(fromDate, toDate)],
        ],
        onProgress,
        errors,
        stateLeads,
      );
    } else if (!isTargetedRun && state === "SC") {
      await runStateWideScrapers(
        [
          ["SC Bankruptcy", () => southCarolina.scrapeBankruptcy(fromDate, toDate)],
          ["SC Obituaries", () => southCarolina.scrapeObituaries(fromDate, toDate)],
          ["SC FSBO", () => southCarolina.scrapeFSBO(fromDate, toDate)],
          ["SC Code Violations", () => southCarolina.scrapeCodeViolations(fromDate, toDate)],
          ["SC Divorce/Eviction", () => southCarolina.scrapeDivorce(fromDate, toDate)],
          ["SC Out-of-State Owners", () => southCarolina.scrapeOutOfStateOwners(fromDate, toDate)],
          ["SC Vacant/Abandoned", () => southCarolina.scrapeVacantAbandoned(fromDate, toDate)],
        ],
        onProgress,
        errors,
        stateLeads,
      );
    }
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
