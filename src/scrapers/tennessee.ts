// @ts-nocheck
/**
 * Tennessee County Scrapers — Hamilton County (Chattanooga).
 *
 * Tennessee is a NON-JUDICIAL, deed-of-trust state, so Hamilton TN models like
 * Missouri and Alabama rather than judicial Ohio: the substitute trustee's notice
 * of sale is the pre-foreclosure record, and there is no separately recorded
 * notice of default.
 *
 * Source map (all verified live 2026-08-13):
 *   Tax Delinquent    — Trustee delinquent file, CSV in a ZIP (this file)
 *   Pre-Foreclosure   — Hamilton County Herald public notices      (tn-courts.ts)
 *   Probate           — Chancery Court dockets, PDF                (tn-courts.ts)
 *   Divorce           — Circuit Court dockets, PDF                 (tn-courts.ts)
 *   Code Violation    — ChattaData code enforcement export      (tn-open-data.ts)
 *   Vacant/Abandoned  — same export, flag_dangerous + keywords   (tn-open-data.ts)
 *   Fire Damage       — ChattaData permit export, fire repairs   (tn-open-data.ts)
 *   Bankruptcy        — PACER RSS, E.D. Tenn. Chattanooga division  (this file)
 *   Obituary          — Google News RSS                             (this file)
 *   FSBO              — forsalebyowner.com                          (fsbo.ts)
 *   Out-of-State /
 *   Absentee / Probate-by-owner-name — parcel roll             (roll-leads.ts)
 *
 * DELIBERATELY NOT BUILT:
 *   Water Shutoff — no source exists. Chattanooga water is Tennessee American
 *     Water (investor-owned) and power is EPB; neither publishes a per-parcel
 *     shutoff list, because account status is protected customer data. Same
 *     conclusion already documented for MO/AL/OH.
 *   Senior Owner  — the county roll has no age/tax-relief field populated. The
 *     Chattanooga parcel layer does expose TAXRLFCODE (TN's elderly/disabled/
 *     veteran tax relief) but it is NULL on all 85,704 rows, and the Trustee
 *     delinquent file's "Tax Relief Indicator" is 'Y' on only 41 of 53,905 rows.
 *     There is no honest way to derive it, so it is omitted rather than faked.
 *   Eviction — General Sessions detainer dockets exist at edockets.us and are the
 *     correct source, but that host (207.207.35.245, shared with
 *     tennesseecasefinder.com) refuses datacenter IPs. It needs the residential
 *     proxy path proven before being wired, so Eviction is not claimed as live.
 */

import { Lead, makeId, formatDate, fetchWithRetry } from "./base.js";
import { lookupOwnerProperties, isGovernmentOwner } from "./assessor.js";
import { fetchZipCsv, parseCsvText, headerIndex } from "./tn-datasets.js";
import { scrapeFsbo } from "./fsbo.js";
import { scrapeForeclosures, scrapeProbate, scrapeDivorce, personMatchesOwner } from "./tn-courts.js";
import { scrapeCodeViolations, scrapeVacantAbandoned, scrapeFireDamage } from "./tn-open-data.js";
import { settleScraperResults } from "./base.js";
import { logger } from "../utils/logger.js";

const COUNTY = "Hamilton";
const STATE = "TN";

const TRUSTEE_DELINQUENT_ZIP =
  "https://www.hamiltontn.gov/_downloadsTrusteeDelinquent/CTRUDELQCSV.zip";
const TRUSTEE_SOURCE = "https://www.hamiltontn.gov/DownloadRecords.aspx#delinquent-tax";

/**
 * The delinquent file holds 23,388 unique parcels. Leads are written one INSERT at
 * a time (leads.repository), so emitting every parcel would mean ~23k round trips
 * per run. Cap to the most actionable slice — newest tax year first, then largest
 * balance — and log what was left behind rather than truncating silently.
 */
const TAX_DELINQUENT_LIMIT = Number(process.env.HAMILTON_TN_TAX_DELINQUENT_LIMIT || 1500);

/** Only surface parcels still delinquent for a recent tax year. */
const TAX_DELINQUENT_MAX_AGE_YEARS = 4;

const NAME_LOOKUP_CONCURRENCY = 5;

// ─── TAX DELINQUENT — Trustee delinquent tax file ────────────────────────────

/** Amounts are zero-padded integer cents: "001962291" → 19622.91. */
function centsToAmount(raw: string): number {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return 0;
  return Number(digits) / 100;
}

