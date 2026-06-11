// @ts-nocheck
/**
 * Missouri County Scrapers
 * Counties: Jackson, Clay, Platte, Cass
 *
 * Sources (all real county/city portals — no federal APIs):
 * - Pre-Foreclosure: Jackson County Recorder of Deeds (recorder.jacksongov.org)
 * - Sheriff Sales:   County sheriff civil process pages
 * - Tax Delinquent:  County collector/treasurer portals
 * - Probate:         Missouri Case.net (courts.mo.gov) — state court system
 * - Bankruptcy:      PACER RSS — Western District MO (ecf.mowb.uscourts.gov)
 * - Code Violations: Kansas City Open Data (data.kcmo.org)
 * - FSBO:            Craigslist Kansas City
 *
 * NOTE: CourtListener removed — returns 0 for all MO county lead types.
 * NOTE: Divorce/Eviction via PACER removed — federal courts don't have state divorce cases.
 * NOTE: Out-of-State Owners via CourtListener removed — not a valid source.
 */

import * as cheerio from "cheerio";
import { PDFParse } from "pdf-parse";
import { filterLeadsByTypes, normalizeLeadTypes } from "../config/county-lead-types.js";
import { extractAddressFromListing } from "../services/owner-placeholders.js";
import {
  Lead,
  makeId,
  formatDate,
  fetchWithRetry,
  fetchRendered,
  fetchBlockedPage,
  CountyConfig,
} from "./base.js";
import {
  collectCraigslistSearchItems,
  fetchCraigslistListingDetails,
} from "./craigslist.js";
import { lookupOwnerProperties, lookupByAddress } from "./assessor.js";

const STATE = "MO";
const OUTER_MO_COUNTIES = new Set(["clay", "platte", "cass"]);

type TaxSalePdfRow = {
  owner: string;
  address: string;
  city: string;
  zip: string | null;
  acct: string;
  amount: string | null;
};

function parseTaxSalePdfLine(line: string): TaxSalePdfRow | null {
  if (!/\$\s*[\d,]+/.test(line) || /Property Owner Name|Tax Sale #/i.test(line)) return null;
  const parts = line
    .split(/\t+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const dollarIdx = parts.findIndex((p) => p === "$");
  if (dollarIdx < 5) return null;

  const amount = parts[dollarIdx + 1] || null;
  const cityStateZip = parts[dollarIdx - 2] || "";
  const address = parts[dollarIdx - 3] || "";
  const owner = parts[dollarIdx - 4] || "";
  let acctIdx = dollarIdx - 5;
  if (/^\d+(?:ST|ND|RD|TH)?$/i.test(parts[acctIdx])) acctIdx -= 1;
  const acct = parts[acctIdx] || "";
  if (!owner || owner.length < 2) return null;

  const cityZip = cityStateZip.match(/^(.+?),\s*MO\s*(\d{5})/i);
  return {
    owner,
    address,
    city: cityZip?.[1]?.trim() || "Harrisonville",
    zip: cityZip?.[2] || null,
    acct,
    amount,
  };
}

async function fetchTaxSalePdfRows(pdfUrl: string): Promise<TaxSalePdfRow[]> {
  const res = await fetchWithRetry(pdfUrl);
  if (!res.ok) return [];
  const buf = Buffer.from(await res.arrayBuffer());
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    const rows: TaxSalePdfRow[] = [];
    for (const line of (result.text || "").split("\n")) {
      const row = parseTaxSalePdfLine(line.trim());
      if (row) rows.push(row);
    }
    return rows;
  } finally {
    await parser.destroy();
  }
}

async function enrichAddressOwners(leads: Lead[], county: string): Promise<void> {
  const CONCURRENCY = 10;
  const needs = leads.filter((l) => !l.owner_name?.trim() && l.address?.trim());
  for (let i = 0; i < needs.length; i += CONCURRENCY) {
    const batch = needs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((l) => lookupByAddress(l.address!, county, STATE)));
    for (let j = 0; j < batch.length; j++) {
      const prop = results[j];
      if (prop?.ownerName) batch[j].owner_name = prop.ownerName;
      if (prop?.address) batch[j].address = prop.address;
      if (prop?.city) batch[j].city = prop.city;
      if (prop?.zip) batch[j].zip = prop.zip;
    }
  }
}

// ─── JACKSON COUNTY Pre-Foreclosure via Recorder of Deeds ────────────────────
async function scrapeJacksonPreForeclosure(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const COUNTY = "Jackson";
  try {
    // Jackson County Recorder of Deeds — Lis Pendens search
    // Uses ScraperAPI (fetchRendered) to bypass geo-block on recorder.jacksongov.org.
    // Falls through gracefully to Case.net LIS PENDENS scraper if still unreachable.
    const url = `https://recorder.jacksongov.org/search/commonsearch.aspx?mode=advanced`;
    const res = await fetchRendered(url).catch(() => null);
    if (!res || !res.ok) {
      console.warn(
        `[Jackson MO] Pre-Foreclosure: recorder.jacksongov.org unreachable even via proxy — covered by Case.net LIS PENDENS scraper`,
      );
      return leads;
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const viewstate = $("input[name='__VIEWSTATE']").val() as string;
    const eventvalidation = $("input[name='__EVENTVALIDATION']").val() as string;

    if (!viewstate) return leads; // page didn't load properly

    const searchRes = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        __VIEWSTATE: viewstate || "",
        __EVENTVALIDATION: eventvalidation || "",
        DocType: "LIS PENDENS",
        DateFrom: fromDate,
        DateTo: toDate,
        btnSearch: "Search",
      }).toString(),
    });

    if (searchRes.ok) {
      const searchHtml = await searchRes.text();
      const $s = cheerio.load(searchHtml);

      $s("table.searchResults tr, #searchResults tr, table tr").each((_, row) => {
        const cells = $s(row).find("td");
        if (cells.length < 3) return;

        const docNum = $s(cells[0]).text().trim();
        const grantor = $s(cells[1]).text().trim();
        const grantee = $s(cells[2]).text().trim();
        const recDate = $s(cells[3])?.text().trim() || "";
        const address = $s(cells[4])?.text().trim() || "";

        if (!docNum || docNum === "Doc #" || docNum === "Document") return;

        leads.push({
          id: makeId(COUNTY, STATE, "Pre-Foreclosure", docNum),
          county: COUNTY,
          state: STATE,
          lead_type: "Pre-Foreclosure",
          owner_name: grantor || null,
          address: address || null,
          city: "Kansas City",
          zip: null,
          mailing_address: null,
          mailing_city: null,
          mailing_state: null,
          mailing_zip: null,
          case_number: docNum,
          filing_date: formatDate(recDate),
          assessed_value: null,
          tax_year: null,
          lender: grantee || null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Lis Pendens recorded — ${grantor} / ${grantee}`,
          source_url: url,
          raw_data: JSON.stringify({ docNum, grantor, grantee, recDate }),
        });
      });
    }
  } catch (e) {
    console.error(`[Jackson MO] Pre-Foreclosure error:`, e);
  }
  return leads;
}

// ─── JACKSON COUNTY Tax Delinquent ───────────────────────────────────────────
// 16th Circuit Court delinquent land tax — paginated ASP (direct fetch, no JS render)
const DLT_BROWSE_URL = "https://www.16thcircuit.org/courtapps/dlt/browseall.asp";

function parse16thCircuitParcel(html: string): {
  suitNo: string;
  parcel: string;
  owner: string;
  address: string;
} | null {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  $("td.labels").each((_, labelEl) => {
    const label = $(labelEl).text().replace(/\s+/g, " ").trim().toLowerCase();
    const value = $(labelEl)
      .nextAll("td.datafield")
      .first()
      .text()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (label && value) fields[label] = value;
  });
  const parcel =
    fields["parcel no"] ||
    Object.values(fields).find((v) => /\d{2}-\d{3}-\d{2}-\d{2}/.test(v)) ||
    "";
  const owner = fields.owner || fields["record owner"] || "";
  const address = fields["property address"] || "";
  const suitNo = fields["suit no"] || "";
  if (!parcel || !owner || /parcel|owner|suit/i.test(owner)) return null;
  return { suitNo, parcel, owner, address };
}

async function scrapeJacksonTaxDelinquent(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const COUNTY = "Jackson";
  const MAX_PAGES = 100;
  try {
    for (let index = 0; index < MAX_PAGES; index++) {
      const pageUrl = index === 0 ? DLT_BROWSE_URL : `${DLT_BROWSE_URL}?index=${index}`;
      const res = await fetchWithRetry(pageUrl);
      if (!res.ok) break;
      const parsed = parse16thCircuitParcel(await res.text());
      if (!parsed) break;
      leads.push({
        id: makeId(COUNTY, STATE, "Tax Delinquent", parsed.parcel),
        county: COUNTY,
        state: STATE,
        lead_type: "Tax Delinquent",
        owner_name: parsed.owner,
        address: parsed.address || null,
        city: "Kansas City",
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: parsed.suitNo || parsed.parcel,
        filing_date: formatDate(fromDate),
        assessed_value: null,
        tax_year: new Date().getFullYear().toString(),
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: `Tax Delinquent — Parcel ${parsed.parcel} — ${parsed.owner}`,
        source_url: pageUrl,
        raw_data: JSON.stringify(parsed),
      });
    }

    const CONCURRENCY = 10;
    const needsAddr = leads.filter((l) => l.owner_name && (!l.address || !l.zip)).slice(0, 40);
    for (let i = 0; i < needsAddr.length; i += CONCURRENCY) {
      const batch = needsAddr.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((l) =>
          l.address
            ? lookupByAddress(l.address, COUNTY, STATE)
            : lookupOwnerProperties(l.owner_name!, COUNTY, STATE).then((p) => p[0] || null),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        const prop = results[j];
        if (!prop) continue;
        if (prop.ownerName && !batch[j].owner_name) batch[j].owner_name = prop.ownerName;
        if (prop.address) batch[j].address = prop.address;
        if (prop.city) batch[j].city = prop.city;
        if (prop.zip) batch[j].zip = prop.zip;
        if (!batch[j].mailing_address && prop.address) {
          batch[j].mailing_address = prop.address;
          batch[j].mailing_city = prop.city;
          batch[j].mailing_state = STATE;
          batch[j].mailing_zip = prop.zip || null;
        }
      }
    }
  } catch (e) {
    console.error(`[Jackson MO] Tax Delinquent error:`, e);
  }
  return leads.slice(0, 200);
}

// ─── JACKSON COUNTY Sheriff Sales ────────────────────────────────────────────
// CONFIRMED WORKING: Jackson County Sheriff civil process page
// URL: https://www.jacksongov.org/government/departments/sheriff/civil-process
async function scrapeJacksonSheriffSales(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const COUNTY = "Jackson";
  try {
    // Jackson County Sheriff — civil process / foreclosure sales
    const url = "https://www.jacksongov.org/government/departments/sheriff/civil-process";
    const res = await fetchWithRetry(url);
    if (!res.ok) return leads;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Parse table rows — typically: Case #, Property Address, Sale Date, Judgment Amount
    $("table tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 2) return;
      const caseNum = $(cells[0]).text().trim();
      const address = $(cells[1]).text().trim();
      const saleDate = $(cells[2])?.text().trim();
      const amount = $(cells[3])?.text().trim();

      if (!caseNum || /case|#|number/i.test(caseNum)) return;
      if (!address && !caseNum) return;

      leads.push({
        id: makeId(COUNTY, STATE, "Sheriff Sale", caseNum),
        county: COUNTY,
        state: STATE,
        lead_type: "Sheriff Sale",
        owner_name: null,
        address: address || null,
        city: "Kansas City",
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: caseNum,
        filing_date: formatDate(fromDate),
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: formatDate(saleDate || ""),
        sale_amount: amount || null,
        description: `Sheriff Sale — Case ${caseNum}`,
        source_url: url,
        raw_data: JSON.stringify({ caseNum, address, saleDate, amount }),
      });
    });

    // Also check for PDF/list links on the page
    $("a[href*='civil'], a[href*='sale'], a[href*='foreclos']").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (!href || leads.some((l) => l.source_url === href)) return;
      leads.push({
        id: makeId(COUNTY, STATE, "Sheriff Sale", href),
        county: COUNTY,
        state: STATE,
        lead_type: "Sheriff Sale",
        owner_name: null,
        address: null,
        city: "Kansas City",
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: null,
        filing_date: formatDate(fromDate),
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: `Jackson County Sheriff Sale — ${text}`,
        source_url: href.startsWith("http") ? href : `https://www.jacksongov.org${href}`,
        raw_data: JSON.stringify({ text, href }),
      });
    });
  } catch (e) {
    console.error(`[Jackson MO] Sheriff Sales error:`, e);
  }
  return leads;
}

