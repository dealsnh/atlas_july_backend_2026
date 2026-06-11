// @ts-nocheck
/**
 * County Assessor Cross-Reference Module
 *
 * Given an owner name + county + state, queries the county assessor's
 * public property search portal and returns all matching property addresses.
 *
 * Used to cross-reference bankruptcy/probate/divorce/obituary leads
 * (which only have a debtor/decedent name) against actual property ownership.
 *
 * Only leads where at least one property address is found are saved to the DB.
 */

import { fetchWithRetry, fetchRendered } from "./base.js";

export interface AssessorProperty {
  address: string;
  city: string;
  state: string;
  zip?: string;
  parcelId?: string;
  ownerName?: string;
  mailingAddress?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingZip?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function cleanName(name: string): string {
  return name
    .replace(/\b(JR|SR|II|III|IV|TRUST|LLC|INC|ESTATE|ET AL)\b/gi, "")
    .replace(/[^a-zA-Z\s]/g, "")
    .trim()
    .toUpperCase();
}

function parseName(fullName: string): { last: string; first: string } {
  const clean = cleanName(fullName);
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { last: parts[0], first: "" };
  // Assume "FIRST LAST" format from PACER/court filings
  return { last: parts[parts.length - 1], first: parts[0] };
}

async function getText(url: string, options: RequestInit = {}): Promise<string> {
  const res = await fetchWithRetry(url, options);
  return res.text();
}

async function getTextRendered(url: string): Promise<string> {
  const res = await fetchRendered(url);
  return res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// Missouri Counties
// ─────────────────────────────────────────────────────────────────────────────

// ─── Jackson County MO: Parcels_Market_Value + AddressPoints fallback ─────────
// Legacy ParcelViewer_Parcels_View no longer exposes owner/situs fields (2025+).
const JACKSON_ADDRESS_POINTS_URL =
  "https://services3.arcgis.com/4LOAHoFXfea6Y3Et/ArcGIS/rest/services/ParcelViewer_AddressPoints_View/FeatureServer/0/query";
const JACKSON_MARKET_VALUE_URL =
  "https://services3.arcgis.com/4LOAHoFXfea6Y3Et/ArcGIS/rest/services/Parcels_Market_Value/FeatureServer/0/query";

function normalizeStreetForQuery(address: string): string {
  let s = address
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
  s = s
    .replace(
      /\s+(KANSAS CITY|KC|INDEPENDENCE|BLUE SPRINGS|LEES SUMMIT|LEE'S SUMMIT|GRAIN VALLEY|GRANDVIEW|RAYTOWN|MO)\b.*$/i,
      "",
    )
    .trim();
  s = s.replace(/\s+\d{5}(-\d{4})?\s*$/i, "").trim();
  return s;
}

function buildAddressLikePatterns(address: string): string[] {
  const street = normalizeStreetForQuery(address);
  const parts = street.split(/\s+/).filter(Boolean);
  if (!parts.length || !/^\d+$/.test(parts[0])) return [];
  const patterns = new Set<string>();
  for (let n = Math.min(parts.length, 6); n >= 2; n--) {
    patterns.add(`${parts.slice(0, n).join(" ")}%`);
  }
  return [...patterns];
}

function mapJacksonMarketFeature(attrs: Record<string, string>): AssessorProperty | null {
  const address = attrs.situs_address?.trim();
  const ownerParts = (attrs.owner_info || "").split("|").map((s) => s.trim());
  const ownerName = ownerParts[0];
  const mailCandidate = ownerParts.find((p, i) => i > 0 && /^\d+\s+[A-Za-z]/.test(p));
  if (!address || !ownerName) return null;
  return {
    address,
    city: attrs.situs_city?.trim() || "Kansas City",
    state: "MO",
    zip: attrs.situs_zip?.trim() || undefined,
    parcelId: attrs.parcel_number?.trim() || undefined,
    ownerName,
    mailingAddress: mailCandidate || undefined,
  };
}

async function queryJacksonMarketValue(where: string, limit = 5): Promise<AssessorProperty[]> {
  const qUrl = new URL(JACKSON_MARKET_VALUE_URL);
  qUrl.searchParams.set("where", where);
  qUrl.searchParams.set("outFields", "parcel_number,situs_address,situs_city,situs_zip,owner_info");
  qUrl.searchParams.set("returnGeometry", "false");
  qUrl.searchParams.set("f", "json");
  qUrl.searchParams.set("resultRecordCount", String(limit));
  const res = await fetchWithRetry(qUrl.toString());
  if (!res.ok) return [];
  const data = (await res.json()) as { features?: { attributes: Record<string, string> }[] };
  return (data.features || [])
    .map((f) => mapJacksonMarketFeature(f.attributes))
    .filter((p): p is AssessorProperty => !!p && /\d+\s+[A-Za-z]/.test(p.address));
}

const STREET_DIRECTIONALS = new Set([
  "N",
  "S",
  "E",
  "W",
  "NW",
  "NE",
  "SW",
  "SE",
  "NORTH",
  "SOUTH",
  "EAST",
  "WEST",
]);
const STREET_SUFFIXES = new Set([
  "ST",
  "STREET",
  "AVE",
  "AV",
  "AVENUE",
  "RD",
  "ROAD",
  "DR",
  "DRIVE",
  "CT",
  "COURT",
  "LN",
  "LANE",
  "BLVD",
  "BOULEVARD",
  "PL",
  "PLACE",
  "TER",
  "TERRACE",
  "WAY",
  "CIR",
]);

function significantStreetTokens(parts: string[]): string[] {
  return parts
    .slice(1)
    .filter((p) => !STREET_DIRECTIONALS.has(p) && !STREET_SUFFIXES.has(p) && !/^\d+$/.test(p));
}

function streetTokenMatch(a: string, b: string): number {
  if (a === b) return 3;
  if (a.startsWith(b) || b.startsWith(a)) return 2;
  return 0;
}

function pickBestJacksonMatch(
  candidates: AssessorProperty[],
  queryStreet: string,
): AssessorProperty | null {
  if (!candidates.length) return null;
  const target = normalizeStreetForQuery(queryStreet);
  const targetParts = target.split(/\s+/);
  const targetNum = targetParts[0];
  const targetTokens = significantStreetTokens(targetParts);
  let best: AssessorProperty | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const situs = normalizeStreetForQuery(c.address);
    if (!situs.startsWith(`${targetNum} `)) continue;
    const situsParts = situs.split(/\s+/);
    const situsTokens = significantStreetTokens(situsParts);
    if (targetTokens.length > 0) {
      let tokenScore = 0;
      for (const t of targetTokens) {
        const hit = situsTokens.some((s) => streetTokenMatch(t, s) >= 2);
        if (hit) tokenScore += 3;
      }
      if (tokenScore < 3) continue;
      if (tokenScore > bestScore) {
        bestScore = tokenScore;
        best = c;
      }
      continue;
    }
    let score = 0;
    for (let i = 1; i < Math.min(targetParts.length, situsParts.length); i++) {
      score += streetTokenMatch(targetParts[i], situsParts[i]);
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

async function lookupJacksonMOByParcelId(parcelId: string): Promise<AssessorProperty | null> {
  const safe = parcelId.replace(/'/g, "''");
  const results = await queryJacksonMarketValue(`parcel_number = '${safe}'`, 1);
  return results[0] || null;
}

async function lookupJacksonMOByAddress(address: string): Promise<AssessorProperty | null> {
  const patterns = buildAddressLikePatterns(address);
  for (const pattern of patterns) {
    const results = await queryJacksonMarketValue(`UPPER(situs_address) LIKE '${pattern}'`, 8);
    const match = pickBestJacksonMatch(results, address);
    if (match?.ownerName) return match;
  }

  // AddressPoints → parcel id → owner (only when FULLADDR matches query street)
  for (const pattern of patterns) {
    const addrUrl = new URL(JACKSON_ADDRESS_POINTS_URL);
    addrUrl.searchParams.set("where", `UPPER(FULLADDR) LIKE '${pattern}'`);
    addrUrl.searchParams.set("outFields", "ADDPTKEY,FULLADDR,ZIP");
    addrUrl.searchParams.set("returnGeometry", "false");
    addrUrl.searchParams.set("f", "json");
    addrUrl.searchParams.set("resultRecordCount", "8");
    const addrRes = await fetchWithRetry(addrUrl.toString());
    if (!addrRes.ok) continue;
    const addrData = (await addrRes.json()) as {
      features?: { attributes: { ADDPTKEY?: string; FULLADDR?: string; ZIP?: string } }[];
    };
    const addrCandidates = (addrData.features || [])
      .filter((f) => f.attributes.FULLADDR && f.attributes.ADDPTKEY)
      .map((f) => ({
        address: f.attributes.FULLADDR!,
        city: "Kansas City",
        state: "MO",
        zip: f.attributes.ZIP || undefined,
        parcelId: f.attributes.ADDPTKEY,
        ownerName: "pending",
      }));
    const addrMatch = pickBestJacksonMatch(addrCandidates, address);
    if (!addrMatch?.parcelId) continue;
    const prop = await lookupJacksonMOByParcelId(addrMatch.parcelId);
    if (prop?.ownerName) return prop;
  }
  return null;
}

async function lookupJacksonMO(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    if (!last) return [];
    return await queryJacksonMarketValue(`UPPER(owner_info) LIKE '%${last.toUpperCase()}%'`, 5);
  } catch {
    return [];
  }
}

async function lookupClayMO(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getText("https://www.claycountymo.gov/property_search/results", {
      method: "POST",
      body: new URLSearchParams({ owner_last: last, owner_first: "" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return parseGenericTable(html, "MO", "Clay County", 2, 3);
  } catch {
    return [];
  }
}

async function lookupCassMO(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getText(
      `https://www.casscounty.com/property/search?owner=${encodeURIComponent(last)}`,
    );
    return parseGenericTable(html, "MO", "Cass County", 2, 3);
  } catch {
    return [];
  }
}

async function lookupPlatteMO(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://www.plattecountymo.gov/assessor/search?name=${encodeURIComponent(last)}`,
    );
    return parseGenericTable(html, "MO", "Platte County", 1, 2);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Alabama Counties
// ─────────────────────────────────────────────────────────────────────────────

async function lookupMadisonAL(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last, first } = parseName(ownerName);
    const pageHtml = await getText(
      "https://madisonproperty.countygovservices.com/Property/Property/Search",
    );
    const tokenMatch = pageHtml.match(
      /name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/,
    );
    if (!tokenMatch) return [];

    const resultHtml = await getText(
      "https://madisonproperty.countygovservices.com/Property/Property/Search",
      {
        method: "POST",
        body: new URLSearchParams({
          PropertySearchYear: "2025",
          PropertySearchType: "name",
          UseContains: "False",
          "SearchCriteria.Criteria1": last,
          "SearchCriteria.Criteria2": first,
          SelectedParcels: "",
          __RequestVerificationToken: tokenMatch[1],
        }).toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://madisonproperty.countygovservices.com/Property/Property/Search",
        },
      },
    );

    const results: AssessorProperty[] = [];
    // Each result row has a DESCRIPTION cell with "OWNER\nADDRESS"
    const cellRegex = /<td[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = cellRegex.exec(resultHtml)) !== null) {
      const text = m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const lines = text
        .split(/\s{2,}|\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (/^\d+\s+[A-Z]/.test(line)) {
          results.push({ address: line, city: "Huntsville", state: "AL" });
          break;
        }
      }
    }
    // Fallback: generic table parse
    if (results.length === 0) {
      return parseGenericTable(resultHtml, "AL", "Huntsville", 1, 2);
    }
    return results;
  } catch {
    return [];
  }
}

async function lookupLimestoneAL(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://qpublic.schneidercorp.com/Application.aspx?AppID=830&LayerID=14957&PageTypeID=4&PageID=7084&KeyValue=${encodeURIComponent(last)}`,
    );
    return parseQPublicResults(html, "AL");
  } catch {
    return [];
  }
}

async function lookupMorganAL(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://qpublic.schneidercorp.com/Application.aspx?AppID=1002&LayerID=20079&PageTypeID=4&PageID=9316&KeyValue=${encodeURIComponent(last)}`,
    );
    return parseQPublicResults(html, "AL");
  } catch {
    return [];
  }
}

