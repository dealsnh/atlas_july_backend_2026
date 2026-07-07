// @ts-nocheck
import { spawnSync } from "child_process";
import { createHash } from "crypto";

export interface Lead {
  id: string;
  county: string;
  state: string;
  lead_type: string;
  owner_name: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  case_number: string | null;
  filing_date: string | null;
  assessed_value: string | null;
  tax_year: string | null;
  lender: string | null;
  loan_amount: string | null;
  sale_date: string | null;
  sale_amount: string | null;
  description: string | null;
  source_url: string | null;
  raw_data: string | null;
}

export function makeId(...parts: (string | null | undefined)[]): string {
  return createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 16);
}

export function formatDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) return d;
  return parsed.toISOString().split("T")[0];
}

/** Convert YYYY-MM-DD (API dates) to MM/DD/YYYY for MO Case.net and AlaCourt. */
export function toUsDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return isoDate;
  return `${m}/${d}/${y}`;
}

// URLs that should NEVER go through ScraperAPI
const SKIP_SCRAPER_PATTERNS = [
  "uscourts.gov", // PACER — requires court auth
  "craigslist.org", // Craigslist — blocks ScraperAPI too
  "scraperapi.com", // Already proxied
  "api.scraperapi", // Already proxied
  "opendata.", // Open data APIs
  "data.kcmo.org/resource/", // KCMO Socrata — no bot blocking, direct is fine
  "data.cincinnati-oh.gov/", // Cincinnati open data — direct JSON
  "16thcircuit.org/", // Jackson MO delinquent land tax — direct ASP pages
  "hcauditor.org", // Hamilton OH auditor XLSX + wedge property search
  "madisontc.com", // NOTE: this is Madison County FLORIDA — disabled as an AL source (see alabama.ts)
  "sheriffclayco.org", // Clay MO sheriff property sales
  "claycountymo.tax", // Clay MO collector tax sale
  "plattecountycollector.com", // Platte MO collector — weak TLS; use fetchBlockedPage
  "casscounty.com", // Cass MO
  "capturecama.com", // AL CaptureCAMA JSON APIs — direct POST works
  "rubinlublin.com", // AL statewide foreclosure listings (legacy)
  "rlselaw.com", // Rubin Lublin AL property listings
  "jeffcointouch.com", // Jefferson AL portal
  "data.birminghamal.gov", // Jefferson vacant structures
  ".arcgis.com", // all Esri ArcGIS Online SaaS feature services — open APIs, fetch direct
  "arcgis/rest/services", // on-prem ArcGIS REST queries
  "kcsgis.com", // Montgomery County AL Revenue self-hosted KCS GIS — direct JSON
  "countygovservices.com", // Madison County AL AssuranceWeb — direct HTML/session
  "rss_outside", // PACER RSS — requires direct (no ScraperAPI)
  "ecf.oh", // PACER Ohio — direct RSS works
];

function shouldSkipScraperAPI(url: string): boolean {
  return SKIP_SCRAPER_PATTERNS.some((p) => url.includes(p));
}

/**
 * fetchWithRetry — standard HTML fetch, routes through ScraperAPI for
 * government/county sites that block server IPs (403/timeout).
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
): Promise<Response> {
  const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
  const useProxy = !!SCRAPER_KEY && !shouldSkipScraperAPI(url);
  const fetchUrl = useProxy
    ? `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=false`
    : url;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...options.headers,
  };

  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s — ScraperAPI can be slow
      let res: Response;
      try {
        res = await fetch(fetchUrl, { ...options, headers, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (res.ok || res.status === 404) return res;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`Failed after ${retries} retries: ${url}`);
}

/**
 * fetchRendered — uses ScraperAPI with render=true for JavaScript-heavy pages
 * (e.g. React/Angular portals like RealAuction, some county sheriff sites).
 * Falls back to regular fetch if no ScraperAPI key.
 */
