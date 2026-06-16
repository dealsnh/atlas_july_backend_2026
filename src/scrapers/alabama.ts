// @ts-nocheck
/**
 * Alabama County Scrapers
 * Counties: Madison, Limestone, Morgan, Montgomery, Autauga, Elmore, Jefferson, Shelby
 */

import * as cheerio from "cheerio";
import {
  Lead,
  CountyConfig,
  makeId,
  formatDate,
  fetchWithRetry,
  fetchRendered,
  fetchBlockedPage,
  settleScraperResults,
  courtCaseToLead,
  validateHtmlResponse,
  toUsDate,
} from "./base.js";
import { lookupOwnerProperties, lookupByAddress } from "./assessor.js";
import {
  collectCraigslistSearchItems,
  fetchCraigslistListingDetails,
} from "./craigslist.js";
import * as XLSX from "xlsx";
import { extractAddressFromListing } from "../services/owner-placeholders.js";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const AL_CRAIGSLIST: Record<string, string> = {
  Madison: "huntsville",
  Limestone: "huntsville",
  Morgan: "huntsville",
  Montgomery: "montgomery",
  Autauga: "montgomery",
  Elmore: "montgomery",
  Jefferson: "bham",
  Shelby: "bham",
};

const AL_COUNTY_CITIES: Record<string, string> = {
  Jefferson: "Birmingham",
  Madison: "Huntsville",
  Shelby: "Birmingham",
  Morgan: "Decatur",
  Limestone: "Athens",
  Montgomery: "Montgomery",
  Autauga: "Prattville",
  Elmore: "Wetumpka",
};

function inferCityFromAddress(address: string | null, county: string): string | null {
  if (!address) return AL_COUNTY_CITIES[county] || null;
  const known = [
    "Birmingham",
    "Hoover",
    "Vestavia",
    "Homewood",
    "Bessemer",
    "Huntsville",
    "Madison",
    "Decatur",
    "Athens",
    "Montgomery",
    "Prattville",
    "Millbrook",
    "Wetumpka",
    "Pinson",
    "Trussville",
    "Pelham",
    "Alabaster",
  ];
  for (const c of known) {
    if (new RegExp(`\\b${c}\\b`, "i").test(address)) return c;
  }
  const comma = address.split(",").map((s) => s.trim());
  if (comma.length >= 2) {
    const candidate = comma[comma.length - 1].replace(/\s*AL\s*\d{5}.*$/i, "").trim();
    if (candidate.length >= 3 && /[A-Za-z]/.test(candidate)) return candidate;
  }
  return AL_COUNTY_CITIES[county] || null;
}

async function fetchAlTaxHtml(url: string): Promise<string> {
  let res = await fetchWithRetry(url, { headers: HEADERS });
  let html = res.ok ? await res.text() : "";
  if (!html || html.length < 500 || res.status === 403) {
    html = await fetchBlockedPage(url);
  }
  if (!html || html.length < 500) {
    const rendered = await fetchRendered(url);
    if (rendered.ok) html = await rendered.text();
  }
  return html;
}

async function fetchAlaCourtHtml(url: string): Promise<string> {
  const html = await fetchBlockedPage(url);
  const check = validateHtmlResponse(html, "AlaCourt", 800);
  if (!check.ok) return "";
  if (/frmlogin\.aspx/i.test(html)) {
    console.warn("[AlaCourt] redirected to login");
    return "";
  }
  if (!/<td/i.test(html)) {
    console.warn("[AlaCourt] response has no table cells");
    return "";
  }
  return html;
}

function alaCourtSearchUrl(
  county: string,
  caseType: string,
  fromDate: string,
  toDate: string,
): string {
  return `https://v2.alacourt.com/frmPublicCaseSearch.aspx?county=${encodeURIComponent(county)}&caseType=${caseType}&fromDate=${encodeURIComponent(toUsDate(fromDate))}&toDate=${encodeURIComponent(toUsDate(toDate))}`;
}

const CAPTURECAMA_TENANTS: Record<string, string> = {
  Autauga: "https://autauga.capturecama.com",
};
const CAPTURECAMA_EXPRESS = "https://prodexpress.capturecama.com";

