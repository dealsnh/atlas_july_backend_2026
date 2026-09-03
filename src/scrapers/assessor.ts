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

import { spawnSync } from "child_process";
import { fetchWithRetry, fetchRendered } from "./base.js";
import { madisonLookupByAddress, madisonLookupByOwner } from "./madison-al.js";

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
// Shared parcel-roll query helper (the universal lead completer)
//
// One generic ArcGIS FeatureServer adapter drives every county whose public
// assessment roll exposes owner name + situs address + owner MAILING address.
// Each endpoint below was validated LIVE (owner-name query AND address query
// returning a real record). Source URLs are env-overridable so a stale snapshot
// can be swapped without a code change.
// ─────────────────────────────────────────────────────────────────────────────

interface RollSpec {
  urls: string[];
  ownerField: string;
  /** Situs from a single display field, or number + street-name parts. */
  situsDisplayField?: string;
  situsNumField?: string;
  situsStreetField?: string;
  /** Optional street-name field when a roll separates directional prefix and name. */
  situsStreetExtraField?: string;
  situsSuffixField?: string;
  situsCityField?: string;
  situsZipField?: string;
  /** Mailing (owner) address line fields, in order. */
  mailFields: string[];
  mailCityField?: string;
  mailStateField?: string;
  mailZipField?: string;
  parcelIdField?: string;
  defaultCity: string;
  state: string;
}

const env = (name: string, fallback: string): string =>
  (process.env[name] && String(process.env[name]).trim()) || fallback;

const ROLL_SPECS: Record<string, RollSpec> = {
  // Clay County MO — official county GIS parcel service (98k parcels).
  "clay-mo": {
    urls: [
      env(
        "CLAY_PARCEL_QUERY_URL",
        "https://services7.arcgis.com/3c8lLdmDNevrTlaV/ArcGIS/rest/services/ClayCountyParcelService/FeatureServer/0/query",
      ),
    ],
    ownerField: "current_owner",
    situsDisplayField: "situs_display",
    situsNumField: "situs_num",
    situsStreetField: "situs_st_name",
    situsCityField: "situs_city",
    situsZipField: "situs_zip",
    mailFields: ["owner_addr_1", "owner_addr_2"],
    mailCityField: "owner_city",
    mailStateField: "owner_state",
    mailZipField: "owner_zip",
    parcelIdField: "parcel_id",
    defaultCity: "Liberty",
    state: "MO",
  },
  // Platte County MO — Parkville-hosted county-wide parcels (45k, whole county).
  "platte-mo": {
    urls: [
      env(
        "PLATTE_PARCEL_QUERY_URL",
        "https://services.arcgis.com/KP64F8Xif9MkUwD4/arcgis/rest/services/Parkville_Parcels_2024/FeatureServer/0/query",
      ),
    ],
    ownerField: "DEEDHOLDER",
    situsNumField: "HOUSENUM",
    situsStreetField: "ADDRESS",
    mailFields: ["Mailing_ad", "Mailing__1"],
    mailCityField: "Mailing__2",
    mailStateField: "Mailing__3",
    mailZipField: "Mailing__4",
    parcelIdField: "Parcel_PIN",
    defaultCity: "Platte City",
    state: "MO",
  },
  // Cass County MO — partial open coverage (Harrisonville area + Belton).
  // Raymore + unincorporated Cass are NOT in either open service.
  "cass-mo": {
    urls: [
      env(
        "CASS_PARCEL_QUERY_URL",
        "https://services7.arcgis.com/nqa85ZDSsMNrKusD/arcgis/rest/services/County_Parcels/FeatureServer/0/query",
      ),
      env(
        "CASS_BELTON_PARCEL_QUERY_URL",
        "https://services6.arcgis.com/ZxotJxQo35Sx0jNg/arcgis/rest/services/Belton_Parcels/FeatureServer/49/query",
      ),
    ],
    ownerField: "DeedHold",
    situsNumField: "HseNum",
    situsStreetField: "Address",
    situsCityField: "City",
    situsZipField: "Zip",
    mailFields: ["MailAdd1", "MailAdd2"],
    mailCityField: "MailCity",
    mailStateField: "MailStat",
    mailZipField: "MailZip",
    parcelIdField: "PARCELID",
    defaultCity: "Harrisonville",
    state: "MO",
  },
  // Hamilton County OH — CAGIS parcel data (owner+situs+true mailing).
  // The auditor "wedge" JSON endpoint was retired (results_ajax → 404); this
  // ArcGIS mirror is the verified keyless replacement. Dated snapshot → env-swappable.
  "hamilton-oh": {
    urls: [
      env(
        "HAMILTON_PARCEL_QUERY_URL",
        "https://services8.arcgis.com/YU1yCuZZBuqsMM2h/arcgis/rest/services/Parcel_Polygons_20241008/FeatureServer/0/query",
      ),
    ],
    ownerField: "OWNNM1",
    situsNumField: "ADDRNO",
    situsStreetField: "ADDRST",
    situsSuffixField: "ADDRSF",
    // OWNAD2 is the "CITY ST ZIP" line (captured separately) — keep only the street line.
    mailFields: ["OWNAD1"],
    mailCityField: "OWNADCITY",
    mailStateField: "OWNADSTATE",
    mailZipField: "OWNADZIP",
    parcelIdField: "PARCELID",
    defaultCity: "Cincinnati",
    state: "OH",
  },
  // Montgomery County AL — county Revenue's self-hosted KCS GIS (owner+situs+mailing,
  // 105k parcels). Host is kcsgis.com (NOT arcgis.com) — base.ts bypasses it for direct
  // fetch. Values are space-padded fixed-width; s()/trim handles it.
  "montgomery-al": {
    urls: [
      env(
        "MONTGOMERY_AL_PARCEL_QUERY_URL",
        "https://al03montrevenue.kcsgis.com/kcsgis/rest/services/Montgomery/AL03_Public_ISV/MapServer/29/query",
      ),
    ],
    ownerField: "OwnerName",
    situsDisplayField: "PropertyAddr1",
    situsCityField: "PropertyCity",
    situsZipField: "PropertyZip",
    mailFields: ["MailAddress1", "MailAddress2"],
    mailCityField: "MailCity",
    mailStateField: "MailState",
    mailZipField: "MailZip",
    parcelIdField: "ParcelNo",
    defaultCity: "Montgomery",
    state: "AL",
  },
  // Hamilton County TN — City of Chattanooga public-works GIS parcel layer
  // (owner + situs + true mailing, 85,704 parcels, 23 placeholder rows).
  // COVERAGE CAVEAT: this layer is CHATTANOOGA CITY LIMITS ONLY. The county-wide
  // roll is 169,055 parcels and is published *only* as a 128 MB CSV zip
  // (_downloadsAssessor/AssessorExportCSV.zip) — too large to hold in a request,
  // so it is deliberately not the completer. Leads in Signal Mountain / Soddy-Daisy /
  // Collegedale / unincorporated Hamilton will therefore fail to complete and be
  // dropped by the save gate. Tax Delinquent does NOT depend on this — the Trustee
  // delinquent file already carries owner+mailing+situs county-wide (see tennessee.ts).
  // MASTNAME (not MASTNUM) holds the whole mailing street line; MASTNUM is blank.
  "hamilton-tn": {
    urls: [
      env(
        "HAMILTON_TN_PARCEL_QUERY_URL",
        "https://pwgis.chattanooga.gov/arcgis/rest/services/Misc/Parcels/FeatureServer/0/query",
      ),
    ],
    ownerField: "OWNERNAME1",
    situsDisplayField: "ADDRESS",
    mailFields: ["MASTNAME", "MALINE2"],
    mailCityField: "MACITY",
    mailStateField: "MASTATE",
    mailZipField: "MAZIP",
    // "154J A 015" — same shape the Herald foreclosure notices print as "Parcel ID".
    parcelIdField: "TAX_MAP_NO",
    defaultCity: "Chattanooga",
    state: "TN",
  },
  // Orange County CA — official County GIS joined parcel roll. It exposes owner,
  // situs, mailing address, and APN without an account. The street is split into
  // number + directional prefix + name + suffix, so avoid the combined display
  // field, which also appends the city.
  "orange-ca": {
    urls: [
      env(
        "ORANGE_CA_PARCEL_QUERY_URL",
        "https://www.ocgis.com/arcpub/rest/services/CEO_RealEstate/RealEstateOCParcels/MapServer/0/query",
      ),
    ],
    ownerField: "OWNER_NAME",
    situsNumField: "SITE_ADDR_",
    situsStreetField: "SITE_STREE",
    situsStreetExtraField: "SITE_STR_1",
    situsSuffixField: "SITE_STR_2",
    situsCityField: "SITE_CITY_",
    situsZipField: "SITE_ZIP5",
    mailFields: ["MAIL_ADDR_", "MAIL_PREFI", "MAIL_STREE", "MAIL_UNIT_", "MAIL_SUFFI"],
    mailCityField: "MAIL_CITY_",
    mailZipField: "MAIL_ZIP5",
    parcelIdField: "ASSESSMENT",
    defaultCity: "Santa Ana",
    state: "CA",
  },
};