export async function fetchRendered(url: string, retries = 2): Promise<Response> {
  const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
  if (!SCRAPER_KEY) {
    return fetchWithRetry(url, {}, retries);
  }
  const fetchUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=true`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  };
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000); // rendered pages take longer
      let res: Response;
      try {
        res = await fetch(fetchUrl, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (res.ok || res.status === 404) return res;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
        continue;
      }
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error(`fetchRendered failed after ${retries} retries: ${url}`);
}

function looksBlocked(html: string): boolean {
  if (!html || html.length < 150) return true;
  return /403 Forbidden|Error 403|Access Denied|data scraper|expressly prohibited|cf-browser-verification|Just a moment|captcha|g-recaptcha|login required|please sign in|session expired|enable javascript|frmlogin\.aspx/i.test(
    html,
  );
}

/** Detect empty, blocked, or login-wall HTML; log and return reason when invalid. */
export function validateHtmlResponse(
  html: string,
  label: string,
  minLength = 200,
): { ok: boolean; reason?: string } {
  if (!html || html.trim().length < minLength) {
    const reason = `${label}: empty or too-short response (${html?.length ?? 0} bytes)`;
    console.warn(`[validateHtml] ${reason}`);
    return { ok: false, reason };
  }
  if (looksBlocked(html)) {
    const reason = `${label}: blocked, CAPTCHA, or login page detected`;
    console.warn(`[validateHtml] ${reason}`);
    return { ok: false, reason };
  }
  return { ok: true };
}

export interface CourtCaseLeadOpts {
  county: string;
  state: string;
  leadType: string;
  caseNum: string;
  caseName: string;
  filedDate: string;
  sourceUrl: string;
  city?: string | null;
  prop?: {
    address?: string;
    city?: string;
    zip?: string;
    parcelId?: string;
    ownerName?: string;
    mailingAddress?: string;
    mailingCity?: string;
    mailingState?: string;
    mailingZip?: string;
  } | null;
}

/** Court case lead — always emitted; assessor match enriches when available. */
export function courtCaseToLead(opts: CourtCaseLeadOpts): Lead {
  const { county, state, leadType, caseNum, caseName, filedDate, sourceUrl, city, prop } = opts;
  const addr = prop?.address || null;
  return {
    id: makeId(county, state, leadType, `${caseNum}-${addr || caseName}`),
    county,
    state,
    lead_type: leadType,
    owner_name: prop?.ownerName || caseName || null,
    address: addr,
    city: prop?.city || city || null,
    zip: prop?.zip || null,
    mailing_address: prop?.mailingAddress || null,
    mailing_city: prop?.mailingCity || null,
    mailing_state: prop?.mailingState || null,
    mailing_zip: prop?.mailingZip || null,
    case_number: caseNum || null,
    filing_date: formatDate(filedDate),
    assessed_value: null,
    tax_year: null,
    lender: null,
    loan_amount: null,
    sale_date: null,
    sale_amount: null,
    description: `${county} County ${state} ${leadType} — ${caseName || caseNum}`,
    source_url: sourceUrl,
    raw_data: JSON.stringify({
      caseNum,
      caseName,
      filedDate,
      parcelId: prop?.parcelId,
    }),
  };
}

function fetchViaBrightDataCurl(url: string, options: RequestInit = {}): string {
  const user = process.env.BRIGHT_DATA_USER;
  const pass = process.env.BRIGHT_DATA_PASS;
  if (!user || !pass) return "";

  const args = [
    "-sSL",
    "--max-time",
    "45",
    "-x",
    `http://${user}:${pass}@brd.superproxy.io:22225`,
    "-H",
    "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "-H",
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  ];
  if (options.method === "POST" && options.body) {
    args.push(
      "-X",
      "POST",
      "-H",
      "Content-Type: application/x-www-form-urlencoded",
      "--data",
      String(options.body),
    );
  }
  args.push(url);

  const result = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 12 * 1024 * 1024 });
  return result.stdout || "";
}