// ─── Jefferson County AL: JCCAL ArcGIS FeatureServer via Bright Data proxy ──────
// CONFIRMED WORKING: gis.jccal.org requires residential proxy to bypass Imperva WAF
// qPublic is Cloudflare-blocked — do NOT use
async function lookupJeffersonAL(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const JCCAL_URL =
      "https://gis.jccal.org/arcgis/rest/services/ParcelViewer/ParcelViewer_Parcels_View/FeatureServer/0/query";
    const qUrl = new URL(JCCAL_URL);
    qUrl.searchParams.set("where", `UPPER(OWNER1) LIKE '%${last.toUpperCase()}%'`);
    qUrl.searchParams.set(
      "outFields",
      "OWNER1,SITUS_ADDR,SITUS_CITY,SITUS_ZIP,PARCELID,MAIL_ADDR1",
    );
    qUrl.searchParams.set("returnGeometry", "false");
    qUrl.searchParams.set("f", "json");
    qUrl.searchParams.set("resultRecordCount", "5");
    // Use Bright Data residential proxy — required for JCCAL (Imperva WAF blocks datacenter IPs)
    const bdUser = process.env.BRIGHT_DATA_USER;
    const bdPass = process.env.BRIGHT_DATA_PASS;
    if (!bdUser || !bdPass) return [];
    // Node native fetch doesn't support HTTP proxy directly — use ScraperAPI as fallback
    // or pass via HTTPS_PROXY env var if set
    const res = await fetchWithRetry(qUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        // Bright Data proxy auth header (works with some proxy-aware fetch implementations)
        "Proxy-Authorization": `Basic ${Buffer.from(`${bdUser}:${bdPass}`).toString("base64")}`,
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: { attributes: Record<string, string> }[] };
    const features = data.features || [];
    return features
      .map((f) => mapJccalParcel(f.attributes))
      .filter((p): p is AssessorProperty => !!p && /\d+\s+[A-Za-z]/.test(p.address));
  } catch {
    return [];
  }
}