/** "CHATTANOOGA TN37409" / "CHATT TN 37416" → city / state / zip. */
function splitMailLine(raw: string): { city: string | null; state: string | null; zip: string | null } {
  const cleaned = String(raw || "").replace(/\s+/g, " ").trim();
  const m = cleaned.match(/^(.*?)\s+([A-Z]{2})\s*(\d{5})(?:-?\d{4})?$/i);
  if (!m) return { city: cleaned || null, state: null, zip: null };
  return { city: m[1].trim() || null, state: m[2].toUpperCase(), zip: m[3] };
}

interface DelinquentParcel {
  parcelId: string;
  owner: string;
  propertyAddress: string;
  mailStreet: string;
  mailLine2: string;
  newestYear: string;
  totalOwed: number;
  years: string[];
}

export async function scrapeTaxDelinquent(_fromDate: string, toDate: string): Promise<Lead[]> {
  const csv = await fetchZipCsv(TRUSTEE_DELINQUENT_ZIP);
  const byParcel = new Map<string, DelinquentParcel>();
  let idx: ReturnType<typeof headerIndex> | null = null;
  let malformed = 0;
  let rows = 0;

  const minYear = String(Number(toDate.slice(0, 4)) - TAX_DELINQUENT_MAX_AGE_YEARS);

  parseCsvText(csv, (row, i) => {
    if (i === 0) {
      idx = headerIndex(row);
      return;
    }
    rows++;
    // ~1,300 of 55,217 rows are short/ragged in the county's export.
    if (row.length < 45) {
      malformed++;
      return;
    }
    const g = (name: string) => String(row[idx!(name)] ?? "").trim();

    // Map + Group + Parcel reconstitutes the assessor's TAX_MAP_NO ("146P K 002").
    const parcelId = [g("Map"), g("Group"), g("Parcel")].filter(Boolean).join(" ");
    const owner = g("Owner Name 1");
    const propertyAddress = g("Property Address");
    const year = g("Bill Year");
    if (!parcelId || !owner || !propertyAddress || !year) return;
    if (year < minYear) return;

    const owed =
      centsToAmount(g("Current County Owed")) +
      centsToAmount(g("Current Mun Owed")) +
      centsToAmount(g("Current Stw Owed"));

    const existing = byParcel.get(parcelId);
    if (existing) {
      existing.totalOwed += owed;
      existing.years.push(year);
      if (year > existing.newestYear) existing.newestYear = year;
      return;
    }
    byParcel.set(parcelId, {
      parcelId,
      owner,
      propertyAddress,
      mailStreet: g("Mail Addr 1").replace(/\s+/g, " ").trim(),
      mailLine2: g("Mail Addr 2"),
      newestYear: year,
      totalOwed: owed,
      years: [year],
    });
  });

  if (!rows) throw new Error("Hamilton TN Tax Delinquent: Trustee export returned no rows");

  const ranked = [...byParcel.values()].sort(
    (a, b) => (b.newestYear === a.newestYear ? b.totalOwed - a.totalOwed : b.newestYear.localeCompare(a.newestYear)),
  );
  const selected = ranked.slice(0, TAX_DELINQUENT_LIMIT);

  logger.info(
    {
      rows,
      malformed,
      parcels: ranked.length,
      emitted: selected.length,
      deferred: Math.max(0, ranked.length - selected.length),
      minYear,
    },
    "[TN] Trustee delinquent file read",
  );

  const leads: Lead[] = [];
  for (const p of selected) {
    if (isGovernmentOwner(p.owner)) continue;
    const mail = splitMailLine(p.mailLine2);
    leads.push({
      id: makeId(COUNTY, STATE, "Tax Delinquent", p.parcelId),
      county: COUNTY,
      state: STATE,
      lead_type: "Tax Delinquent",
      owner_name: p.owner,
      address: p.propertyAddress,
      city: "Chattanooga",
      zip: null,
      // The delinquent file carries mailing directly — no roll lookup needed, which
      // is why Tax Delinquent covers the whole county while the city-limits-only
      // datasets do not.
      mailing_address: p.mailStreet || null,
      mailing_city: mail.city,
      mailing_state: mail.state,
      mailing_zip: mail.zip,
      case_number: p.parcelId,
      filing_date: null,
      assessed_value: null,
      tax_year: p.newestYear,
      lender: null,
      loan_amount: null,
      sale_date: null,
      sale_amount: null,
      description:
        `Hamilton County TN Tax Delinquent — $${p.totalOwed.toFixed(2)} owed across ` +
        `${p.years.length} bill year(s), most recent ${p.newestYear}`,
      source_url: TRUSTEE_SOURCE,
      raw_data: JSON.stringify({
        parcelId: p.parcelId,
        years: [...new Set(p.years)].sort(),
        totalOwed: Number(p.totalOwed.toFixed(2)),
      }),
    });
  }
  return leads;
}

// ─── BANKRUPTCY — PACER RSS, Eastern District of Tennessee ───────────────────

