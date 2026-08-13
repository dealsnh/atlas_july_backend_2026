// @ts-nocheck
/**
 * Hamilton County TN court + legal-notice scrapers.
 *
 *   Pre-Foreclosure — Hamilton County Herald public notices (the county's legal
 *                     newspaper). Tennessee is a NON-JUDICIAL / deed-of-trust
 *                     state, so the recorded substitute trustee's notice of sale
 *                     IS the pre-foreclosure record. There is no judicial
 *                     foreclosure docket to scrape and no separately recorded
 *                     notice of default — which is why "Notice of Trustee Sale"
 *                     and "Notice of Default" both alias onto Pre-Foreclosure for
 *                     TN exactly as they do for MO and AL.
 *
 *   Probate         — Chancery Court dockets (PDF). In Hamilton County TN probate
 *                     is heard in Chancery, and estates appear on the docket as
 *                     "IN THE MATTER OF THE ESTATE OF: <decedent>" with a "NN-P
 *                     NNN" case number.
 *
 *   Divorce         — Circuit Court daily/motion dockets (PDF). Domestic cases
 *                     carry a "NNDNNNN" case number.
 *
 * The Herald notice carries a full property address and parcel id, so foreclosure
 * leads are complete without a roll lookup. Court dockets carry names only, so
 * probate/divorce leads are enriched by owner-name lookup against the parcel roll
 * and dropped when the party owns nothing in the county.
 */

import { PDFParse } from "pdf-parse";
import { Lead, makeId, formatDate, fetchWithRetry, fetchBlockedPage, courtCaseToLead } from "./base.js";
import { lookupOwnerProperties, lookupByParcel, lookupByAddress, isGovernmentOwner } from "./assessor.js";
import { logger } from "../utils/logger.js";

const COUNTY = "Hamilton";
const STATE = "TN";

const HERALD = "https://hamiltoncountyherald.com";
const CHANCERY_DOCKETS = "https://www.hamiltontn.gov/ChanceryCourt_Dockets.aspx";
const CIRCUIT_BASE = "https://www.hamiltontn.gov/CircuitClerkDockets";

/** Circuit Court publishes four divisions, each with a daily and a motion docket. */
const CIRCUIT_DOCKETS = [
  "Daily1.pdf",
  "Daily2.pdf",
  "Daily3.pdf",
  "Daily4.pdf",
  "MOTION1.pdf",
  "MOTION2.pdf",
  "MOTION3.pdf",
  "MOTION4.pdf",
];

const NAME_LOOKUP_CONCURRENCY = 5;
const NAME_LOOKUP_CAP = 120;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function pdfText(url: string): Promise<string> {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`PDF fetch failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

// ─── PRE-FORECLOSURE — Hamilton County Herald public notices ──────────────────

/** The Herald publishes weekly (Fridays); off-days return an empty notice list. */
function datesInWindow(fromDate: string, toDate: string, maxDays: number): string[] {
  const out: string[] = [];
  const end = new Date(`${toDate}T00:00:00Z`);
  const start = new Date(`${fromDate}T00:00:00Z`);
  for (let d = new Date(end); d >= start && out.length < maxDays; d.setUTCDate(d.getUTCDate() - 1)) {
    out.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`);
  }
  return out;
}

/**
 * The notice index renders category headings and OpenChild('id','date') links in
 * document order, with no id→category attribute to key on. Walking both in
 * position order and carrying the last-seen heading is the only way to tell a
 * foreclosure notice from a bid notice. Ids repeat (title + view link), so first
 * occurrence wins.
 */
function foreclosureNoticeIds(html: string): string[] {
  const markers: Array<{ pos: number; kind: "cat" | "id"; value: string }> = [];
  for (const m of html.matchAll(/>(Foreclosures|Miscellaneous|Courts|Bids)</g)) {
    markers.push({ pos: m.index!, kind: "cat", value: m[1] });
  }
  for (const m of html.matchAll(/OpenChild\('(\d+)'/g)) {
    markers.push({ pos: m.index!, kind: "id", value: m[1] });
  }
  markers.sort((a, b) => a.pos - b.pos);

  const ids: string[] = [];
  const seen = new Set<string>();
  let current = "";
  for (const mk of markers) {
    if (mk.kind === "cat") current = mk.value;
    else if (current === "Foreclosures" && !seen.has(mk.value)) {
      seen.add(mk.value);
      ids.push(mk.value);
    }
  }
  return ids;
}

/** Notices open with a labelled summary block: "Borrower: X Address: Y ...". */
function noticeField(text: string, label: string, stopLabels: string[]): string {
  const stop = stopLabels.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`${label}\\s*:\\s*(.*?)\\s*(?=${stop}\\s*:|$)`, "i");
  return text.match(re)?.[1]?.trim() || "";
}

