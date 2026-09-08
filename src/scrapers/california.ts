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

import {
  Lead,
  fetchWithRetry,
  formatDate,
  makeId,
  settleScraperResults,
  toUsDate,
  validateHtmlResponse,
} from "./base.js";
import { isGovernmentOwner, lookupOwnerProperties } from "./assessor.js";
import { logger } from "../utils/logger.js";

const COUNTY = "Orange";
const STATE = "CA";
const CACB_RSS = "https://ecf.cacb.uscourts.gov/cgi-bin/rss_outside.pl";
const NAME_LOOKUP_CONCURRENCY = 4;
const CAPUBLICNOTICE_BASE = "https://www.capublicnotice.com";

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

// ─────────────────────────────────────────────────────────────────────────────
// Probate — www.capublicnotice.com (the SINGULAR domain; the plural
// capublicnotices.com measured at ~1.4% OC yield and is not used).
//
// Every result row carries a structural `location` field set to the county
// name by the publisher's own newspaper assignment — this is the OC filter,
// not a text guess (a bare city-name or newspaper-name match is unreliable:
// city names also appear as attorney addresses or incidental text). The
// search is SESSION-GATED: a cold request with no prior page load on this
// host returns zero rows no matter how correct the query parameters are, so
// every pull first loads the landing page to pick up a session cookie.
// `page` does not paginate correctly here — request one oversized `size`
// instead (verified: size=9000 returns a full 12-month OC-and-statewide feed
// in one request, no partitioning needed the way the Recorder site needs).
// ─────────────────────────────────────────────────────────────────────────────

export interface CaliforniaProbateItem {
  caseNumber: string;
  decedentName: string;
  publisher: string;
  postDate: string | null;
  sourceUrl: string;
  snippet: string;
}

const PROBATE_INCLUDE_RE =
  /NOTICE OF PETITION TO ADMINISTER ESTATE|LETTERS TESTAMENTARY|NOTICE TO CREDITORS/i;
const PROBATE_EXCLUDE_RE =
  /TRUSTEE('|’)S SALE|NOTICE OF DEFAULT|SHERIFF('|’)S SALE|LIEN SALE|CHANGE OF NAME|DISSOLUTION OF MARRIAGE|SUMMONS/i;

function decodeCaPublicNoticeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeCaPublicNoticeCookies(res: Response): string {
  const getSetCookie = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
  const raw =
    typeof getSetCookie === "function"
      ? getSetCookie.call(res.headers)
      : res.headers.get("set-cookie")?.split(", ") || [];
  return raw.map((c) => c.split(";")[0]).join("; ");
}

/** Loads the landing page to establish the session cookie a cold search request lacks. */
async function warmCaPublicNoticeSession(): Promise<string> {
  try {
    const res = await fetchWithRetry(`${CAPUBLICNOTICE_BASE}/`);
    return mergeCaPublicNoticeCookies(res);
  } catch {
    return "";
  }
}

/**
 * Parses the search-results page into probate notices. Each result renders as a
 * repeating `data-uuid="Notices_<id>"` block; only the `<div class="location">`
 * value confirms Orange County. Descriptions are truncated to ~200 chars in the
 * list view, so the decedent name + case number must both be readable within
 * that snippet — verified live: OC's own boilerplate opening
 * ("NOTICE OF PETITION TO ADMINISTER ESTATE OF: NAME CASE# ...") always puts
 * both before the truncation point.
 */