// ─── JACKSON COUNTY Probate via Missouri Case.net ────────────────────────────
async function scrapeJacksonProbate(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const COUNTY = "Jackson";
  try {
    // Missouri Case.net — public court search
    // Jackson County = county code 16
    const url = `https://www.courts.mo.gov/casenet/cases/searchCases.do`;
    const body = new URLSearchParams({
      countyCode: "16", // Jackson County
      caseType: "P", // Probate
      fromDate: fromDate,
      toDate: toDate,
      submit: "Search",
    }).toString();

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return leads;

    const html = await res.text();
    const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const rows = html.match(rowRe) || [];

    // Collect all cases first, then batch-lookup assessor in parallel
    type CaseRow = { caseNum: string; caseName: string; filedDate: string };
    const cases: CaseRow[] = [];
    for (const row of rows) {
      const cells: string[] = [];
      let m;
      while ((m = cellRe.exec(row)) !== null) {
        cells.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      cellRe.lastIndex = 0;
      if (cells.length < 2 || !cells[0]) continue;
      const caseNum = cells[0];
      const caseName = cells[1];
      const filedDate = cells[2] || fromDate;
      if (!caseNum || caseNum.toLowerCase().includes("case")) continue;
      cases.push({ caseNum, caseName, filedDate });
    }
    // Parallel assessor lookups — 5 concurrent
    const CONCURRENCY = 5;
    for (let i = 0; i < cases.length; i += CONCURRENCY) {
      const batch = cases.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((c) => lookupOwnerProperties(c.caseName, COUNTY, STATE)),
      );
      for (let j = 0; j < batch.length; j++) {
        const { caseNum, caseName, filedDate } = batch[j];
        const properties = results[j];
        if (properties.length === 0) continue;
        for (const prop of properties) {
          leads.push({
            id: makeId(COUNTY, STATE, "Probate", `${caseNum}-${prop.address}`),
            county: COUNTY,
            state: STATE,
            lead_type: "Probate/Estate",
            owner_name: caseName || null,
            address: prop.address,
            city: prop.city || "Kansas City",
            zip: prop.zip || null,
            mailing_address: null,
            mailing_city: null,
            mailing_state: null,
            mailing_zip: null,
            case_number: caseNum,
            filing_date: formatDate(filedDate),
            assessed_value: null,
            tax_year: null,
            lender: null,
            loan_amount: null,
            sale_date: null,
            sale_amount: null,
            description: `Jackson County MO Probate — ${caseName || caseNum}`,
            source_url: url,
            raw_data: JSON.stringify({ caseNum, caseName, filedDate, parcelId: prop.parcelId }),
          });
        }
      }
    }
  } catch (e) {
    console.error(`[Jackson MO] Probate error:`, e);
  }
  return leads;
}

const PLATTE_ZIPS = new Set([
  "64048",
  "64058",
  "64068",
  "64079",
  "64098",
  "64150",
  "64151",
  "64152",
  "64153",
  "64154",
  "64155",
  "64156",
  "64157",
  "64158",
  "64163",
  "64164",
  "64165",
  "64166",
  "64167",
  "64168",
  "64190",
]);