const NOTICE_LABELS = [
  "Borrower",
  "Address",
  "Original Trustee",
  "Attorney",
  "Instrument No",
  "Substitute Trustee",
  "Advertised Auction Date",
  "Date of First Public Notice",
  "Trust Date",
  "DR No",
  "NOTICE",
];

/**
 * Hamilton County municipalities and CDPs, longest first so "Soddy Daisy" wins
 * over a bare "Daisy" and "Lookout Mountain" over "Mountain".
 */
const HAMILTON_TN_CITIES = [
  "Lookout Mountain",
  "Signal Mountain",
  "Walden's Ridge",
  "Soddy Daisy",
  "Soddy-Daisy",
  "East Ridge",
  "Red Bank",
  "Lupton City",
  "Sale Creek",
  "Collegedale",
  "Chattanooga",
  "Georgetown",
  "Birchwood",
  "Ooltewah",
  "Harrison",
  "Ridgeside",
  "Hixson",
  "Apison",
  "Walden",
].sort((a, b) => b.length - a.length);

/**
 * "116 Dolores Dr Hixson, TN 37343" → street / city / zip.
 *
 * The notice prints "<street> <city>, TN <zip>" with NO comma before the city, so
 * there is no delimiter to split on — a positional guess mis-parses "116 Dolores
 * Dr Hixson" into street "116" / city "Dolores Dr Hixson". Matching a known city
 * off the end of the pre-comma text is the only reliable split.
 */