async function scrapeCaptureCamaDelinquent(county: string, fromDate: string): Promise<Lead[]> {
  const tenantUrl = CAPTURECAMA_TENANTS[county];
  if (!tenantUrl) return [];
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Referring-Page": `${tenantUrl}/DelqSearch`,
  };
  const baseBody = { tenantUrl, expressUrl: CAPTURECAMA_EXPRESS, reserved: 0 };
  try {
    const yearsRes = await fetchWithRetry(`${CAPTURECAMA_EXPRESS}/GetDelqSearchYears`, {
      method: "POST",
      headers,
      body: JSON.stringify(baseBody),
    });
    if (!yearsRes.ok) return [];
    const years: Array<{ RecordYear: string | number }> = await yearsRes.json();
    const recordYears = [
      ...new Set([
        ...years.map((y) => String(y.RecordYear)),
        String(new Date().getFullYear()),
        String(new Date().getFullYear() - 1),
        String(new Date().getFullYear() - 2),
      ]),
    ];
    let rows: Array<Record<string, unknown>> = [];
    let usedYear = "";
    for (const recordYear of recordYears) {
      const searchRes = await fetchWithRetry(`${CAPTURECAMA_EXPRESS}/SearchDelq`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...baseBody,
          searchstring: "",
          searchtype: "4",
          recordyear: recordYear,
        }),
      });
      if (!searchRes.ok) continue;
      const data = (await searchRes.json()) as Array<Record<string, unknown>>;
      if (data.length) {
        rows = data;
        usedYear = recordYear;
        break;
      }
    }
    if (!rows.length) return [];

    return rows.map((row) => {
      const owner = String(row.Name1 || "").trim();
      const address = String(row.PropAddr1 || row.Address1 || "").trim() || null;
      const city =
        String(row.PropCity || row.City || AL_COUNTY_CITIES[county] || "").trim() || null;
      const zipRaw = String(row.PropZip || row.Zip || "").trim();
      const zip = zipRaw.slice(0, 5) || null;
      const parcel = String(row.ParcelNo || "").trim();
      return {
        id: makeId(parcel || owner, county, "AL", "tax"),
        county,
        state: "AL",
        lead_type: "Tax Delinquent",
        owner_name: owner || null,
        address,
        city,
        zip,
        mailing_address: String(row.Address1 || "").trim() || null,
        mailing_city: String(row.City || "").trim() || null,
        mailing_state: "AL",
        mailing_zip: String(row.Zip || "").trim().slice(0, 5) || null,
        case_number: parcel || null,
        filing_date: formatDate(fromDate),
        assessed_value: row.TotalValue != null ? String(row.TotalValue) : null,
        tax_year: usedYear || new Date().getFullYear().toString(),
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: row.CurrAmtDue != null ? String(row.CurrAmtDue) : null,
        description: `Tax delinquent — ${county} County AL — ${owner || parcel}`,
        source_url: `${tenantUrl}/DelqSearch`,
        raw_data: JSON.stringify(row),
      };
    });
  } catch (e) {
    console.error(`[${county} AL] CaptureCAMA delinquent error:`, e);
    return [];
  }
}

// ─── Pre-Foreclosure via AlaCourt public search ───────────────────────────────
async function scrapePreForeclosure(
  county: string,
  fromDate: string,
  toDate: string,
): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    const url = alaCourtSearchUrl(county, "CV", fromDate, toDate);
    const html = await fetchAlaCourtHtml(url);

    // Simple regex parse for case rows (AlaCourt uses tables)
    const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const rows = html.match(rowRe) || [];

    for (const row of rows) {
      const cells: string[] = [];
      let m;
      while ((m = cellRe.exec(row)) !== null) {
        cells.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      cellRe.lastIndex = 0;
      if (cells.length < 3) continue;

      const caseNumber = cells[0];
      const caseStyle = cells[1];
      const filedDate = cells[2];

      if (!caseNumber || !/foreclos|lis pendens|mortgage/i.test(caseStyle)) continue;

      const parts = caseStyle.split(/\s+v\.?\s+/i);
      const ownerName = parts.length > 1 ? parts[1].trim() : caseStyle;

      leads.push({
        id: makeId(caseNumber, county, "AL"),
        county,
        state: "AL",
        lead_type: "Pre-Foreclosure",
        owner_name: ownerName,
        address: null,
        city: null,
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: caseNumber,
        filing_date: formatDate(filedDate),
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: `${county} County AL Pre-Foreclosure — ${caseStyle}`,
        source_url: `https://v2.alacourt.com/frmPublicCaseSearch.aspx`,
        raw_data: JSON.stringify({ caseStyle }),
      });
    }
  } catch (_) {
    /* silent */
  }
  return leads;
}

// ─── Madison AL tax certificates (county XLSX — direct download) ─────────────
const MADISON_CERT_XLSX = "https://madisontc.com/s/MadisonCountyCertificates-tshc.xlsx";

function trimCell(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function madisonRowAddress(row: Record<string, unknown>): string | null {
  const house = trimCell(row["Location House #"]);
  const street = trimCell(row["Location Address"]);
  const city = trimCell(row["Location City"]);
  const core =
    [house, street]
      .filter((p) => p && /\S/.test(p))
      .join(" ")
      .trim() || street;
  if (!core) return null;
  return city ? `${core}, ${city}` : core;
}

function excelDateToIso(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString().split("T")[0];
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    }
  }
  return formatDate(String(value ?? ""));
}

