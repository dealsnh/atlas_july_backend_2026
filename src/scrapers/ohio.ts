// @ts-nocheck
/**
 * Ohio County Scrapers
 * Counties: Hamilton (Cincinnati), Montgomery (Dayton), Franklin (Columbus),
 *           Cuyahoga (Cleveland), Summit (Akron)
 *
 * Sources (all real county/city portals — no federal APIs):
 * - Pre-Foreclosure: Hamilton County Clerk of Courts (courtclerk.org)
 * - Sheriff Sales:   Hamilton County RealAuction (hamilton.sheriffsaleauction.ohio.gov)
 *                    + county-specific portals for other counties
 * - Tax Delinquent:  Hamilton County Auditor (hamiltoncountyauditor.org)
 * - Probate:         Hamilton County Probate Court (probatect.org)
 * - Bankruptcy:      PACER RSS — Southern District OH (ecf.ohsb.uscourts.gov)
 *                    + Northern District OH (ecf.ohnb.uscourts.gov)
 * - Code Violations: Cincinnati Open Data (data.cincinnati-oh.gov)
 * - Fire Damage:     Cincinnati Fire incident reports
 * - FSBO:            Craigslist Cincinnati
 *
 * NOTE: CourtListener removed — it returns 0 for all Ohio county lead types.
 * NOTE: Montgomery/Franklin/Cuyahoga/Summit removed until their portals are built.
 *       Tina's config should only list Hamilton for OH until those are added.
 */

import * as XLSX from "xlsx";
import { Lead, makeId, formatDate, fetchWithRetry, fetchRendered, fetchBlockedPage, settleScraperResults, courtCaseToLead, validateHtmlResponse } from "./base.js";
import {
  lookupOwnerProperties,
  lookupByAddress,
  lookupByParcel,
  lookupByPoint,
  isGovernmentOwner,
} from "./assessor.js";
import { scrapeFsbo } from "./fsbo.js";

