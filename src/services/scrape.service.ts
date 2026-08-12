import cron from "node-cron";
import { resolveCountyLeadTypes, leadMatchesRequestedType } from "../config/county-lead-types.js";
import { clientConfig } from "../config/constants.js";
import { env } from "../config/env.js";
import {
  findLeads,
  insertLeadIfNotExists,
} from "../repositories/leads.repository.js";
import { RAW_REJECT_REASON, resolveRejectReason } from "../config/raw-lead-reasons.js";
import {
  countRawLeadsForRun,
  finalizeRawLead,
  upsertRawLead,
} from "../repositories/raw-leads.repository.js";
import {
  finishScrapeRun,
  getLastScrapeTime,
  logScrapeRun,
  setLastScrapeTime,
} from "../repositories/scrape-runs.repository.js";
import { getDateRange, runAllScrapers } from "../scrapers/index.js";
import type { CountyConfig } from "../scrapers/base.js";
import { isGovernmentOwner } from "../scrapers/assessor.js";
import { logger } from "../utils/logger.js";
import { enrichLeads, enrichmentStatus, isLeadSaveable } from "./enrichment.service.js";
import { sendDailyReport } from "./email.service.js";
import {
  getEmailRecipients,
  getRawSettings,
  isDailyScrapePaused,
  isSmtpReady,
} from "./settings.service.js";

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

/** Optional targeting for a manual run: restrict to one county and/or specific lead types. */
export interface ScrapeFilter {
  county?: string;
  leadTypes?: string[];
}

export function buildCountyConfigs(filter?: ScrapeFilter): CountyConfig[] {
  return clientConfig.counties
    .filter((county) => !filter?.county || (county.name || county.county) === filter.county)
    .map((county) => {
      const leadTypes = resolveCountyLeadTypes(county);
      return {
        name: county.name || county.county,
        state: county.state,
        leadTypes: filter?.leadTypes?.length
          ? leadTypes.filter((t) => filter.leadTypes?.includes(t))
          : leadTypes,
        publicsearch_slug: county.publicsearch_slug,
        publicsearch_state: county.publicsearch_state,
      };
    })
    .filter((county) => county.leadTypes.length > 0);
}

/**
 * Distill the per-scraper progress lines (from runAllScrapers) into a compact `label=count` /
 * `label=ERR(...)` summary, persisted on the run so a scraper that returned 0 — which writes no
 * raw_leads and is otherwise indistinguishable from "never dispatched" — is visible after the fact.
 *
 * Tina's multi-state dispatcher emits county/source-level totals ("✓ Clay MO: 5 leads",
 * "✓ AL Bankruptcy: 3 leads", "✓ roll-derived Jackson MO: 10 leads", "✓ publicsearch Hamilton: 2
 * leads") and folds per-sub-scraper failures into a single "⚠ N errors: <County ST Type>: msg; ..."
 * line — both are surfaced here. Counts are raw scraper output (pre-save dedup/enrichment).
 */
export function summarizeScraperResults(log: string[]): string {
  const out: string[] = [];
  for (const line of log) {
    const ok = line.match(/^✓ (.+): (\d+) leads$/);
    if (ok?.[1]) {
      out.push(`${ok[1]}=${ok[2] ?? "0"}`);
      continue;
    }
    const errs = line.match(/^⚠ \d+ errors?: (.+)$/);
    if (errs?.[1]) {
      for (const piece of errs[1].split("; ")) {
        const m = piece.match(/^(?:Error scraping )?(.+?): (.+)$/);
        if (m?.[1]) out.push(`${m[1].trim()}=ERR(${(m[2] ?? "").slice(0, 60)})`);
      }
    }
  }
  return out.join(" ").slice(0, 3500);
}

