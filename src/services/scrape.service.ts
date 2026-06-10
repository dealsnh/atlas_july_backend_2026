import cron from "node-cron";
import { clientConfig } from "../config/constants.js";
import { findLeadById, findLeads, insertLeadIfNotExists } from "../repositories/leads.repository.js";
import {
  finishScrapeRun,
  getLastScrapeTime,
  logScrapeRun,
  setLastScrapeTime,
} from "../repositories/scrape-runs.repository.js";
import { getDateRange, runAllScrapers } from "../scrapers/index.js";
import type { CountyConfig } from "../scrapers/base.js";
import { logger } from "../utils/logger.js";
import { enrichLeads, isLeadSaveable } from "./enrichment.service.js";
import { sendDailyReport } from "./email.service.js";
import { getEmailRecipients, getRawSettings, isSmtpReady } from "./settings.service.js";
import { skipTraceLeadsBatch } from "./skip-trace.service.js";

const DEFAULT_LEAD_TYPES = [
  "Pre-Foreclosure",
  "Tax Delinquent",
  "Probate",
  "Sheriff Sale",
  "FSBO",
  "Obituary",
  "Code Violation",
  "Divorce",
  "Fire Damage",
];

let scrapeInProgress = false;
let lastScrapeLog: string[] = [];
let lastScrapeTime: string | null = null;
let lastScrapeTimeLoaded = false;
let lastScrapeTimeLoadPromise: Promise<void> | null = null;

async function ensureLastScrapeTimeLoaded(): Promise<void> {
  if (lastScrapeTimeLoaded) return;
  if (!lastScrapeTimeLoadPromise) {
    lastScrapeTimeLoadPromise = getLastScrapeTime().then((t) => {
      lastScrapeTime = t;
      lastScrapeTimeLoaded = true;
    });
  }
  await lastScrapeTimeLoadPromise;
}

export function getScrapeStatus() {
  return { in_progress: scrapeInProgress, log: lastScrapeLog };
}

export async function getLastScrapeTimeValue(): Promise<string | null> {
  await ensureLastScrapeTimeLoaded();
  return lastScrapeTime;
}

function buildCountyConfigs(): CountyConfig[] {
  return clientConfig.counties.map((county) => ({
    name: county.name || county.county,
    state: county.state,
    leadTypes: DEFAULT_LEAD_TYPES,
    publicsearch_slug: county.publicsearch_slug,
    publicsearch_state: county.publicsearch_state,
  }));
}

async function maybeAutoSkipTrace(
  newLeadIds: string[],
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (!newLeadIds.length) return;

  const settings = await getRawSettings();
  if (settings.auto_skip_trace !== "true" || !settings.skip_trace_key) return;

  onProgress?.(`Auto skip-tracing ${newLeadIds.length} new leads...`);
  const { traced, failed } = await skipTraceLeadsBatch(
    newLeadIds,
    findLeadById,
    settings.skip_trace_key,
    onProgress,
  );
  onProgress?.(`✓ Auto skip trace: ${traced} traced, ${failed} failed`);
}

export async function runScrapeJob(fromDate: string, toDate: string): Promise<number> {
  if (scrapeInProgress) {
    throw new Error("Scrape already in progress");
  }

  scrapeInProgress = true;
  lastScrapeLog = [];
  let totalNew = 0;
  const runId = await logScrapeRun(fromDate, toDate);

  const newLeadIds: string[] = [];
  const savedIds = new Set<string>();

  const saveBatch = async (batch: Parameters<typeof enrichLeads>[0]): Promise<void> => {
    if (!batch.length) return;
    const enriched = await enrichLeads(batch, (msg) => {
      lastScrapeLog.push(msg);
      logger.info({ msg }, "Enrichment progress");
    });
    let batchNew = 0;
    let batchSkipped = 0;
    for (const lead of enriched) {
      if (savedIds.has(lead.id)) continue;
      if (!isLeadSaveable(lead)) {
        batchSkipped++;
        continue;
      }
      const isNew = await insertLeadIfNotExists(lead as unknown as Record<string, string | null>);
      if (isNew) {
        totalNew++;
        batchNew++;
        newLeadIds.push(lead.id);
        savedIds.add(lead.id);
      }
    }
    if (batchNew > 0) {
      lastScrapeLog.push(`✓ ${batchNew} leads saved to DB (${totalNew} total)`);
    }
    if (batchSkipped > 0) {
      lastScrapeLog.push(`⚠ Skipped ${batchSkipped} leads — no assessor owner match`);
    }
  };

  try {
    const counties = buildCountyConfigs();
    const { errors } = await runAllScrapers(
      counties,
      fromDate,
      toDate,
      (msg) => {
        lastScrapeLog.push(msg);
        logger.info({ msg }, "Scrape progress");
      },
      saveBatch,
    );

    await maybeAutoSkipTrace(newLeadIds, (msg) => {
      lastScrapeLog.push(msg);
      logger.info({ msg }, "Skip trace progress");
    });

    if (errors.length) {
      lastScrapeLog.push(`⚠ ${errors.length} errors: ${errors.join("; ")}`);
    }
    lastScrapeLog.push(`✓ Done: ${totalNew} new leads saved`);

    lastScrapeTime = new Date().toISOString();
    await setLastScrapeTime(lastScrapeTime);
    lastScrapeTimeLoaded = true;
    await finishScrapeRun(runId, totalNew);
    logger.info({ totalNew }, "Scrape complete");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await finishScrapeRun(runId, totalNew, errMsg);
    throw error;
  } finally {
    scrapeInProgress = false;
  }

  return totalNew;
}

