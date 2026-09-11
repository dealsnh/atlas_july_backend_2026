/**
 * California County Scrapers — Orange County.
 *
 * Verified source map:
 *   Bankruptcy — U.S. Bankruptcy Court, Central District of California public RSS,
 *     then conservative debtor-name → Orange County parcel-roll completion.
 *   Probate — capublicnotice.com (singular domain), session-gated search,
 *     county-confirmed on the result's own `location` field.
 *   Foreclosure — OC Clerk-Recorder RecorderWorks Document Type search (code 210,
 *     "NT TRUSTEE SALE"). Session-gated the same way as Probate but requires NO
 *     JavaScript at all: a plain GET picks up an ASP.NET session cookie, then a
 *     plain POST to the AJAX endpoint reusing that cookie returns real result
 *     rows — verified live. A cookie-less POST alone returns "your session has
 *     expired," so the GET must always run first.
 *
 * Tax-sale and listing integrations remain intentionally absent until each
 * source's public interface and production response signature are verified.
 * This module must never report a blocked source as an empty run.
 */

import {
  Lead,
  fetchBlockedPage,
  fetchViaBrightDataWithSession,
  fetchWithRetry,
  formatDate,
  makeId,
  settleScraperResults,
  toUsDate,
  validateHtmlResponse,
} from "./base.js";
import { isGovernmentOwner, lookupByAddress, lookupOwnerProperties } from "./assessor.js";
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
    const postDate = timeMatch?.[1] ?? null;

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

// ─────────────────────────────────────────────────────────────────────────────
// Foreclosure — OC Clerk-Recorder RecorderWorks, Document Type search
// (code 210, "NT TRUSTEE SALE"). CA forecloses nonjudicially through the
// Recorder, never a court docket, so this is the only source for it.
//
// SESSION-GATED, but needs NO browser/JS at all: a plain GET on the site's
// root establishes an ASP.NET session cookie, then a plain POST to the AJAX
// endpoint reusing that cookie returns real rows. Verified live: a cookie-less
// POST alone returns the literal text "your session has expired."
//
// Each row carries a Grantor block mixing the sale trustee company with the
// actual owner name, same field, no role marker — split on entity keywords,
// not a bare "TR" suffix (an individual can legitimately hold title via their
// own personal living trust, e.g. "RICHARDS JAMES ROBERT TR" is a real
// homeowner). Grantor names are indexed "LAST FIRST [MIDDLE]" — the OPPOSITE
// order from a notice body — confirmed live.
//
// KNOWN CAP: the site truncates any single query at 367 results, newest
// first, so a range wider than ~1 month can silently drop the OLDER end.
// This scraper does not yet partition wide ranges by month — safe for the
// normal daily/weekly incremental window, not yet safe for a multi-month
// historical backfill.
// ─────────────────────────────────────────────────────────────────────────────

const RECORDER_BASE = "https://cr.occlerkrecorder.gov/RecorderWorksInternet/";
const RECORDER_AJAX = `${RECORDER_BASE}Presentors/AjaxPresentor.aspx`;
const RECORDER_PAGE_SIZE = 20;
const RECORDER_MAX_PAGES = 20; // 400 rows of headroom over the real 367 cap

export interface CaliforniaForeclosureItem {
  docNumber: string;
  recordingDate: string | null;
  grantors: string[];
  numPages: string | null;
}

/**
 * Parses the Recorder's M/D/YYYY date text straight to YYYY-MM-DD, with no
 * Date object involved at any point. `formatDate()` round-trips through
 * `new Date(...).toISOString()`, which reads the string as LOCAL midnight
 * and can roll the date back a day once converted to UTC — confirmed live
 * on this machine (local timezone runs ahead of UTC). Same class of bug the
 * Probate parser above already had to route around for its own date field.
 */
function parseRecorderDate(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, m, d, y] = match;
  return `${y}-${(m || "").padStart(2, "0")}-${(d || "").padStart(2, "0")}`;
}

const FORECLOSURE_ENTITY_MARKERS = new Set([
  "LLC",
  "INC",
  "CORP",
  "CORPORATION",
  "CORPS",
  "COMPANY",
  "LLP",
  "LP",
  "CO",
  "SERVICES",
  "SOLUTIONS",
  "SPECIALISTS",
  "RECOVERY",
  "RECONVEYANCE",
  "DEFAULT",
  "TITLE",
  "INSURANCE",
  "LENDER",
  "LENDERS",
  "LENDING",
  "MANAGEMENT",
  "ADVISORS",
  "FORECLOSURE",
  "BANK",
  "NATIONAL",
  "MORTGAGE",
  "FINANCIAL",
  "CAPITAL",
  "FUND",
  "ASSOCIATION",
  "AGENCY",
  "GROUP",
  "HOLDINGS",
  "INVESTMENT",
  "SERVICING",
  "TRUSTEE",
  "ATTORNEY",
  "LEGAL",
  "LAW",
  "REAL",
  "ESTATE",
  "SYSTEMS",
  "PARTNERS",
  "PROGRESSIVE",
  "WESTERN",
  "NATIONWIDE",
  "WORLDWIDE",
]);
const FORECLOSURE_SUFFIX_DROP = new Set(["TR", "TRUSTEE"]);