function needsResidentialProxy(url: string): boolean {
  return (
    url.includes("craigslist.org") ||
    url.includes("plattesheriff.org") ||
    url.includes("plattecountycollector.com") ||
    url.includes("courts.mo.gov/casenet") ||
    url.includes("v2.alacourt.com") ||
    url.includes("probatect.org")
  );
}

/**
 * fetchBlockedPage — direct fetch, then ScraperAPI proxy + render for sites that
 * block datacenter IPs (e.g. Platte sheriff, Craigslist on Railway).
 * Craigslist + Platte + Case.net try Bright Data residential proxy first.
 */
export async function fetchBlockedPage(url: string, options: RequestInit = {}): Promise<string> {
  const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
  const isCraigslist = url.includes("craigslist.org");
  let html = "";
  let lastReason = "empty";

  if (needsResidentialProxy(url)) {
    const bright = fetchViaBrightDataCurl(url, options);
    if (bright && !looksBlocked(bright)) return bright;
    if (bright) lastReason = "bright_data_blocked";
  }

  try {
    const res = await fetchWithRetry(url, options);
    if (res.ok) html = await res.text();
    else lastReason = `http_${res.status}`;
  } catch {
    lastReason = "direct_fetch_failed";
  }
  if (html && !looksBlocked(html)) return html;
  if (html && looksBlocked(html)) lastReason = "direct_blocked";

  if (SCRAPER_KEY) {
    try {
      const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=false`;
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(options.headers as Record<string, string>),
      };
      const init: RequestInit = { headers, signal: AbortSignal.timeout(60000) };
      if (options.method && options.method !== "GET") {
        init.method = options.method;
        init.body = options.body;
      }
      const res = await fetch(proxyUrl, init);
      if (res.ok) {
        const t = await res.text();
        if (t && !looksBlocked(t)) return t;
      }
    } catch {
      /* try rendered */
    }

    if (!isCraigslist) {
      try {
        const rendered = await fetchRendered(url);
        if (rendered.ok) {
          const t = await rendered.text();
          if (t && !looksBlocked(t)) return t;
        }
      } catch {
        /* fall through */
      }
    }
  }

  const bright = fetchViaBrightDataCurl(url, options);
  if (bright && !looksBlocked(bright)) return bright;
  if (bright) lastReason = "bright_data_blocked";

  if (!html && lastReason !== "empty") {
    console.warn(`[fetchBlockedPage] ${lastReason}: ${url.slice(0, 120)}`);
  }
  return html;
}

/**
 * proxiedFetch — legacy alias for fetchWithRetry with ScraperAPI support.
 * Kept for backward compatibility with suffolk_ny.ts and other scrapers
 * that import this name.
 */
export async function proxiedFetch(
  url: string,
  options: {
    render?: boolean;
    method?: string;
    body?: string;
    contentType?: string;
    retries?: number;
  } = {},
): Promise<Response> {
  const { render = false, method = "GET", body, contentType, retries = 3 } = options;
  if (render) {
    return fetchRendered(url, retries);
  }
  return fetchWithRetry(
    url,
    { method, body, headers: contentType ? { "Content-Type": contentType } : {} },
    retries,
  );
}

export interface CountyConfig {
  name: string;
  state: string;
  leadTypes: string[];
  publicsearch_slug?: string;
  publicsearch_state?: string;
}

/** Collect leads from parallel scrapers; surface rejected promises into errors[]. */
export function settleScraperResults(
  results: PromiseSettledResult<Lead[]>[],
  labels: string[],
  errors?: string[],
): Lead[] {
  const leads: Lead[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const label = labels[i] ?? `scraper-${i}`;
    if (result.status === "fulfilled") {
      leads.push(...result.value);
    } else {
      const msg = `${label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
      console.error(`[scraper] ${msg}`);
      errors?.push(msg);
    }
  }
  return leads;
}