// ─── Pre-Foreclosure via Hamilton County Clerk of Courts ──────────────────────
async function scrapePreForeclosure(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // Hamilton County Clerk of Courts — foreclosure case search
    // URL format confirmed working via ScraperAPI
    const url = `https://www.courtclerk.org/records-search/case-search/?caseType=F&fromDate=${fromDate}&toDate=${toDate}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) return leads;
    const html = await res.text();

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
      if (cells.length < 2 || !cells[0]) continue;

      const caseNumber = cells[0];
      const caseStyle = cells[1];
      const filedDate = cells[2] || "";

      if (!caseNumber || caseNumber.toLowerCase().includes("case")) continue;

      const parts = caseStyle.split(/\s+v\.?\s+/i);
      const ownerName = parts.length > 1 ? parts[1].trim() : caseStyle;

      leads.push({
        id: makeId(caseNumber, "Hamilton", "OH"),
        county: "Hamilton",
        state: "OH",
        lead_type: "Pre-Foreclosure",
        owner_name: ownerName,
        address: null,
        city: "Cincinnati",
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
        description: caseStyle,
        source_url: "https://www.courtclerk.org/records-search/case-search/",
        raw_data: JSON.stringify({ caseStyle }),
      });
    }
  } catch (e) {
    console.error("[Hamilton OH] Pre-Foreclosure error:", e);
  }
  return leads;
}

// ─── Sheriff Sales via Hamilton County RealAuction ───────────────────────────
async function scrapeSheriffSales(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // Hamilton County uses RealAuction for online sheriff sales
    // This is a JS-rendered page — use fetchRendered
    const url =
      "https://hamilton.sheriffsaleauction.ohio.gov/index.cfm?zaction=AUCTION&zmethod=preview";
    const res = await fetchRendered(url);
    if (!res.ok) return leads;
    const html = await res.text();

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
      if (cells.length < 2) continue;

      const caseNumber = cells[0];
      const address = cells[1];
      const ownerName = cells[2] || "Unknown";
      const saleDate = cells[3] || "";
      const amount = cells[4] || "";

      if (!address && !ownerName) continue;
      if (!caseNumber || caseNumber.toLowerCase().includes("case")) continue;

      leads.push({
        id: makeId(caseNumber, "Hamilton", "OH", "sheriff"),
        county: "Hamilton",
        state: "OH",
        lead_type: "Sheriff Sale",
        owner_name: ownerName,
        address: address || null,
        city: "Cincinnati",
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: caseNumber || null,
        filing_date: null,
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: formatDate(saleDate),
        sale_amount: amount || null,
        description: `Sheriff sale — Hamilton County, OH`,
        source_url: url,
        raw_data: JSON.stringify(cells),
      });
    }
  } catch (e) {
    console.error("[Hamilton OH] Sheriff Sales error:", e);
  }
  return leads;
}

// ─── Tax Delinquent via Hamilton County Auditor XLSX ─────────────────────────
// CONFIRMED WORKING: hcauditor.org/download/Delinquent/unpaid.xlsx (updated monthly)
// Full XLSX has ~28k rows — cap per run for daily pipeline performance (still >> old 100 cap)
const HAMILTON_TAX_MAX_ROWS = 500;

async function scrapeTaxDelinquent(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const sourceUrl = "https://www.hcauditor.org/download/Delinquent/unpaid.xlsx";
  try {
    const res = await fetchWithRetry(sourceUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    if (!res.ok) return leads;
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(sheet);
    const sorted = [...rows].sort((a, b) => {
      const av = Number(a.unpaid_amount) || 0;
      const bv = Number(b.unpaid_amount) || 0;
      return bv - av;
    });
    for (const row of sorted.slice(0, HAMILTON_TAX_MAX_ROWS)) {
      const parcel = String(row.parcel_number || "").trim();
      const owner1 = String(row.owner_name_1 || "").trim();
      const owner2 = String(row.owner_name_2 || "").trim();
      const owner = [owner1, owner2].filter(Boolean).join(" & ");
      const mail1 = String(row.owner_address_1 || "").trim();
      const mail2 = String(row.owner_address_2 || "").trim();
      const amount = row.unpaid_amount != null ? String(row.unpaid_amount) : null;
      if (!parcel || !owner) continue;
      const cityZip = mail2.match(/^([^,]+),\s*([A-Z]{2})\s*(\d{5})/i);
      leads.push({
        id: makeId(parcel, "Hamilton", "OH", "tax"),
        county: "Hamilton",
        state: "OH",
        lead_type: "Tax Delinquent",
        owner_name: owner,
        address: mail1 || null,
        city: cityZip?.[1]?.trim() || "Cincinnati",
        zip: cityZip?.[3] || null,
        mailing_address: mail1 || null,
        mailing_city: cityZip?.[1]?.trim() || null,
        mailing_state: cityZip?.[2]?.trim() || "OH",
        mailing_zip: cityZip?.[3] || null,
        case_number: parcel,
        filing_date: formatDate(fromDate),
        assessed_value: null,
        tax_year: new Date().getFullYear().toString(),
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: amount,
        description: `Tax Delinquent — Hamilton County OH${amount ? ` — $${amount}` : ""}`,
        source_url: sourceUrl,
        raw_data: JSON.stringify(row),
      });
    }

    // Recover the TRUE situs (the XLSX only carries the owner's mailing address).
    // Join by parcel id to the county roll; keep the XLSX mailing (authoritative
    // tax-bill address) — only the property/situs is overwritten.
    const CONCURRENCY = 10;
    const needsSitus = leads.filter((l) => l.owner_name).slice(0, 60);
    for (let i = 0; i < needsSitus.length; i += CONCURRENCY) {
      const batch = needsSitus.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((l) =>
          lookupByParcel("Hamilton", "OH", l.case_number).then(
            (p) =>
              p ||
              (l.owner_name
                ? lookupOwnerProperties(l.owner_name, "Hamilton", "OH").then((r) => r[0] || null)
                : null),
          ),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        const prop = results[j];
        if (!prop?.address) continue;
        batch[j].address = prop.address; // true situs (mailing left intact)
        if (prop.city) batch[j].city = prop.city;
        if (prop.zip) batch[j].zip = prop.zip;
      }
    }
  } catch (e) {
    console.error("[Hamilton OH] Tax Delinquent error:", e);
  }
  return leads;
}

// ─── Probate via Hamilton County Probate Court ────────────────────────────────
async function scrapeProbate(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // Hamilton County Probate Court — probatect.org
    // Try the case search with estate type
    const url = `https://www.probatect.org/case-search?fromDate=${fromDate}&caseType=estate`;
    const html = await fetchBlockedPage(url);
    const check = validateHtmlResponse(html, "Hamilton OH Probate");
    if (!check.ok) return leads;

    const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const rows = html.match(rowRe) || [];

    // Collect all rows first
    type OHProbateRow = { ownerName: string; caseNum: string; cells: string[] };
    const ohCases: OHProbateRow[] = [];
    for (const row of rows) {
      const cells: string[] = [];
      let m;
      while ((m = cellRe.exec(row)) !== null) {
        cells.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      cellRe.lastIndex = 0;
      if (cells.length < 2 || !cells[1]) continue;
      ohCases.push({ ownerName: cells[1], caseNum: cells[0], cells });
    }
    // Parallel assessor lookups — 5 concurrent
    const CONCURRENCY = 5;
    for (let i = 0; i < ohCases.length; i += CONCURRENCY) {
      const batch = ohCases.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((c) => lookupOwnerProperties(c.ownerName, "Hamilton", "OH")),
      );
      for (let j = 0; j < batch.length; j++) {
        const { ownerName, caseNum, cells } = batch[j];
        const properties = results[j];
        if (properties.length === 0) {
          leads.push(
            courtCaseToLead({
              county: "Hamilton",
              state: "OH",
              leadType: "Probate/Estate",
              caseNum,
              caseName: ownerName,
              filedDate: cells[2] || fromDate,
              sourceUrl: url,
              city: "Cincinnati",
            }),
          );
          continue;
        }
        for (const prop of properties) {
          leads.push(
            courtCaseToLead({
              county: "Hamilton",
              state: "OH",
              leadType: "Probate/Estate",
              caseNum,
              caseName: ownerName,
              filedDate: cells[2] || fromDate,
              sourceUrl: url,
              city: prop.city || "Cincinnati",
              prop,
            }),
          );
        }
      }
    }
  } catch (e) {
    console.error("[Hamilton OH] Probate error:", e);
  }
  return leads;
}

