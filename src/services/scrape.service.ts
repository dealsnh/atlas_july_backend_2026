import cron from "node-cron";
import { clientConfig } from "../config/constants.js";
import { findLeads, insertLeadIfNotExists } from "../repositories/leads.repository.js";
import {
  finishScrapeRun,
  getLastScrapeTime,
  logScrapeRun,
  setLastScrapeTime,
} from "../repositories/scrape-runs.repository.js";
import { getDateRange, runAllScrapers } from "../scrapers/index.js";
import type { CountyConfig } from "../scrapers/base.js";
import { logger } from "../utils/logger.js";
import { sendDailyReport } from "./email.service.js";
import { getEmailRecipients, getRawSettings, isSmtpReady } from "./settings.service.js";

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
  }));
}

export async function runScrapeJob(fromDate: string, toDate: string): Promise<number> {
  if (scrapeInProgress) {
    throw new Error("Scrape already in progress");
  }

  scrapeInProgress = true;
  lastScrapeLog = [];
  let totalNew = 0;
  const runId = await logScrapeRun(fromDate, toDate);

  try {
    const counties = buildCountyConfigs();
    const { leads, errors } = await runAllScrapers(counties, fromDate, toDate, (msg) => {
      lastScrapeLog.push(msg);
      logger.info({ msg }, "Scrape progress");
    });

    for (const lead of leads) {
      const isNew = await insertLeadIfNotExists(lead as unknown as Record<string, string | null>);
      if (isNew) totalNew++;
    }

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
    "0 11 * * *",
    async () => {
      logger.info("Running daily scrape at 6am EST");
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
    { timezone: "America/New_York" },
  );

  logger.info("Daily scrape scheduled for 6:00 AM EST");
}

export { getDateRange };