function isForeclosureEntityName(name: string): boolean {
  if (name.includes("&")) return true;
  const tokens = name.toUpperCase().match(/[A-Z']+/g) || [];
  return tokens.some((t) => FORECLOSURE_ENTITY_MARKERS.has(t));
}

/**
 * Splits raw Grantor names into individual owner candidates vs. entity/trustee
 * names, reordering an individual name from the source's own "LAST FIRST
 * [MIDDLE]" convention to "FIRST LAST" for the county roll lookup. A lone
 * trailing TR/TRUSTEE token is dropped first (a personal living trust marker,
 * not the sale trustee) before reordering.
 */
function splitForeclosureGrantors(grantors: string[]): { owners: string[]; entities: string[] } {
  const owners: string[] = [];
  const entities: string[] = [];

  for (const raw of grantors) {
    const g = (raw || "").trim();
    if (!g) continue;
    if (isForeclosureEntityName(g)) {
      entities.push(g);
      continue;
    }

    let tokens = g.split(/\s+/).filter(Boolean);
    const lastToken = tokens[tokens.length - 1]?.toUpperCase().replace(/\.$/, "");
    if (tokens.length > 1 && lastToken && FORECLOSURE_SUFFIX_DROP.has(lastToken)) {
      tokens = tokens.slice(0, -1);
    }
    if (tokens.length < 2) continue;

    owners.push(`${tokens[1]} ${tokens[0]}`);
  }

  return { owners, entities };
}

/** Parses one search-results page (or one OnPage response) into raw rows. */
export function parseRecorderResultRows(html: string): CaliforniaForeclosureItem[] {
  const rows = html.split(/class=["']searchResultRow["']/).slice(1);
  const out: CaliforniaForeclosureItem[] = [];

  for (const row of rows) {
    const chunk = row.slice(0, 5000);

    const docMatch = chunk.match(/id="EntityTitleDocNum_docNumber"[^>]*>([^<]+)</);
    const docNumber = (docMatch?.[1] || "").trim();
    if (!docNumber) continue;

    const grtMatch = chunk.match(/class=["']GrtContainer["'][^>]*>([\s\S]*?)<\/div>/);
    const grtInner = grtMatch?.[1] || "";
    const grantors = grtInner
      ? [...grtInner.matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map((m) => (m[1] || "").trim()).filter(Boolean)
      : [];

    const dateMatch = chunk.match(/id="recDate"[^>]*>([^<]+)</);
    const recordingDate = dateMatch ? parseRecorderDate((dateMatch[1] || "").trim()) : null;

    const pagesMatch = chunk.match(/id="numOfPages"[^>]*>([^<]+)</);
    const numPages = (pagesMatch?.[1] || "").trim() || null;

    out.push({ docNumber, recordingDate, grantors, numPages });
  }

  return out;
}

function recorderSearchBody(fromDate: string, toDate: string): string {
  return (
    `&FromDate=${fromDate}&ToDate=${toDate}&DocumentTypes=210,` +
    `&DocumentNames=NT TRUSTEE SALE,&ERetrievalGroup=1&SearchMode=3&IsNewSearch=true`
  );
}

function recorderPageBody(fromDate: string, toDate: string, page: number): string {
  return (
    `PageNum=${page}&DocumentTypes=210&DocumentNames=NT TRUSTEE SALE` +
    `&FromDate=${fromDate}&ToDate=${toDate}&MapPrior=False&ERetrievalGroup=1&SearchMode=3`
  );
}

const RECORDER_AJAX_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Accept: "*/*",
  "X-Requested-With": "XMLHttpRequest",
  Referer: RECORDER_BASE,
};

export async function scrapeCaliforniaForeclosure(fromDate: string, toDate: string): Promise<Lead[]> {
  const fromUs = toUsDate(fromDate);
  const toUs = toUsDate(toDate);

  const page1Html = fetchViaBrightDataWithSession(
    RECORDER_BASE,
    RECORDER_AJAX,
    recorderSearchBody(fromUs, toUs),
    RECORDER_AJAX_HEADERS,
  );
  if (!page1Html) {
    throw new Error(
      "Orange CA Foreclosure RecorderWorks: no response (Bright Data proxy credentials missing or the source is unreachable)",
    );
  }
  if (/your session has expired/i.test(page1Html)) {
    throw new Error("Orange CA Foreclosure RecorderWorks: session cookie was rejected");
  }
  const validated = validateHtmlResponse(page1Html, "Orange CA Foreclosure RecorderWorks", 500);
  if (!validated.ok) {
    throw new Error(validated.reason || "Orange CA Foreclosure RecorderWorks returned an invalid response");
  }

  const seenDocs = new Map<string, CaliforniaForeclosureItem>();
  for (const item of parseRecorderResultRows(page1Html)) {
    if (!seenDocs.has(item.docNumber)) seenDocs.set(item.docNumber, item);
  }

  // Keep paging (same session, same Bright Data call — OnPage() reuses the
  // search already stored server-side) until a page comes back short of a
  // full page, meaning we've reached the end.
  let lastPageCount = parseRecorderResultRows(page1Html).length;
  for (let page = 2; lastPageCount >= RECORDER_PAGE_SIZE && page <= RECORDER_MAX_PAGES; page++) {
    const pageHtml = fetchViaBrightDataWithSession(
      RECORDER_BASE,
      RECORDER_AJAX,
      recorderPageBody(fromUs, toUs, page),
      RECORDER_AJAX_HEADERS,
    );
    if (!pageHtml || /your session has expired/i.test(pageHtml)) break;

    const pageItems = parseRecorderResultRows(pageHtml);
    lastPageCount = pageItems.length;
    if (!lastPageCount) break;
    for (const item of pageItems) {
      if (!seenDocs.has(item.docNumber)) seenDocs.set(item.docNumber, item);
    }
  }

  const items = [...seenDocs.values()];
  const leads: Lead[] = [];

  for (let i = 0; i < items.length; i += NAME_LOOKUP_CONCURRENCY) {
    const batch = items.slice(i, i + NAME_LOOKUP_CONCURRENCY);
    const splitBatch = batch.map((item) => splitForeclosureGrantors(item.grantors));

    const propertyResults = await Promise.all(
      splitBatch.map(({ owners }) =>
        owners.length
          ? Promise.all(owners.map((name) => lookupOwnerProperties(name, COUNTY, STATE).catch(() => [])))
          : Promise.resolve([]),
      ),
    );

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const split = splitBatch[j];
      if (!item || !split) continue;
      const { owners } = split;
      const perOwnerProperties = propertyResults[j] || [];

      for (let k = 0; k < owners.length; k++) {
        const ownerName = owners[k];
        if (!ownerName) continue;
        const properties = perOwnerProperties[k] || [];

        for (const property of properties) {
          if (!property.address || !property.mailingAddress || isGovernmentOwner(property.ownerName))
            continue;
          if (!personMatchesOwner(ownerName, property.ownerName)) continue;

          const id = makeId(COUNTY, STATE, "Foreclosure", `${item.docNumber}-${property.address}`);
          if (leads.some((l) => l.id === id)) continue;

          leads.push({
            id,
            county: COUNTY,
            state: STATE,
            lead_type: "Foreclosure",
            owner_name: property.ownerName || ownerName,
            address: property.address,
            city: property.city || null,
            zip: property.zip || null,
            mailing_address: property.mailingAddress,
            mailing_city: property.mailingCity || null,
            mailing_state: property.mailingState || null,
            mailing_zip: property.mailingZip || null,
            case_number: item.docNumber,
            filing_date: item.recordingDate,
            assessed_value: null,
            tax_year: null,
            lender: null,
            loan_amount: null,
            sale_date: null,
            sale_amount: null,
            description: `Orange County CA Foreclosure — Trustee Sale, Document ${item.docNumber}`,
            source_url: RECORDER_BASE,
            raw_data: JSON.stringify({
              docNumber: item.docNumber,
              recordingDate: item.recordingDate,
              grantors: item.grantors,
              numPages: item.numPages,
            }),
          });
        }
      }
    }
  }

  return leads;
}

// ─────────────────────────────────────────────────────────────────────────────
// Code Violation — Orange County has NO countywide feed; each of its 34
// incorporated cities runs its own code-enforcement program (unincorporated
// areas alone are covered by OC Development Services, itself not yet a
// verified machine-readable source). Two cities confirmed live so far, both
// via a public ArcGIS FeatureServer synced from the city's own Accela system
// — no login, no browser, plain HTTP queries. More cities can be added the
// same way once found and verified; do not assume every OC city has one of
// these until checked.
// ─────────────────────────────────────────────────────────────────────────────

const ANAHEIM_CODE_ENFORCEMENT_URL =
  "https://services3.arcgis.com/hPs600I3X0RTaaaq/arcgis/rest/services/CodeEnforcementCasesPublic/FeatureServer/0/query";
const ANAHEIM_CODE_ENFORCEMENT_SOURCE =
  "https://data-anaheim.opendata.arcgis.com/datasets/anaheim::recent-code-enforcement-cases-1/about";
const IRVINE_CODE_ENFORCEMENT_URL =
  "https://services2.arcgis.com/3mkVbLdbLBFHrfbK/arcgis/rest/services/Code_Enforcement_Cases_AGO/FeatureServer/0/query";
const IRVINE_CODE_ENFORCEMENT_SOURCE = "https://coi-gis-cityofirvine.hub.arcgis.com/";
// Newport Beach hosts its own ArcGIS Server rather than ArcGIS Online's shared
// infrastructure (unlike Anaheim/Irvine above) — same class of block as the
// Recorder site, direct connections from a non-residential IP time out. Query
// through fetchBlockedPage (routes via Bright Data, see needsResidentialProxy
// in base.ts) rather than the plain fetchWithRetry the other two cities use.
const NEWPORT_BEACH_CODE_ENFORCEMENT_URL =
  "https://nbgis.newportbeachca.gov/arcgis/rest/services/ArcGISOnlineDataGISViewer/FeatureServer/17/query";
const NEWPORT_BEACH_CODE_ENFORCEMENT_SOURCE =
  "https://nbgis.newportbeachca.gov/gispub/Dashboards/CodeCasesDash.htm";

/** ArcGIS date fields are epoch milliseconds — an absolute UTC instant, no
 * ambiguous local-time parsing involved (unlike the Recorder's bare M/D/YYYY
 * text, which is why that one needed its own direct string parser instead). */
function arcgisEpochToIso(value: unknown): string | null {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().split("T")[0] ?? null;
}

function arcgisTimestamp(isoDate: string, endOfDay = false): string {
  return `TIMESTAMP '${isoDate} ${endOfDay ? "23:59:59" : "00:00:00"}'`;
}

async function queryArcgisFeatureServer(
  queryUrl: string,
  where: string,
  outFields: string,
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({ where, outFields, returnGeometry: "false", f: "json" });
  const res = await fetchWithRetry(`${queryUrl}?${params.toString()}`);
  if (!res.ok) throw new Error(`ArcGIS query HTTP ${res.status}: ${queryUrl}`);
  const data = (await res.json()) as {
    features?: Array<{ attributes: Record<string, unknown> }>;
    error?: { message?: string };
  };
  if (data.error) throw new Error(`ArcGIS query error (${queryUrl}): ${data.error.message || "unknown"}`);
  return (data.features || []).map((f) => f.attributes);
}

/** Same as queryArcgisFeatureServer, routed through fetchBlockedPage for a
 * city-hosted (not ArcGIS-Online-hosted) server that blocks datacenter IPs. */
async function queryArcgisFeatureServerBlocked(
  queryUrl: string,
  where: string,
  outFields: string,
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({ where, outFields, returnGeometry: "false", f: "json" });
  const body = await fetchBlockedPage(`${queryUrl}?${params.toString()}`);
  if (!body) throw new Error(`ArcGIS query returned no response: ${queryUrl}`);
  const data = JSON.parse(body) as {
    features?: Array<{ attributes: Record<string, unknown> }>;
    error?: { message?: string };
  };
  if (data.error) throw new Error(`ArcGIS query error (${queryUrl}): ${data.error.message || "unknown"}`);
  return (data.features || []).map((f) => f.attributes);
}

/** Anaheim's own address field is "STREET\nCITY, ST ZIP" on one string. */
function parseAnaheimAddress(raw: string): { street: string; city: string | null; zip: string | null } {
  const match = raw.match(/^(.+?)\r?\n([^,]+),\s*[A-Za-z]{2}\.?\s*(\d{5})/);
  if (match) {
    return {
      street: (match[1] || "").trim(),
      city: (match[2] || "").trim(),
      zip: (match[3] || "").trim(),
    };
  }
  return { street: raw.trim(), city: null, zip: null };
}

/**
 * Anaheim's feed already carries owner name AND address directly (synced from
 * Accela every 15 minutes) — no county-roll lookup is required to identify
 * who to contact. The roll is still consulted for the MAILING address (an
 * absentee owner's mailing address can differ from the situs), falling back
 * to the situs address itself when no roll match is found — the same
 * "property owner, mailing falls back to property address" default this
 * project already uses elsewhere for a living owner with no better data.
 */
async function scrapeAnaheimCodeViolation(fromDate: string, toDate: string): Promise<Lead[]> {
  const where =
    `casestatus <> 'Closed' AND opendate >= ${arcgisTimestamp(fromDate)}` +
    ` AND opendate <= ${arcgisTimestamp(toDate, true)}`;
  const rows = await queryArcgisFeatureServer(
    ANAHEIM_CODE_ENFORCEMENT_URL,
    where,
    "casenumber,casestatus,address,description,opendate,parcel,ownername",
  );

  const leads: Lead[] = [];
  for (const row of rows) {
    const caseNumber = String(row.casenumber || "").trim();
    const rawAddress = String(row.address || "").trim();
    const ownerName = String(row.ownername || "").trim();
    if (!caseNumber || !rawAddress || !ownerName) continue;

    const { street, city, zip } = parseAnaheimAddress(rawAddress);
    if (!street || isGovernmentOwner(ownerName)) continue;

    let mailingAddress = street;
    let mailingCity = city;
    let mailingState = "CA";
    let mailingZip = zip;
    try {
      const rollMatch = await lookupByAddress(street, COUNTY, STATE);
      if (rollMatch?.mailingAddress) {
        mailingAddress = rollMatch.mailingAddress;
        mailingCity = rollMatch.mailingCity || city;
        mailingState = rollMatch.mailingState || "CA";
        mailingZip = rollMatch.mailingZip || zip;
      }
    } catch {
      // fall back to situs as mailing
    }

    leads.push({
      id: makeId(COUNTY, STATE, "Code Violation", `anaheim-${caseNumber}`),
      county: COUNTY,
      state: STATE,
      lead_type: "Code Violation",
      owner_name: ownerName,
      address: street,
      city: city || "Anaheim",
      zip,
      mailing_address: mailingAddress,
      mailing_city: mailingCity,
      mailing_state: mailingState,
      mailing_zip: mailingZip,
      case_number: caseNumber,
      filing_date: arcgisEpochToIso(row.opendate),
      assessed_value: null,
      tax_year: null,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: null,
      description: `Anaheim Code Enforcement — ${String(row.description || "").trim() || "case"} (${String(row.casestatus || "").trim()})`,
      source_url: ANAHEIM_CODE_ENFORCEMENT_SOURCE,
      raw_data: JSON.stringify(row),
    });
  }
  return leads;
}

/**
 * Irvine's feed carries address only, no owner name at all — a county-roll
 * lookup is REQUIRED here, not optional. A case with no roll match is
 * skipped rather than uploaded with a blank owner, since there would be
 * nothing to actually call.
 */
async function scrapeIrvineCodeViolation(fromDate: string, toDate: string): Promise<Lead[]> {
  const where =
    `USER_Status <> 'Closed' AND USER_Date_opened >= ${arcgisTimestamp(fromDate)}` +
    ` AND USER_Date_opened <= ${arcgisTimestamp(toDate, true)}`;
  const rows = await queryArcgisFeatureServer(
    IRVINE_CODE_ENFORCEMENT_URL,
    where,
    "USER_Case_,USER_Topic,USER_Status,USER_Date_opened,USER_FULL_ADDRESS,GroupTopic",
  );

  const leads: Lead[] = [];
  for (const row of rows) {
    const caseNumber = String(row.USER_Case_ || "").trim();
    const rawAddress = String(row.USER_FULL_ADDRESS || "").trim();
    if (!caseNumber || !rawAddress) continue;

    let rollMatch: Awaited<ReturnType<typeof lookupByAddress>> = null;
    try {
      rollMatch = await lookupByAddress(rawAddress, COUNTY, STATE);
    } catch {
      rollMatch = null;
    }
    if (!rollMatch?.ownerName || !rollMatch.mailingAddress || isGovernmentOwner(rollMatch.ownerName)) continue;

    const topic = String(row.USER_Topic || row.GroupTopic || "").trim() || "case";
    leads.push({
      id: makeId(COUNTY, STATE, "Code Violation", `irvine-${caseNumber}`),
      county: COUNTY,
      state: STATE,
      lead_type: "Code Violation",
      owner_name: rollMatch.ownerName,
      address: rollMatch.address || rawAddress,
      city: rollMatch.city || "Irvine",
      zip: rollMatch.zip || null,
      mailing_address: rollMatch.mailingAddress,
      mailing_city: rollMatch.mailingCity || null,
      mailing_state: rollMatch.mailingState || "CA",
      mailing_zip: rollMatch.mailingZip || null,
      case_number: caseNumber,
      filing_date: arcgisEpochToIso(row.USER_Date_opened),
      assessed_value: null,
      tax_year: null,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: null,
      description: `Irvine Code Enforcement — ${topic} (${String(row.USER_Status || "").trim()})`,
      source_url: IRVINE_CODE_ENFORCEMENT_SOURCE,
      raw_data: JSON.stringify(row),
    });
  }
  return leads;
}

/**
 * Newport Beach's feed, like Anaheim's, already carries owner name (CASE_NAME,
 * "LAST, FIRST[...]") and a street address (ADDS) directly — no county-roll
 * lookup required to identify who to contact. No city/zip field exists on
 * this layer at all, so both are filled in (city hardcoded, zip via the
 * roll) rather than left as an unexplained gap. STATUS values verified live:
 * CLOSED and VOID are done; NOTICE ISSUED, INVESTIGATING CASES, and CITATION
 * are active.
 */
async function scrapeNewportBeachCodeViolation(fromDate: string, toDate: string): Promise<Lead[]> {
  const where =
    `STATUS NOT IN ('CLOSED','VOID') AND OPEN_DATE >= ${arcgisTimestamp(fromDate)}` +
    ` AND OPEN_DATE <= ${arcgisTimestamp(toDate, true)}`;
  const rows = await queryArcgisFeatureServerBlocked(
    NEWPORT_BEACH_CODE_ENFORCEMENT_URL,
    where,
    "CASENUMBER,STATUS,ADDS,DESCRIPTION,CASE_NAME,CASE_TYPE,OPEN_DATE,NEIGHBORHOOD",
  );

  const leads: Lead[] = [];
  for (const row of rows) {
    const caseNumber = String(row.CASENUMBER || "").trim();
    const street = String(row.ADDS || "").trim();
    const ownerName = String(row.CASE_NAME || "").trim();
    if (!caseNumber || !street || !ownerName || isGovernmentOwner(ownerName)) continue;

    let mailingAddress = street;
    let mailingCity: string | null = "Newport Beach";
    let mailingState = "CA";
    let mailingZip: string | null = null;
    let zip: string | null = null;
    try {
      const rollMatch = await lookupByAddress(street, COUNTY, STATE);
      if (rollMatch?.mailingAddress) {
        mailingAddress = rollMatch.mailingAddress;
        mailingCity = rollMatch.mailingCity || mailingCity;
        mailingState = rollMatch.mailingState || "CA";
        mailingZip = rollMatch.mailingZip || null;
        zip = rollMatch.zip || null;
      }
    } catch {
      // fall back to situs as mailing
    }

    const caseType = String(row.CASE_TYPE || row.DESCRIPTION || "").trim() || "case";
    leads.push({
      id: makeId(COUNTY, STATE, "Code Violation", `newport-beach-${caseNumber}`),
      county: COUNTY,
      state: STATE,
      lead_type: "Code Violation",
      owner_name: ownerName,
      address: street,
      city: "Newport Beach",
      zip,
      mailing_address: mailingAddress,
      mailing_city: mailingCity,
      mailing_state: mailingState,
      mailing_zip: mailingZip,
      case_number: caseNumber,
      filing_date: arcgisEpochToIso(row.OPEN_DATE),
      assessed_value: null,
      tax_year: null,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: null,
      description: `Newport Beach Code Enforcement — ${caseType} (${String(row.STATUS || "").trim()})`,
      source_url: NEWPORT_BEACH_CODE_ENFORCEMENT_SOURCE,
      raw_data: JSON.stringify(row),
    });
  }
  return leads;
}

/**
 * Garden Grove runs its own custom Leaflet-based map portal (not Esri/
 * ArcGIS like the other three cities) backed by a real GeoServer WFS
 * instance. The portal itself never surfaces the endpoint directly — its
 * <gg-map-portal> web component just points at a `config.yml` alongside the
 * page (`https://ggcity.org/maps/data-portal/config.yml`), which lists a
 * "Code Enforcement Layers" group with a `code:violations` WMS layer name.
 * That WMS name is NOT the real WFS feature-type name, though — GeoServer's
 * `GetCapabilities` for the `code` workspace shows the actual queryable type
 * is `code:open_violations` (confirmed live; a query for the WMS-display
 * name alone 400s with "Feature type code:violations unknown"). No owner
 * name is published here either — same free county-roll resolution as
 * every other Orange County scraper. `opened_on` is already a clean
 * YYYY-MM-DD string, no epoch/timezone parsing needed at all. The layer
 * itself is server-side pre-filtered to open cases only (there is no
 * separate "closed" layer to exclude), and GeoServer's CQL_FILTER on
 * `opened_on` does real server-side date filtering (verified live) so a
 * daily/weekly scrape only pulls what changed, not the full ~1,745-record
 * backlog every run.
 */
const GARDEN_GROVE_WFS_URL = "https://geonode.ggcity.org/geoserver/code/ows";
const GARDEN_GROVE_CODE_ENFORCEMENT_SOURCE = "https://ggcity.org/maps/data-portal/";

interface GardenGroveViolationProperties {
  case_id: number;
  address: string;
  opened_on: string;
  citation: string;
}

async function scrapeGardenGroveCodeViolation(fromDate: string, toDate: string): Promise<Lead[]> {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeName: "code:open_violations",
    outputFormat: "application/json",
    CQL_FILTER: `opened_on >= '${fromDate}' AND opened_on <= '${toDate}'`,
  });
  const res = await fetchWithRetry(`${GARDEN_GROVE_WFS_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Garden Grove WFS HTTP ${res.status}`);
  const data = (await res.json()) as {
    features?: Array<{ properties: GardenGroveViolationProperties }>;
  };

  const leads: Lead[] = [];
  for (const feature of data.features || []) {
    const { case_id, address, opened_on, citation } = feature.properties;
    const street = String(address || "").trim();
    if (!case_id || !street) continue;

    let rollMatch: Awaited<ReturnType<typeof lookupByAddress>> = null;
    try {
      rollMatch = await lookupByAddress(street, COUNTY, STATE);
    } catch {
      rollMatch = null;
    }
    if (!rollMatch?.ownerName || !rollMatch.mailingAddress || isGovernmentOwner(rollMatch.ownerName))
      continue;

    const filingDate = /^\d{4}-\d{2}-\d{2}/.test(String(opened_on || ""))
      ? String(opened_on).slice(0, 10)
      : null;

    leads.push({
      id: makeId(COUNTY, STATE, "Code Violation", `garden-grove-${case_id}`),
      county: COUNTY,
      state: STATE,
      lead_type: "Code Violation",
      owner_name: rollMatch.ownerName,
      address: rollMatch.address || street,
      city: rollMatch.city || "Garden Grove",
      zip: rollMatch.zip || null,
      mailing_address: rollMatch.mailingAddress,
      mailing_city: rollMatch.mailingCity || null,
      mailing_state: rollMatch.mailingState || "CA",
      mailing_zip: rollMatch.mailingZip || null,
      case_number: String(case_id),
      filing_date: filingDate,
      assessed_value: null,
      tax_year: null,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: null,
      description: `Garden Grove Code Enforcement — ${String(citation || "").trim() || "open violation"}`,
      source_url: GARDEN_GROVE_CODE_ENFORCEMENT_SOURCE,
      raw_data: JSON.stringify(feature.properties),
    });
  }
  return leads;
}

export async function scrapeCaliforniaCodeViolation(fromDate: string, toDate: string): Promise<Lead[]> {
  const cities: Array<[string, () => Promise<Lead[]>]> = [
    ["Anaheim", () => scrapeAnaheimCodeViolation(fromDate, toDate)],
    ["Irvine", () => scrapeIrvineCodeViolation(fromDate, toDate)],
    ["Newport Beach", () => scrapeNewportBeachCodeViolation(fromDate, toDate)],
    ["Garden Grove", () => scrapeGardenGroveCodeViolation(fromDate, toDate)],
  ];
  const results = await Promise.allSettled(cities.map(([, fn]) => fn()));
  return settleScraperResults(
    results,
    cities.map(([city]) => `Orange CA Code Violation (${city})`),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tax Delinquent — bid4assets.com, Orange County's tax-defaulted property
// auction storefront. Verified live: viewing the listing and every parcel's
// detail page needs NO login or registration at all — the site's documented
// "registration required" gate is for the deposit/bidding flow, not for
// reading the public data. The county's own auction schedule is genuinely
// IRREGULAR (recent ones: June and Sept 2025, nothing fixed/annual), so
// unlike every other CA lead type here, this one does NOT filter by the
// passed fromDate/toDate window — those parameters don't map onto "check for
// new activity since last run" the way they do for a daily notice feed.
// Instead this reports whatever the county's storefront CURRENTLY shows as
// posted and still open (bid close date not yet passed); an auction that
// already closed, or no auction being posted at all right now, both
// correctly produce zero leads, not an error.
// ─────────────────────────────────────────────────────────────────────────────

const BID4ASSETS_STOREFRONT_URL = "https://www.bid4assets.com/Orange";
const BID4ASSETS_AUCTIONS_API = "https://www.bid4assets.com/api/storefront/auctions/index";
const BID4ASSETS_AUCTION_DETAIL_BASE = "https://www.bid4assets.com/auction/index";

interface Bid4AssetsAuctionItem {
  auctionID: number;
  asset_title: string;
  minimumBid: number | null;
  bidCloseTime: string;
}

/** The site marks a pulled/paid-off/sold parcel with a text prefix on the
 * title rather than a documented status-code enum — matching on that text is
 * more robust than guessing what an undocumented statusID value means. */
function isWithdrawnListing(title: string): boolean {
  return /\*{2,}\s*(withdrawn|sold|removed|cancel(l)?ed)/i.test(title);
}

/** bidCloseTime arrives as a bare "YYYY-MM-DDTHH:MM:SS" with no timezone
 * marker. This is only ever used as a coarse "is this auction still open"
 * gate over a period of WEEKS, not a same-day precision check, so a direct
 * string-prefix compare (no Date-object round trip at all) sidesteps the
 * whole local-timezone class of bug the Recorder/Probate scrapers hit. */
function bid4AssetsCloseDateIso(bidCloseTime: string): string | null {
  const datePart = bidCloseTime.split("T")[0];
  return datePart && /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

function isStillOpen(bidCloseTime: string): boolean {
  const closeDate = bid4AssetsCloseDateIso(bidCloseTime);
  if (!closeDate) return false;
  const today = new Date().toISOString().split("T")[0]!;
  return closeDate >= today;
}

async function fetchBid4AssetsStorefrontGroups(): Promise<{ storefrontId: string; groupIds: string[] }> {
  const res = await fetchWithRetry(BID4ASSETS_STOREFRONT_URL);
  if (!res.ok) throw new Error(`bid4assets Orange storefront HTTP ${res.status}`);
  const html = await res.text();

  const storefrontMatch = html.match(/name="StorefrontId"\s+value="(\d+)"/);
  if (!storefrontMatch) {
    throw new Error(
      "bid4assets Orange storefront: could not find StorefrontId — page structure may have changed",
    );
  }
  const groupIds = [...new Set([...html.matchAll(/"StorefrontCollectionId":(\d+)/g)].map((m) => m[1]!))];
  if (!groupIds.length) {
    throw new Error(
      "bid4assets Orange storefront: no auction collection groups found — page structure may have changed",
    );
  }
  return { storefrontId: storefrontMatch[1]!, groupIds };
}

async function fetchBid4AssetsGroupItems(
  storefrontId: string,
  groupId: string,
): Promise<Bid4AssetsAuctionItem[]> {
  const url = `${BID4ASSETS_AUCTIONS_API}?take=9999&skip=0&page=1&pageSize=9999`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storefrontId: Number(storefrontId), storefrontCollectionId: Number(groupId) }),
  });
  if (!res.ok) throw new Error(`bid4assets auctions/index HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Bid4AssetsAuctionItem[] };
  return data.data || [];
}

/** Parses the "Item Specifics - Parcel Information" block on a parcel's
 * detail page. No owner name is published anywhere on this site — address
 * is the only identifying field, resolved to an owner via the free county
 * parcel roll afterward, same as every other Orange County scraper here. */
function parseBid4AssetsDetail(
  html: string,
): { apn: string | null; legalDescription: string | null; street: string | null; city: string | null } {
  const sectionStart = html.indexOf("Item Specifics - Parcel Information");
  const section = sectionStart >= 0 ? html.slice(sectionStart, sectionStart + 2000) : html;

  const apnMatch = section.match(/<strong[^>]*>APN<\/strong>[\s\S]{0,150}?<td[^>]*>([^<]+)<\/td>/i);
  const legalMatch = section.match(
    /<strong[^>]*>Legal Description\s*<\/strong>[\s\S]{0,150}?<td[^>]*>([^<]+)<\/td>/i,
  );
  const addrMatch = section.match(
    /<strong[^>]*>Address<\/strong>[\s\S]{0,150}?<td[^>]*>([^<]+)<br\s*\/?>\s*([^<]+)<\/td>/i,
  );
  const street = addrMatch?.[1]?.trim() || null;
  const cityLine = addrMatch?.[2]?.trim() || null;
  const city = cityLine ? cityLine.replace(/,\s*CA\.?$/i, "").trim() : null;

  return {
    apn: apnMatch?.[1]?.trim() || null,
    legalDescription: legalMatch?.[1]?.trim() || null,
    street,
    city,
  };
}

export async function scrapeCaliforniaTaxDelinquent(): Promise<Lead[]> {
  const { storefrontId, groupIds } = await fetchBid4AssetsStorefrontGroups();

  const allItems: Bid4AssetsAuctionItem[] = [];
  for (const groupId of groupIds) {
    const items = await fetchBid4AssetsGroupItems(storefrontId, groupId);
    allItems.push(...items);
  }

  const openItems = allItems.filter(
    (item) => !isWithdrawnListing(item.asset_title) && isStillOpen(item.bidCloseTime),
  );

  const leads: Lead[] = [];
  for (let i = 0; i < openItems.length; i += NAME_LOOKUP_CONCURRENCY) {
    const batch = openItems.slice(i, i + NAME_LOOKUP_CONCURRENCY);
    const detailPages = await Promise.all(
      batch.map((item) =>
        fetchWithRetry(`${BID4ASSETS_AUCTION_DETAIL_BASE}/${item.auctionID}`)
          .then((res) => (res.ok ? res.text() : ""))
          .catch(() => ""),
      ),
    );

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j]!;
      const html = detailPages[j] || "";
      if (!html) continue;

      const { apn, legalDescription, street, city } = parseBid4AssetsDetail(html);
      if (!apn || !street) continue;

      let rollMatch: Awaited<ReturnType<typeof lookupByAddress>> = null;
      try {
        rollMatch = await lookupByAddress(street, COUNTY, STATE);
      } catch {
        rollMatch = null;
      }
      if (!rollMatch?.ownerName || !rollMatch.mailingAddress || isGovernmentOwner(rollMatch.ownerName))
        continue;

      const closeDateIso = bid4AssetsCloseDateIso(item.bidCloseTime);
      const minBid = item.minimumBid != null ? String(item.minimumBid) : null;

      leads.push({
        id: makeId(COUNTY, STATE, "Tax Delinquent", `bid4assets-${item.auctionID}`),
        county: COUNTY,
        state: STATE,
        lead_type: "Tax Delinquent",
        owner_name: rollMatch.ownerName,
        address: rollMatch.address || street,
        city: rollMatch.city || city || null,
        zip: rollMatch.zip || null,
        mailing_address: rollMatch.mailingAddress,
        mailing_city: rollMatch.mailingCity || null,
        mailing_state: rollMatch.mailingState || "CA",
        mailing_zip: rollMatch.mailingZip || null,
        case_number: apn,
        filing_date: null,
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: closeDateIso,
        sale_amount: minBid,
        description:
          `Orange County CA Tax-Defaulted Property Auction — APN ${apn}` +
          (legalDescription ? ` — ${legalDescription}` : "") +
          (minBid ? ` — Min Bid $${minBid}` : ""),
        source_url: `${BID4ASSETS_AUCTION_DETAIL_BASE}/${item.auctionID}`,
        raw_data: JSON.stringify({ item, apn, legalDescription, street, city }),
      });
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
    Foreclosure: () => scrapeCaliforniaForeclosure(fromDate, toDate),
    "Code Violation": () => scrapeCaliforniaCodeViolation(fromDate, toDate),
    "Tax Delinquent": () => scrapeCaliforniaTaxDelinquent(),
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