function mapJccalParcel(attrs: Record<string, string>): AssessorProperty | null {
  const address = attrs.SITUS_ADDR?.trim();
  if (!address) return null;
  return {
    address,
    city: attrs.SITUS_CITY || "Birmingham",
    state: "AL",
    zip: attrs.SITUS_ZIP || undefined,
    parcelId: attrs.PARCELID || undefined,
    ownerName: attrs.OWNER1 || undefined,
    mailingAddress: attrs.MAIL_ADDR1?.trim() || undefined,
    mailingCity: attrs.MAIL_CITY?.trim() || undefined,
    mailingState: attrs.MAIL_STATE?.trim() || "AL",
    mailingZip: attrs.MAIL_ZIP?.trim() || undefined,
  };
}

async function lookupShelbyAL(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://esearch.shelbyal.com/search/result?keywords=OwnerName%3A%22${encodeURIComponent(last)}%22`,
    );
    return parseEsearchResults(html, "AL");
  } catch {
    return [];
  }
}

async function lookupMontgomeryAL(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://qpublic.schneidercorp.com/Application.aspx?AppID=1026&LayerID=20683&PageTypeID=4&PageID=9581&KeyValue=${encodeURIComponent(last)}`,
    );
    return parseQPublicResults(html, "AL");
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ohio Counties
// ─────────────────────────────────────────────────────────────────────────────