function splitNoticeAddress(raw: string): { street: string; city: string | null; zip: string | null } {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const zip = cleaned.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || null;

  // Drop the ", TN 37343" tail (state may be absent on some notices).
  const head = cleaned
    .replace(/,?\s*\b(TN|TENNESSEE)\b\.?\s*\d{5}(-\d{4})?\s*$/i, "")
    .replace(/,?\s*\d{5}(-\d{4})?\s*$/, "")
    .replace(/,\s*$/, "")
    .trim();

  for (const city of HAMILTON_TN_CITIES) {
    const re = new RegExp(`[,\\s]+${city.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}$`, "i");
    if (re.test(head)) {
      return { street: head.replace(re, "").trim(), city, zip };
    }
  }
  // Unknown city — keep the whole line as the street rather than inventing a split.
  return { street: head.replace(/,\s*[A-Za-z .'-]+$/, "").trim() || head, city: null, zip };
}

export async function scrapeForeclosures(fromDate: string, toDate: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  const dates = datesInWindow(fromDate, toDate, 45);
  let indexesRead = 0;

  for (const date of dates) {
    const encoded = encodeURIComponent(date);
    let html = "";
    try {
      html = await fetchBlockedPage(`${HERALD}/PublicNotices.aspx?date=${encoded}`);
    } catch (e) {
      logger.warn({ date, err: (e as Error).message }, "[TN] Herald notice index failed");
      continue;
    }
    if (!html) continue;
    indexesRead++;

    const ids = foreclosureNoticeIds(html);
    for (const id of ids) {
      try {
        const detail = await fetchBlockedPage(`${HERALD}/ViewNotice.aspx?id=${id}&date=${encoded}`);
        if (!detail) continue;
        const text = stripTags(detail);

        const borrower = noticeField(text, "Borrower", NOTICE_LABELS);
        const addressRaw = noticeField(text, "Address", NOTICE_LABELS);
        if (!borrower && !addressRaw) continue;

        const { street, city, zip } = splitNoticeAddress(addressRaw);
        if (!street) continue;

        const auctionDate = noticeField(text, "Advertised Auction Date", NOTICE_LABELS);
        const firstNotice = noticeField(text, "Date of First Public Notice", NOTICE_LABELS);
        const trustee = noticeField(text, "Substitute Trustee", NOTICE_LABELS);
        const attorney = noticeField(text, "Attorney", NOTICE_LABELS);
        const instrument = noticeField(text, "Instrument No", NOTICE_LABELS);
        const parcelId = text.match(/Parcel\s*ID\s*:?\s*([0-9A-Z]{2,4}[A-Z]?\s+[A-Z]\s+[0-9.]+)/i)?.[1] || null;

        // The notice already carries owner + situs; the roll adds the mailing
        // address, which the notice never prints. Try the parcel id first (exact),
        // then the situs address — the parcel layer covers city limits only, so
        // neither will resolve for a Signal Mountain or unincorporated property and
        // the lead is still emitted with the notice's own owner + address.
        let prop = parcelId ? await lookupByParcel(COUNTY, STATE, parcelId).catch(() => null) : null;
        if (!prop?.mailingAddress) {
          prop = (await lookupByAddress(street, COUNTY, STATE).catch(() => null)) || prop;
        }

        leads.push({
          id: makeId(COUNTY, STATE, "Pre-Foreclosure", instrument || `${id}-${street}`),
          county: COUNTY,
          state: STATE,
          lead_type: "Pre-Foreclosure",
          owner_name: borrower || prop?.ownerName || null,
          address: street,
          city: city || prop?.city || "Chattanooga",
          zip: zip || prop?.zip || null,
          mailing_address: prop?.mailingAddress || null,
          mailing_city: prop?.mailingCity || null,
          mailing_state: prop?.mailingState || null,
          mailing_zip: prop?.mailingZip || null,
          case_number: instrument || parcelId || null,
          filing_date: formatDate(firstNotice) || formatDate(date),
          assessed_value: null,
          tax_year: null,
          lender: null,
          loan_amount: null,
          sale_date: formatDate(auctionDate),
          sale_amount: null,
          description:
            `Hamilton County TN Pre-Foreclosure — substitute trustee's sale` +
            (auctionDate ? ` set ${auctionDate}` : "") +
            (trustee ? ` (${trustee})` : ""),
          source_url: `${HERALD}/ViewNotice.aspx?id=${id}&date=${encoded}`,
          raw_data: JSON.stringify({
            borrower,
            addressRaw,
            trustee,
            attorney,
            instrument,
            parcelId,
            auctionDate,
            firstNotice,
            noticeId: id,
          }),
        });
      } catch (e) {
        logger.warn({ id, err: (e as Error).message }, "[TN] Herald notice detail failed");
      }
    }
  }

  if (indexesRead === 0) {
    throw new Error("Hamilton TN Pre-Foreclosure: Herald notice index unreachable for every date");
  }
  return leads;
}

// ─── PROBATE — Chancery Court dockets ────────────────────────────────────────

const ESTATE_MARKER = /IN THE MATTER OF THE ESTATE OF/i;

interface Estate {
  name: string;
  caseNumber: string;
}

/**
 * Docket text renders each estate as:
 *     15-P
 *     762
 *     IN THE MATTER OF THE ESTATE OF:
 *     LOUIS E. McDONALD
 * so the decedent is the next non-empty line and the case number is the nearest
 * "NN-P" above it (its numeric half is on the following line).
 */
function parseEstates(text: string): Estate[] {
  const lines = text.split("\n").map((l) => l.trim());
  const out: Estate[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!ESTATE_MARKER.test(lines[i])) continue;

    // Decedent name: next non-empty line that is not another label.
    let name = "";
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const l = lines[j];
      if (!l || /^(DISPOSITION|MOTION|IN RE)\b/i.test(l)) continue;
      name = l.replace(/[,:]+$/, "").trim();
      break;
    }
    if (!name || name.length < 4) continue;

    let caseNumber = "";
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const m = lines[j].match(/^(\d{2}-P)$/i);
      if (m) {
        const num = lines[j + 1]?.match(/^(\d{2,4})$/)?.[1] || "";
        caseNumber = `${m[1].toUpperCase()}${num}`;
        break;
      }
      const inline = lines[j].match(/^(\d{2}-P\s*\d{2,4})$/i);
      if (inline) {
        caseNumber = inline[1].replace(/\s+/g, "").toUpperCase();
        break;
      }
    }
    out.push({ name, caseNumber });
  }
  return out;
}

async function chanceryDocketUrls(): Promise<string[]> {
  const res = await fetchWithRetry(CHANCERY_DOCKETS);
  if (!res.ok) throw new Error(`Chancery docket page HTTP ${res.status}`);
  const html = await res.text();
  const urls = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*pdf\/courts\/Chancery\/data\/[^"]+\.pdf)"/gi)) {
    const href = m[1].startsWith("http") ? m[1] : `https://www.hamiltontn.gov/${m[1].replace(/^\//, "")}`;
    urls.add(href);
  }
  return [...urls];
}