const TNEB_RSS = "https://ecf.tneb.uscourts.gov/cgi-bin/rss_outside.pl";

/**
 * E.D. Tenn. spans four divisions; Hamilton County is the Chattanooga division,
 * whose case numbers are prefixed "1:". Filtering there keeps roll lookups bounded
 * (111 of 301 entries in a typical feed window) without losing local filings.
 */
export async function scrapeBankruptcy(fromDate: string, _toDate: string): Promise<Lead[]> {
  const res = await fetchWithRetry(TNEB_RSS);
  if (!res.ok) throw new Error(`Hamilton TN Bankruptcy: PACER RSS HTTP ${res.status}`);
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (!items.length) throw new Error("Hamilton TN Bankruptcy: PACER RSS returned no items");

  const parsed: Array<{ caseNum: string; caseName: string; link: string; pubDate: string }> = [];
  const seen = new Set<string>();

  for (const item of items) {
    const title = (
      item.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) || item.match(/<title>(.+?)<\/title>/)
    )?.[1]?.trim();
    if (!title || !title.startsWith("1:")) continue;

    const caseNum = title.match(/^(1:\d{2}-bk-\d+)/)?.[1] || "";
    const caseName = title
      .replace(/^1:\d{2}-bk-\d+-?\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!caseName || caseName.length < 4) continue;

    const key = `${caseNum}|${caseName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    parsed.push({
      caseNum,
      caseName,
      link: item.match(/<link>(.+?)<\/link>/)?.[1]?.trim() || TNEB_RSS,
      pubDate: item.match(/<pubDate>(.+?)<\/pubDate>/)?.[1]?.trim() || "",
    });
  }

  const leads: Lead[] = [];
  const emitted = new Set<string>();
  for (let i = 0; i < parsed.length; i += NAME_LOOKUP_CONCURRENCY) {
    const batch = parsed.slice(i, i + NAME_LOOKUP_CONCURRENCY);
    const results = await Promise.all(
      batch.map((b) => lookupOwnerProperties(b.caseName, COUNTY, STATE).catch(() => [])),
    );
    for (let j = 0; j < batch.length; j++) {
      const { caseNum, caseName, link, pubDate } = batch[j];
      for (const prop of results[j]) {
        if (!prop.address || isGovernmentOwner(prop.ownerName)) continue;
        // Surname-only roll hits fan one debtor out across unrelated families.
        if (!personMatchesOwner(caseName, prop.ownerName)) continue;
        const id = makeId(COUNTY, STATE, "Bankruptcy", `${caseNum}-${prop.address}`);
        if (emitted.has(id)) continue;
        emitted.add(id);
        leads.push({
          id,
          county: COUNTY,
          state: STATE,
          lead_type: "Bankruptcy",
          owner_name: prop.ownerName || caseName,
          address: prop.address,
          city: prop.city || "Chattanooga",
          zip: prop.zip || null,
          mailing_address: prop.mailingAddress || null,
          mailing_city: prop.mailingCity || null,
          mailing_state: prop.mailingState || null,
          mailing_zip: prop.mailingZip || null,
          case_number: caseNum || null,
          filing_date: pubDate
            ? formatDate(new Date(pubDate).toISOString().slice(0, 10))
            : formatDate(fromDate),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Hamilton County TN Bankruptcy — ${caseName}${caseNum ? ` (${caseNum})` : ""}`,
          source_url: link,
          raw_data: JSON.stringify({ caseNum, caseName, pubDate, parcelId: prop.parcelId }),
        });
      }
    }
  }
  return leads;
}

// ─── OBITUARY — Google News RSS ──────────────────────────────────────────────

/**
 * The ChattaData "Chattanooga Obituary Index" is a library history index that
 * stops at 2024-12-31, and both legacy.com and obituaries.timesfreepress.com are
 * Cloudflare-walled. Google News RSS surfaces the same funeral-home notices and is
 * the fallback ohio.ts already relies on.
 */
const OBIT_FEEDS = [
  "https://news.google.com/rss/search?q=Chattanooga+Tennessee+obituaries&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Hamilton+County+Tennessee+obituary+Chattanooga&hl=en-US&gl=US&ceid=US:en",
];