// ─── Hamilton County OH: wedge.hcauditor.org (DevNet portal) ─────────────────
// Legacy wedge1.hcauditor.org/search/re/* URLs return 404 (2025+).
// Flow: session cookie → POST /execute → POST /results_ajax (JSON owner + address).
const HAMILTON_WEDGE_BASE = "https://wedge.hcauditor.org";

function mergeSetCookies(res: Response): string {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }
  const raw = res.headers.get("set-cookie");
  if (!raw) return "";
  return raw
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .join("; ");
}

function stripStreetSuffix(street: string): string {
  return street
    .replace(
      /\s+(ST|STREET|DR|DRIVE|AVE|AVENUE|LN|LANE|RD|ROAD|CT|COURT|BLVD|WAY|PL|PLACE|CIR|CIRCLE)\.?$/i,
      "",
    )
    .trim();
}

interface WedgeParcelRow {
  property_key?: string;
  owner?: string;
  site_address?: string;
  masked_property_key?: string;
}

async function queryHamiltonWedge(params: {
  searchType: "Address" | "Owner";
  houseNumber?: string;
  streetName?: string;
  ownerBegins?: string;
}): Promise<WedgeParcelRow[]> {
  const init = await fetchWithRetry(`${HAMILTON_WEDGE_BASE}/`);
  let cookies = mergeSetCookies(init);
  const postHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json, text/javascript, */*; q=0.01",
  };
  if (cookies) postHeaders.Cookie = cookies;

  const body = new URLSearchParams();
  body.set("search_method", params.searchType);
  body.set("search_type", params.searchType);
  if (params.searchType === "Address") {
    if (!params.houseNumber || !params.streetName) return [];
    body.set("site_house_number_low", params.houseNumber);
    body.set("site_street_name", stripStreetSuffix(params.streetName));
  } else {
    if (!params.ownerBegins?.trim()) return [];
    body.set("owner_name_begins", params.ownerBegins.trim());
  }

  const exec = await fetchWithRetry(`${HAMILTON_WEDGE_BASE}/execute`, {
    method: "POST",
    headers: postHeaders,
    body: body.toString(),
  });
  const extra = mergeSetCookies(exec);
  if (extra) cookies = [cookies, extra].filter(Boolean).join("; ");
  const execData = (await exec.json().catch(() => ({}))) as { Message?: string };
  if (execData.Message) return [];

  const ajax = await fetchWithRetry(`${HAMILTON_WEDGE_BASE}/results_ajax`, {
    method: "POST",
    headers: { ...postHeaders, ...(cookies ? { Cookie: cookies } : {}) },
    body: "draw=1&start=0&length=25",
  });
  const ajaxData = (await ajax.json().catch(() => ({}))) as { data?: WedgeParcelRow[] };
  return Array.isArray(ajaxData.data) ? ajaxData.data : [];
}

function mapWedgeRows(rows: WedgeParcelRow[]): AssessorProperty[] {
  return rows
    .filter((r) => r.site_address && r.owner)
    .map((r) => ({
      address: r.site_address!.trim(),
      city: "Cincinnati",
      state: "OH",
      parcelId: r.property_key || r.masked_property_key || undefined,
      ownerName: r.owner!.trim(),
    }));
}

async function lookupHamiltonOH(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last, first } = parseName(ownerName);
    const ownerBegins = first ? `${last} ${first.charAt(0)}` : last;
    const rows = await queryHamiltonWedge({ searchType: "Owner", ownerBegins });
    return mapWedgeRows(rows);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wisconsin Counties
// ─────────────────────────────────────────────────────────────────────────────

async function lookupDaneWI(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getText(
      `https://landonline.countyofdane.com/LandRecords/protected/LRSearch.aspx?searchType=owner&ownerName=${encodeURIComponent(last)}`,
    );
    return parseGenericTable(html, "WI", "Dane County", 2, 3);
  } catch {
    return [];
  }
}

async function lookupRockWI(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://qpublic.schneidercorp.com/Application.aspx?AppID=1017&LayerID=20421&PageTypeID=4&PageID=9494&KeyValue=${encodeURIComponent(last)}`,
    );
    return parseQPublicResults(html, "WI");
  } catch {
    return [];
  }
}

async function lookupDoorWI(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://qpublic.schneidercorp.com/Application.aspx?AppID=1060&LayerID=21426&PageTypeID=4&PageID=9872&KeyValue=${encodeURIComponent(last)}`,
    );
    return parseQPublicResults(html, "WI");
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// South Carolina Counties
// ─────────────────────────────────────────────────────────────────────────────

async function lookupHorrySC(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://www.horrycountysc.gov/departments/assessor/property-search/?owner=${encodeURIComponent(last)}`,
    );
    return parseGenericTable(html, "SC", "Horry County", 2, 3);
  } catch {
    return [];
  }
}

async function lookupGeorgetownSC(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://qpublic.schneidercorp.com/Application.aspx?AppID=830&LayerID=14957&PageTypeID=4&PageID=7084&KeyValue=${encodeURIComponent(last)}`,
    );
    return parseQPublicResults(html, "SC");
  } catch {
    return [];
  }
}

async function lookupMarionSC(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://esearch.marioncountysc.com/search/result?keywords=OwnerName%3A%22${encodeURIComponent(last)}%22`,
    );
    return parseEsearchResults(html, "SC");
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// New York Counties
// ─────────────────────────────────────────────────────────────────────────────

async function lookupSuffolkNY(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://www.suffolkcountyny.gov/Departments/Assessment/Property-Search?lastName=${encodeURIComponent(last)}`,
    );
    return parseGenericTable(html, "NY", "Suffolk County", 2, 3);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Texas Counties
// ─────────────────────────────────────────────────────────────────────────────

async function lookupBexarTX(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getText(
      `https://bexar.trueautomation.com/clientdb/Property/PropertySearch.aspx?cid=110&ownername=${encodeURIComponent(last)}`,
    );
    return parseTrueAutomationResults(html, "TX");
  } catch {
    return [];
  }
}

async function lookupNuecesT(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getTextRendered(
      `https://esearch.nuecescad.net/search/result?keywords=OwnerName%3A%22${encodeURIComponent(last)}%22`,
    );
    return parseEsearchResults(html, "TX");
  } catch {
    return [];
  }
}

async function lookupKlebergTX(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getText(
      `https://kleberg.trueautomation.com/clientdb/Property/PropertySearch.aspx?cid=85&ownername=${encodeURIComponent(last)}`,
    );
    return parseTrueAutomationResults(html, "TX");
  } catch {
    return [];
  }
}

async function lookupJimWellsTX(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getText(
      `https://jimwells.trueautomation.com/clientdb/Property/PropertySearch.aspx?cid=90&ownername=${encodeURIComponent(last)}`,
    );
    return parseTrueAutomationResults(html, "TX");
  } catch {
    return [];
  }
}

async function lookupSanPatricioTX(ownerName: string): Promise<AssessorProperty[]> {
  try {
    const { last } = parseName(ownerName);
    const html = await getText(
      `https://sanpatricio.trueautomation.com/clientdb/Property/PropertySearch.aspx?cid=203&ownername=${encodeURIComponent(last)}`,
    );
    return parseTrueAutomationResults(html, "TX");
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared parsers
// ─────────────────────────────────────────────────────────────────────────────

/** Generic table parser: addressCol is 0-indexed column index for address */
function parseGenericTable(
  html: string,
  state: string,
  defaultCity: string,
  addressCol: number,
  cityCol?: number,
): AssessorProperty[] {
  const results: AssessorProperty[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const cells = m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    const text = cells.map((c) => c.replace(/<[^>]+>/g, "").trim());
    const addr = text[addressCol];
    if (addr && /^\d+\s+[A-Za-z]/.test(addr)) {
      results.push({
        address: addr,
        city: (cityCol !== undefined ? text[cityCol] : "") || defaultCity,
        state,
      });
    }
  }
  return results;
}

function parseQPublicResults(html: string, state: string): AssessorProperty[] {
  const results: AssessorProperty[] = [];
  const rowRegex = /<tr[^>]*class="[^"]*SearchResultRow[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const cells = m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    const text = cells.map((c) => c.replace(/<[^>]+>/g, "").trim());
    // qPublic: [parcel, owner, address, city, zip]
    if (text.length >= 3 && text[2] && /^\d+\s+[A-Za-z]/.test(text[2])) {
      results.push({
        address: text[2],
        city: text[3] || "",
        state,
        zip: text[4] || "",
        parcelId: text[0],
        ownerName: text[1],
      });
    }
  }
  return results;
}