function parseMOCaseOwner(caseName: string): string | null {
  const n = caseName.replace(/\s+/g, " ").trim();
  if (!n || /case|number|style|search/i.test(n)) return null;
  const fromEstate = n
    .match(/(?:Estate|In re|In the Estate)\s+(?:of\s+)?(.+?)(?:,|\s+Deceased|\s+Dec'?d|$)/i)?.[1]
    ?.trim();
  if (fromEstate && fromEstate.length >= 2) return fromEstate;
  const fromVs = n.split(/\s+v\.?\s+/i);
  if (fromVs.length > 1) {
    const defendant = fromVs[1].split(",")[0].trim();
    if (defendant.length >= 2) return defendant;
  }
  const plain = n.split(",")[0].trim();
  return plain.length >= 2 ? plain : null;
}

function appendCraigslistFsboLeads(
  leads: Lead[],
  html: string,
  county: string,
  sourceUrl: string,
  fromDate: string,
  defaultCity: string,
): void {
  const $ = cheerio.load(html);
  const seen = new Set(leads.map((l) => l.id));

  const pushFsbo = (title: string, link: string, price: string, date: string) => {
    if (!title || title.length < 5) return;
    const parsedAddress = extractAddressFromListing(title);
    const id = makeId(county, STATE, "FSBO", link || title);
    if (seen.has(id)) return;
    seen.add(id);
    leads.push({
      id,
      county,
      state: STATE,
      lead_type: "FSBO",
      owner_name: null,
      address: parsedAddress || title,
      city: defaultCity,
      zip: null,
      mailing_address: null,
      mailing_city: null,
      mailing_state: null,
      mailing_zip: null,
      case_number: null,
      filing_date: formatDate(date || fromDate),
      assessed_value: null,
      tax_year: null,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: price.replace(/[^\d.]/g, "") || null,
      description: title,
      source_url: link.startsWith("http") ? link : `https://kansascity.craigslist.org${link}`,
      raw_data: JSON.stringify({ title, price, sourceUrl }),
    });
  };

  $("li.cl-static-search-result, li.result-row, .cl-search-result").each((_, el) => {
    const title = $(el)
      .find(".title, .result-title, a.posting-title, .title-blob")
      .first()
      .text()
      .trim();
    const price = $(el).find(".price, .result-price, .priceinfo").first().text().trim();
    const date = $(el).find("time").attr("datetime") || "";
    const link = $(el).find("a").first().attr("href") || "";
    pushFsbo(title, link, price, date);
  });

  $("a[href*='/rea/d/'], a[href*='/reo/d/']").each((_, el) => {
    const link = $(el).attr("href") || "";
    const title =
      $(el).find(".title").first().text().trim() ||
      $(el).text().trim() ||
      $(el).attr("title") ||
      "";
    pushFsbo(title, link, "", "");
  });
}

async function scrapePlatteCaseNet(
  caseType: string,
  leadType: string,
  fromDate: string,
  toDate: string,
): Promise<Lead[]> {
  const COUNTY = "Platte";
  const leads: Lead[] = [];
  const url = "https://www.courts.mo.gov/casenet/cases/searchCases.do";
  const body = new URLSearchParams({
    countyCode: "25",
    caseType,
    fromDate,
    toDate,
    submit: "Search",
  }).toString();

  const html = await fetchBlockedPage(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!html) return leads;

  const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (const row of html.match(rowRe) || []) {
    const cells: string[] = [];
    let m;
    while ((m = cellRe.exec(row)) !== null) {
      cells.push(m[1].replace(/<[^>]+>/g, "").trim());
    }
    cellRe.lastIndex = 0;
    if (cells.length < 2 || !cells[0] || cells[0].toLowerCase().includes("case")) continue;

    const caseNum = cells[0];
    const caseName = cells[1];
    const filedDate = cells[2] || fromDate;
    const owner = parseMOCaseOwner(caseName);
    if (!owner) continue;

    leads.push({
      id: makeId(COUNTY, STATE, leadType, `${caseNum}-${owner}`),
      county: COUNTY,
      state: STATE,
      lead_type: leadType,
      owner_name: owner,
      address: null,
      city: "Platte City",
      zip: null,
      mailing_address: null,
      mailing_city: null,
      mailing_state: null,
      mailing_zip: null,
      case_number: caseNum,
      filing_date: formatDate(filedDate),
      assessed_value: null,
      tax_year: null,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: null,
      description: `Platte County MO ${leadType} — ${caseName}`,
      source_url: url,
      raw_data: JSON.stringify({ caseNum, caseName, filedDate }),
    });
  }
  return leads;
}

async function scrapePlatteBankruptcy(fromDate: string, toDate: string): Promise<Lead[]> {
  const COUNTY = "Platte";
  const leads: Lead[] = [];
  try {
    const rss = await fetchWithRetry("https://ecf.mowb.uscourts.gov/cgi-bin/rss_outside.pl");
    if (!rss.ok) return leads;
    const xml = await rss.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    type BkItem = { caseNum: string; caseName: string; pubDate: string; link: string };
    const bkItems: BkItem[] = [];

    for (const item of items) {
      const title =
        (item.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) ||
          item.match(/<title>(.+?)<\/title>/))?.[1]?.trim() || "";
      const link = item.match(/<link>(.+?)<\/link>/)?.[1]?.trim() || "";
      const pubDate = item.match(/<pubDate>(.+?)<\/pubDate>/)?.[1]?.trim() || "";
      const caseNum = title.match(/([0-9]{2}-[0-9]{5})/)?.[1] || title;
      const caseName = title.replace(/^[0-9]{2}-[0-9]{5}(-[a-zA-Z0-9]+)?\s*/, "").trim();
      if (pubDate) {
        const d = new Date(pubDate);
        if (!isNaN(d.getTime())) {
          const from = new Date(fromDate);
          const to = new Date(toDate);
          to.setHours(23, 59, 59, 999);
          if (d < from || d > to) continue;
        }
      }
      if (caseName.length >= 2) bkItems.push({ caseNum, caseName, pubDate, link });
    }

    const CONCURRENCY = 5;
    for (let i = 0; i < Math.min(bkItems.length, 30); i += CONCURRENCY) {
      const batch = bkItems.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((b) => lookupOwnerProperties(b.caseName, COUNTY, STATE)),
      );
      for (let j = 0; j < batch.length; j++) {
        const { caseNum, caseName, pubDate, link } = batch[j];
        const platteProps = results[j].filter((p) => p.zip && PLATTE_ZIPS.has(p.zip.slice(0, 5)));
        if (!platteProps.length) continue;
        for (const prop of platteProps) {
          leads.push({
            id: makeId(COUNTY, STATE, "Bankruptcy", `${caseNum}-${prop.address}`),
            county: COUNTY,
            state: STATE,
            lead_type: "Bankruptcy",
            owner_name: prop.ownerName || caseName,
            address: prop.address,
            city: prop.city || "Platte City",
            zip: prop.zip || null,
            mailing_address: null,
            mailing_city: null,
            mailing_state: null,
            mailing_zip: null,
            case_number: caseNum,
            filing_date: pubDate
              ? formatDate(new Date(pubDate).toISOString().slice(0, 10))
              : formatDate(fromDate),
            assessed_value: null,
            tax_year: null,
            lender: null,
            loan_amount: null,
            sale_date: null,
            sale_amount: null,
            description: `Platte County MO Bankruptcy — ${caseName}`,
            source_url: link || "https://ecf.mowb.uscourts.gov/cgi-bin/rss_outside.pl",
            raw_data: JSON.stringify({ caseNum, caseName, pubDate, parcelId: prop.parcelId }),
          });
        }
      }
    }
  } catch (e) {
    console.error("[Platte MO] Bankruptcy error:", e);
  }
  return leads;
}

function parseSheriffNoticeText(
  noticeHtml: string,
  county: string,
  state: string,
  sourceUrl: string,
  fromDate: string,
): Lead | null {
  const text = cheerio.load(noticeHtml).text().replace(/\s+/g, " ").trim();
  if (/CANCELLED/i.test(text)) return null;

  const caseNum = text.match(/Case\s+No\.?\s*([\w-]+)/i)?.[1] || null;
  const owner =
    text.match(/vs\.?\s*([^,]+),\s*Defendant/i)?.[1]?.trim() ||
    text.match(/Defendant[:\s]+([^,.]+)/i)?.[1]?.trim() ||
    null;
  const saleDateMatch = text.match(
    /on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+day of\s+(\w+),?\s+(\d{4})/i,
  );
  let saleDate: string | null = null;
  if (saleDateMatch) {
    const parsed = new Date(`${saleDateMatch[2]} ${saleDateMatch[1]}, ${saleDateMatch[3]}`);
    if (!isNaN(parsed.getTime())) saleDate = formatDate(parsed.toISOString().slice(0, 10));
  }
  const address =
    text.match(/described as[:\s]+(.+?)(?:\.|Situated in)/i)?.[1]?.trim() ||
    text.match(/(Lot\s+\d+[^.]{5,80})/i)?.[1]?.trim() ||
    text.match(/(\d+\s+[\w\s]+(?:Kansas City|Liberty)[^,]*,\s*MO\s*\d{5})/i)?.[1]?.trim() ||
    null;

  if (!caseNum && !owner && !address) return null;

  let city = "Liberty";
  if (/Kansas City/i.test(text)) city = "Kansas City";
  else if (/Platte City/i.test(text)) city = "Platte City";
  else if (/Parkville/i.test(text)) city = "Parkville";
  else if (/Weston/i.test(text)) city = "Weston";
  else if (county === "Platte") city = "Platte City";
  else if (county === "Cass") city = "Harrisonville";
  return {
    id: makeId(county, state, "Sheriff Sale", caseNum || owner || address || text.slice(0, 40)),
    county,
    state,
    lead_type: "Sheriff Sale",
    owner_name: owner,
    address,
    city,
    zip: address?.match(/\b(\d{5})\b/)?.[1] || null,
    mailing_address: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    case_number: caseNum,
    filing_date: formatDate(fromDate),
    assessed_value: null,
    tax_year: null,
    lender: null,
    loan_amount: null,
    sale_date: saleDate,
    sale_amount: null,
    description: `${county} County ${state} Sheriff Sale — ${owner || caseNum || address}`,
    source_url: sourceUrl,
    raw_data: JSON.stringify({ caseNum, owner, address, saleDate }),
  };
}