async function fetchMadisonCertificateRows(): Promise<Record<string, unknown>[]> {
  try {
    const res = await fetchWithRetry(MADISON_CERT_XLSX, {
      headers: {
        ...HEADERS,
        Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
      },
    });
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

async function scrapeMadisonTaxDelinquent(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const rows = await fetchMadisonCertificateRows();
  for (const row of rows) {
    if (trimCell(row["Paid Status"]) !== "U") continue;
    const owner = trimCell(row["Name"]);
    const parcel = trimCell(row["Parcel"]);
    if (!owner || !parcel) continue;
    const address = madisonRowAddress(row);
    const city = trimCell(row["Location City"]) || "Huntsville";
    const amount = row["Unpaid Bal"] != null ? String(row["Unpaid Bal"]) : null;
    const taxYear =
      row["Tax Year"] != null ? String(row["Tax Year"]) : new Date().getFullYear().toString();
    leads.push({
      id: makeId(parcel, "Madison", "AL", "tax"),
      county: "Madison",
      state: "AL",
      lead_type: "Tax Delinquent",
      owner_name: owner,
      address,
      city,
      zip: null,
      mailing_address: trimCell(row["Address"]) || null,
      mailing_city: trimCell(row["City"]) || null,
      mailing_state: trimCell(row["St"]) || "AL",
      mailing_zip: row["Zip"] != null ? String(row["Zip"]).slice(0, 5) : null,
      case_number: trimCell(row["Cert #"]) || parcel,
      filing_date: formatDate(fromDate),
      assessed_value: row["Assessed Value"] != null ? String(row["Assessed Value"]) : null,
      tax_year: taxYear,
      lender: null,
      loan_amount: null,
      sale_date: excelDateToIso(row["Sale Date"]),
      sale_amount: amount,
      description: `Tax Delinquent — Madison County AL${amount ? ` — $${amount}` : ""}`,
      source_url: MADISON_CERT_XLSX,
      raw_data: JSON.stringify({ parcel, owner, amount, taxYear }),
    });
  }
  return leads;
}

async function scrapeMadisonSheriffSales(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const rows = await fetchMadisonCertificateRows();
  for (const row of rows) {
    if (trimCell(row["Paid Status"]) !== "U") continue;
    const owner = trimCell(row["Name"]);
    const parcel = trimCell(row["Parcel"]);
    const saleDate = excelDateToIso(row["Sale Date"]);
    if (!owner || !parcel || !saleDate) continue;
    const address = madisonRowAddress(row);
    const amount = row["Cert. Face Amt"] != null ? String(row["Cert. Face Amt"]) : null;
    leads.push({
      id: makeId(parcel, "Madison", "AL", "sheriff"),
      county: "Madison",
      state: "AL",
      lead_type: "Sheriff Sale",
      owner_name: owner,
      address,
      city: trimCell(row["Location City"]) || "Huntsville",
      zip: null,
      mailing_address: trimCell(row["Address"]) || null,
      mailing_city: trimCell(row["City"]) || null,
      mailing_state: trimCell(row["St"]) || "AL",
      mailing_zip: row["Zip"] != null ? String(row["Zip"]).slice(0, 5) : null,
      case_number: trimCell(row["Cert #"]) || parcel,
      filing_date: saleDate,
      assessed_value: null,
      tax_year: row["Tax Year"] != null ? String(row["Tax Year"]) : null,
      lender: trimCell(row["Cert Holder"]) || null,
      loan_amount: null,
      sale_date: saleDate,
      sale_amount: amount,
      description: `Tax certificate sale — Madison County AL — ${address || parcel}`,
      source_url: MADISON_CERT_XLSX,
      raw_data: JSON.stringify({ parcel, owner, saleDate, amount }),
    });
  }
  return leads;
}

// ─── Tax Delinquent via Alabama Revenue Commissioner sites ────────────────────
async function scrapeTaxDelinquent(
  county: string,
  fromDate: string,
  toDate: string,
): Promise<Lead[]> {
  if (county === "Madison") {
    const madison = await scrapeMadisonTaxDelinquent(fromDate, toDate);
    if (madison.length) return madison;
  }
  if (CAPTURECAMA_TENANTS[county]) {
    const capture = await scrapeCaptureCamaDelinquent(county, fromDate);
    if (capture.length) return capture;
  }
  const leads: Lead[] = [];
  const urls: Record<string, string> = {
    Jefferson: "https://www.jeffcointouch.com/revenue/delinquent-tax-list",
    Madison: "https://www.madisoncountyal.gov/departments/revenue/delinquent-taxes",
    Montgomery: "https://www.montgomerycountyal.gov/departments/revenue/delinquent-tax",
    Shelby: "https://www.shelbyal.com/departments/revenue/delinquent-tax-list",
    Morgan: "https://www.morgancountyal.gov/departments/revenue",
    Limestone: "https://www.co.limestone.al.us/departments/revenue",
    Autauga: "https://www.revenue.alabama.gov/property-tax/delinquent-property-tax-list/?county=Autauga",
    Elmore: "https://www.elmoreco.org/departments/revenue",
  };
  const url =
    urls[county] ||
    `https://www.revenue.alabama.gov/property-tax/delinquent-property-tax-list/?county=${county}`;

  try {
    const html = await fetchAlTaxHtml(url);
    if (!html) return leads;
    const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const rows = html.match(rowRe) || [];

    for (const row of rows) {
      const cells: string[] = [];
      let m;
      while ((m = cellRe.exec(row)) !== null) {
        // Strip HTML tags, decode &nbsp; and other common HTML entities
        const text = m[1]
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/&quot;/gi, '"')
          .replace(/&#?\w+;/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        cells.push(text);
      }
      cellRe.lastIndex = 0;
      if (cells.length < 2 || !cells[0]) continue;
      // Skip rows that look like navigation/header/contact content (not real property records)
      // Real delinquent tax rows have: owner name (all caps or mixed), parcel/amount, address
      const firstCell = cells[0];
      if (
        /courthouse|hours of operation|monday|friday|phone|fax|\d{3}\s*[-.]\s*\d{3}|north side square|access denied|permission/i.test(
          firstCell,
        )
      )
        continue;
      if (firstCell.length < 3 || firstCell.length > 120) continue;
      // Must look like a real owner name: letters, not just whitespace/symbols
      if (!/[A-Za-z]{2,}/.test(firstCell)) continue;

      const addr = cells[1] || null;
      const city = inferCityFromAddress(addr, county);

      leads.push({
        id: makeId(cells[0], county, "AL", "tax"),
        county,
        state: "AL",
        lead_type: "Tax Delinquent",
        owner_name: cells[0],
        address: addr,
        city,
        zip: addr?.match(/\b(\d{5})\b/)?.[1] || null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: cells[3] || null,
        filing_date: formatDate(cells[4]) || new Date().toISOString().split("T")[0],
        assessed_value: cells[2] || null,
        tax_year: new Date().getFullYear().toString(),
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: `Tax delinquent — amount: ${cells[2] || "unknown"}`,
        source_url: url,
        raw_data: JSON.stringify(cells),
      });
    }

    const CONCURRENCY = 10;
    const needsOwner = leads.filter((l) => !l.owner_name?.trim() && l.address);
    for (let i = 0; i < needsOwner.length; i += CONCURRENCY) {
      const batch = needsOwner.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((l) => lookupByAddress(l.address!, l.county, "AL")),
      );
      for (let j = 0; j < batch.length; j++) {
        const prop = results[j];
        if (prop?.ownerName) batch[j].owner_name = prop.ownerName;
        if (prop?.address) batch[j].address = prop.address;
        if (prop?.city) batch[j].city = prop.city;
        if (prop?.zip) batch[j].zip = prop.zip;
      }
    }

    for (const lead of leads) {
      if (!lead.city) lead.city = inferCityFromAddress(lead.address, county);
    }

    if (!leads.length && urls[county]) {
      const fallbackUrl = `https://www.revenue.alabama.gov/property-tax/delinquent-property-tax-list/?county=${encodeURIComponent(county)}`;
      if (fallbackUrl !== url) {
        const fallbackHtml = await fetchAlTaxHtml(fallbackUrl);
        if (fallbackHtml) {
          const fbRows = fallbackHtml.match(rowRe) || [];
          for (const row of fbRows) {
            const cells: string[] = [];
            let m;
            while ((m = cellRe.exec(row)) !== null) {
              const text = m[1]
                .replace(/<[^>]+>/g, " ")
                .replace(/&nbsp;/gi, " ")
                .replace(/\s+/g, " ")
                .trim();
              cells.push(text);
            }
            cellRe.lastIndex = 0;
            if (cells.length < 2 || !cells[0]) continue;
            const firstCell = cells[0];
            if (
              /courthouse|hours of operation|monday|friday|phone|fax|\d{3}\s*[-.]\s*\d{3}|access denied|permission/i.test(
                firstCell,
              )
            )
              continue;
            if (firstCell.length < 3 || firstCell.length > 120) continue;
            if (!/[A-Za-z]{2,}/.test(firstCell)) continue;
            const addr = cells[1] || null;
            leads.push({
              id: makeId(cells[0], county, "AL", "tax"),
              county,
              state: "AL",
              lead_type: "Tax Delinquent",
              owner_name: cells[0],
              address: addr,
              city: inferCityFromAddress(addr, county),
              zip: addr?.match(/\b(\d{5})\b/)?.[1] || null,
              mailing_address: null,
              mailing_city: null,
              mailing_state: null,
              mailing_zip: null,
              case_number: cells[3] || null,
              filing_date: formatDate(cells[4]) || new Date().toISOString().split("T")[0],
              assessed_value: cells[2] || null,
              tax_year: new Date().getFullYear().toString(),
              lender: null,
              loan_amount: null,
              sale_date: null,
              sale_amount: null,
              description: `Tax delinquent — amount: ${cells[2] || "unknown"}`,
              source_url: fallbackUrl,
              raw_data: JSON.stringify(cells),
            });
          }
        }
      }
    }
  } catch (e) {
    console.error(`[AL ${county}] Tax Delinquent error:`, e);
  }
  return leads;
}

// ─── Sheriff Sales via Rubin Lublin / RLS Law (statewide AL foreclosure listings) ──
// CONFIRMED WORKING: rlselaw.com/property-listing/alabama-property-listings/
async function scrapeSheriffSales(
  county: string,
  fromDate: string,
  toDate: string,
): Promise<Lead[]> {
  const leads: Lead[] = [];
  if (county === "Madison") {
    const madison = await scrapeMadisonSheriffSales(fromDate, toDate);
    if (madison.length) return madison;
  }
  try {
    const url = "https://rlselaw.com/property-listing/alabama-property-listings/";
    let res = await fetchWithRetry(url, { headers: HEADERS });
    let html = res.ok ? await res.text() : "";
    if (!html.includes("td.county") || !html.toLowerCase().includes(county.toLowerCase())) {
      const rendered = await fetchRendered(url);
      if (rendered.ok) html = await rendered.text();
    }
    if (!html) return leads;

    const $ = cheerio.load(html);
    const countyLower = county.toLowerCase();
    $("tr").each((_, row) => {
      const countyCell = $(row).find("td.county").text().trim().toLowerCase();
      if (!countyCell.includes(countyLower)) return;

      const caseNum = $(row).find("td.case").text().trim();
      const address = $(row).find("td.property").text().trim();
      const city = $(row).find("td.city").text().trim();
      const zip = $(row).find("td.zip").text().trim();
      const saleDate = $(row).find("td.date").text().trim();
      if (!caseNum || !address) return;

      leads.push({
        id: makeId(caseNum, county, "AL", "sheriff"),
        county,
        state: "AL",
        lead_type: "Sheriff Sale",
        owner_name: null,
        address,
        city: city || null,
        zip: zip || null,
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
        sale_date: formatDate(saleDate.split("(")[0].trim()),
        sale_amount: null,
        description: `Foreclosure Sale — ${county} County AL — ${address}`,
        source_url: url,
        raw_data: JSON.stringify({ caseNum, address, city, zip, saleDate }),
      });
    });
  } catch (e) {
    console.error(`[AL ${county}] Sheriff Sales error:`, e);
  }

  const CONCURRENCY = 10;
  const needsOwner = leads.filter((l) => !l.owner_name?.trim() && l.address);
  for (let i = 0; i < needsOwner.length; i += CONCURRENCY) {
    const batch = needsOwner.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((l) => lookupByAddress(l.address!, l.county, "AL")),
    );
    for (let j = 0; j < batch.length; j++) {
      const prop = results[j];
      if (prop?.ownerName) batch[j].owner_name = prop.ownerName;
      if (prop?.address) batch[j].address = prop.address;
      if (prop?.city) batch[j].city = prop.city || batch[j].city;
      if (prop?.zip) batch[j].zip = prop.zip;
    }
  }

  for (const lead of leads) {
    if (!lead.city) lead.city = inferCityFromAddress(lead.address, county);
  }
  return leads;
}
// ─── Craigslist FSBO — search + full listing page for street address ──────────
async function scrapeFSBO(county: string, fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const clCity = AL_CRAIGSLIST[county];
  if (!clCity) return leads;

  const baseHost = `https://${clCity}.craigslist.org`;
  const defaultCity = AL_COUNTY_CITIES[county] || null;

  try {
    const searchUrl = `${baseHost}/search/rea?purveyor=owner`;
    const html = await fetchBlockedPage(searchUrl);
    if (!html) return leads;

    const items = collectCraigslistSearchItems(html, baseHost);
    const detailed = await fetchCraigslistListingDetails(items, 25);

    const CONCURRENCY = 8;
    const needsOwner: Lead[] = [];

    for (const item of detailed) {
      const title = item.title || "";
      const address =
        item.address ||
        extractAddressFromListing(title) ||
        extractAddressFromListing(item.location);
      if (!address || address.length < 5) continue;

      const leadCity =
        item.city ||
        (item.location?.replace(/[()]/g, "").trim() || null) ||
        inferCityFromAddress(address, county) ||
        defaultCity;

      const lead: Lead = {
        id: makeId(item.url, county, "AL", "fsbo"),
        county,
        state: "AL",
        lead_type: "FSBO",
        owner_name: null,
        address,
        city: leadCity,
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
        description: title,
        source_url: item.url,
        raw_data: JSON.stringify({
          title,
          price: item.price,
          location: item.location,
          detailAddress: item.address,
        }),
      };
      needsOwner.push(lead);
    }

    for (let i = 0; i < needsOwner.length; i += CONCURRENCY) {
      const batch = needsOwner.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((l) => lookupByAddress(l.address!, county, "AL")),
      );
      for (let j = 0; j < batch.length; j++) {
        const prop = results[j];
        if (prop?.ownerName) batch[j].owner_name = prop.ownerName;
        if (prop?.address) batch[j].address = prop.address;
        if (prop?.city) batch[j].city = prop.city;
        if (prop?.zip) batch[j].zip = prop.zip;
      }
    }

    for (const lead of needsOwner) {
      if (!lead.city) lead.city = defaultCity;
      if (lead.address && lead.city) leads.push(lead);
    }
  } catch (e) {
    console.error(`[AL ${county}] FSBO error:`, e);
  }
  return leads;
}