function parseEsearchResults(html: string, state: string): AssessorProperty[] {
  const results: AssessorProperty[] = [];
  // esearch renders a table; try multiple row class patterns
  const patterns = [
    /<tr[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi,
    /<tr[^>]*class="[^"]*odd[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi,
    /<tr[^>]*class="[^"]*even[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const cells = m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      const text = cells.map((c) => c.replace(/<[^>]+>/g, "").trim());
      if (text.length >= 3 && text[2] && /^\d+\s+[A-Za-z]/.test(text[2])) {
        results.push({ address: text[2], city: text[3] || "", state });
      }
    }
    if (results.length > 0) break;
  }
  return results;
}

function parseTrueAutomationResults(html: string, state: string): AssessorProperty[] {
  const results: AssessorProperty[] = [];
  const rowRegex = /<tr[^>]*class="[^"]*SearchResultRow[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const cells = m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    const text = cells.map((c) => c.replace(/<[^>]+>/g, "").trim());
    if (text.length >= 3 && text[2] && /^\d+\s+[A-Za-z]/.test(text[2])) {
      results.push({ address: text[2], city: text[3] || "", state, parcelId: text[0] });
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export type CountyKey =
  | "jackson-mo"
  | "clay-mo"
  | "cass-mo"
  | "platte-mo"
  | "madison-al"
  | "limestone-al"
  | "morgan-al"
  | "jefferson-al"
  | "shelby-al"
  | "autauga-al"
  | "elmore-al"
  | "montgomery-al"
  | "hamilton-oh"
  | "dane-wi"
  | "rock-wi"
  | "door-wi"
  | "horry-sc"
  | "georgetown-sc"
  | "marion-sc"
  | "suffolk-ny"
  | "bexar-tx"
  | "nueces-tx"
  | "kleberg-tx"
  | "jim-wells-tx"
  | "san-patricio-tx";

const LOOKUP_MAP: Record<CountyKey, (name: string) => Promise<AssessorProperty[]>> = {
  "jackson-mo": lookupJacksonMO,
  "clay-mo": lookupClayMO,
  "cass-mo": lookupCassMO,
  "platte-mo": lookupPlatteMO,
  "madison-al": lookupMadisonAL,
  "limestone-al": lookupLimestoneAL,
  "morgan-al": lookupMorganAL,
  "jefferson-al": lookupJeffersonAL,
  "shelby-al": lookupShelbyAL,
  "autauga-al": lookupMontgomeryAL,
  "elmore-al": lookupMontgomeryAL,
  "montgomery-al": lookupMontgomeryAL,
  "hamilton-oh": lookupHamiltonOH,
  "dane-wi": lookupDaneWI,
  "rock-wi": lookupRockWI,
  "door-wi": lookupDoorWI,
  "horry-sc": lookupHorrySC,
  "georgetown-sc": lookupGeorgetownSC,
  "marion-sc": lookupMarionSC,
  "suffolk-ny": lookupSuffolkNY,
  "bexar-tx": lookupBexarTX,
  "nueces-tx": lookupNuecesT,
  "kleberg-tx": lookupKlebergTX,
  "jim-wells-tx": lookupJimWellsTX,
  "san-patricio-tx": lookupSanPatricioTX,
};

/**
 * Look up the owner of a property by street address in a given county.
 * Used to enrich address-based leads (fire damage, water shutoffs, code violations, vacant/abandoned).
 * Returns owner name + parcel data, or null if not found.
 *
 * @param address  Street address string (e.g. "1234 Main St")
 * @param county   County name (e.g. "Hamilton")
 * @param state    State abbreviation (e.g. "OH")
 */
export async function lookupByAddress(
  address: string,
  county: string,
  state: string,
): Promise<AssessorProperty | null> {
  if (!address || address.trim().length < 5) return null;
  const addrClean = address
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
  const parts = addrClean.split(" ");
  const streetNum = parts[0];
  const streetName = parts[1] || "";
  if (!streetNum || !/^\d+$/.test(streetNum)) return null;
  const countyKey = county
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .replace(/\s+/g, "-");
  try {
    if (state === "MO") {
      if (countyKey === "jackson") {
        const match = await lookupJacksonMOByAddress(address);
        if (match) return match;
      }
      // Clay/Cass/Platte — legacy parcels layer (Jackson uses Parcels_Market_Value above)
      const parcelsUrl =
        "https://services3.arcgis.com/4LOAHoFXfea6Y3Et/ArcGIS/rest/services/ParcelViewer_Parcels_View/FeatureServer/0/query";
      const qUrl = new URL(parcelsUrl);
      qUrl.searchParams.set("where", `UPPER(SITUS_ADDR) LIKE '${streetNum} ${streetName}%'`);
      qUrl.searchParams.set(
        "outFields",
        "PARCELID,OWNER_NAME,SITUS_ADDR,SITUS_CITY,SITUS_ZIP,MAIL_ADDR,MAIL_ADDR1,MAIL_CITY,MAIL_STATE,MAIL_ZIP",
      );
      qUrl.searchParams.set("returnGeometry", "false");
      qUrl.searchParams.set("f", "json");
      qUrl.searchParams.set("resultRecordCount", "1");
      const res = await fetchWithRetry(qUrl.toString());
      if (res.ok) {
        const data = (await res.json()) as { features?: { attributes: Record<string, string> }[] };
        const f = data.features?.[0]?.attributes;
        if (f?.SITUS_ADDR) {
          return {
            address: f.SITUS_ADDR,
            city: f.SITUS_CITY || "Kansas City",
            state: "MO",
            zip: f.SITUS_ZIP || undefined,
            parcelId: f.PARCELID || undefined,
            ownerName: f.OWNER_NAME || undefined,
            mailingAddress: f.MAIL_ADDR || f.MAIL_ADDR1 || undefined,
            mailingCity: f.MAIL_CITY || undefined,
            mailingState: f.MAIL_STATE || "MO",
            mailingZip: f.MAIL_ZIP || undefined,
          };
        }
      }
    } else if (state === "OH" && countyKey === "hamilton") {
      const rows = await queryHamiltonWedge({
        searchType: "Address",
        houseNumber: streetNum,
        streetName: parts.slice(1).join(" ") || streetName,
      });
      const match = mapWedgeRows(rows)[0];
      if (match) return match;
    } else if (state === "AL") {
      // Jefferson AL — JCCAL ArcGIS
      if (countyKey === "jefferson") {
        const qUrl = new URL(
          "https://gis.jccal.org/arcgis/rest/services/ParcelViewer/ParcelViewer_Parcels_View/FeatureServer/0/query",
        );
        qUrl.searchParams.set("where", `UPPER(SITUS_ADDR) LIKE '${streetNum} ${streetName}%'`);
        qUrl.searchParams.set(
          "outFields",
          "PARCELID,OWNER1,SITUS_ADDR,SITUS_CITY,SITUS_ZIP,MAIL_ADDR1,MAIL_CITY,MAIL_STATE,MAIL_ZIP",
        );
        qUrl.searchParams.set("returnGeometry", "false");
        qUrl.searchParams.set("f", "json");
        qUrl.searchParams.set("resultRecordCount", "1");
        const res = await fetchWithRetry(qUrl.toString(), {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            features?: { attributes: Record<string, string> }[];
          };
          const f = data.features?.[0]?.attributes;
          if (f) {
            const mapped = mapJccalParcel(f);
            if (mapped) return mapped;
          }
        }
      } else if (countyKey === "madison") {
        const qUrl = new URL(
          "https://services.arcgis.com/V6ZHFr6zdgNZuVG0/ArcGIS/rest/services/Madison_County_Parcels/FeatureServer/0/query",
        );
        qUrl.searchParams.set("where", `UPPER(SITUS_ADDR) LIKE '${streetNum} ${streetName}%'`);
        qUrl.searchParams.set(
          "outFields",
          "PARCELID,OWNER_NAME,SITUS_ADDR,SITUS_CITY,SITUS_ZIP,MAIL_ADDR,MAIL_CITY,MAIL_STATE,MAIL_ZIP",
        );
        qUrl.searchParams.set("returnGeometry", "false");
        qUrl.searchParams.set("f", "json");
        qUrl.searchParams.set("resultRecordCount", "1");
        const res = await fetchWithRetry(qUrl.toString(), {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            features?: { attributes: Record<string, string> }[];
          };
          const f = data.features?.[0]?.attributes;
          if (f && f.SITUS_ADDR) {
            return {
              address: f.SITUS_ADDR,
              city: f.SITUS_CITY || "Huntsville",
              state: "AL",
              zip: f.SITUS_ZIP || undefined,
              parcelId: f.PARCELID || undefined,
              ownerName: f.OWNER_NAME || undefined,
              mailingAddress: f.MAIL_ADDR?.trim() || undefined,
              mailingCity: f.MAIL_CITY?.trim() || undefined,
              mailingState: f.MAIL_STATE?.trim() || "AL",
              mailingZip: f.MAIL_ZIP?.trim() || undefined,
            };
          }
        }
      }
    }
  } catch {
    // enrichment is best-effort, silently fail
  }
  return null;
}

/**
 * Look up all properties owned by a person in a given county.
 * Returns an empty array if no properties found or lookup fails.
 *
 * @param ownerName  Full name from court filing (e.g. "John Smith" or "SMITH JOHN")
 * @param county     County name (e.g. "Hamilton")
 * @param state      State abbreviation (e.g. "OH")
 */
export async function lookupOwnerProperties(
  ownerName: string,
  county: string,
  state: string,
): Promise<AssessorProperty[]> {
  if (!ownerName || ownerName.trim().length < 2) return [];
  const key = `${county
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .replace(/\s+/g, "-")}-${state.toLowerCase()}` as CountyKey;
  const fn = LOOKUP_MAP[key];
  if (!fn) return [];
  try {
    const results = await fn(ownerName);
    return results.filter((r) => r.address && /\d+\s+[A-Za-z]/.test(r.address));
  } catch {
    return [];
  }
}