export async function runScrapeJob(
  fromDate: string,
  toDate: string,
  filter?: ScrapeFilter,
): Promise<number> {
  if (scrapeInProgress) {
    throw new Error("Scrape already in progress");
  }

  scrapeInProgress = true;
  lastScrapeLog = [];
  let totalNew = 0;
  let runId: number | null = null;

  const savedIds = new Set<string>();

  const saveBatch = async (batch: Parameters<typeof enrichLeads>[0]): Promise<void> => {
    if (!batch.length) return;

    try {
      // 1. Persist every scraped row to raw_leads immediately (pre-enrichment snapshot)
      for (const lead of batch) {
        await upsertRawLead(runId!, lead);
      }

      // 2. Best-effort enrichment — never blocks promotion
      const enriched = await enrichLeads(batch, (msg) => {
        lastScrapeLog.push(msg);
        logger.info({ msg }, "Enrichment progress");
      });

      let batchNew = 0;
      let batchSkipped = 0;
      let batchPartial = 0;

      for (const lead of enriched) {
        if (savedIds.has(lead.id)) {
          await finalizeRawLead(runId!, lead, {
            promoted: false,
            rejectReason: RAW_REJECT_REASON.DUPLICATE_IN_BATCH,
          });
          continue;
        }

        if (!isLeadSaveable(lead)) {
          batchSkipped++;
          await finalizeRawLead(runId!, lead, {
            promoted: false,
            rejectReason: resolveRejectReason(lead),
          });
          continue;
        }

        // Government / municipal / utility owners are complete but not sellable.
        if (isGovernmentOwner(lead.owner_name)) {
          batchSkipped++;
          await finalizeRawLead(runId!, lead, {
            promoted: false,
            rejectReason: RAW_REJECT_REASON.GOVERNMENT_OWNER,
          });
          continue;
        }

        if (enrichmentStatus(lead) === "partial") batchPartial++;

        const isNew = await insertLeadIfNotExists(lead as unknown as Record<string, string | null>);
        if (isNew) {
          totalNew++;
          batchNew++;
          savedIds.add(lead.id);
          await finalizeRawLead(runId!, lead, { promoted: true, rejectReason: null });
        } else {
          await finalizeRawLead(runId!, lead, {
            promoted: false,
            rejectReason: RAW_REJECT_REASON.DUPLICATE,
          });
        }
      }

      if (batchNew > 0) {
        lastScrapeLog.push(
          `✓ ${batchNew} leads saved to DB (${totalNew} total${batchPartial ? `, ${batchPartial} partial enrichment` : ""})`,
        );
      }
      if (batchSkipped > 0) {
        lastScrapeLog.push(`⚠ ${batchSkipped} rows lacked minimum identity + location`);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, `Error saving lead batch: ${errMsg}`);
      lastScrapeLog.push(`✗ Error saving batch of ${batch.length} leads: ${errMsg}`);
    }
  };

  try {
    runId = await logScrapeRun(fromDate, toDate);
    const counties = buildCountyConfigs(filter);
    if (filter?.leadTypes?.length) {
      lastScrapeLog.push(`Targeted run: ${filter.leadTypes.join(", ")} only`);
    }
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

    if (errors.length) {
      lastScrapeLog.push(`⚠ ${errors.length} errors: ${errors.join("; ")}`);
    }
    lastScrapeLog.push(`✓ Done: ${totalNew} new leads saved`);

    const rawTotals = await countRawLeadsForRun(runId);
    lastScrapeLog.push(
      `✓ Raw leads: ${rawTotals.scraped} scraped, ${rawTotals.saved} promoted, ${rawTotals.rejected} rejected`,
    );

    lastScrapeTime = new Date().toISOString();
    await setLastScrapeTime(lastScrapeTime);
    lastScrapeTimeLoaded = true;
    await finishScrapeRun(runId, totalNew, undefined, summarizeScraperResults(lastScrapeLog));
    logger.info({ totalNew }, "Scrape complete");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (runId !== null) {
      const perType = summarizeScraperResults(lastScrapeLog);
      await finishScrapeRun(runId, totalNew, perType ? `${errMsg} | ${perType}` : errMsg);
    }
    throw error;
  } finally {
    scrapeInProgress = false;
  }

  return totalNew;
}

export function startScrapeJob(fromDate: string, toDate: string, filter?: ScrapeFilter): void {
  runScrapeJob(fromDate, toDate, filter).catch((error) => {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, `Background scrape failed: ${errMsg}`);
  });
}

export const DAILY_CRON_EXPRESSION = "0 9 * * *";
export const DAILY_CRON_TIMEZONE = "America/Los_Angeles";

export function startDailyCron(): void {
  cron.schedule(
    DAILY_CRON_EXPRESSION,
    async () => {
      try {
        if (await isDailyScrapePaused()) {
          logger.info("Daily scrape skipped — paused by client");
          return;
        }
      } catch (error) {
        logger.error({ err: error }, "Could not read daily scrape pause flag — running scrape");
      }

      logger.info("Running daily scrape at 9:00 AM PT");
      const { fromDate, toDate } = getDateRange(env.SCRAPE_LOOKBACK_DAYS);

      try {
        const newLeads = await runScrapeJob(fromDate, toDate);

        if (env.DISABLE_DAILY_EMAIL) {
          logger.info("Daily email disabled (DISABLE_DAILY_EMAIL)");
        } else {
          const settings = await getRawSettings();
          const recipients = await getEmailRecipients();

          if (recipients.length > 0 && newLeads > 0 && isSmtpReady(settings)) {
            const allLeads = await findLeads({ from_date: toDate, to_date: toDate });
            for (const recipient of recipients) {
              await sendDailyReport(recipient, clientConfig.name, allLeads, toDate, settings).catch(
                (error) => {
                  logger.error({ err: error, recipient }, "Daily email failed");
                },
              );
            }
            logger.info({ count: recipients.length }, "Daily report sent");
          } else if (!isSmtpReady(settings)) {
            logger.info("Email skipped — SMTP not configured");
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, `Daily scrape failed: ${errMsg}`);
      }
    },
    { timezone: DAILY_CRON_TIMEZONE },
  );

  logger.info(
    { lookbackDays: env.SCRAPE_LOOKBACK_DAYS, emailDisabled: env.DISABLE_DAILY_EMAIL },
    "Daily scrape scheduled for 9:00 AM PT",
  );
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

  const configured = clientConfig.counties.find(
    (c) => c.state === params.state && (c.name === params.county || c.county === params.county),
  );

  const countyConfig: CountyConfig = {
    name: params.county,
    state: params.state,
    leadTypes: params.lead_type
      ? [params.lead_type]
      : resolveCountyLeadTypes(
          configured ?? {
            name: params.county,
            county: params.county,
            state: params.state,
          },
        ),
  };

  if (configured?.publicsearch_slug) {
    countyConfig.publicsearch_slug = configured.publicsearch_slug;
    countyConfig.publicsearch_state = configured.publicsearch_state;
  }

  const { leads, errors } = await runAllScrapers([countyConfig], fromDate, toDate);
  const countyNorm = params.county.toLowerCase();
  let filtered = leads.filter((l) => {
    if (l.county.toLowerCase() !== countyNorm) return false;
    if (params.lead_type && !leadMatchesRequestedType(l.lead_type, [params.lead_type])) return false;
    return true;
  });
  if (!filtered.some((l) => isLeadSaveable(l))) {
    filtered = await enrichLeads(filtered.slice(0, 50));
  } else {
    filtered = await enrichLeads(filtered);
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