// ─── Code Violations via Cincinnati Open Data ─────────────────────────────
// Dataset cncm-znd6. Filter to distressed RESIDENTIAL cases (buildings/barricade/
// demolition/property-maintenance) — the huge "trash/litter/tall grass" and
// abandoned-vehicle buckets are low-signal noise and excluded. full_address feeds
// the Hamilton parcel-roll completer for owner + mailing (required by the gate).
const DISTRESS_CV_CLAUSE =
  "(comp_type_desc like '%Buildings with Residences%' OR " +
  "comp_type_desc like '%Barricading%' OR " +
  "comp_type_desc like '%Demolition%' OR " +
  "comp_type_desc like '%Property Maintenance%')";

async function scrapeCodeViolationsHamilton(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    const where = `entered_date>'${fromDate}' AND ${DISTRESS_CV_CLAUSE}`;
    const url = `https://data.cincinnati-oh.gov/resource/cncm-znd6.json?$where=${encodeURIComponent(where)}&$limit=400&$order=${encodeURIComponent("entered_date DESC")}`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return leads;
    const data = (await res.json()) as Record<string, string>[];

    const rows = data
      .map((item) => ({ item, address: (item.full_address || "").trim() }))
      .filter((r) => /^\d+\s+\S/.test(r.address));

    const CONCURRENCY = 10;
    const CAP = 200; // completer calls per run
    for (let i = 0; i < rows.length && i < CAP; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      const props = await Promise.all(
        batch.map((r) => lookupByAddress(r.address, "Hamilton", "OH")),
      );
      for (let j = 0; j < batch.length; j++) {
        const { item, address } = batch[j];
        const prop = props[j];
        if (!prop?.ownerName || !prop.mailingAddress || isGovernmentOwner(prop.ownerName)) continue;
        const type = item.comp_type_desc || item.sub_type_desc || "Code Violation";
        leads.push({
          id: makeId("CV", item.number_key || address, "Hamilton", "OH"),
          county: "Hamilton",
          state: "OH",
          lead_type: "Code Violation",
          owner_name: prop.ownerName,
          address: prop.address || address,
          city: prop.city || "Cincinnati",
          zip: prop.zip || null,
          mailing_address: prop.mailingAddress,
          mailing_city: prop.mailingCity || null,
          mailing_state: prop.mailingState || null,
          mailing_zip: prop.mailingZip || null,
          case_number: item.number_key || null,
          filing_date: formatDate(item.entered_date),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Code Violation — ${type} — ${prop.address || address}`,
          source_url: "https://data.cincinnati-oh.gov/resource/cncm-znd6",
          raw_data: JSON.stringify({
            number_key: item.number_key,
            comp_type_desc: item.comp_type_desc,
            data_status_display: item.data_status_display,
            entered_date: item.entered_date,
            parcelId: prop.parcelId,
          }),
        });
      }
    }
  } catch (e) {
    console.error("[Hamilton OH] Code Violations error:", e);
  }
  return leads;
}

// ─── Fire Damage via Cincinnati Fire incident reports ─────────────────────────
async function scrapeFireDamage(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    // CONFIRMED WORKING: vnsz-a3wp = Cincinnati Fire Incidents (CAD)
    // Fields: create_time_incident, address_x, incident_type_desc, cfd_incident_type_group, event_number
    const url = `https://data.cincinnati-oh.gov/resource/vnsz-a3wp.json?$where=create_time_incident>='${fromDate}' AND cfd_incident_type_group='STRUCTURE FIRE'&$limit=500&$order=create_time_incident DESC`;
    const res = await fetchWithRetry(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      // Fallback: Cincinnati Fire Department incident page
      const fallbackUrl = "https://www.cincinnati-oh.gov/fire/incident-reports/";
      const r2 = await fetchWithRetry(fallbackUrl);
      if (!r2.ok) return leads;
      const html = await r2.text();
      const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const rows = html.match(rowRe) || [];
      for (const row of rows) {
        const text = row.replace(/<[^>]+>/g, " ");
        if (!/structure fire|building fire|residential fire|house fire/i.test(text)) continue;
        const cells: string[] = [];
        let m;
        while ((m = cellRe.exec(row)) !== null) {
          cells.push(m[1].replace(/<[^>]+>/g, "").trim());
        }
        cellRe.lastIndex = 0;
        if (!cells[0]) continue;
        leads.push({
          id: makeId(cells[0], "Hamilton", "OH", "fire"),
          county: "Hamilton",
          state: "OH",
          lead_type: "Fire Damage",
          owner_name: "Unknown",
          address: cells[0] || null,
          city: "Cincinnati",
          zip: null,
          mailing_address: null,
          mailing_city: null,
          mailing_state: null,
          mailing_zip: null,
          case_number: null,
          filing_date: formatDate(cells[1]) || new Date().toISOString().split("T")[0],
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: cells[2] || "Structure Fire",
          source_url: fallbackUrl,
          raw_data: JSON.stringify(cells),
        });
      }
      return leads;
    }

    const data = (await res.json()) as Record<string, string>[];
    for (const item of data) {
      const type = (item.incident_type_desc || item.type_desc || "").toLowerCase();
      if (!type.includes("fire") && !type.includes("structure") && !type.includes("residential"))
        continue;

      const address = item.address_x || item.incident_address || "";
      const date = item.create_time_incident || item.date || fromDate;
      // Enrich with owner name via address lookup
      const enriched = address ? await lookupByAddress(address, "Hamilton", "OH") : null;

      leads.push({
        id: makeId("FIRE", item.event_number || item.incident_no || address, "Hamilton", "OH"),
        county: "Hamilton",
        state: "OH",
        lead_type: "Fire Damage",
        owner_name: enriched?.ownerName || null,
        address: enriched?.address || address || null,
        city: enriched?.city || "Cincinnati",
        zip: enriched?.zip || null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: item.event_number || item.incident_no || null,
        filing_date: formatDate(date),
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: `Fire Damage — ${item.incident_type_desc || "Structure Fire"} — ${address}`,
        source_url:
          "https://data.cincinnati-oh.gov/Public-Safety/Cincinnati-Fire-Incidents-CAD/vnsz-a3wp",
        raw_data: JSON.stringify(item),
      });
    }
  } catch (e) {
    console.error("[Hamilton OH] Fire Damage error:", e);
  }
  return leads;
}

// ─── BANKRUPTCY — Southern + Northern Districts of OH ────────────────────────
export async function scrapeBankruptcy(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const feeds = [
    "https://ecf.ohsb.uscourts.gov/cgi-bin/rss_outside.pl", // Southern OH (Cincinnati, Columbus, Dayton)
    "https://ecf.ohnb.uscourts.gov/cgi-bin/rss_outside.pl", // Northern OH (Cleveland, Akron)
  ];

  for (const feedUrl of feeds) {
    try {
      const rss = await fetchWithRetry(feedUrl);
      if (!rss.ok) continue;
      const xml = await rss.text();
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      // Parse all items first
      type OHBkItem = {
        title: string;
        link: string;
        pubDate: string;
        caseNum: string;
        caseName: string;
      };
      const bkItems: OHBkItem[] = [];
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
        const ownerFromTitle = title.replace(/^[0-9]{2}-[0-9]{5}(-[0-9]+)?\s*/, "").trim();
        const caseName =
          ownerFromTitle ||
          desc
            .replace(/<[^>]+>/g, "")
            .replace(/&[a-z0-9#]+;/g, "")
            .trim();
        bkItems.push({ title, link, pubDate, caseNum, caseName });
      }
      // Parallel assessor lookups — 5 concurrent
      const CONCURRENCY = 5;
      for (let i = 0; i < bkItems.length; i += CONCURRENCY) {
        const batch = bkItems.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((b) => lookupOwnerProperties(b.caseName, "Hamilton", "OH")),
        );
        for (let j = 0; j < batch.length; j++) {
          const { title, link, pubDate, caseNum, caseName } = batch[j];
          const properties = results[j];
          if (properties.length === 0) continue;
          for (const prop of properties) {
            leads.push({
              id: makeId(
                "OH",
                feedUrl.includes("ohsb") ? "S" : "N",
                "Bankruptcy",
                `${caseNum}-${prop.address}`,
              ),
              county: "Hamilton",
              state: "OH",
              lead_type: "Bankruptcy",
              owner_name: caseName || caseNum,
              address: prop.address,
              city: prop.city || "Cincinnati",
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
              source_url: link || feedUrl,
              description: `OH Bankruptcy — ${caseName || caseNum}`,
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
      console.error("[OH] Bankruptcy RSS error:", e);
    }
  }
  return leads;
}

// ─── FSBO — Craigslist Cincinnati ─────────────────────────────────────────────
async function scrapeFSBO(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    const url = "https://cincinnati.craigslist.org/search/reo?format=json";
    const res = await fetchWithRetry(url);
    if (!res.ok) return leads;
    const data = (await res.json()) as any;
    const items = data?.data?.items || [];

    for (const item of items.slice(0, 60)) {
      const title: string = item.title || "";
      if (!/fsbo|for sale by owner|motivated|must sell|price.?reduc|cash.?only|as.?is/i.test(title))
        continue;

      leads.push({
        id: makeId(item.id || title, "Hamilton", "OH", "fsbo"),
        county: "Hamilton",
        state: "OH",
        lead_type: "FSBO",
        owner_name: null,
        address: title,
        city: "Cincinnati",
        zip: null,
        mailing_address: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
        case_number: null,
        filing_date: formatDate(item.posted_date) || new Date().toISOString().split("T")[0],
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: item.ask?.toString() || null,
        description: title,
        source_url: item.url || url,
        raw_data: JSON.stringify({ title, price: item.ask }),
      });
    }
  } catch (e) {
    console.error("[Hamilton OH] FSBO error:", e);
  }
  return leads;
}

// ─── OBITUARIES — Legacy.com Cincinnati + Google News RSS ───────────────────
// Enrichment: lookupOwnerProperties by decedent name → only keep leads with a found property
// NOTE: Date filter removed — RSS feeds only carry ~20 recent items; all are relevant.
//       Legacy.com RSS routes through ScraperAPI (xml extension no longer in SKIP_SCRAPER_PATTERNS).
export async function scrapeObituaries(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    const rssUrls = [
      "https://www.legacy.com/obituaries/cincinnati/rss.aspx",
      "https://www.legacy.com/obituaries/enquirer/rss.aspx",
      // Google News RSS fallback — broader Hamilton County coverage
      "https://news.google.com/rss/search?q=Hamilton+County+Ohio+obituary+Cincinnati&hl=en-US&gl=US&ceid=US:en",
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
          if (!title) continue;
          // Only filter by date if the item is older than 30 days (keep a wide window)
          if (pubDate) {
            const d = new Date(pubDate);
            if (!isNaN(d.getTime())) {
              const thirtyDaysAgo = new Date();
              thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
              if (d < thirtyDaysAgo) continue;
            }
          }
          leads.push({
            id: makeId("Hamilton", "OH", "Obituary", link || title),
            county: "Hamilton",
            state: "OH",
            lead_type: "Obituary",
            owner_name: title || null,
            address: null,
            city: "Cincinnati",
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
            description: `Obituary — ${title}`,
            source_url: link || rssUrl,
            raw_data: JSON.stringify({ title, pubDate }),
          });
        }
      } catch {
        /* try next URL */
      }
    }
    // Enrich: only keep obituaries where decedent owns property in Hamilton OH
    const enriched: Lead[] = [];
    const CONCURRENCY_O = 5;
    for (let i = 0; i < leads.length; i += CONCURRENCY_O) {
      const batch = leads.slice(i, i + CONCURRENCY_O);
      const results = await Promise.all(
        batch.map((l) => lookupOwnerProperties(l.owner_name || "", "Hamilton", "OH")),
      );
      for (let j = 0; j < batch.length; j++) {
        const properties = results[j];
        if (properties.length === 0) continue;
        const lead = batch[j];
        for (const prop of properties) {
          enriched.push({
            ...lead,
            id: makeId("Hamilton", "OH", "Obituary", `${lead.owner_name || ""}-${prop.address}`),
            address: prop.address,
            city: prop.city || "Cincinnati",
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
    return enriched;
  } catch (e) {
    console.error("[Hamilton OH] Obituaries error:", e);
  }
  return [];
}
// ─── CODE VIOLATIONS — stub (handled inside scrapeOhio) ──────────────────────
export async function scrapeCodeViolations(fromDate: string, toDate: string): Promise<Lead[]> {
  return []; // handled inside scrapeOhio() via scrapeCodeViolationsHamilton()
}
// ─── DIVORCE — Google News RSS (Hamilton County OH) ──────────────────────────
// courtclerk.org case-search POST endpoint returns 404 (URL changed).
// Replacement: Google News RSS for Hamilton County divorce filings.
// Names extracted from article titles → enriched via lookupOwnerProperties.
export async function scrapeDivorce(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    const rssUrls = [
      // Google News RSS — Hamilton County OH divorce filings
      "https://news.google.com/rss/search?q=Hamilton+County+Ohio+divorce+filing+property&hl=en-US&gl=US&ceid=US:en",
      // Fallback: Cincinnati.com divorce notices
      "https://news.google.com/rss/search?q=Cincinnati+Ohio+divorce+real+estate+property&hl=en-US&gl=US&ceid=US:en",
    ];
    const seen = new Set<string>();
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
          if (!title || seen.has(title)) continue;
          seen.add(title);
          // Only filter by date if the item is older than 30 days
          if (pubDate) {
            const d = new Date(pubDate);
            if (!isNaN(d.getTime())) {
              const thirtyDaysAgo = new Date();
              thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
              if (d < thirtyDaysAgo) continue;
            }
          }
          // Extract person name from title — pattern: "FirstName LastName files for divorce"
          // or "FirstName LastName divorce" — take first 2-3 words before "divorce" or "files"
          const nameMatch = title.match(
            /^([A-Z][a-z]+(?: [A-Z][a-z]+){1,2})(?:\s+(?:files?|filed|granted|vs?\.?|and|&))/i,
          );
          const personName =
            nameMatch?.[1] ||
            title
              .replace(/\s*-\s*.*$/, "")
              .trim()
              .slice(0, 50);
          leads.push({
            id: makeId("Hamilton", "OH", "Divorce", link || title),
            county: "Hamilton",
            state: "OH",
            lead_type: "Divorce",
            owner_name: personName || null,
            address: null,
            city: "Cincinnati",
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
            description: `Hamilton County OH Divorce — ${title}`,
            source_url: link || rssUrl,
            raw_data: JSON.stringify({ title, pubDate }),
          });
        }
      } catch {
        /* try next URL */
      }
    }
    // Enrich: only keep divorce leads where person owns property in Hamilton OH
    const enriched: Lead[] = [];
    const CONCURRENCY = 5;
    for (let i = 0; i < leads.length; i += CONCURRENCY) {
      const batch = leads.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((l) => lookupOwnerProperties(l.owner_name || "", "Hamilton", "OH")),
      );
      for (let j = 0; j < batch.length; j++) {
        const properties = results[j];
        if (properties.length === 0) continue;
        const lead = batch[j];
        for (const prop of properties) {
          enriched.push({
            ...lead,
            id: makeId("Hamilton", "OH", "Divorce", `${lead.owner_name || ""}-${prop.address}`),
            address: prop.address,
            city: prop.city || "Cincinnati",
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
    return enriched;
  } catch (e) {
    console.error("[Hamilton OH] Divorce error:", e);
  }
  return leads;
}
// ─── VACANT/ABANDONED + PRE-FORECLOSURE — Cincinnati Vacant/Foreclosed Registry ─
// Dataset w3jp-dfxy carries latitude/longitude but NO street field, so we resolve
// owner + situs + mailing directly with a SPATIAL parcel-roll query (lookupByPoint) —
// far more reliable than Nominatim reverse-geocoding. Two filters, two lead types:
//   work_type='VACANT FORECLOSED PROPTY PROGRAM'   → Vacant/Abandoned
//   data_status_display like '%Foreclosure Filed%' → Pre-Foreclosure
async function scrapeRegistryByPoint(
  where: string,
  leadType: string,
  note: string,
): Promise<Lead[]> {
  const leads: Lead[] = [];
  try {
    const url = `https://data.cincinnati-oh.gov/resource/w3jp-dfxy.json?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent("entered_date DESC")}&$limit=400`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return leads;
    const data = (await res.json()) as Record<string, string>[];
    const rows = data.filter((it) => it.latitude && it.longitude);

    const CONCURRENCY = 8;
    const CAP = 200;
    for (let i = 0; i < rows.length && i < CAP; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      const props = await Promise.all(
        batch.map((it) => lookupByPoint(it.longitude, it.latitude, "Hamilton", "OH")),
      );
      for (let j = 0; j < batch.length; j++) {
        const it = batch[j];
        const prop = props[j];
        if (!prop?.ownerName || !prop.mailingAddress || isGovernmentOwner(prop.ownerName)) continue;
        leads.push({
          id: makeId(
            leadType,
            it.uniqueid || it.number_key || `${it.latitude},${it.longitude}`,
            "Hamilton",
            "OH",
          ),
          county: "Hamilton",
          state: "OH",
          lead_type: leadType,
          owner_name: prop.ownerName,
          address: prop.address,
          city: prop.city || "Cincinnati",
          zip: prop.zip || null,
          mailing_address: prop.mailingAddress,
          mailing_city: prop.mailingCity || null,
          mailing_state: prop.mailingState || null,
          mailing_zip: prop.mailingZip || null,
          case_number: prop.parcelId || it.number_key || null,
          filing_date: formatDate(it.entered_date?.slice(0, 10)),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `${leadType} — ${note} — ${prop.address}${it.neighborhood ? ` — ${it.neighborhood}` : ""}`,
          source_url: "https://data.cincinnati-oh.gov/resource/w3jp-dfxy",
          raw_data: JSON.stringify({
            number_key: it.number_key,
            data_status_display: it.data_status_display,
            work_type: it.work_type,
            parcelId: prop.parcelId,
          }),
        });
      }
    }
  } catch (e) {
    console.error(`[Hamilton OH] ${leadType} error:`, e);
  }
  return leads;
}

export async function scrapeVacantAbandoned(fromDate: string, toDate: string): Promise<Lead[]> {
  return scrapeRegistryByPoint(
    "work_type='VACANT FORECLOSED PROPTY PROGRAM'",
    "Vacant/Abandoned",
    "vacant/foreclosed registry",
  );
}

export async function scrapePreForeclosureRegistry(
  fromDate: string,
  toDate: string,
): Promise<Lead[]> {
  return scrapeRegistryByPoint(
    "data_status_display like '%Foreclosure Filed%'",
    "Pre-Foreclosure",
    "foreclosure filed",
  );
}
export async function scrapeOutOfStateOwners(fromDate: string, toDate: string): Promise<Lead[]> {
  return []; // out-of-state owners excluded per Atlas config
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function scrapeOhio(
  county: string,
  fromDate: string,
  toDate: string,
  leadTypes?: string[],
  scraperErrors?: string[],
): Promise<Lead[]> {
  if (county !== "Hamilton") {
    console.log(`[OH] Skipping ${county} — county portal scraper not yet implemented`);
    return [];
  }

  const runners: Record<string, () => Promise<Lead[]>> = {
    "Pre-Foreclosure": async () => {
      // Primary: Cincinnati foreclosure-filed registry (keyless, completes via spatial roll).
      // Secondary: courtclerk.org (Cloudflare-walled — best-effort, may return 0).
      const [registry, court] = await Promise.all([
        scrapePreForeclosureRegistry(fromDate, toDate),
        scrapePreForeclosure(fromDate, toDate).catch(() => [] as Lead[]),
      ]);
      return [...registry, ...court];
    },
    "Sheriff Sale": () => scrapeSheriffSales(fromDate, toDate),
    "Tax Delinquent": () => scrapeTaxDelinquent(fromDate, toDate),
    Probate: () => scrapeProbate(fromDate, toDate),
    FSBO: () => scrapeFsbo("Hamilton", "OH", fromDate, toDate),
    "Fire Damage": () => scrapeFireDamage(fromDate, toDate),
    Bankruptcy: () => scrapeBankruptcy(fromDate, toDate),
    "Code Violation": () => scrapeCodeViolationsHamilton(fromDate, toDate),
    Obituary: () => scrapeObituaries(fromDate, toDate),
    Divorce: () => scrapeDivorce(fromDate, toDate),
    "Vacant/Abandoned": () => scrapeVacantAbandoned(fromDate, toDate),
  };

  const types = leadTypes?.length ? leadTypes : Object.keys(runners);
  const entries = types
    .map((t) => [t, runners[t]] as const)
    .filter(([, fn]) => Boolean(fn));
  const results = await Promise.allSettled(entries.map(([, fn]) => fn!()));

  return settleScraperResults(
    results,
    entries.map(([t]) => `${county} OH ${t}`),
    scraperErrors,
  );
}