/** Name noise that must not count as a matching token. */
const NAME_STOPWORDS = new Set([
  "JR", "SR", "II", "III", "IV", "V", "MR", "MRS", "MS", "DR", "THE", "AND", "ETAL",
  "ET", "AL", "ESTATE", "OF", "TRUST", "TRUSTEE", "TR", "LLC", "INC", "LP", "LLP", "CO",
]);

/** Entity names that can never be the natural person named on a docket. */
const ORG_OWNER_RE =
  /\b(COUNTY|CITY OF|STATE OF|TENNESSEE|MUNICIPAL|BOARD|AUTHORITY|DEPARTMENT|DEPT|COMMISSION|ASSOCIATION|CHURCH|SCHOOL|BANK|CREDIT UNION|LLC|L\.L\.C|INC|CORP|COMPANY|PARTNERS|HOLDINGS|PROPERTIES|ENTERPRISES)\b/i;

function nameTokens(name: string): string[] {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NAME_STOPWORDS.has(t));
}

/**
 * True when a roll owner plausibly IS the named party.
 *
 * lookupOwnerProperties queries the roll with `LIKE '%<surname>%'` and returns up
 * to five hits, which for a common surname is mostly other families: the estate of
 * "LOUIS E. McDONALD" was matching DAVID, PERRY and JACQUELINE MCDONALD, and a
 * single bankruptcy debtor was fanning out into dozens of unrelated parcels. A
 * surname alone is not identification, so require the surname AND at least one
 * given name to appear in the owner-of-record string. Owner records are stored
 * "LAST FIRST MIDDLE" while dockets print "FIRST MIDDLE LAST", so the check is
 * token containment rather than positional.
 */
export function personMatchesOwner(personName: string, ownerName: string | null | undefined): boolean {
  const person = nameTokens(personName);
  const owner = new Set(nameTokens(ownerName || ""));
  if (person.length < 2 || owner.size === 0) return false;

  // A government/organisation record is never the natural person on the docket.
  // isGovernmentOwner catches "COUNTY OF X" but not "HAMILTON COUNTY TENNESSEE".
  if (ORG_OWNER_RE.test(personName) || ORG_OWNER_RE.test(ownerName || "")) return false;

  // Dockets and news headlines are "FIRST … LAST"; the surname is the last token.
  const surname = person[person.length - 1];
  if (!owner.has(surname)) return false;

  // Given names only — a joint filing ("Cornelius Ridley and Annie Ridley") repeats
  // the surname, and counting that repeat as a given-name match would let every
  // other Ridley on the roll through on surname alone.
  const given = person.slice(0, -1).filter((t) => t !== surname);
  return given.some((t) => owner.has(t));
}

/**
 * Shared tail for the two docket-driven types: names → roll → leads.
 * A party who owns no Hamilton County property is not a real estate lead, so
 * non-matching names are dropped rather than saved without an address.
 */
async function leadsFromNames(
  entries: Array<{ name: string; caseNumber: string; sourceUrl: string }>,
  leadType: string,
  filedDate: string,
  describe: (name: string, caseNumber: string) => string,
): Promise<Lead[]> {
  const leads: Lead[] = [];
  const seenIds = new Set<string>();
  const capped = entries.slice(0, NAME_LOOKUP_CAP);

  for (let i = 0; i < capped.length; i += NAME_LOOKUP_CONCURRENCY) {
    const batch = capped.slice(i, i + NAME_LOOKUP_CONCURRENCY);
    const results = await Promise.all(
      batch.map((e) => lookupOwnerProperties(e.name, COUNTY, STATE).catch(() => [])),
    );
    for (let j = 0; j < batch.length; j++) {
      const { name, caseNumber, sourceUrl } = batch[j];
      for (const prop of results[j]) {
        if (!prop.address || isGovernmentOwner(prop.ownerName)) continue;
        if (!personMatchesOwner(name, prop.ownerName)) continue;
        const lead = courtCaseToLead({
          county: COUNTY,
          state: STATE,
          leadType,
          caseNum: caseNumber,
          caseName: name,
          filedDate,
          sourceUrl,
          city: "Chattanooga",
          prop: {
            address: prop.address,
            city: prop.city,
            zip: prop.zip,
            parcelId: prop.parcelId,
            ownerName: prop.ownerName,
            mailingAddress: prop.mailingAddress,
            mailingCity: prop.mailingCity,
            mailingState: prop.mailingState,
            mailingZip: prop.mailingZip,
          },
        });
        lead.description = describe(name, caseNumber);
        if (seenIds.has(lead.id)) continue;
        seenIds.add(lead.id);
        leads.push(lead);
      }
    }
  }
  return leads;
}