/** "Chad Young Obituary - Chattanooga, TN - Dignity Memorial" → "Chad Young". */
function decedentFromTitle(title: string): string | null {
  const cleaned = title.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const m =
    cleaned.match(/^(.+?)\s+Obituary\b/i) ||
    cleaned.match(/^Obituary (?:information )?for\s+(.+?)(?:\s+[-–|]|$)/i);
  const name = m?.[1]?.replace(/[",]/g, "").trim();
  if (!name || name.length < 5 || name.split(/\s+/).length < 2) return null;
  if (/\b(county|city|jail|police|school|hospital|department)\b/i.test(name)) return null;
  return name;
}

export async function scrapeObituaries(fromDate: string, _toDate: string): Promise<Lead[]> {
  const names = new Map<string, { link: string; pubDate: string }>();
  let okFeeds = 0;

  for (const feed of OBIT_FEEDS) {
    try {
      const res = await fetchWithRetry(feed);
      if (!res.ok) continue;
      okFeeds++;
      const xml = await res.text();
      for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
        const title = (
          item.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) || item.match(/<title>(.+?)<\/title>/)
        )?.[1]?.trim();
        if (!title) continue;
        const name = decedentFromTitle(title);
        if (!name || names.has(name.toUpperCase())) continue;
        names.set(name.toUpperCase(), {
          link: item.match(/<link>(.+?)<\/link>/)?.[1]?.trim() || feed,
          pubDate: item.match(/<pubDate>(.+?)<\/pubDate>/)?.[1]?.trim() || "",
        });
      }
    } catch (e) {
      logger.warn({ feed, err: (e as Error).message }, "[TN] Obituary feed failed");
    }
  }
  if (!okFeeds) throw new Error("Hamilton TN Obituary: every news feed unreachable");

  const entries = [...names.entries()];
  const leads: Lead[] = [];
  const emitted = new Set<string>();

  for (let i = 0; i < entries.length; i += NAME_LOOKUP_CONCURRENCY) {
    const batch = entries.slice(i, i + NAME_LOOKUP_CONCURRENCY);
    const results = await Promise.all(
      batch.map(([name]) => lookupOwnerProperties(name, COUNTY, STATE).catch(() => [])),
    );
    for (let j = 0; j < batch.length; j++) {
      const [nameKey, meta] = batch[j];
      for (const prop of results[j]) {
        if (!prop.address || isGovernmentOwner(prop.ownerName)) continue;
        if (!personMatchesOwner(nameKey, prop.ownerName)) continue;
        const id = makeId(COUNTY, STATE, "Obituary", `${nameKey}-${prop.address}`);
        if (emitted.has(id)) continue;
        emitted.add(id);
        leads.push({
          id,
          county: COUNTY,
          state: STATE,
          lead_type: "Obituary",
          owner_name: prop.ownerName || nameKey,
          address: prop.address,
          city: prop.city || "Chattanooga",
          zip: prop.zip || null,
          mailing_address: prop.mailingAddress || null,
          mailing_city: prop.mailingCity || null,
          mailing_state: prop.mailingState || null,
          mailing_zip: prop.mailingZip || null,
          case_number: null,
          filing_date: meta.pubDate
            ? formatDate(new Date(meta.pubDate).toISOString().slice(0, 10))
            : formatDate(fromDate),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: null,
          sale_amount: null,
          description: `Hamilton County TN Obituary — ${nameKey} owned property in the county`,
          source_url: meta.link,
          raw_data: JSON.stringify({ decedent: nameKey, parcelId: prop.parcelId }),
        });
      }
    }
  }
  return leads;
}

// ─── DISPATCH ────────────────────────────────────────────────────────────────

export async function scrapeTennessee(
  county: string,
  fromDate: string,
  toDate: string,
  leadTypes?: string[],
  scraperErrors?: string[],
): Promise<Lead[]> {
  if (county !== "Hamilton") {
    logger.info({ county }, "[TN] no scraper registered for county");
    return [];
  }

  const runners: Record<string, () => Promise<Lead[]>> = {
    "Tax Delinquent": () => scrapeTaxDelinquent(fromDate, toDate),
    "Pre-Foreclosure": () => scrapeForeclosures(fromDate, toDate),
    Probate: () => scrapeProbate(fromDate, toDate),
    Divorce: () => scrapeDivorce(fromDate, toDate),
    "Code Violation": () => scrapeCodeViolations(fromDate, toDate),
    "Vacant/Abandoned": () => scrapeVacantAbandoned(fromDate, toDate),
    "Fire Damage": () => scrapeFireDamage(fromDate, toDate),
    Bankruptcy: () => scrapeBankruptcy(fromDate, toDate),
    Obituary: () => scrapeObituaries(fromDate, toDate),
    FSBO: () => scrapeFsbo(COUNTY, STATE, fromDate, toDate),
  };

  const types = leadTypes?.length ? leadTypes : Object.keys(runners);
  const entries = types.map((t) => [t, runners[t]] as const).filter(([, fn]) => Boolean(fn));
  const results = await Promise.allSettled(entries.map(([, fn]) => fn!()));

  return settleScraperResults(
    results,
    entries.map(([t]) => `${county} TN ${t}`),
    scraperErrors,
  );
}
