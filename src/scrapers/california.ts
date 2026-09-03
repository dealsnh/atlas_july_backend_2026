/**
 * California County Scrapers — Orange County.
 *
 * Initial verified source map:
 *   Bankruptcy — U.S. Bankruptcy Court, Central District of California public RSS,
 *     then conservative debtor-name → Orange County parcel-roll completion.
 *
 * Recorder, court, tax-sale, and listing integrations remain intentionally absent
 * until each source's public interface and production response signature are
 * verified. This module must never report a blocked source as an empty run.
 */

import { Lead, fetchWithRetry, formatDate, makeId, settleScraperResults } from "./base.js";
import { isGovernmentOwner, lookupOwnerProperties } from "./assessor.js";
import { logger } from "../utils/logger.js";

const COUNTY = "Orange";
const STATE = "CA";
const CACB_RSS = "https://ecf.cacb.uscourts.gov/cgi-bin/rss_outside.pl";
const NAME_LOOKUP_CONCURRENCY = 4;

export interface CaliforniaBankruptcyItem {
  caseNumber: string;
  caseName: string;
  chapter: string | null;
  filingDate: string | null;
  sourceUrl: string;
  event: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagValue(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? decodeEntities(match[1]) : "";
}

function itemInWindow(pubDate: string, fromDate: string, toDate: string): boolean {
  const when = new Date(pubDate);
  if (Number.isNaN(when.getTime())) return false;
  const start = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T23:59:59.999Z`);
  return when >= start && when <= end;
}

function hasPetitionEvent(value: string): boolean {
  return /\b(voluntary|involuntary) petition\b/i.test(value);
}

/**
 * Parse only case-opening bankruptcy entries. A public RSS feed contains many
 * subsequent docket events per case; using opening petitions prevents the same
 * case from being emitted repeatedly on every run.
 */
export function parseCaliforniaBankruptcyRss(
  xml: string,
  fromDate: string,
  toDate: string,
): CaliforniaBankruptcyItem[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const parsed = new Map<string, CaliforniaBankruptcyItem>();

  for (const item of items) {
    const title = tagValue(item, "title");
    const description = tagValue(item, "description");
    const pubDate = tagValue(item, "pubDate");
    if (!title || !pubDate || !itemInWindow(pubDate, fromDate, toDate)) continue;
    if (!hasPetitionEvent(description)) continue;

    const caseMatch = title.match(/^(\d{1,2}:\d{2}-bk-\d+(?:-[A-Za-z]{1,4})?)/i);
    const caseNumber = caseMatch?.[1] || "";
    const caseName = title
      .replace(/^\d{1,2}:\d{2}-bk-\d+(?:-[A-Za-z]{1,4})?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!caseNumber || !caseName || caseName.length < 4) continue;

    const chapter = description.match(/\bChapter:\s*(\d{1,2})\b/i)?.[1] || null;
    const sourceUrl = tagValue(item, "link") || CACB_RSS;
    if (!parsed.has(caseNumber)) {
      parsed.set(caseNumber, {
        caseNumber,
        caseName,
        chapter,
        filingDate: formatDate(pubDate),
        sourceUrl,
        event: description.slice(0, 500),
      });
    }
  }

  return [...parsed.values()];
}

function personTokens(value: string): string[] {
  return value
    .toUpperCase()
    .replace(/\b(JR|SR|II|III|IV|TRUST|ESTATE|ET\s+AL)\b/g, " ")
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function personMatchesOwner(personName: string, ownerName: string | null | undefined): boolean {
  const person = personTokens(personName);
  const owner = new Set(personTokens(ownerName || ""));
  if (person.length < 2 || owner.size === 0) return false;
  if (
    /\b(LLC|INC|CORP|BANK|TRUSTEE|COUNTY|CITY|ASSOCIATION|PARTNERSHIP)\b/i.test(
      `${personName} ${ownerName || ""}`,
    )
  ) {
    return false;
  }
  const surname = person.at(-1) || "";
  return (
    owner.has(surname) && person.slice(0, -1).some((token) => token !== surname && owner.has(token))
  );
}

function debtorNameCandidates(caseName: string): string[] {
  const candidates = caseName
    .split(/\s+(?:and|&)\s+/i)
    .map((name) => name.trim())
    .filter((name) => name.split(/\s+/).length >= 2);
  return candidates.length ? candidates : [caseName];
}

export async function scrapeBankruptcy(fromDate: string, toDate: string): Promise<Lead[]> {
  const response = await fetchWithRetry(CACB_RSS);
  if (!response.ok) throw new Error(`Orange CA Bankruptcy PACER RSS HTTP ${response.status}`);

  const xml = await response.text();
  const cases = parseCaliforniaBankruptcyRss(xml, fromDate, toDate);
  if (!xml.includes("<item>")) {
    throw new Error("Orange CA Bankruptcy PACER RSS returned an invalid or blocked feed");
  }

  const candidates = cases.flatMap((caseItem) =>
    debtorNameCandidates(caseItem.caseName).map((debtorName) => ({ caseItem, debtorName })),
  );
  const leads: Lead[] = [];
  const emitted = new Set<string>();

  for (let i = 0; i < candidates.length; i += NAME_LOOKUP_CONCURRENCY) {
    const batch = candidates.slice(i, i + NAME_LOOKUP_CONCURRENCY);
    const propertyResults = await Promise.all(
      batch.map(({ debtorName }) =>
        lookupOwnerProperties(debtorName, COUNTY, STATE).catch(() => []),
      ),
    );

    for (let j = 0; j < batch.length; j++) {
      const candidate = batch[j];
      const properties = propertyResults[j] || [];
      if (!candidate) continue;
      const { caseItem, debtorName } = candidate;
      for (const property of properties) {
        if (!property.address || !property.mailingAddress || isGovernmentOwner(property.ownerName))
          continue;
        if (!personMatchesOwner(debtorName, property.ownerName)) continue;

        const id = makeId(
          COUNTY,
          STATE,
          "Bankruptcy",
          `${caseItem.caseNumber}-${property.address}`,
        );
        if (emitted.has(id)) continue;
        emitted.add(id);

        leads.push({
          id,
          county: COUNTY,
          state: STATE,
          lead_type: "Bankruptcy",
          owner_name: property.ownerName || debtorName,
          address: property.address,
          city: property.city || null,
          zip: property.zip || null,
          mailing_address: property.mailingAddress,
          mailing_city: property.mailingCity || null,
          mailing_state: property.mailingState || null,
          mailing_zip: property.mailingZip || null,
          case_number: caseItem.caseNumber,
          filing_date: caseItem.filingDate || fromDate,
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Orange County CA Bankruptcy — ${debtorName} (${caseItem.caseNumber})${caseItem.chapter ? ` — Chapter ${caseItem.chapter}` : ""}`,
          source_url: caseItem.sourceUrl,
          raw_data: JSON.stringify({
            caseNumber: caseItem.caseNumber,
            caseName: caseItem.caseName,
            debtorName,
            chapter: caseItem.chapter,
            event: caseItem.event,
            parcelId: property.parcelId || null,
          }),
        });
      }
    }
  }

  return leads;
}

export async function scrapeCalifornia(
  county: string,
  fromDate: string,
  toDate: string,
  leadTypes?: string[],
  scraperErrors?: string[],
): Promise<Lead[]> {
  if (county !== COUNTY) {
    logger.info({ county }, "[CA] no scraper registered for county");
    return [];
  }

  const runners: Record<string, () => Promise<Lead[]>> = {
    Bankruptcy: () => scrapeBankruptcy(fromDate, toDate),
  };
  const types = leadTypes?.length ? leadTypes : Object.keys(runners);
  const entries = types
    .map((type) => [type, runners[type]] as const)
    .filter(([, fn]) => Boolean(fn));
  const results = await Promise.allSettled(entries.map(([, fn]) => fn!()));
  return settleScraperResults(
    results,
    entries.map(([type]) => `${county} CA ${type}`),
    scraperErrors,
  );
}