export async function scrapeProbate(fromDate: string, _toDate: string): Promise<Lead[]> {
  const urls = await chanceryDocketUrls();
  if (!urls.length) throw new Error("Hamilton TN Probate: no Chancery docket PDFs linked");

  const entries: Array<{ name: string; caseNumber: string; sourceUrl: string }> = [];
  const seen = new Set<string>();
  let parsed = 0;

  for (const url of urls) {
    try {
      const text = await pdfText(url);
      parsed++;
      for (const e of parseEstates(text)) {
        const key = `${e.caseNumber}|${e.name}`.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ name: e.name, caseNumber: e.caseNumber, sourceUrl: url });
      }
    } catch (e) {
      logger.warn({ url, err: (e as Error).message }, "[TN] Chancery docket parse failed");
    }
  }
  if (!parsed) throw new Error("Hamilton TN Probate: every Chancery docket PDF failed to parse");

  logger.info({ dockets: urls.length, estates: entries.length }, "[TN] Chancery estates found");
  return leadsFromNames(
    entries,
    "Probate",
    fromDate,
    (name, caseNumber) =>
      `Hamilton County TN Probate — estate of ${name}${caseNumber ? ` (case ${caseNumber})` : ""}`,
  );
}

// ─── DIVORCE — Circuit Court dockets ─────────────────────────────────────────

const CASE_RE = /\b(\d{2}D\d{3,5})\b/g;
const NON_NAME_RE =
  /^(VS|PRO SE|DISPOSITION|CASE NO|ATTORNEY|STYLE OF CASE|COMMENT|SERVICE|JUDGE|PAGE NO|FIRST COURT|SECOND COURT|THIRD COURT|FOURTH COURT|[-\s]+)$/i;

/** Party lines are ALL-CAPS names; strip the attorney prefix and service flag. */
function partyNames(block: string): string[] {
  const names: string[] = [];
  for (let raw of block.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^\d+\.\s*/, "").replace(/\b\d{2}D\d{3,5}\b/g, "");
    line = line.replace(/^\s*PRO SE\s*,?\s*/i, "").replace(/^[A-Z& ]+(?:LAW|PLLC|LLC|P\.?C\.?)\s*,?\s*/i, "");
    line = line.replace(/\s+[A-Z]$/, "").replace(/[-]{3,}/g, "").trim();
    if (!line || line.length < 5 || NON_NAME_RE.test(line)) continue;
    if (!/^[A-Z][A-Z .,'\-]{4,60}$/.test(line)) continue;
    if (!/[A-Z]{2,}\s+[A-Z]{2,}/.test(line)) continue;
    names.push(line.replace(/\s+/g, " ").trim());
  }
  return [...new Set(names)];
}

export async function scrapeDivorce(fromDate: string, _toDate: string): Promise<Lead[]> {
  const entries: Array<{ name: string; caseNumber: string; sourceUrl: string }> = [];
  const seen = new Set<string>();
  let parsed = 0;

  for (const file of CIRCUIT_DOCKETS) {
    const url = `${CIRCUIT_BASE}/${file}`;
    let text = "";
    try {
      text = await pdfText(url);
      parsed++;
    } catch (e) {
      logger.warn({ url, err: (e as Error).message }, "[TN] Circuit docket parse failed");
      continue;
    }

    // Slice the text into per-case blocks keyed on the domestic case number.
    const positions: Array<{ caseNumber: string; start: number }> = [];
    for (const m of text.matchAll(CASE_RE)) {
      positions.push({ caseNumber: m[1], start: m.index! });
    }
    for (let i = 0; i < positions.length; i++) {
      const block = text.slice(positions[i].start, positions[i + 1]?.start ?? text.length);
      for (const name of partyNames(block)) {
        const key = `${positions[i].caseNumber}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ name, caseNumber: positions[i].caseNumber, sourceUrl: url });
      }
    }
  }

  if (!parsed) throw new Error("Hamilton TN Divorce: every Circuit docket PDF failed to parse");
  logger.info({ parties: entries.length }, "[TN] Circuit domestic parties found");

  return leadsFromNames(
    entries,
    "Divorce",
    fromDate,
    (name, caseNumber) =>
      `Hamilton County TN Divorce — Circuit Court domestic case ${caseNumber} (${name})`,
  );
}