// ─── CLAY COUNTY ─────────────────────────────────────────────────────────────
async function scrapeClayCounty(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const COUNTY = "Clay";
  try {
    const sheriffUrl = "https://www.sheriffclayco.org/community-resources/sheriffs-property-sales/";
    let res = await fetchWithRetry(sheriffUrl);
    let html = res.ok ? await res.text() : "";
    if (!/Notice of Sheriff/i.test(html)) {
      const rendered = await fetchRendered(sheriffUrl);
      if (rendered.ok) html = await rendered.text();
    }

    for (const chunk of html.split(/Notice of Sheriff'?s? Sale/i).slice(1)) {
      const lead = parseSheriffNoticeText(chunk, COUNTY, STATE, sheriffUrl, fromDate);
      if (lead) leads.push(lead);
    }

    const taxUrl = "https://claycountymo.tax/tax-sale/";
    const taxRes = await fetchWithRetry(taxUrl);
    if (taxRes.ok) {
      const taxHtml = await taxRes.text();
      const $ = cheerio.load(taxHtml);
      $("a[href*='.pdf'], a[href*='sold'], a[href*='list']").each((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().trim();
        if (!href || !/tax|sold|list|delinquent/i.test(text + href)) return;
        leads.push({
          id: makeId(COUNTY, STATE, "Tax Delinquent", href),
          county: COUNTY,
          state: STATE,
          lead_type: "Tax Delinquent",
          owner_name: null,
          address: null,
          city: "Liberty",
          zip: null,
          mailing_address: null,
          mailing_city: null,
          mailing_state: null,
          mailing_zip: null,
          case_number: null,
          filing_date: formatDate(fromDate),
          assessed_value: null,
          tax_year: new Date().getFullYear().toString(),
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Clay County Tax Delinquent — ${text}`,
          source_url: href.startsWith("http") ? href : `https://claycountymo.tax${href}`,
          raw_data: JSON.stringify({ text, href }),
        });
      });
    }
  } catch (e) {
    console.error(`[Clay MO] error:`, e);
  }
  await enrichAddressOwners(leads, COUNTY);
  return leads;
}

// ─── PLATTE COUNTY ───────────────────────────────────────────────────────────
async function scrapePlatteCounty(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const COUNTY = "Platte";
  try {
    const sheriffUrl = "https://www.plattesheriff.org/community-resources/sheriffs-property-sales/";
    const sheriffHtml = await fetchBlockedPage(sheriffUrl);
    for (const chunk of sheriffHtml.split(/Notice of Sheriff'?s? Sale/i).slice(1)) {
      const lead = parseSheriffNoticeText(chunk, COUNTY, STATE, sheriffUrl, fromDate);
      if (lead) {
        lead.city = lead.city || "Platte City";
        leads.push(lead);
      }
    }

    try {
      const taxUrl = "https://plattecountycollector.com/taxsale6.php";
      const taxHtml = await fetchBlockedPage(taxUrl);
      if (taxHtml.trim().length > 100) {
        const $ = cheerio.load(taxHtml);
        $("table tr").each((_, row) => {
          const cells = $(row)
            .find("td")
            .map((__, td) => $(td).text().trim())
            .get();
          if (cells.length < 2) return;
          const owner = cells[0];
          const address = cells[1] || cells[2];
          if (!owner || owner.length < 2 || /owner|name|parcel/i.test(owner)) return;
          leads.push({
            id: makeId(COUNTY, STATE, "Tax Delinquent", `${owner}-${address}`),
            county: COUNTY,
            state: STATE,
            lead_type: "Tax Delinquent",
            owner_name: owner,
            address: address || null,
            city: "Platte City",
            zip: null,
            mailing_address: null,
            mailing_city: null,
            mailing_state: null,
            mailing_zip: null,
            case_number: cells[2] || null,
            filing_date: formatDate(fromDate),
            assessed_value: null,
            tax_year: new Date().getFullYear().toString(),
            lender: null,
            loan_amount: null,
            sale_date: null,
            sale_amount: null,
            description: `Platte County Tax Delinquent — ${owner}`,
            source_url: taxUrl,
            raw_data: JSON.stringify(cells),
          });
        });
      }
    } catch {
      /* collector may be empty or TLS-blocked */
    }

    const fsboSearches = [
      "https://kansascity.craigslist.org/search/rea?query=platte&purveyor=owner",
      "https://kansascity.craigslist.org/search/rea?query=parkville&purveyor=owner",
      "https://kansascity.craigslist.org/search/rea?query=weston+mo&purveyor=owner",
      "https://kansascity.craigslist.org/search/rea?query=platte+city&purveyor=owner",
    ];
    const seenFsbo = new Set<string>();
    for (const searchUrl of fsboSearches) {
      const fsboHtml = await fetchBlockedPage(searchUrl);
      if (!fsboHtml) continue;
      const items = collectCraigslistSearchItems(fsboHtml, "https://kansascity.craigslist.org");
      const detailed = await fetchCraigslistListingDetails(items, 12);
      for (const item of detailed) {
        const address = item.address || extractAddressFromListing(item.title);
        if (!address || address.length < 5) continue;
        const id = makeId(COUNTY, STATE, "FSBO", item.url);
        if (seenFsbo.has(id)) continue;
        const prop = await lookupByAddress(address, COUNTY, STATE);
        seenFsbo.add(id);
        leads.push({
          id,
          county: COUNTY,
          state: STATE,
          lead_type: "FSBO",
          owner_name: prop?.ownerName || null,
          address: prop?.address || address,
          city: prop?.city || item.city || "Platte City",
          zip: prop?.zip || item.zip || null,
          mailing_address: null,
          mailing_city: null,
          mailing_state: null,
          mailing_zip: null,
          case_number: null,
          filing_date: formatDate(item.date || fromDate),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: (item.price || "").replace(/[^\d.]/g, "") || null,
          description: item.title,
          source_url: item.url,
          raw_data: JSON.stringify({ title: item.title, price: item.price }),
        });
      }
    }

    const [probate, lisPendens, bankruptcy] = await Promise.all([
      scrapePlatteCaseNet("P", "Probate", fromDate, toDate),
      scrapePlatteCaseNet("L", "Lis Pendens", fromDate, toDate),
      scrapePlatteBankruptcy(fromDate, toDate),
    ]);
    leads.push(...probate, ...lisPendens, ...bankruptcy);
  } catch (e) {
    console.error(`[Platte MO] error:`, e);
  }
  await enrichAddressOwners(leads, COUNTY);
  return leads;
}

// ─── CASS COUNTY ─────────────────────────────────────────────────────────────
async function scrapeCassCounty(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const COUNTY = "Cass";
  const taxPdfUrl = "https://www.casscounty.com/DocumentCenter/View/3889/2024-TAX-SALE-LIST";
  try {
    const rows = await fetchTaxSalePdfRows(taxPdfUrl);
    for (const row of rows) {
      leads.push({
        id: makeId(COUNTY, STATE, "Tax Delinquent", `${row.acct}-${row.owner}`),
        county: COUNTY,
        state: STATE,
        lead_type: "Tax Delinquent",
        owner_name: row.owner,
        address: row.address || null,
        city: row.city,
        zip: row.zip,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: row.acct || null,
        filing_date: formatDate(fromDate),
        assessed_value: null,
        tax_year: new Date().getFullYear().toString(),
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: row.amount,
        description: `Cass County Tax Delinquent — ${row.owner}`,
        source_url: taxPdfUrl,
        raw_data: JSON.stringify(row),
      });
    }
  } catch (e) {
    console.error(`[Cass MO] error:`, e);
  }
  await enrichAddressOwners(leads, COUNTY);
  return leads;
}

// ─── KC Code Violations via Kansas City Open Data ────────────────────────────
// CONFIRMED WORKING: KC 311 Socrata API — dataset d4px-6rwg (311 Call Center Service Requests)
// No auth required. Returns real-time code violations, fire/dangerous, water shutoffs.
async function scrapeKCCodeViolations(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // KC 311 Socrata d4px-6rwg — same dataset as Water Shutoff / Fire Damage
    const types = [
      "Dangerous Buildings",
      "Health Code Violations",
      "Property Violations",
      "Contract and Labor Violations",
    ];
    const typeClause = types.map((t) => `issue_type='${t}'`).join(" OR ");
    const where = `open_date_time>='${fromDate}T00:00:00' AND (${typeClause})`;
    const url = `https://data.kcmo.org/resource/d4px-6rwg.json?$where=${encodeURIComponent(where)}&$limit=100&$order=${encodeURIComponent("open_date_time DESC")}`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return leads;

    const data = (await res.json()) as Record<string, string>[];
    for (const item of data) {
      const address = item.incident_address || item.address || "";
      if (!address) continue;
      const type = item.issue_type || item.issue_sub_type || "Code Violation";
      const date = item.open_date_time?.slice(0, 10) || fromDate;
      const caseNum = item.workorder_ || item.case_id || "";

      leads.push({
        id: makeId("Jackson", STATE, "Code Violation", caseNum || address),
        county: "Jackson",
        state: STATE,
        lead_type: "Code Violation",
        owner_name: null,
        address: address || null,
        city: "Kansas City",
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: caseNum || null,
        filing_date: formatDate(date),
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: `Code Violation — ${type} — ${address}`,
        source_url: "https://data.kcmo.org/311/311-Call-Center-Reported-Issues/d4px-6rwg",
        raw_data: JSON.stringify(item),
      });
    }

    const CONCURRENCY_ADDR = 10;
    const unenrichedAddr = leads.filter((l) => !l.owner_name && l.address).slice(0, 40);
    for (let i = 0; i < unenrichedAddr.length; i += CONCURRENCY_ADDR) {
      const batch = unenrichedAddr.slice(i, i + CONCURRENCY_ADDR);
      const results = await Promise.all(
        batch.map((l) => lookupByAddress(l.address!, l.county, STATE)),
      );
      for (let j = 0; j < batch.length; j++) {
        const prop = results[j];
        if (prop?.ownerName) batch[j].owner_name = prop.ownerName;
        if (prop?.address) batch[j].address = prop.address;
        if (prop?.zip && !batch[j].zip) batch[j].zip = prop.zip;
      }
    }
  } catch (e) {
    console.error("[MO] KC Code Violations error:", e);
  }
  return leads;
}

// ─── KC Craigslist FSBO ───────────────────────────────────────────────────────
function resolveMoCountyFromLocation(location: string): string {
  const locLower = location.toLowerCase();
  if (locLower.includes("liberty") || locLower.includes("kearney") || locLower.includes("clay"))
    return "Clay";
  if (
    locLower.includes("platte") ||
    locLower.includes("parkville") ||
    locLower.includes("camden") ||
    locLower.includes("weston") ||
    locLower.includes("dearborn") ||
    locLower.includes("smithville")
  )
    return "Platte";
  if (
    locLower.includes("cass") ||
    locLower.includes("harrisonville") ||
    locLower.includes("belton")
  )
    return "Cass";
  return "Jackson";
}

async function scrapeKCCraigslistFSBO(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const baseHost = "https://kansascity.craigslist.org";
  try {
    const url = `${baseHost}/search/rea?query=for+sale+by+owner&purveyor=owner`;
    const html = await fetchBlockedPage(url);
    if (!html) return leads;

    const items = collectCraigslistSearchItems(html, baseHost);
    const detailed = await fetchCraigslistListingDetails(items, 30);

    for (const item of detailed) {
      const location = item.location?.replace(/[()]/g, "").trim() || "";
      const county = resolveMoCountyFromLocation(location);
      const address =
        item.address ||
        extractAddressFromListing(item.title) ||
        extractAddressFromListing(location);
      if (!address || address.length < 5) continue;

      const lead: Lead = {
        id: makeId(county, STATE, "FSBO", item.url),
        county,
        state: STATE,
        lead_type: "FSBO",
        owner_name: null,
        address,
        city: item.city || location || null,
        zip: item.zip || address.match(/\b(\d{5})\b/)?.[1] || null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: null,
        filing_date: formatDate(item.date || fromDate),
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: (item.price || "").replace(/[^\d.]/g, "") || null,
        description: item.title,
        source_url: item.url,
        raw_data: JSON.stringify({ title: item.title, price: item.price, location }),
      };

      const prop = await lookupByAddress(address, county, STATE);
      if (prop?.ownerName) lead.owner_name = prop.ownerName;
      if (prop?.address) lead.address = prop.address;
      if (prop?.city) lead.city = prop.city;
      if (prop?.zip) lead.zip = prop.zip;
      if (lead.address && lead.city) leads.push(lead);
    }
  } catch (e) {
    console.error(`[MO] Craigslist FSBO error:`, e);
  }
  return leads;
}

// ─── LIS PENDENS — Missouri Case.net (all 4 counties) ──────────────────────────
// Missouri Case.net public search — case type "L" = Lis Pendens
// County codes: Jackson=16, Clay=12, Cass=7, Platte=25
// Enrichment: lookupOwnerProperties by case name → only keep leads with a found property
async function scrapeLisPendens(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const counties = [
    { name: "Jackson", code: "16", city: "Kansas City" },
    { name: "Clay", code: "12", city: "Liberty" },
    { name: "Cass", code: "7", city: "Harrisonville" },
    { name: "Platte", code: "25", city: "Platte City" },
  ];
  const url = `https://www.courts.mo.gov/casenet/cases/searchCases.do`;
  for (const { name, code } of counties) {
    try {
      const body = new URLSearchParams({
        countyCode: code,
        caseType: "L",
        fromDate,
        toDate,
        submit: "Search",
      }).toString();
      const html = await fetchBlockedPage(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!html) continue;
      const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const rows = html.match(rowRe) || [];
      type CaseRow = { caseNum: string; caseName: string; filedDate: string };
      const cases: CaseRow[] = [];
      for (const row of rows) {
        const cells: string[] = [];
        let m;
        while ((m = cellRe.exec(row)) !== null) {
          cells.push(m[1].replace(/<[^>]+>/g, "").trim());
        }
        cellRe.lastIndex = 0;
        if (cells.length < 2 || !cells[0] || cells[0].toLowerCase().includes("case")) continue;
        cases.push({ caseNum: cells[0], caseName: cells[1], filedDate: cells[2] || fromDate });
      }
      // Batch assessor enrichment — 5 concurrent
      const CONCURRENCY = 5;
      for (let i = 0; i < cases.length; i += CONCURRENCY) {
        const batch = cases.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((c) => lookupOwnerProperties(c.caseName, name, STATE)),
        );
        for (let j = 0; j < batch.length; j++) {
          const { caseNum, caseName, filedDate } = batch[j];
          const properties = results[j];
          if (properties.length === 0) continue; // skip if no property found
          for (const prop of properties) {
            leads.push({
              id: makeId(name, STATE, "Lis Pendens", `${caseNum}-${prop.address}`),
              county: name,
              state: STATE,
              lead_type: "Lis Pendens",
              owner_name: prop.ownerName || caseName || null,
              address: prop.address,
              city: prop.city || "Kansas City",
              zip: prop.zip || null,
              mailing_address: null,
              mailing_city: null,
              mailing_state: null,
              mailing_zip: null,
              case_number: caseNum,
              filing_date: formatDate(filedDate),
              assessed_value: null,
              tax_year: null,
              lender: null,
              loan_amount: null,
              sale_date: null,
              sale_amount: null,
              description: `${name} County MO Lis Pendens — ${caseName}`,
              source_url: url,
              raw_data: JSON.stringify({ caseNum, caseName, filedDate, parcelId: prop.parcelId }),
            });
          }
        }
      }
    } catch (e) {
      console.error(`[${name} MO] Lis Pendens error:`, e);
    }
  }
  return leads;
}

