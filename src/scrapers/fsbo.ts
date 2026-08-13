// @ts-nocheck
/**
 * FSBO (For Sale By Owner) — portable, keyless, complete.
 *
 * Source: forsalebyowner.com's undocumented but keyless JSON search API
 *   POST https://directory.forsalebyowner.com/search/listings
 *   body {"listing_search":{"slug":"<city>-<state>","page":N}}
 * Each listing carries seller name + full property address + COUNTY + coords.
 * Verified live 2026-07-07 from a datacenter IP (Railway-safe) for every target
 * metro. Craigslist/Zillow/fsbo.com are all IP/bot-walled and were rejected.
 *
 * Completeness: the listing lacks a mailing address, so we run each property
 * address through the county completer (parcel roll / E-Ring) to attach the
 * owner-of-record + mailing address. Only rows that complete are emitted; the
 * save gate drops the rest.
 */

import { Lead, makeId, formatDate } from "./base.js";
import { lookupByAddress, isGovernmentOwner } from "./assessor.js";

const FSBO_ENDPOINT = "https://directory.forsalebyowner.com/search/listings";
const FSBO_SOURCE = "https://www.forsalebyowner.com";

/** City slugs to query per county (slug = "<city-hyphenated>-<full-state-name>").
 *  The API returns the whole metro; we then keep only rows whose address.county
 *  matches, so a couple of anchor cities per county is enough. */
const FSBO_METROS: Record<string, string[]> = {
  "MO:Jackson": [
    "kansas-city-missouri",
    "independence-missouri",
    "lees-summit-missouri",
    "blue-springs-missouri",
    "raytown-missouri",
    "grandview-missouri",
  ],
  "MO:Clay": [
    "kansas-city-missouri",
    "liberty-missouri",
    "gladstone-missouri",
    "kearney-missouri",
    "smithville-missouri",
  ],
  "MO:Platte": [
    "kansas-city-missouri",
    "parkville-missouri",
    "platte-city-missouri",
    "riverside-missouri",
  ],
  "MO:Cass": [
    "belton-missouri",
    "raymore-missouri",
    "harrisonville-missouri",
    "pleasant-hill-missouri",
  ],
  "OH:Hamilton": [
    "cincinnati-ohio",
    "norwood-ohio",
    "blue-ash-ohio",
    "forest-park-ohio",
    "cheviot-ohio",
  ],
  // Hamilton County TN (Chattanooga). Slugs verified 2026-08-13 — each returns
  // listings whose address.county is "Hamilton" / state "TN". lookout-mountain-tennessee
  // is omitted: the API has no listings for it.
  "TN:Hamilton": [
    "chattanooga-tennessee",
    "hixson-tennessee",
    "east-ridge-tennessee",
    "signal-mountain-tennessee",
    "red-bank-tennessee",
    "ooltewah-tennessee",
    "harrison-tennessee",
    "soddy-daisy-tennessee",
    "collegedale-tennessee",
  ],
  "AL:Jefferson": [
    "birmingham-alabama",
    "hoover-alabama",
    "bessemer-alabama",
    "homewood-alabama",
    "vestavia-hills-alabama",
    "gardendale-alabama",
  ],
  "AL:Madison": ["huntsville-alabama", "madison-alabama"],
  "AL:Shelby": [
    "alabaster-alabama",
    "pelham-alabama",
    "helena-alabama",
    "chelsea-alabama",
    "columbiana-alabama",
  ],
  "AL:Morgan": ["decatur-alabama", "hartselle-alabama"],
  "AL:Limestone": ["athens-alabama"],
  "AL:Montgomery": ["montgomery-alabama"],
  "AL:Autauga": ["prattville-alabama"],
  "AL:Elmore": ["wetumpka-alabama", "millbrook-alabama", "tallassee-alabama"],
};

function normCounty(s: unknown): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+county$/, "");
}

async function fetchFsboPage(slug: string, page: number): Promise<Record<string, any>[]> {
  try {
    const res = await fetch(FSBO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.forsalebyowner.com",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ listing_search: { slug, page } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { listings?: Record<string, any>[] } };
    return data?.data?.listings || [];
  } catch {
    return [];
  }
}

const MAX_PAGES = 4;
const COMPLETER_CONCURRENCY = 8;

export async function scrapeFsbo(
  county: string,
  state: string,
  _fromDate?: string,
  _toDate?: string,
): Promise<Lead[]> {
  const key = `${state.toUpperCase()}:${county}`;
  const slugs = FSBO_METROS[key];
  if (!slugs) return [];

  // Collect unique listings across the county's anchor cities.
  const seen = new Set<string>();
  const listings: Record<string, any>[] = [];
  for (const slug of slugs) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await fetchFsboPage(slug, page);
      if (!items.length) break;
      for (const it of items) {
        const id = String(it.id || it.sourceKey || "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        listings.push(it);
      }
      if (items.length < 10) break; // last page for this slug
    }
  }

  // Keep only this county's active listings.
  const wanted = listings.filter((it) => {
    const a = it.address || {};
    const st = String(a.stateOrProvince || "").toUpperCase();
    const status = String(it.listingStatus || "").toLowerCase();
    return (
      normCounty(a.county) === normCounty(county) &&
      st === state.toUpperCase() &&
      (!status || status === "active") &&
      /\d/.test(String(a.fullStreetAddress || ""))
    );
  });

  // Complete each via the county roll/E-Ring (owner-of-record + mailing).
  const leads: Lead[] = [];
  for (let i = 0; i < wanted.length; i += COMPLETER_CONCURRENCY) {
    const batch = wanted.slice(i, i + COMPLETER_CONCURRENCY);
    const props = await Promise.all(
      batch.map((it) => lookupByAddress(String(it.address?.fullStreetAddress || ""), county, state)),
    );
    for (let j = 0; j < batch.length; j++) {
      const it = batch[j];
      const a = it.address || {};
      const prop = props[j];
      // Require a completer match with owner + mailing → guarantees a saveable lead.
      if (!prop?.ownerName || !prop.mailingAddress || isGovernmentOwner(prop.ownerName)) continue;

      const sellerName =
        it.contact?.ownerName ||
        `${it.contact?.firstName || ""} ${it.contact?.lastName || ""}`.trim() ||
        "";
      const price = it.listPrice ? String(it.listPrice) : "";
      const listed = formatDate(it.listingDate) || null;

      leads.push({
        id: makeId("FSBO", county, state, String(it.id || a.fullStreetAddress)),
        county,
        state,
        lead_type: "FSBO",
        owner_name: prop.ownerName,
        address: prop.address || a.fullStreetAddress || null,
        city: prop.city || a.city || null,
        zip: prop.zip || (a.postalCode ? String(a.postalCode).slice(0, 5) : null),
        mailing_address: prop.mailingAddress,
        mailing_city: prop.mailingCity || null,
        mailing_state: prop.mailingState || null,
        mailing_zip: prop.mailingZip || null,
        case_number: prop.parcelId || null,
        filing_date: listed,
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: price || null,
        description:
          `FSBO — listed ${listed || "?"}${price ? ` — $${price}` : ""} — ${a.fullStreetAddress || ""}` +
          (sellerName && sellerName.toUpperCase() !== prop.ownerName.toUpperCase()
            ? ` — seller ${sellerName}`
            : ""),
        source_url: FSBO_SOURCE,
        raw_data: JSON.stringify({
          id: it.id,
          listPrice: it.listPrice,
          listingStatus: it.listingStatus,
          seller: sellerName,
          county: a.county,
          parcelId: prop.parcelId,
        }),
      });
    }
  }

  return leads;
}