export function parseCaPublicNoticeProbate(html: string): CaliforniaProbateItem[] {
  const blocks = html.split('data-bs-target="#ajax_preview" data-uuid="Notices_').slice(1);
  const out = new Map<string, CaliforniaProbateItem>();

  for (const block of blocks) {
    const chunk = block.slice(0, 6000);

    const locationMatch = chunk.match(/<div class="location">([^<]*)<\/div>/);
    if (!/^orange$/i.test((locationMatch?.[1] || "").trim())) continue;

    const descMatch = chunk.match(/<span class="description[^"]*">([\s\S]*?)<\/span>/);
    const snippet = decodeCaPublicNoticeEntities((descMatch?.[1] || "").replace(/<[^>]+>/g, " "));
    if (!snippet || !PROBATE_INCLUDE_RE.test(snippet) || PROBATE_EXCLUDE_RE.test(snippet)) continue;

    const caseMatch =
      snippet.match(/CASE\s*#\s*[:.]?\s*([0-9]{2}-[0-9]{4}-[0-9]+-PR-[A-Z]{2,4}(?:-[A-Z]+)?)/i) ||
      snippet.match(/CASE\s*#\s*[:.]?\s*([A-Z0-9-]{5,40})/i) ||
      snippet.match(/CASE\s*NO\.?\s*([A-Z0-9-]{5,40})/i);
    const caseNumber = (caseMatch?.[1] || "").trim();
    if (!caseNumber) continue;

    const nameMatch = snippet.match(
      /ESTATE OF:?\s*([A-Za-z][A-Za-z .,'-]{2,80}?)\s*(?:CASE\s*#|CASE\s*NO\.?|To all heirs)/i,
    );
    const decedentName = (nameMatch?.[1] || "").replace(/[.,]+$/, "").trim();
    if (!decedentName || decedentName.length < 4) continue;

    const publisherMatch = chunk.match(/<h4>([^<]*)<\/h4>/);
    const publisher = decodeCaPublicNoticeEntities(publisherMatch?.[1] || "");

    // The datetime attribute ("2026-09-08 00:00:00.0") carries no timezone marker,
    // so a generic Date-parse-then-toISOString round trip (formatDate) reads it as
    // local time and can shift it a day when converting to UTC. It's already
    // YYYY-MM-DD — slice instead of parsing through Date at all.
    const timeMatch = chunk.match(/<time datetime="(\d{4}-\d{2}-\d{2})/);
    const postDate = timeMatch ? timeMatch[1] : null;

    const idMatch = block.match(/^(\d+)/);
    const sourceUrl = idMatch
      ? `${CAPUBLICNOTICE_BASE}/advert/-Notices_${idMatch[1]}`
      : CAPUBLICNOTICE_BASE;

    // Notices republish weekly under a fresh advert id — dedupe on the case number,
    // not the id, so one estate collapses to one candidate per pull.
    if (!out.has(caseNumber)) {
      out.set(caseNumber, {
        caseNumber,
        decedentName,
        publisher,
        postDate,
        sourceUrl,
        snippet: snippet.slice(0, 500),
      });
    }
  }

  return [...out.values()];
}

export async function scrapeCaliforniaProbate(fromDate: string, toDate: string): Promise<Lead[]> {
  const cookie = await warmCaPublicNoticeSession();
  const url =
    `${CAPUBLICNOTICE_BASE}/search/query?` +
    `firstDate=${toUsDate(fromDate)}&lastDate=${toUsDate(toDate)}&size=9000&page=0`;
  const res = await fetchWithRetry(url, cookie ? { headers: { Cookie: cookie } } : {});
  if (!res.ok) throw new Error(`Orange CA Probate capublicnotice.com HTTP ${res.status}`);

  const html = await res.text();
  const validated = validateHtmlResponse(html, "Orange CA Probate capublicnotice.com", 1000);
  if (!validated.ok) {
    throw new Error(validated.reason || "Orange CA Probate capublicnotice.com returned an invalid response");
  }

  const items = parseCaPublicNoticeProbate(html);
  const leads: Lead[] = [];

  for (let i = 0; i < items.length; i += NAME_LOOKUP_CONCURRENCY) {
    const batch = items.slice(i, i + NAME_LOOKUP_CONCURRENCY);
    const propertyResults = await Promise.all(
      batch.map((item) => lookupOwnerProperties(item.decedentName, COUNTY, STATE).catch(() => [])),
    );

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const properties = propertyResults[j] || [];
      if (!item) continue;

      for (const property of properties) {
        if (!property.address || !property.mailingAddress || isGovernmentOwner(property.ownerName))
          continue;
        if (!personMatchesOwner(item.decedentName, property.ownerName)) continue;

        const id = makeId(COUNTY, STATE, "Probate", `${item.caseNumber}-${property.address}`);
        leads.push({
          id,
          county: COUNTY,
          state: STATE,
          lead_type: "Probate",
          owner_name: property.ownerName || item.decedentName,
          address: property.address,
          city: property.city || null,
          zip: property.zip || null,
          mailing_address: property.mailingAddress,
          mailing_city: property.mailingCity || null,
          mailing_state: property.mailingState || null,
          mailing_zip: property.mailingZip || null,
          case_number: item.caseNumber,
          filing_date: item.postDate,
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Orange County CA Probate — Estate of ${item.decedentName} (${item.caseNumber}) — published ${item.publisher || "unknown paper"}`,
          source_url: item.sourceUrl,
          raw_data: JSON.stringify({
            caseNumber: item.caseNumber,
            decedentName: item.decedentName,
            publisher: item.publisher,
            postDate: item.postDate,
            snippet: item.snippet,
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
    Probate: () => scrapeCaliforniaProbate(fromDate, toDate),
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