// ─── Obituaries (estate leads) ────────────────────────────────────────────────
async function scrapeObituaries(county: string, fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const city = AL_CRAIGSLIST[county]; // same city mapping
  if (!city) return leads;

  try {
    const url = `https://obits.al.com/${city}/obituaries`;
    const res = await fetchWithRetry(url);
    const html = await res.text();

    // Extract obituary names and dates
    const nameRe = /class="[^"]*obit[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;
    const dateRe = /class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;
    const names: string[] = [];
    const dates: string[] = [];
    let m;
    while ((m = nameRe.exec(html)) !== null) names.push(m[1].replace(/<[^>]+>/g, "").trim());
    while ((m = dateRe.exec(html)) !== null) dates.push(m[1].replace(/<[^>]+>/g, "").trim());

    for (let i = 0; i < Math.min(names.length, 30); i++) {
      if (!names[i]) continue;
      leads.push({
        id: makeId(names[i], county, "AL", "obit"),
        county,
        state: "AL",
        lead_type: "Obituary",
        owner_name: names[i],
        address: null,
        city: null,
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: null,
        filing_date: formatDate(dates[i]) || new Date().toISOString().split("T")[0],
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: "Obituary — potential estate/probate lead",
        source_url: url,
        raw_data: JSON.stringify({ name: names[i], date: dates[i] }),
      });
    }
    // Enrich: only keep obituaries where decedent owns property in this county
    const enriched: Lead[] = [];
    const CONCURRENCY_O = 5;
    for (let i = 0; i < leads.length; i += CONCURRENCY_O) {
      const batch = leads.slice(i, i + CONCURRENCY_O);
      const results = await Promise.all(
        batch.map((l) => lookupOwnerProperties(l.owner_name || "", county, "AL")),
      );
      for (let j = 0; j < batch.length; j++) {
        const properties = results[j];
        if (properties.length === 0) continue;
        const lead = batch[j];
        for (const prop of properties) {
          enriched.push({
            ...lead,
            id: makeId(county, "AL", "Obituary", `${lead.owner_name || ""}-${prop.address}`),
            address: prop.address,
            city: prop.city || null,
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
    if (enriched.length) return enriched;
    return leads.filter((l) => (l.owner_name || "").trim().length >= 2);
  } catch (_) {
    /* silent */
  }
  return [];
}

// ─── BANKRUPTCY — Northern District of AL (ecf.alnb.uscourts.gov) ─────────────

// ─── PROBATE — Alabama SJIS probate court filings ────────────────────────────
export async function scrapeProbate(
  county: string,
  fromDate: string,
  toDate: string,
): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    const url = alaCourtSearchUrl(county, "PR", fromDate, toDate);
    const html = await fetchAlaCourtHtml(url);
    if (!html) return leads;
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    // Collect all cases first
    type ALProbateRow = { caseNum: string; name: string; filed: string };
    const cases: ALProbateRow[] = [];
    for (const row of rows) {
      const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      if (cells.length < 3) continue;
      const getCell = (cell: string) => cell.replace(/<[^>]+>/g, "").trim();
      const caseNum = getCell(cells[0] || "");
      const name = getCell(cells[1] || "");
      const filed = getCell(cells[2] || "");
      if (!caseNum && !name) continue;
      cases.push({ caseNum, name, filed });
    }
    // Parallel assessor lookups — 5 concurrent
    const CONCURRENCY = 5;
    for (let i = 0; i < cases.length; i += CONCURRENCY) {
      const batch = cases.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((c) => lookupOwnerProperties(c.name, county, "AL")),
      );
      for (let j = 0; j < batch.length; j++) {
        const { caseNum, name, filed } = batch[j];
        const properties = results[j];
        if (properties.length === 0) {
          leads.push(
            courtCaseToLead({
              county,
              state: "AL",
              leadType: "Probate",
              caseNum,
              caseName: name,
              filedDate: filed,
              sourceUrl: url,
              city: county,
            }),
          );
          continue;
        }
        for (const prop of properties) {
          leads.push(
            courtCaseToLead({
              county,
              state: "AL",
              leadType: "Probate",
              caseNum,
              caseName: name,
              filedDate: filed,
              sourceUrl: url,
              city: prop.city || county,
              prop,
            }),
          );
        }
      }
    }
  } catch (e) {
    console.error(`[AL] Probate ${county} error:`, e);
  }
  return leads;
}

export async function scrapeBankruptcy(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  // AL Northern District covers Madison, Morgan, Jefferson, Shelby; Southern covers Montgomery, Autauga, Elmore
  const RSS_FEEDS = [
    {
      url: "https://ecf.alnb.uscourts.gov/cgi-bin/rss_outside.pl",
      counties: ["Madison", "Morgan", "Jefferson", "Shelby", "Limestone"],
    },
    {
      url: "https://ecf.alsb.uscourts.gov/cgi-bin/rss_outside.pl",
      counties: ["Montgomery", "Autauga", "Elmore"],
    },
  ];
  try {
    for (const feed of RSS_FEEDS) {
      const rss = await fetchWithRetry(feed.url);
      if (!rss.ok) continue;
      const xml = await rss.text();
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      // Parse all items first
      type ALBkItem = {
        title: string;
        link: string;
        pubDate: string;
        caseNum: string;
        caseName: string;
      };
      const bkItems: ALBkItem[] = [];
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
        const ownerFromTitle = title.replace(/^[0-9]{2}-[0-9]{5}(-[0-9]+)?\s*/, "").trim();
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
      // Parallel assessor lookups across counties — 5 concurrent
      const CONCURRENCY = 5;
      for (let i = 0; i < itemsToProcess.length; i += CONCURRENCY) {
        const batch = itemsToProcess.slice(i, i + CONCURRENCY);
        // For each item, try all counties in parallel and pick first match
        const batchResults = await Promise.all(
          batch.map(async (b) => {
            for (const county of feed.counties) {
              const props = await lookupOwnerProperties(b.caseName, county, "AL");
              if (props.length > 0) return { county, props };
            }
            return null;
          }),
        );
        for (let j = 0; j < batch.length; j++) {
          const match = batchResults[j];
          if (!match) continue;
          const { title, link, pubDate, caseNum, caseName } = batch[j];
          const { county, props } = match;
          for (const prop of props) {
            leads.push({
              id: makeId("AL", "AL", "Bankruptcy", `${caseNum}-${prop.address}`),
              county,
              state: "AL",
              lead_type: "Bankruptcy",
              owner_name: caseName || caseNum,
              address: prop.address,
              city: prop.city || county,
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
              source_url: link || feed.url,
              description: `AL Bankruptcy — ${caseName || caseNum}`,
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
    }
  } catch (e) {
    console.error("[AL] Bankruptcy RSS error:", e);
  }
  return leads;
}

// ─── Main export ──────────────────────────────────────────────────────────────

// ─── CODE VIOLATIONS — Huntsville Open Data + Birmingham municipal portal ─────
export async function scrapeCodeViolations(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];

  // NOTE: data.huntsvilleal.gov domain no longer resolves — removed to prevent DNS errors.
  // Huntsville code violations are not available via public API at this time.

  // Jefferson County (Birmingham) code enforcement
  try {
    const url = `https://www.jeffcointouch.com/codeenforcement/search?fromDate=${fromDate}&toDate=${toDate}`;
    let res = await fetchWithRetry(url, { headers: HEADERS });
    let html = res.ok ? await res.text() : "";
    if (!html.includes("<td")) {
      const rendered = await fetchRendered(url);
      if (rendered.ok) html = await rendered.text();
    }
    if (html) {
      const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const rows = html.match(rowRe) || [];
      for (const row of rows) {
        const cells: string[] = [];
        let m;
        while ((m = cellRe.exec(row)) !== null) cells.push(m[1].replace(/<[^>]+>/g, "").trim());
        cellRe.lastIndex = 0;
        if (cells.length < 2 || !cells[0]) continue;
        leads.push({
          id: makeId("CV", cells[0], "Jefferson", "AL"),
          county: "Jefferson",
          state: "AL",
          lead_type: "Code Violation",
          owner_name: cells[1] || null,
          address: cells[2] || null,
          city: "Birmingham",
          zip: null,
          mailing_address: null,
          mailing_city: null,
          mailing_state: null,
          mailing_zip: null,
          case_number: cells[0] || null,
          filing_date: formatDate(cells[3]) || new Date().toISOString().split("T")[0],
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Code Violation — Jefferson County AL — ${cells[2] || cells[0]}`,
          source_url: url,
          raw_data: JSON.stringify(cells),
        });
      }
      const needsOwner = leads.filter((l) => !l.owner_name?.trim() && l.address);
      for (let i = 0; i < needsOwner.length; i += 10) {
        const batch = needsOwner.slice(i, i + 10);
        const results = await Promise.all(
          batch.map((l) => lookupByAddress(l.address!, "Jefferson", "AL")),
        );
        for (let j = 0; j < batch.length; j++) {
          if (results[j]?.ownerName) batch[j].owner_name = results[j]!.ownerName;
        }
      }
    }
  } catch (e) {
    console.error("[AL] Jefferson Code Violations error:", e);
  }

  return leads;
}

export async function scrapeOutOfStateOwners(fromDate: string, toDate: string): Promise<Lead[]> {
  return []; // out-of-state owners excluded per Atlas config
}

// ─── VACANT / ABANDONED — Birmingham Open Data blight registry ─────────────────
// Enrichment: lookupByAddress → owner name from county assessor
export async function scrapeVacantAbandoned(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // Birmingham Open Data — vacant/abandoned structures
    const url = `https://data.birminghamal.gov/resource/vacant-structures.json?$where=date_reported>='${fromDate}T00:00:00'&$limit=200&$order=date_reported DESC`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const data = (await res.json()) as Record<string, string>[];
      for (const item of data) {
        const address = item.address || item.street_address || "";
        if (!address) continue;
        leads.push({
          id: makeId("Jefferson", "AL", "Vacant Abandoned", item.id || address),
          county: "Jefferson",
          state: "AL",
          lead_type: "Vacant/Abandoned",
          owner_name: null,
          address: address || null,
          city: "Birmingham",
          zip: item.zip_code || null,
          mailing_address: null,
          mailing_city: null,
          mailing_state: null,
          mailing_zip: null,
          case_number: item.id || null,
          filing_date: formatDate(item.date_reported?.slice(0, 10) || fromDate),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Vacant/Abandoned — ${item.status || "Vacant Structure"} — ${address}`,
          source_url: "https://data.birminghamal.gov/resource/vacant-structures",
          raw_data: JSON.stringify(item),
        });
      }
    }
    // Enrich with owner name via assessor address lookup — 10 concurrent
    const CONCURRENCY_V = 10;
    const unenriched = leads.filter((l) => !l.owner_name && l.address);
    for (let i = 0; i < unenriched.length; i += CONCURRENCY_V) {
      const batch = unenriched.slice(i, i + CONCURRENCY_V);
      const results = await Promise.all(
        batch.map((l) => lookupByAddress(l.address!, l.county, "AL")),
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
    console.error("[AL] Vacant/Abandoned error:", e);
  }
  return leads;
}

// ─── DIVORCE — Alabama AlaCourt public search (case type DR) ───────────────────
// Enrichment: lookupOwnerProperties by case name → only keep leads with a found property
export async function scrapeDivorce(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const counties = ["Jefferson", "Madison", "Montgomery", "Morgan", "Shelby", "Limestone"];
  for (const county of counties) {
    try {
      const url = alaCourtSearchUrl(county, "DR", fromDate, toDate);
      const res = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
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
        while ((m = cellRe.exec(row)) !== null) cells.push(m[1].replace(/<[^>]+>/g, "").trim());
        cellRe.lastIndex = 0;
        if (cells.length < 2 || !cells[0] || cells[0].toLowerCase().includes("case")) continue;
        cases.push({ caseNum: cells[0], caseName: cells[1], filedDate: cells[2] || fromDate });
      }
      const CONCURRENCY = 5;
      for (let i = 0; i < cases.length; i += CONCURRENCY) {
        const batch = cases.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((c) => lookupOwnerProperties(c.caseName, county, "AL")),
        );
        for (let j = 0; j < batch.length; j++) {
          const { caseNum, caseName, filedDate } = batch[j];
          const properties = results[j];
          if (properties.length === 0) continue;
          for (const prop of properties) {
            leads.push({
              id: makeId(county, "AL", "Divorce", `${caseNum}-${prop.address}`),
              county,
              state: "AL",
              lead_type: "Divorce",
              owner_name: prop.ownerName || caseName || null,
              address: prop.address,
              city: prop.city || null,
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
              description: `${county} County AL Divorce — ${caseName}`,
              source_url: url,
              raw_data: JSON.stringify({ caseNum, caseName, filedDate, parcelId: prop.parcelId }),
            });
          }
        }
      }
    } catch (e) {
      console.error(`[${county} AL] Divorce error:`, e);
    }
  }
  return leads;
}

export async function scrapeAlabama(
  county: string,
  fromDate: string,
  toDate: string,
  leadTypes?: string[],
  scraperErrors?: string[],
): Promise<Lead[]> {
  const runners: Record<string, () => Promise<Lead[]>> = {
    "Pre-Foreclosure": () => scrapePreForeclosure(county, fromDate, toDate),
    "Tax Delinquent": () => scrapeTaxDelinquent(county, fromDate, toDate),
    "Sheriff Sale": () => scrapeSheriffSales(county, fromDate, toDate),
    FSBO: () => scrapeFSBO(county, fromDate, toDate),
    Obituary: () => scrapeObituaries(county, fromDate, toDate),
    Probate: () => scrapeProbate(county, fromDate, toDate),
  };

  const types = leadTypes?.length ? leadTypes : Object.keys(runners);
  const entries = types
    .map((t) => [t, runners[t]] as const)
    .filter(([, fn]) => Boolean(fn));
  const results = await Promise.allSettled(entries.map(([, fn]) => fn!()));

  return settleScraperResults(
    results,
    entries.map(([t]) => `${county} AL ${t}`),
    scraperErrors,
  );
}