function rollSpecKey(county: string, state: string): string {
  return `${county
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .replace(/\s+/g, "-")}-${state.toLowerCase()}`;
}

function s(v: unknown): string {
  return v == null ? "" : String(v).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function rollOutFields(spec: RollSpec): string {
  const fields = [
    spec.ownerField,
    spec.situsDisplayField,
    spec.situsNumField,
    spec.situsStreetField,
    spec.situsStreetExtraField,
    spec.situsSuffixField,
    spec.situsCityField,
    spec.situsZipField,
    ...spec.mailFields,
    spec.mailCityField,
    spec.mailStateField,
    spec.mailZipField,
    spec.parcelIdField,
  ].filter(Boolean) as string[];
  return [...new Set(fields)].join(",");
}

function buildSitus(attrs: Record<string, unknown>, spec: RollSpec): string {
  if (spec.situsDisplayField) {
    // Some display fields append the state and/or zip — strip it to a clean street line.
    const disp = s(attrs[spec.situsDisplayField])
      .replace(/[,\s]+(MO|OH|AL|CA)\s*(\d{5}(-\d{4})?)?\s*$/i, "")
      .trim();
    if (disp && /^\d/.test(disp)) return disp;
  }
  const parts = [
    spec.situsNumField ? s(attrs[spec.situsNumField]) : "",
    spec.situsStreetField ? s(attrs[spec.situsStreetField]) : "",
    spec.situsStreetExtraField ? s(attrs[spec.situsStreetExtraField]) : "",
    spec.situsSuffixField ? s(attrs[spec.situsSuffixField]) : "",
  ].filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function trimStateFromCity(value: string, state: string): string {
  return value.replace(new RegExp(`[,\\s]+${state}\\s*$`, "i"), "").trim();
}

function mapRollFeature(attrs: Record<string, unknown>, spec: RollSpec): AssessorProperty | null {
  const owner = decodeHtmlEntities(s(attrs[spec.ownerField]));
  const situs = buildSitus(attrs, spec);
  // Require a real owner name and a situs that begins with a house number.
  if (!owner || !/^\d+\s+\S/.test(situs)) return null;
  const mailing = spec.mailFields
    .map((f) => s(attrs[f]))
    .filter(Boolean)
    .join(" ")
    .trim();
  return {
    address: situs,
    city: trimStateFromCity(
      (spec.situsCityField && s(attrs[spec.situsCityField])) || spec.defaultCity,
      spec.state,
    ),
    state: spec.state,
    zip: (spec.situsZipField && s(attrs[spec.situsZipField]).slice(0, 5)) || undefined,
    parcelId: (spec.parcelIdField && s(attrs[spec.parcelIdField])) || undefined,
    ownerName: owner,
    mailingAddress: mailing || undefined,
    mailingCity:
      (spec.mailCityField && trimStateFromCity(s(attrs[spec.mailCityField]), spec.state)) || undefined,
    mailingState: (spec.mailStateField && s(attrs[spec.mailStateField])) || spec.state,
    mailingZip: (spec.mailZipField && s(attrs[spec.mailZipField]).slice(0, 5)) || undefined,
  };
}

async function queryRoll(spec: RollSpec, where: string, limit = 5): Promise<AssessorProperty[]> {
  const out: AssessorProperty[] = [];
  for (const base of spec.urls) {
    try {
      const qUrl = new URL(base);
      qUrl.searchParams.set("where", where);
      qUrl.searchParams.set("outFields", rollOutFields(spec));
      qUrl.searchParams.set("returnGeometry", "false");
      qUrl.searchParams.set("resultRecordCount", String(limit));
      qUrl.searchParams.set("f", "json");
      const res = await fetchWithRetry(qUrl.toString());
      if (!res.ok) continue;
      const data = (await res.json()) as { features?: { attributes: Record<string, unknown> }[] };
      for (const f of data.features || []) {
        const mapped = mapRollFeature(f.attributes, spec);
        if (mapped) out.push(mapped);
      }
      if (out.length >= limit) break;
    } catch {
      /* try next endpoint */
    }
  }
  return out.slice(0, limit);
}

/** Owner-name → complete properties (situs + mailing) from the county roll. */
async function rollLookupByOwner(spec: RollSpec, ownerName: string): Promise<AssessorProperty[]> {
  const { last } = parseName(ownerName);
  if (!last || last.length < 2) return [];
  const safe = last.toUpperCase().replace(/'/g, "''");
  return queryRoll(spec, `UPPER(${spec.ownerField}) LIKE '%${safe}%'`, 5);
}

/** Situs address → owner + mailing from the county roll (conservative match). */
async function rollLookupByAddress(
  spec: RollSpec,
  streetNum: string,
  streetRest: string,
): Promise<AssessorProperty | null> {
  const rest = streetRest.toUpperCase().replace(/'/g, "''").trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const firstTok =
    tokens.find((token) => !/^(N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST)$/i.test(token)) ||
    tokens[0] ||
    rest;
  if (!streetNum || !firstTok) return null;

  const queryStreetField = spec.situsStreetExtraField || spec.situsStreetField;
  const where = spec.situsDisplayField
    ? `UPPER(${spec.situsDisplayField}) LIKE '${streetNum} %${firstTok}%'`
    : `${spec.situsNumField}='${streetNum}' AND UPPER(${queryStreetField}) LIKE '%${firstTok}%'`;

  const results = await queryRoll(spec, where, 8);
  // Conservative: keep only rows whose situs starts with the same house number
  // and whose street contains the first significant token — else skip (no guess).
  const match = results.find((r) => {
    const situs = r.address.toUpperCase();
    return situs.startsWith(`${streetNum} `) && situs.includes(firstTok);
  });
  return match || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// E-Ring "Citizen Access Portal" roll (CaptureCAMA family) — Alabama counties
//
// POST {express}/SearchRP returns owner + situs + mailing (+ class/tax fields) in
// ONE record, queryable by owner name (searchtype=1) or situs address (4). These
// hosts serve JSON directly to datacenter IPs (Jefferson's E-Ring express even
// bypasses the gis.jccal.org Imperva WAF). Validated live per county.
// ─────────────────────────────────────────────────────────────────────────────

interface ERingTenant {
  tenant: string;
  express: string;
  defaultCity: string;
  /** Express host blocks datacenter IPs — go straight through Bright Data. */
  proxyOnly?: boolean;
}

const ERING_TENANTS: Record<string, ERingTenant> = {
  "autauga-al": {
    tenant: env("AUTAUGA_ERING_TENANT", "https://autauga.capturecama.com"),
    express: env("AUTAUGA_ERING_EXPRESS", "https://prodexpress.capturecama.com"),
    defaultCity: "Prattville",
  },
  "elmore-al": {
    tenant: env("ELMORE_ERING_TENANT", "https://elmorerevenuecommissioner.net"),
    express: env("ELMORE_ERING_EXPRESS", "https://prodexpress.capturecama.com"),
    defaultCity: "Wetumpka",
  },
  "jefferson-al": {
    tenant: env("JEFFERSON_ERING_TENANT", "https://eringcapture.jccal.org"),
    express: env("JEFFERSON_ERING_EXPRESS", "https://jeffersonexpress.capturecama.com"),
    defaultCity: "Birmingham",
  },
  "shelby-al": {
    tenant: env("SHELBY_ERING_TENANT", "https://ptc.shelbyal.com"),
    express: env("SHELBY_ERING_EXPRESS", "https://ptcexpress.shelbyal.com"),
    defaultCity: "Columbiana",
  },
  "morgan-al": {
    tenant: env("MORGAN_ERING_TENANT", "https://morgan.capturecama.com"),
    express: env("MORGAN_ERING_EXPRESS", "https://prodexpress.capturecama.com"),
    defaultCity: "Decatur",
  },
  // Limestone's express host blocks datacenter IPs → residential proxy only.
  // NOTE: never route Limestone's tenantUrl through prodexpress — it silently
  // falls back to a DEFAULT tenant (Monroe County) and returns wrong-county data.
  "limestone-al": {
    tenant: env("LIMESTONE_ERING_TENANT", "https://limestonerevenue.net"),
    express: env("LIMESTONE_ERING_EXPRESS", "https://express.limestonerevenue.net"),
    defaultCity: "Athens",
    proxyOnly: true,
  },
};

function eRingRecordYear(): number {
  return new Date().getFullYear();
}

/** POST to an E-Ring express host via curl (--insecure like the county TLS quirk), Bright Data fallback. */
function fetchERingJson<T>(
  express: string,
  path: string,
  body: Record<string, unknown>,
  proxyOnly = false,
): T | null {
  const url = `${express}${path}`;
  const runCurl = (proxy?: string): string => {
    const args = ["-sS", "--insecure", "-X", "POST", url, "--max-time", "25"];
    if (proxy) args.push("-x", proxy);
    args.push(
      "-H",
      "Content-Type: application/json",
      "-H",
      "Accept: application/json",
      "-H",
      "Referring-Page: propsearch",
      "--data",
      JSON.stringify(body),
    );
    const result = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 12 * 1024 * 1024 });
    return result.stdout?.trim() || "";
  };
  const user = process.env.BRIGHT_DATA_USER;
  const pass = process.env.BRIGHT_DATA_PASS;
  const proxy = user && pass ? `http://${user}:${pass}@brd.superproxy.io:22225` : undefined;

  // proxyOnly hosts block datacenter IPs — skip the (timeout-prone) direct attempt.
  let stdout = proxyOnly ? (proxy ? runCurl(proxy) : "") : runCurl();
  if (!stdout && !proxyOnly && proxy) stdout = runCurl(proxy);
  if (!stdout) return null;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

function mapERingRecord(r: Record<string, unknown>, defaultCity: string): AssessorProperty | null {
  const owner = decodeHtmlEntities(s(r.MigratedOwners));
  const situs = s(r.PropAddr1);
  // Require a real owner name and a house-numbered situs street.
  if (!owner || !/^\d+\s+\S/.test(situs)) return null;
  const mailStreet = [s(r.Address1), s(r.Address2)].filter(Boolean).join(" ").trim();
  return {
    address: situs,
    city: s(r.PropCity) || defaultCity,
    state: "AL",
    zip: s(r.PropZip).slice(0, 5) || undefined,
    parcelId: s(r.ParcelNo) || undefined,
    ownerName: owner,
    mailingAddress: mailStreet || undefined,
    mailingCity: s(r.City) || undefined,
    mailingState: s(r.State) || "AL",
    mailingZip: s(r.Zip).slice(0, 5) || undefined,
  };
}

/** searchtype: 1 = owner name, 4 = property/situs address (both CONTAINS). */
function queryERing(
  tenant: ERingTenant,
  searchstring: string,
  searchtype: 1 | 4,
  limit = 8,
): AssessorProperty[] {
  const data = fetchERingJson<Array<Record<string, unknown>>>(
    tenant.express,
    "/SearchRP",
    {
      tenantUrl: tenant.tenant,
      expressUrl: tenant.express,
      reserved: 0,
      searchstring,
      searchtype,
      recordyear: eRingRecordYear(),
    },
    tenant.proxyOnly,
  );
  if (!Array.isArray(data)) return [];
  const out: AssessorProperty[] = [];
  for (const r of data.slice(0, 300)) {
    const mapped = mapERingRecord(r, tenant.defaultCity);
    if (mapped) out.push(mapped);
    if (out.length >= limit) break;
  }
  return out;
}

function eRingLookupByOwner(tenant: ERingTenant, ownerName: string): AssessorProperty[] {
  const { last, first } = parseName(ownerName);
  if (!last || last.length < 2) return [];
  const q = first ? `${last} ${first}` : last;
  return queryERing(tenant, q, 1, 5);
}

const STREET_SUFFIX: Record<string, string> = {
  AVENUE: "AVE",
  STREET: "ST",
  ROAD: "RD",
  DRIVE: "DR",
  PLACE: "PL",
  LANE: "LN",
  COURT: "CT",
  BOULEVARD: "BLVD",
  TERRACE: "TER",
  CIRCLE: "CIR",
  PARKWAY: "PKWY",
  HIGHWAY: "HWY",
  TRAIL: "TRL",
  ROUTE: "RT",
};

/** Normalized street tokens (suffix-canonicalized) for precise address matching. */
function streetTokens(addr: string): string[] {
  return addr
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_SUFFIX[t] || t);
}

function eRingLookupByAddress(
  tenant: ERingTenant,
  streetNum: string,
  streetRest: string,
): AssessorProperty | null {
  const rest = streetRest.trim();
  const firstTok = rest.split(/\s+/).filter(Boolean)[0] || "";
  if (!streetNum || !firstTok) return null;
  const results = queryERing(tenant, `${streetNum} ${firstTok}`, 4, 25);
  const want = streetTokens(`${streetNum} ${rest}`);
  // Require the house number AND every (suffix-normalized) street token to be
  // present — Birmingham's lettered grid means "2608 AVENUE T" must NOT match
  // "2608 AVENUE B"; the old house-number+first-token check silently did.
  return (
    results.find((r) => {
      const got = new Set(streetTokens(r.address));
      return got.has(streetNum) && want.every((t) => got.has(t));
    }) || null
  );
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

const MAIL_STREET_SUFFIX = new Set([
  "ST", "AVE", "AVENUE", "BLVD", "RD", "DR", "DRIVE", "LN", "LANE", "CT", "COURT",
  "PL", "PLACE", "TER", "TERRACE", "TRFY", "TFWY", "PKWY", "PARKWAY", "HWY", "HIGHWAY",
  "CIR", "CIRCLE", "WAY", "TRL", "TRAIL", "BOX", "LOOP", "PLAZA", "SQ", "ROW", "RUN",
  "PT", "PATH", "PIKE", "BEND", "PASS", "XING", "COVE", "STE", "APT", "UNIT",
]);

/**
 * Parse a combined single-string mailing address ("STREET [UNIT] CITY, ST ZIP")
 * into street / city / state / zip. Used for Jackson County MO, whose roll stores
 * the owner mailing address as one field (`address_compl`).
 */
function parseCombinedMailing(raw: unknown): {
  mailingAddress?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingZip?: string;
} {
  const str = s(raw);
  if (!str || str.length < 5) return {};
  const m = str.match(/^(.*?)[,\s]+([A-Z]{2})\.?\s+(\d{5})(?:-\d{4})?\s*$/i);
  if (!m) return { mailingAddress: str };
  const state = m[2].toUpperCase();
  const zip = m[3];
  const left = m[1].replace(/,\s*$/, "").trim();
  const toks = left.split(/\s+/).filter(Boolean);
  let cut = -1;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i].replace(/[^A-Z0-9#]/gi, "").toUpperCase();
    if (/^\d+$/.test(t) || /^\d+[A-Z]$/.test(t) || MAIL_STREET_SUFFIX.has(t) || toks[i].startsWith("#")) {
      cut = i;
      break;
    }
  }
  if (cut >= 0 && cut < toks.length - 1) {
    return {
      mailingAddress: toks.slice(0, cut + 1).join(" "),
      mailingCity: toks.slice(cut + 1).join(" "),
      mailingState: state,
      mailingZip: zip,
    };
  }
  return { mailingAddress: left, mailingState: state, mailingZip: zip };
}

function mapJacksonMarketFeature(attrs: Record<string, string>): AssessorProperty | null {
  const address = attrs.situs_address?.trim();
  const ownerName = (attrs.owner_info || "").split("|")[0]?.trim();
  if (!address || !ownerName) return null;
  // `address_compl` is the owner MAILING address (equals situs for owner-occupants;
  // an out-of-town/out-of-state address for absentees) — the county's only mailing field.
  const mail = parseCombinedMailing(attrs.address_compl);
  return {
    address,
    city: attrs.situs_city?.trim() || "Kansas City",
    state: "MO",
    zip: attrs.situs_zip?.trim() || undefined,
    parcelId: attrs.parcel_number?.trim() || undefined,
    ownerName,
    mailingAddress: mail.mailingAddress,
    mailingCity: mail.mailingCity,
    mailingState: mail.mailingState || "MO",
    mailingZip: mail.mailingZip,
  };
}

async function queryJacksonMarketValue(where: string, limit = 5): Promise<AssessorProperty[]> {
  const qUrl = new URL(JACKSON_MARKET_VALUE_URL);
  qUrl.searchParams.set("where", where);
  qUrl.searchParams.set(
    "outFields",
    "parcel_number,situs_address,situs_city,situs_zip,owner_info,address_compl",
  );
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

  // Shared parcel roll first (Clay/Platte/Cass MO, Hamilton OH, …) — the verified
  // owner+situs+mailing source. Falls through to bespoke per-county paths below.
  const specKey = rollSpecKey(county, state);
  const rollSpec = ROLL_SPECS[specKey];
  if (rollSpec) {
    const rollMatch = await rollLookupByAddress(rollSpec, streetNum, parts.slice(1).join(" "));
    if (rollMatch) return rollMatch;
  }

  // Alabama E-Ring portal roll (situs address → owner + mailing).
  const eRingAddr = ERING_TENANTS[specKey];
  if (eRingAddr) {
    const m = eRingLookupByAddress(eRingAddr, streetNum, parts.slice(1).join(" "));
    if (m) return m;
  }

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
        // Madison AL AssuranceWeb portal (owner + situs + mailing). The old
        // V6ZHFr6zdgNZuVG0 ArcGIS endpoint was fake/wrong-county — replaced.
        const m = await madisonLookupByAddress(streetNum, parts.slice(1).join(" ") || streetName);
        if (m) return m;
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
  const specKey = rollSpecKey(county, state);

  // Shared parcel roll first — verified owner+situs+mailing source.
  const rollSpec = ROLL_SPECS[specKey];
  if (rollSpec) {
    try {
      const rollResults = await rollLookupByOwner(rollSpec, ownerName);
      if (rollResults.length) {
        return rollResults.filter((r) => r.address && /\d+\s+[A-Za-z]/.test(r.address));
      }
    } catch {
      /* fall through */
    }
  }

  // Alabama E-Ring portal roll (owner+situs+mailing in one record).
  const eRing = ERING_TENANTS[specKey];
  if (eRing) {
    try {
      const r = eRingLookupByOwner(eRing, ownerName);
      if (r.length) return r.filter((x) => x.address && /\d+\s+[A-Za-z]/.test(x.address));
    } catch {
      /* fall through to bespoke lookup */
    }
  }

  // Madison AL AssuranceWeb portal (owner + situs + mailing).
  if (specKey === "madison-al") {
    try {
      const r = await madisonLookupByOwner(ownerName);
      if (r.length) return r.filter((x) => x.address && /\d+\s+[A-Za-z]/.test(x.address));
    } catch {
      /* fall through */
    }
  }

  const fn = LOOKUP_MAP[specKey as CountyKey];
  if (!fn) return [];
  try {
    const results = await fn(ownerName);
    return results.filter((r) => r.address && /\d+\s+[A-Za-z]/.test(r.address));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Roll-derived lead scans (keyless, always-current, complete owner+situs+mailing)
// Only for counties whose roll is a queryable ArcGIS FeatureServer (ROLL_SPECS).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Government / municipal / institutional owners — not sellable, excluded from leads.
 *
 * Bare "COUNTY" (not just "COUNTY OF") is matched because rolls record the county
 * itself as "HAMILTON COUNTY", "HAMILTON COUNTY DEPT OF EDUCATION", "HAMILTON
 * COUNTY & CHATT CITY OF" and so on — 349 parcels in Hamilton TN alone, none of
 * which "COUNTY OF" catches. All 40 distinct owner strings containing "COUNTY" on
 * that roll are government bodies.
 *
 * The federal land agencies and TVA/EPB are listed for the same reason: the
 * National Park Service and Tennessee Valley Authority are large landowners around
 * Chattanooga and were otherwise surfacing as Out-of-State Owner leads.
 */
const GOV_OWNER_RE =
  /\b(CITY OF|COUNTY|STATE OF|TOWN OF|VILLAGE OF|UNITED STATES|U\.?S\.?A|NATIONAL PARK|PARK SERVICE|FOREST SERVICE|TENNESSEE VALLEY|TVA|ELECTRIC POWER BOARD|HOUSING AUTHORITY|LAND BANK|LAND TRUST|SCHOOL|BOARD OF EDUC|UNIVERSITY|COLLEGE|CHURCH|MINISTR|FIRE DIST|FIRE PROTECT|WATER (DIST|WORKS|AUTH)|SEWER|PARK (DIST|BOARD)|DEPARTMENT OF|COMMISSION|AUTHORITY|CEMETERY|PRESERV|CONSERVAT|MUNICIPAL|REDEVELOP|HABITAT FOR|FANNIE MAE|FREDDIE MAC|FEDERAL (HOME|NATIONAL)|SECRETARY OF|VETERANS AFFAIRS|\bHUD\b|DRAINAGE|LEVEE|LIBRARY|HOSPITAL|FOUNDATION|GAS (CO|COMPANY|& |AND )|ELECTRIC (CO|COMPANY|POWER)|DUKE ENERGY|\bAEP\b|AMERICAN ELECTRIC|ENERGY (CO|CORP|INC|OHIO|LLC|SERVICES)|POWER (CO|COMPANY)|UTILIT|SANITARY|TRANSIT AUTH|PORT AUTH|TURNPIKE|RAILROAD|RAILWAY|\bRR CO|PIPELINE|TELEPHONE|ACADEMY|INSTITUTE|SEMINARY|ARCHDIOCESE|DIOCESE)/i;

export function isGovernmentOwner(name: string | null | undefined): boolean {
  const n = (name || "").toUpperCase();
  return !!n && GOV_OWNER_RE.test(n);
}

function getRollSpec(county: string, state: string): RollSpec | undefined {
  return ROLL_SPECS[rollSpecKey(county, state)];
}

/** Parcel-id → property (true situs + owner + mailing) from a county's ArcGIS roll. */
export async function lookupByParcel(
  county: string,
  state: string,
  parcelId: string | null | undefined,
): Promise<AssessorProperty | null> {
  const spec = getRollSpec(county, state);
  if (!spec?.parcelIdField || !parcelId) return null;
  const raw = String(parcelId).replace(/[^0-9A-Za-z]/g, "");
  const candidates = new Set([String(parcelId).trim(), raw].filter(Boolean));
  // Hamilton OH: tax-roll parcel (13 digits) → GIS PARCELID = "0" + first 11 digits.
  if (rollSpecKey(county, state) === "hamilton-oh" && /^\d{13}$/.test(raw)) {
    candidates.add("0" + raw.slice(0, 11));
  }
  for (const c of candidates) {
    const res = await queryRoll(spec, `${spec.parcelIdField}='${c.replace(/'/g, "''")}'`, 1);
    if (res[0]) return res[0];
  }
  return null;
}

export function rollSupportsCounty(county: string, state: string): boolean {
  return !!getRollSpec(county, state);
}

/**
 * lat/long point → property (owner + situs + mailing) via a spatial parcel query.
 * For coordinate-only sources (e.g. Cincinnati open-data foreclosure / vacant
 * registries that carry latitude/longitude but no street field). Verified live:
 * a point inside a Hamilton parcel returns OWNNM1 + situs + owner mailing.
 */
export async function lookupByPoint(
  lon: number | string,
  lat: number | string,
  county: string,
  state: string,
): Promise<AssessorProperty | null> {
  const spec = getRollSpec(county, state);
  if (!spec) return null;
  const lonN = Number(lon);
  const latN = Number(lat);
  if (!isFinite(lonN) || !isFinite(latN) || (lonN === 0 && latN === 0)) return null;
  for (const base of spec.urls) {
    try {
      const qUrl = new URL(base);
      qUrl.searchParams.set("geometry", `${lonN},${latN}`);
      qUrl.searchParams.set("geometryType", "esriGeometryPoint");
      qUrl.searchParams.set("inSR", "4326");
      qUrl.searchParams.set("spatialRel", "esriSpatialRelIntersects");
      qUrl.searchParams.set("outFields", rollOutFields(spec));
      qUrl.searchParams.set("returnGeometry", "false");
      qUrl.searchParams.set("resultRecordCount", "1");
      qUrl.searchParams.set("f", "json");
      const res = await fetchWithRetry(qUrl.toString());
      if (!res.ok) continue;
      const data = (await res.json()) as { features?: { attributes: Record<string, unknown> }[] };
      const mapped = data.features?.[0] && mapRollFeature(data.features[0].attributes, spec);
      if (mapped) return mapped;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

/** Out-of-State Owner: mailing state ≠ property state (a strong absentee-seller signal). */
export async function scanOutOfStateOwners(
  county: string,
  state: string,
  limit = 200,
): Promise<AssessorProperty[]> {
  const spec = getRollSpec(county, state);
  if (!spec?.mailStateField) return [];
  const f = spec.mailStateField;
  // NOT LIKE 'STATE%' (not <> 'STATE') so space-padded fixed-width values (e.g. "AL  ")
  // are still recognized as in-state and excluded.
  const where = `${f} IS NOT NULL AND ${f} <> '' AND ${f} <> ' ' AND UPPER(${f}) NOT LIKE '${spec.state}%'`;
  const props = await queryRoll(spec, where, limit);
  return props.filter((p) => {
    const ms = (p.mailingState || "").toUpperCase().trim();
    return (
      /^[A-Z]{2}$/.test(ms) &&
      ms !== spec.state &&
      !!p.mailingAddress &&
      !isGovernmentOwner(p.ownerName)
    );
  });
}

/**
 * Absentee Owner: the owner's mailing address differs from the property's situs
 * address (they don't live there) but is still IN-state — the in-state complement
 * to Out-of-State Owner, so the two lists don't overlap. Pure roll-derived, already
 * complete (owner + situs + mailing). Conservative: a row counts as owner-occupied
 * (excluded) only when the mailing clearly contains the situs house# AND street.
 */
export async function scanAbsenteeOwners(
  county: string,
  state: string,
  limit = 200,
): Promise<AssessorProperty[]> {
  const spec = getRollSpec(county, state);
  if (!spec) return [];
  // Prefer in-state rows so this doesn't duplicate the Out-of-State list.
  const f = spec.mailStateField;
  // LIKE 'STATE%' so space-padded in-state values (e.g. "AL  ") still match.
  const where = f
    ? `${f} IS NULL OR ${f} = '' OR UPPER(${f}) LIKE '${spec.state}%'`
    : "1=1";
  const props = await queryRoll(spec, where, Math.min(limit * 8, 2500));
  const out: AssessorProperty[] = [];
  const seen = new Set<string>();
  for (const p of props) {
    if (!p.address || !p.mailingAddress || isGovernmentOwner(p.ownerName)) continue;
    const ms = (p.mailingState || "").toUpperCase().trim();
    if (ms && ms !== spec.state) continue; // out-of-state handled elsewhere
    const situsToks = streetTokens(p.address);
    const mailToks = new Set(streetTokens(p.mailingAddress));
    const situsNum = situsToks[0];
    const situsStreet = situsToks.find((t) => !/^\d+$/.test(t) && !STREET_DIRECTIONALS.has(t));
    // Owner-occupied when the mailing carries the same house number AND street name.
    const occupied = !!situsNum && mailToks.has(situsNum) && !!situsStreet && mailToks.has(situsStreet);
    if (occupied) continue;
    if (!/^\d/.test(p.mailingAddress.trim()) && !/P\.?\s?O\.?\s?BOX/i.test(p.mailingAddress)) continue;
    const key = p.parcelId || `${p.ownerName}|${p.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Probate/Estate: owner recorded as a deceased person's estate or heirs.
 * Conservative — excludes company names ("REAL ESTATE", "…ESTATES LLC",
 * subdivisions) that merely contain the word "estate", to avoid wrong-owner leads.
 */
const ESTATE_COMPANY_RE =
  /\b(LLC|L L C|INC|CORP|COMPANY|CO|HOLDINGS?|DEVELOP|REAL ESTATE|ESTATES|PROPERT|PARTNERS?|LP|LLP|LTD|BANK|ASSOC|INVESTMENT|CAPITAL|GROUP|ENTERPRISE|MANAGEMENT|REALTY|FARMS)\b/i;
const ESTATE_PERSON_RE = /(ESTATE OF|LIFE ESTATE|\bHEIRS?\b|\bEST\b|[A-Z]\s+ESTATE\b)/i;

export async function scanEstateOwners(
  county: string,
  state: string,
  limit = 200,
): Promise<AssessorProperty[]> {
  const spec = getRollSpec(county, state);
  if (!spec) return [];
  const f = spec.ownerField;
  // Anchor at the DB: names ENDING in " ESTATE", or containing "ESTATE OF"/"HEIRS"/
  // "LIFE ESTATE" — this excludes "…ESTATES LLC"/subdivisions before the fetch cap.
  const where =
    `UPPER(${f}) LIKE '% ESTATE' OR UPPER(${f}) LIKE '%ESTATE OF%' OR ` +
    `UPPER(${f}) LIKE '%LIFE ESTATE%' OR UPPER(${f}) LIKE '%HEIRS%'`;
  const props = await queryRoll(spec, where, Math.min(limit * 3, 600));
  return props
    .filter((p) => {
      const n = (p.ownerName || "").toUpperCase();
      if (!p.mailingAddress || isGovernmentOwner(n)) return false;
      if (ESTATE_COMPANY_RE.test(n)) return false; // "REAL ESTATE"/"ESTATES LLC"/subdivisions
      return ESTATE_PERSON_RE.test(n);
    })
    .slice(0, limit);
}

/**
 * Generic roll scan by an arbitrary WHERE clause — returns complete (owner+situs+
 * mailing) rows, government owners dropped. Used for county-specific roll-derived
 * types whose signal is a native field (e.g. Hamilton OH `DELQ_TAXES` tax-delinquent,
 * `HMSD_FLAG` senior/homestead, `SALDAT` long-time owner). Only fields present on the
 * layer are needed in the WHERE — outFields stay owner+situs+mailing.
 */
export async function scanRollByWhere(
  county: string,
  state: string,
  where: string,
  limit = 250,
): Promise<AssessorProperty[]> {
  const spec = getRollSpec(county, state);
  if (!spec) return [];
  const props = await queryRoll(spec, where, Math.min(limit * 2, 1500));
  return props
    .filter((p) => p.address && p.mailingAddress && !isGovernmentOwner(p.ownerName))
    .slice(0, limit);
}

// ─── Jackson County MO roll-derived scans ────────────────────────────────────
// Jackson isn't a generic ROLL_SPEC (owner_info is pipe-delimited, mailing is the
// single combined `address_compl`), so it gets bespoke scans over Parcels_Market_Value.
export async function scanJacksonOutOfState(limit = 250): Promise<AssessorProperty[]> {
  const where =
    "situs_address IS NOT NULL AND address_compl IS NOT NULL AND address_compl NOT LIKE '%, MO%'";
  const props = await queryJacksonMarketValue(where, limit);
  return props.filter((p) => {
    const ms = (p.mailingState || "").toUpperCase().trim();
    return /^[A-Z]{2}$/.test(ms) && ms !== "MO" && !!p.mailingAddress && !isGovernmentOwner(p.ownerName);
  });
}

export async function scanJacksonAbsentee(limit = 250): Promise<AssessorProperty[]> {
  const where =
    "situs_address IS NOT NULL AND address_compl IS NOT NULL AND address_compl LIKE '%, MO%'";
  const props = await queryJacksonMarketValue(where, Math.min(limit * 6, 2000));
  const out: AssessorProperty[] = [];
  const seen = new Set<string>();
  for (const p of props) {
    if (!p.address || !p.mailingAddress || isGovernmentOwner(p.ownerName)) continue;
    if ((p.mailingState || "").toUpperCase().trim() !== "MO") continue;
    const situsToks = streetTokens(p.address);
    const mailToks = new Set(streetTokens(p.mailingAddress));
    const situsNum = situsToks[0];
    const situsStreet = situsToks.find((t) => !/^\d+$/.test(t) && !STREET_DIRECTIONALS.has(t));
    const occupied = !!situsNum && mailToks.has(situsNum) && !!situsStreet && mailToks.has(situsStreet);
    if (occupied) continue;
    const key = p.parcelId || `${p.ownerName}|${p.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export async function scanJacksonEstate(limit = 200): Promise<AssessorProperty[]> {
  const where =
    "situs_address IS NOT NULL AND (UPPER(owner_info) LIKE '% ESTATE' OR " +
    "UPPER(owner_info) LIKE '%ESTATE OF%' OR UPPER(owner_info) LIKE '%LIFE ESTATE%' OR " +
    "UPPER(owner_info) LIKE '%HEIRS%')";
  const props = await queryJacksonMarketValue(where, Math.min(limit * 3, 600));
  return props
    .filter((p) => {
      const n = (p.ownerName || "").toUpperCase();
      if (!p.mailingAddress || isGovernmentOwner(n) || ESTATE_COMPANY_RE.test(n)) return false;
      return ESTATE_PERSON_RE.test(n);
    })
    .slice(0, limit);
}
// NOTE: A duplicate, half-merged `skipTraceOwner` (Tracerfy) once lived here but
// referenced symbols (`str`, `TRACERFY_DEFAULT_URL`, `SkipTraceOwner`) that are only
// defined in services/skip-trace.service.ts — it was dead and would ReferenceError if
// called. The real, complete skip-trace lives in services/skip-trace.service.ts.