export function startScrapeJob(fromDate: string, toDate: string): void {
  runScrapeJob(fromDate, toDate).catch((error) => {
    logger.error({ err: error }, "Background scrape failed");
  });
}

export function startDailyCron(): void {
  cron.schedule(
    "0 9 * * *",
    async () => {
      logger.info("Running daily scrape at 9:00 AM PT");
      const { fromDate, toDate } = getDateRange(1);

      try {
        const newLeads = await runScrapeJob(fromDate, toDate);
        const settings = await getRawSettings();
        const recipients = await getEmailRecipients();

        if (recipients.length > 0 && newLeads > 0 && isSmtpReady(settings)) {
          const allLeads = await findLeads({ from_date: toDate, to_date: toDate });
          for (const recipient of recipients) {
            await sendDailyReport(
              recipient,
              clientConfig.name,
              allLeads,
              toDate,
              settings,
            ).catch((error) => {
              logger.error({ err: error, recipient }, "Daily email failed");
            });
          }
          logger.info({ count: recipients.length }, "Daily report sent");
        } else if (!isSmtpReady(settings)) {
          logger.info("Email skipped — SMTP not configured");
        }
      } catch (error) {
        logger.error({ err: error }, "Daily scrape failed");
      }
    },
    { timezone: "America/Los_Angeles" },
  );

  logger.info("Daily scrape scheduled for 9:00 AM PT");
}

export { getDateRange };

/** Dry-run scrape for QA — does not persist leads. */
export async function validateCountyScrape(params: {
  county: string;
  state: string;
  lead_type?: string;
  days_back?: number;
}): Promise<{
  county: string;
  state: string;
  from_date: string;
  to_date: string;
  sample: Awaited<ReturnType<typeof enrichLeads>>;
  errors: string[];
  total: number;
  saveable: number;
  by_type: Record<string, number>;
}> {
  const daysBack = Math.min(params.days_back ?? 7, 90);
  const { fromDate, toDate } = getDateRange(daysBack);

  const countyConfig: CountyConfig = {
    name: params.county,
    state: params.state,
    leadTypes: params.lead_type ? [params.lead_type] : DEFAULT_LEAD_TYPES,
  };

  const configured = clientConfig.counties.find(
    (c) =>
      c.state === params.state &&
      (c.name === params.county || c.county === params.county),
  );
  if (configured?.publicsearch_slug) {
    countyConfig.publicsearch_slug = configured.publicsearch_slug;
    countyConfig.publicsearch_state = configured.publicsearch_state;
  }

  const { leads, errors } = await runAllScrapers([countyConfig], fromDate, toDate);
  const countyNorm = params.county.toLowerCase();
  let filtered = leads.filter((l) => {
    if (l.county.toLowerCase() !== countyNorm) return false;
    if (params.lead_type && l.lead_type !== params.lead_type) return false;
    return true;
  });
  // Scrapers already run inline assessor enrichment; avoid re-enriching hundreds in QA.
  if (!filtered.some((l) => isLeadSaveable(l))) {
    filtered = await enrichLeads(filtered.slice(0, 25));
  }

  const by_type: Record<string, number> = {};
  for (const lead of filtered) {
    by_type[lead.lead_type] = (by_type[lead.lead_type] ?? 0) + 1;
  }

  const saveable = filtered.filter(isLeadSaveable).length;
  return {
    county: params.county,
    state: params.state,
    from_date: fromDate,
    to_date: toDate,
    sample: filtered.slice(0, 5),
    errors,
    total: filtered.length,
    saveable,
    by_type,
  };
}