// ─── PROBATE — Missouri Case.net (Clay, Cass, Platte) ────────────────────────
// Jackson probate is handled by scrapeJacksonProbate above (with assessor enrichment)
// Clay=12, Cass=7, Platte=25
// Enrichment: lookupOwnerProperties by case name → only keep leads with a found property
async function scrapeMOProbate(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const counties = [
    { name: "Clay", code: "12", city: "Liberty" },
    { name: "Cass", code: "7", city: "Harrisonville" },
    { name: "Platte", code: "25", city: "Platte City" },
  ];
  const url = `https://www.courts.mo.gov/casenet/cases/searchCases.do`;
  for (const { name, code, city } of counties) {
    try {
      const body = new URLSearchParams({
        countyCode: code,
        caseType: "P",
        fromDate,
        toDate,
        submit: "Search",
      }).toString();
      const html = await fetchBlockedPage(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!html) continue;
      const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const rows = html.match(rowRe) || [];
      type CaseRow = { caseNum: string; caseName: string; filedDate: string };
      const cases: CaseRow[] = [];
      for (const row of rows) {
        const cells: string[] = [];
        let m;
        while ((m = cellRe.exec(row)) !== null) {
          cells.push(m[1].replace(/<[^>]+>/g, "").trim());
        }
        cellRe.lastIndex = 0;
        if (cells.length < 2 || !cells[0] || cells[0].toLowerCase().includes("case")) continue;
        cases.push({ caseNum: cells[0], caseName: cells[1], filedDate: cells[2] || fromDate });
      }
      // Batch assessor enrichment — 5 concurrent, only keep leads with a found property
      const CONCURRENCY = 5;
      for (let i = 0; i < cases.length; i += CONCURRENCY) {
        const batch = cases.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((c) => lookupOwnerProperties(c.caseName, name, STATE)),
        );
        for (let j = 0; j < batch.length; j++) {
          const { caseNum, caseName, filedDate } = batch[j];
          const properties = results[j];
          if (properties.length === 0) continue;
          for (const prop of properties) {
            leads.push({
              id: makeId(name, STATE, "Probate", `${caseNum}-${prop.address}`),
              county: name,
              state: STATE,
              lead_type: "Probate/Estate",
              owner_name: prop.ownerName || caseName || null,
              address: prop.address,
              city: prop.city || city,
              zip: prop.zip || null,
              mailing_address: null,
              mailing_city: null,
              mailing_state: null,
              mailing_zip: null,
              case_number: caseNum,
              filing_date: formatDate(filedDate),
              assessed_value: null,
              tax_year: null,
              lender: null,
              loan_amount: null,
              sale_date: null,
              sale_amount: null,
              description: `${name} County MO Probate — ${caseName}`,
              source_url: url,
              raw_data: JSON.stringify({ caseNum, caseName, filedDate, parcelId: prop.parcelId }),
            });
          }
        }
      }
    } catch (e) {
      console.error(`[${name} MO] Probate error:`, e);
    }
  }
  return leads;
}
// ─── DIVORCE — Missouri Case.net (all 4 counties, case type "D") ──────────────
// Enrichment: lookupOwnerProperties by case name → only keep leads with a found property
async function scrapeMODivorce(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const counties = [
    { name: "Jackson", code: "16", city: "Kansas City" },
    { name: "Clay", code: "12", city: "Liberty" },
    { name: "Cass", code: "7", city: "Harrisonville" },
    { name: "Platte", code: "25", city: "Platte City" },
  ];
  const url = `https://www.courts.mo.gov/casenet/cases/searchCases.do`;
  for (const { name, code, city } of counties) {
    try {
      const body = new URLSearchParams({
        countyCode: code,
        caseType: "D",
        fromDate,
        toDate,
        submit: "Search",
      }).toString();
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) continue;
      const html = await res.text();
      const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const rows = html.match(rowRe) || [];
      type DivorceRow = { caseNum: string; caseName: string; filedDate: string };
      const cases: DivorceRow[] = [];
      for (const row of rows) {
        const cells: string[] = [];
        let m;
        while ((m = cellRe.exec(row)) !== null) {
          cells.push(m[1].replace(/<[^>]+>/g, "").trim());
        }
        cellRe.lastIndex = 0;
        if (cells.length < 2 || !cells[0] || cells[0].toLowerCase().includes("case")) continue;
        cases.push({ caseNum: cells[0], caseName: cells[1], filedDate: cells[2] || fromDate });
      }
      // Batch assessor enrichment — 5 concurrent, only keep leads with a found property
      const CONCURRENCY = 5;
      for (let i = 0; i < cases.length; i += CONCURRENCY) {
        const batch = cases.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((c) => lookupOwnerProperties(c.caseName, name, STATE)),
        );
        for (let j = 0; j < batch.length; j++) {
          const { caseNum, caseName, filedDate } = batch[j];
          const properties = results[j];
          if (properties.length === 0) continue;
          for (const prop of properties) {
            leads.push({
              id: makeId(name, STATE, "Divorce", `${caseNum}-${prop.address}`),
              county: name,
              state: STATE,
              lead_type: "Divorce",
              owner_name: prop.ownerName || caseName || null,
              address: prop.address,
              city: prop.city || city,
              zip: prop.zip || null,
              mailing_address: null,
              mailing_city: null,
              mailing_state: null,
              mailing_zip: null,
              case_number: caseNum,
              filing_date: formatDate(filedDate),
              assessed_value: null,
              tax_year: null,
              lender: null,
              loan_amount: null,
              sale_date: null,
              sale_amount: null,
              description: `${name} County MO Divorce — ${caseName}`,
              source_url: url,
              raw_data: JSON.stringify({ caseNum, caseName, filedDate, parcelId: prop.parcelId }),
            });
          }
        }
      }
    } catch (e) {
      console.error(`[${name} MO] Divorce error:`, e);
    }
  }
  return leads;
}
// ─── OBITUARIES — Legacy.com KC metro ────────────────────────────────────────
// Legacy.com RSS feed for Kansas City area obituaries
async function scrapeMOObituaries(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // Legacy.com RSS for Kansas City Star obituaries
    const rssUrls = [
      "https://www.legacy.com/obituaries/kansascity/rss.aspx",
      "https://www.legacy.com/obituaries/kcstar/rss.aspx",
    ];
    for (const rssUrl of rssUrls) {
      try {
        const res = await fetchWithRetry(rssUrl);
        if (!res.ok) continue;
        const xml = await res.text();
        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        for (const item of items) {
          const title =
            (item.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) ||
              item.match(/<title>(.+?)<\/title>/))?.[1]?.trim() || "";
          const link = item.match(/<link>(.+?)<\/link>/)?.[1]?.trim() || "";
          const pubDate = item.match(/<pubDate>(.+?)<\/pubDate>/)?.[1]?.trim() || "";
          const desc =
            (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
              item.match(/<description>([\s\S]*?)<\/description>/))?.[1]?.trim() || "";
          if (!title) continue;
          // Filter to date range
          if (pubDate) {
            const d = new Date(pubDate);
            if (!isNaN(d.getTime())) {
              const ds = d.toISOString().slice(0, 10);
              if (ds < fromDate || ds > toDate) continue;
            }
          }
          leads.push({
            id: makeId("Jackson", STATE, "Obituary", link || title),
            county: "Jackson",
            state: STATE,
            lead_type: "Obituary",
            owner_name: title || null,
            address: null,
            city: "Kansas City",
            zip: null,
            mailing_address: null,
            mailing_city: null,
            mailing_state: null,
            mailing_zip: null,
            case_number: null,
            filing_date: pubDate
              ? formatDate(new Date(pubDate).toISOString().slice(0, 10))
              : formatDate(fromDate),
            assessed_value: null,
            tax_year: null,
            lender: null,
            loan_amount: null,
            sale_date: null,
            sale_amount: null,
            description: desc.replace(/<[^>]+>/g, "").slice(0, 200) || `Obituary — ${title}`,
            source_url: link || rssUrl,
            raw_data: JSON.stringify({ title, pubDate }),
          });
        }
      } catch {
        /* try next URL */
      }
    }

    // Enrich obituaries with property lookup by decedent name — 5 concurrent
    // Only keep obituaries where the decedent owns property in the area
    const enrichedObitLeads: Lead[] = [];
    const CONCURRENCY_O = 5;
    for (let i = 0; i < leads.length; i += CONCURRENCY_O) {
      const batch = leads.slice(i, i + CONCURRENCY_O);
      const results = await Promise.all(
        batch.map((l) => lookupOwnerProperties(l.owner_name || "", "Jackson", STATE)),
      );
      for (let j = 0; j < batch.length; j++) {
        const properties = results[j];
        if (properties.length === 0) continue;
        const lead = batch[j];
        for (const prop of properties) {
          enrichedObitLeads.push({
            ...lead,
            id: makeId("Jackson", STATE, "Obituary", `${lead.owner_name || ""}-${prop.address}`),
            address: prop.address,
            city: prop.city || "Kansas City",
            zip: prop.zip || null,
            owner_name: prop.ownerName || lead.owner_name,
            raw_data: JSON.stringify({
              ...JSON.parse(lead.raw_data || "{}"),
              parcelId: prop.parcelId,
            }),
          });
        }
      }
    }
    return enrichedObitLeads;
  } catch (e) {
    console.error(`[MO] Obituaries error:`, e);
  }
  return [];
}

// ─── WATER SHUTOFFS — KC 311 Open Data (Jackson County only) ─────────────────
// Already covered inside scrapeKCCodeViolations for Jackson.
// This function adds a dedicated Water Shutoff type for Clay/Platte/Cass
// using their county utility / 311 portals where available.
async function scrapeMOWaterShutoffs(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // KC 311 Socrata — CONFIRMED WORKING
    // Dataset: d4px-6rwg (2021-present) | Fields: open_date_time, issue_type, issue_sub_type, incident_address, workorder_
    const where = `open_date_time>='${fromDate}T00:00:00' AND issue_type='Water Service'`;
    const url = `https://data.kcmo.org/resource/d4px-6rwg.json?$where=${encodeURIComponent(where)}&$limit=100&$order=${encodeURIComponent("open_date_time DESC")}`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`[MO] Water Shutoffs fetch failed: HTTP ${res.status}`);
    }
    if (res.ok) {
      const data = (await res.json()) as Record<string, string>[];
      for (const item of data) {
        const address = item.incident_address || "";
        if (!address) continue;
        leads.push({
          id: makeId("Jackson", STATE, "Water Shutoff", item.workorder_ || address),
          county: "Jackson",
          state: STATE,
          lead_type: "Water Shutoff",
          owner_name: null,
          address: address || null,
          city: "Kansas City",
          zip: null,
          mailing_address: null,
          mailing_city: null,
          mailing_state: null,
          mailing_zip: null,
          case_number: item.workorder_ || null,
          filing_date: formatDate(item.open_date_time?.slice(0, 10) || fromDate),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Water Shutoff — No Water — ${address}`,
          source_url: "https://data.kcmo.org/311/311-Call-Center-Reported-Issues/d4px-6rwg",
          raw_data: JSON.stringify(item),
        });
      }
    }

    // Enrich with owner name via assessor address lookup — 10 concurrent
    const CONCURRENCY_ADDR = 10;
    const unenrichedAddr = leads.filter((l) => !l.owner_name && l.address).slice(0, 40);
    for (let i = 0; i < unenrichedAddr.length; i += CONCURRENCY_ADDR) {
      const batch = unenrichedAddr.slice(i, i + CONCURRENCY_ADDR);
      const results = await Promise.all(
        batch.map((l) => lookupByAddress(l.address!, l.county, STATE)),
      );
      for (let j = 0; j < batch.length; j++) {
        const prop = results[j];
        if (prop?.ownerName) batch[j].owner_name = prop.ownerName;
        if (prop?.zip && !batch[j].zip) batch[j].zip = prop.zip;
        if (prop?.parcelId)
          batch[j].raw_data = JSON.stringify({
            ...JSON.parse(batch[j].raw_data || "{}"),
            parcelId: prop.parcelId,
          });
      }
    }
  } catch (e) {
    console.error(`[MO] Water Shutoffs error:`, e);
  }
  return leads;
}

// ─── FIRE DAMAGE — KC 311 + KC Fire Open Data ─────────────────────────────────
// Jackson County: KC Open Data fire incidents
// Clay/Platte/Cass: No open data portal available — use KC 311 fire/structure requests
async function scrapeMOFireDamage(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // KC 311 Socrata — CONFIRMED WORKING
    // Dataset: d4px-6rwg (2021-present) | issue_type: 'Dangerous Buildings', 'Open Burning/Fire'
    const where = `open_date_time>='${fromDate}T00:00:00' AND (issue_type='Dangerous Buildings' OR issue_type='Open Burning/Fire')`;
    const url = `https://data.kcmo.org/resource/d4px-6rwg.json?$where=${encodeURIComponent(where)}&$limit=100&$order=${encodeURIComponent("open_date_time DESC")}`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`[MO] Fire Damage fetch failed: HTTP ${res.status}`);
    }
    if (res.ok) {
      const data = (await res.json()) as Record<string, string>[];
      for (const item of data) {
        const address = item.incident_address || "";
        if (!address) continue;
        leads.push({
          id: makeId("Jackson", STATE, "Fire Damage", item.workorder_ || address),
          county: "Jackson",
          state: STATE,
          lead_type: "Fire Damage",
          owner_name: null,
          address: address || null,
          city: "Kansas City",
          zip: null,
          mailing_address: null,
          mailing_city: null,
          mailing_state: null,
          mailing_zip: null,
          case_number: item.workorder_ || null,
          filing_date: formatDate(item.open_date_time?.slice(0, 10) || fromDate),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Fire Damage — ${item.issue_type || "Dangerous Building"} — ${address}`,
          source_url: "https://data.kcmo.org/311/311-Call-Center-Reported-Issues/d4px-6rwg",
          raw_data: JSON.stringify(item),
        });
      }
    }

    // Enrich with owner name via assessor address lookup — 10 concurrent
    const CONCURRENCY_ADDR = 10;
    const unenrichedAddr = leads.filter((l) => !l.owner_name && l.address).slice(0, 40);
    for (let i = 0; i < unenrichedAddr.length; i += CONCURRENCY_ADDR) {
      const batch = unenrichedAddr.slice(i, i + CONCURRENCY_ADDR);
      const results = await Promise.all(
        batch.map((l) => lookupByAddress(l.address!, l.county, STATE)),
      );
      for (let j = 0; j < batch.length; j++) {
        const prop = results[j];
        if (prop?.ownerName) batch[j].owner_name = prop.ownerName;
        if (prop?.zip && !batch[j].zip) batch[j].zip = prop.zip;
        if (prop?.parcelId)
          batch[j].raw_data = JSON.stringify({
            ...JSON.parse(batch[j].raw_data || "{}"),
            parcelId: prop.parcelId,
          });
      }
    }
  } catch (e) {
    console.error(`[MO] Fire Damage error:`, e);
  }
  return leads;
}

// ─── VACANT/ABANDONED — KC 311 Open Data ─────────────────────────────────────
async function scrapeMOVacantAbandoned(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // KC 311 Socrata — CONFIRMED WORKING
    // Dataset: d4px-6rwg (2021-present) | issue_type: 'Property Violations', issue_sub_type contains 'Vacant'
    const url = `https://data.kcmo.org/resource/d4px-6rwg.json?$where=open_date_time>='${fromDate}T00:00:00' AND issue_type='Property Violations' AND issue_sub_type like '%Vacant%'&$limit=500&$order=open_date_time DESC`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return leads;
    const data = (await res.json()) as Record<string, string>[];
    for (const item of data) {
      const address = item.incident_address || "";
      if (!address) continue;
      leads.push({
        id: makeId("Jackson", STATE, "Vacant Abandoned", item.workorder_ || address),
        county: "Jackson",
        state: STATE,
        lead_type: "Vacant/Abandoned",
        owner_name: null,
        address: address || null,
        city: "Kansas City",
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: item.workorder_ || null,
        filing_date: formatDate(item.open_date_time?.slice(0, 10) || fromDate),
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: `Vacant/Abandoned — ${item.issue_sub_type || "Vacant Property"} — ${address}`,
        source_url: "https://data.kcmo.org/311/311-Call-Center-Reported-Issues/d4px-6rwg",
        raw_data: JSON.stringify(item),
      });
    }

    // Enrich with owner name via assessor address lookup — 10 concurrent
    const CONCURRENCY_ADDR = 10;
    const unenrichedAddr = leads.filter((l) => !l.owner_name && l.address);
    for (let i = 0; i < unenrichedAddr.length; i += CONCURRENCY_ADDR) {
      const batch = unenrichedAddr.slice(i, i + CONCURRENCY_ADDR);
      const results = await Promise.all(
        batch.map((l) => lookupByAddress(l.address!, l.county, STATE)),
      );
      for (let j = 0; j < batch.length; j++) {
        const prop = results[j];
        if (prop?.ownerName) batch[j].owner_name = prop.ownerName;
        if (prop?.zip && !batch[j].zip) batch[j].zip = prop.zip;
        if (prop?.parcelId)
          batch[j].raw_data = JSON.stringify({
            ...JSON.parse(batch[j].raw_data || "{}"),
            parcelId: prop.parcelId,
          });
      }
    }
  } catch (e) {
    console.error(`[MO] Vacant/Abandoned error:`, e);
  }
  return leads;
}

// ─── BANKRUPTCY — Western District of MO (PACER RSS) ─────────────────────────
export async function scrapeBankruptcy(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    const rss = await fetchWithRetry("https://ecf.mowb.uscourts.gov/cgi-bin/rss_outside.pl");
    if (!rss.ok) return leads;
    const xml = await rss.text();
    const COUNTY = "Jackson"; // Western MO district covers KC/Jackson area
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    // Parse all items first
    type BkItem = {
      title: string;
      link: string;
      pubDate: string;
      caseNum: string;
      caseName: string;
    };
    const bkItems: BkItem[] = [];
    for (const item of items) {
      const title =
        (item.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) ||
          item.match(/<title>(.+?)<\/title>/))?.[1]?.trim() || "";
      const link = item.match(/<link>(.+?)<\/link>/)?.[1]?.trim() || "";
      const desc =
        (item.match(/<description><!\[CDATA\[(.+?)\]\]><\/description>/) ||
          item.match(/<description>(.+?)<\/description>/))?.[1]?.trim() || "";
      const pubDate = item.match(/<pubDate>(.+?)<\/pubDate>/)?.[1]?.trim() || "";
      const caseNum = title.match(/([0-9]{2}-[0-9]{5})/)?.[1] || title;
      if (pubDate) {
        const d = new Date(pubDate);
        if (!isNaN(d.getTime())) {
          const from = new Date(fromDate);
          const to = new Date(toDate);
          to.setHours(23, 59, 59, 999);
          if (d < from || d > to) continue;
        }
      }
      // Strip full case prefix including chapter suffix: e.g. "26-40368-btf13 " or "26-30205-7 "
      const ownerFromTitle = title.replace(/^[0-9]{2}-[0-9]{5}(-[a-zA-Z0-9]+)?\s*/, "").trim();
      const caseName =
        ownerFromTitle ||
        desc
          .replace(/<[^>]+>/g, "")
          .replace(/&[a-z0-9#]+;/g, "")
          .trim();
      bkItems.push({ title, link, pubDate, caseNum, caseName });
    }
    const MAX_BK_ITEMS = 10;
    const itemsToProcess = bkItems.slice(0, MAX_BK_ITEMS);
    // Parallel assessor lookups — 5 concurrent
    const CONCURRENCY = 5;
    for (let i = 0; i < itemsToProcess.length; i += CONCURRENCY) {
      const batch = itemsToProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((b) => lookupOwnerProperties(b.caseName, COUNTY, STATE)),
      );
      for (let j = 0; j < batch.length; j++) {
        const { title, link, pubDate, caseNum, caseName } = batch[j];
        const properties = results[j];
        if (properties.length === 0) continue;
        for (const prop of properties) {
          leads.push({
            id: makeId("MO", STATE, "Bankruptcy", `${caseNum}-${prop.address}`),
            county: COUNTY,
            state: STATE,
            lead_type: "Bankruptcy",
            owner_name: caseName || caseNum,
            address: prop.address,
            city: prop.city || "",
            zip: prop.zip || null,
            mailing_address: null,
            mailing_city: null,
            mailing_state: null,
            mailing_zip: null,
            case_number: caseNum,
            filing_date: pubDate
              ? formatDate(new Date(pubDate).toISOString().slice(0, 10))
              : formatDate(fromDate),
            assessed_value: null,
            tax_year: null,
            lender: null,
            loan_amount: null,
            sale_date: null,
            sale_amount: null,
            source_url: link || "https://ecf.mowb.uscourts.gov/cgi-bin/rss_outside.pl",
            description: `MO Bankruptcy — ${caseName || caseNum}`,
            raw_data: JSON.stringify({
              title,
              caseNum,
              caseName,
              pubDate,
              parcelId: prop.parcelId,
            }),
          });
        }
      }
    }
  } catch (e) {
    console.error("[MO] Bankruptcy RSS error:", e);
  }
  return leads;
}

// ─── PROBATE — Missouri Case.net statewide (exported for scraper index) ───────
export async function scrapeProbate(fromDate: string, toDate: string): Promise<Lead[]> {
  // Delegated to per-county function above
  return scrapeJacksonProbate(fromDate, toDate);
}

// ─── TARGETED COUNTY SCRAPE (validate / single lead-type QA) ─────────────────
export async function scrapeCounty(
  county: string,
  fromDate: string,
  toDate: string,
  leadTypes?: string[],
): Promise<Lead[]> {
  const norm = county.toLowerCase();

  const countyBulk: Record<string, () => Promise<Lead[]>> = {
    clay: () => scrapeClayCounty(fromDate, toDate),
    platte: () => scrapePlatteCounty(fromDate, toDate),
    cass: () => scrapeCassCounty(fromDate, toDate),
  };

  const jacksonRunners: Record<string, () => Promise<Lead[]>> = {
    "Lis Pendens": () => scrapeLisPendens(fromDate, toDate),
    "Water Shutoff": () => scrapeMOWaterShutoffs(fromDate, toDate),
    "Fire Damage": () => scrapeMOFireDamage(fromDate, toDate),
    "Code Violation": () => scrapeKCCodeViolations(fromDate, toDate),
    "Tax Delinquent": () => scrapeJacksonTaxDelinquent(fromDate, toDate),
    "Sheriff Sale": () => scrapeJacksonSheriffSales(fromDate, toDate),
    "Pre-Foreclosure": () => scrapeJacksonPreForeclosure(fromDate, toDate),
    Probate: () => scrapeJacksonProbate(fromDate, toDate),
    Bankruptcy: () => scrapeBankruptcy(fromDate, toDate),
    "Vacant/Abandoned": () => scrapeMOVacantAbandoned(fromDate, toDate),
    FSBO: () => scrapeKCCraigslistFSBO(fromDate, toDate),
    Divorce: () => scrapeMODivorce(fromDate, toDate),
    Obituary: () => scrapeMOObituaries(fromDate, toDate),
  };

  const outerRunners: Record<string, () => Promise<Lead[]>> = {
    "Lis Pendens": () => scrapeLisPendens(fromDate, toDate),
    "Pre-Foreclosure": () => scrapeLisPendens(fromDate, toDate),
    Probate: () => scrapeMOProbate(fromDate, toDate),
    Bankruptcy: () => scrapeBankruptcy(fromDate, toDate),
    FSBO: () => scrapeKCCraigslistFSBO(fromDate, toDate),
  };

  const types = leadTypes?.length
    ? normalizeLeadTypes(leadTypes)
    : norm === "jackson"
      ? Object.keys(jacksonRunners)
      : [...Object.keys(outerRunners), "Sheriff Sale", "Tax Delinquent"];
  const wants = (type: string) => types.includes(type);
  const fns: Array<() => Promise<Lead[]>> = [];

  if (
    countyBulk[norm] &&
    (!leadTypes?.length || wants("Sheriff Sale") || wants("Tax Delinquent"))
  ) {
    fns.push(countyBulk[norm]);
  }

  const runners =
    norm === "jackson" ? jacksonRunners : OUTER_MO_COUNTIES.has(norm) ? outerRunners : {};
  for (const [type, fn] of Object.entries(runners)) {
    if (wants(type)) fns.push(fn);
  }

  const results = await Promise.allSettled(fns.map((fn) => fn()));
  let leads = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!county) return leads;

  leads = leads.filter((l) => l.county.toLowerCase() === norm);
  if (leadTypes?.length) leads = filterLeadsByTypes(leads, leadTypes);

  return leads;
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
export async function scrapeAll(fromDate: string, toDate: string): Promise<Lead[]> {
  const results = await Promise.allSettled([
    // Pre-Foreclosure / Lis Pendens
    scrapeJacksonPreForeclosure(fromDate, toDate), // Jackson Recorder of Deeds
    scrapeLisPendens(fromDate, toDate), // Case.net Lis Pendens (all 4 counties)
    // Tax Delinquent
    scrapeJacksonTaxDelinquent(fromDate, toDate),
    // Sheriff Sales
    scrapeJacksonSheriffSales(fromDate, toDate),
    scrapeClayCounty(fromDate, toDate),
    scrapePlatteCounty(fromDate, toDate),
    scrapeCassCounty(fromDate, toDate),
    // Probate
    scrapeJacksonProbate(fromDate, toDate),
    scrapeMOProbate(fromDate, toDate), // Clay, Cass, Platte via Case.net
    // Bankruptcy
    scrapeBankruptcy(fromDate, toDate),
    // Code Violations / Fire / Water / Vacant
    scrapeKCCodeViolations(fromDate, toDate),
    scrapeMOFireDamage(fromDate, toDate),
    scrapeMOWaterShutoffs(fromDate, toDate),
    scrapeMOVacantAbandoned(fromDate, toDate),
    // FSBO
    scrapeKCCraigslistFSBO(fromDate, toDate),
    // Divorce
    scrapeMODivorce(fromDate, toDate),
    // Obituaries
    scrapeMOObituaries(fromDate, toDate),
  ]);
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
