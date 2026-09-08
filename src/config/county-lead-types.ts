import type { ClientCounty } from "./constants.js";

/** Fallback when a county has no preset and no explicit `lead_types` in config. */
export const FALLBACK_LEAD_TYPES = [
  "Pre-Foreclosure",
  "Tax Delinquent",
  "Sheriff Sale",
  "Probate",
  "FSBO",
] as const;

/**
 * Tina client — MULTI-STATE (Missouri, Alabama, Ohio).
 *
 * Each county lists the PRIORITY-12 target set FIRST (in the 12's canonical order,
 * limited to the types a registered scraper actually dispatches for that county's
 * state), then the existing working extras. A type is listed only where a scraper is
 * wired for it — a listed type is LIVE, an omitted one of the 12 is documented below.
 *
 * PRIORITY 12 — status per state (they differ because MO/AL are NON-JUDICIAL,
 * OH is JUDICIAL):
 *   1. Probate           — LIVE all 3 (MO Case.net "P" + roll-estate scan; AL AlaCourt "PR";
 *                          OH probatect.org + roll-estate scan). Roll path carries mailing.
 *   2. Pre-Foreclosure   — LIVE all 3 (MO Case.net LIS PENDENS + Jackson recorder + publicsearch;
 *                          AL AlaCourt "CV" foreclosure/lis-pendens; OH Cincinnati foreclosure-filed
 *                          registry + courtclerk). Lis Pendens leads satisfy it via LEAD_TYPE_MATCHES.
 *   3. Code Violation    — LIVE only where a portal exists: MO Jackson (KC Socrata), AL Jefferson
 *                          (jeffcointouch), OH Hamilton (Cincinnati Socrata). NOT BUILT elsewhere.
 *   4. Tax Delinquent    — LIVE all counties (county collector / revenue / auditor lists).
 *   5. Notice of Trustee Sale — alias → Pre-Foreclosure. MO/AL are deed-of-trust (power-of-sale)
 *                          states: the recorded trustee-sale notice IS the pre-foreclosure filing.
 *                          OH is judicial (no recorded NTS); the alias still resolves to the
 *                          dispatchable Pre-Foreclosure registry. The completed auction = Sheriff
 *                          Sale (see "Trustee Sale" alias, kept distinct).
 *   6. Notice of Default — alias → Pre-Foreclosure. No U.S. state here records a separate NOD in a
 *                          non-judicial (MO/AL) or judicial (OH) process; the pre-foreclosure filing
 *                          is the first public default signal.
 *   7. Water Shutoff     — NOT BUILT. No free per-parcel utility-shutoff list (billing status is
 *                          protected PII). MO has a KC-311 "Water Service" request feed but that is
 *                          service requests, not shutoffs — deliberately not wired. Omitted everywhere.
 *   8. Fire Damage       — LIVE MO Jackson (KC 311 fire/dangerous) + OH Hamilton (Cincinnati Fire CAD).
 *                          NOT BUILT for AL or the outer MO counties.
 *   9. Eviction          — alias → Divorce (same court-docket scraper family). Where Divorce is LIVE.
 *  10. Divorce           — LIVE MO Jackson (Case.net "D") + AL (AlaCourt "DR": Jefferson/Madison/
 *                          Montgomery/Morgan/Shelby/Limestone) + OH Hamilton (news RSS). Court source,
 *                          so yield is owner+situs (mailing via enrichment); listed where covered.
 *  11. Bankruptcy        — LIVE all 3 (PACER RSS: MO mowb; AL alnb+alsb; OH ohsb+ohnb), enriched to
 *                          the county roll.
 *  12. Vacant            — alias → Vacant/Abandoned. LIVE MO Jackson (KC Socrata dangerous buildings),
 *                          AL Jefferson (Birmingham open data), OH Hamilton (registry). NOT BUILT else.
 *
 * Existing working extras kept after the 12: Sheriff Sale, FSBO, Out-of-State Owner / Absentee Owner
 * (roll-backed counties only), Long-Time/Senior Owner (Hamilton OH roll only), Obituary.
 */
export const COUNTY_DEFAULT_LEAD_TYPES: Record<string, readonly string[]> = {
  // ── Missouri (non-judicial; trustee sale ≈ pre-foreclosure) ──
  // Jackson = full KC roll (owner+situs+mailing) → completer-backed types available.
  "MO:Jackson": ["Probate", "Pre-Foreclosure", "Code Violation", "Tax Delinquent", "Fire Damage", "Divorce", "Bankruptcy", "Vacant/Abandoned", "Sheriff Sale", "FSBO", "Out-of-State Owner", "Absentee Owner", "Obituary"],
  // Outer MO (Clay/Platte/Cass): only court + collector + roll wired (no Code/Vacant/Fire/Divorce portal).
  "MO:Clay": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Bankruptcy", "Sheriff Sale", "FSBO", "Out-of-State Owner", "Absentee Owner"],
  "MO:Platte": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Bankruptcy", "Sheriff Sale", "FSBO", "Out-of-State Owner", "Absentee Owner"],
  "MO:Cass": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Bankruptcy", "Sheriff Sale", "FSBO", "Out-of-State Owner", "Absentee Owner"],
  // ── Ohio (judicial; foreclosure filing = pre-foreclosure, sheriff sale = auction) ──
  "OH:Hamilton": ["Probate", "Pre-Foreclosure", "Code Violation", "Tax Delinquent", "Fire Damage", "Divorce", "Bankruptcy", "Vacant/Abandoned", "Sheriff Sale", "FSBO", "Out-of-State Owner", "Absentee Owner", "Long-Time Owner", "Senior Owner", "Obituary"],
  // ── Tennessee (non-judicial deed-of-trust; substitute trustee's sale = pre-foreclosure) ──
  // Hamilton (Chattanooga). Roll-backed via the Chattanooga parcel layer → Out-of-State /
  // Absentee available. Sheriff Sale omitted: TN foreclosures are trustee's sales (already
  // Pre-Foreclosure) and the only auction is the Clerk & Master's once-a-year tax sale, which
  // is published as a May newspaper list, not a scrapeable recurring docket.
  // Senior Owner omitted: no populated age/tax-relief field on the county roll.
  // Eviction omitted: General Sessions detainer dockets (edockets.us) refuse datacenter IPs.
  // Long-Time Owner omitted: derivable from roll sale dates but not wired as a scan yet.
  "TN:Hamilton": ["Probate", "Pre-Foreclosure", "Code Violation", "Tax Delinquent", "Fire Damage", "Divorce", "Bankruptcy", "Vacant/Abandoned", "FSBO", "Out-of-State Owner", "Absentee Owner", "Obituary"],
  // ── California ──
  // Orange County: Central District bankruptcy RSS, capublicnotice.com probate
  // notices (session-gated, county-filtered on the result's own `location`
  // field), the roll-derived "still on the tax roll as an estate" scan
  // (labeled Pre-Probate here, not Probate — CA already has a real
  // court-filed Probate above, so the roll signal is the earlier, weaker
  // stage), plus countywide public parcel-roll completion. Other source
  // categories remain deliberately unlisted until a lawful source contract
  // and response signature are verified.
  "CA:Orange": ["Probate", "Pre-Probate", "Bankruptcy"],
  // ── Alabama (non-judicial; trustee sale ≈ pre-foreclosure) ──
  // Jefferson (Birmingham) has the only AL Code Violation + Vacant/Abandoned portals.
  "AL:Jefferson": ["Probate", "Pre-Foreclosure", "Code Violation", "Tax Delinquent", "Divorce", "Bankruptcy", "Vacant/Abandoned", "Sheriff Sale", "FSBO", "Obituary"],
  "AL:Madison": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Divorce", "Bankruptcy", "Sheriff Sale", "FSBO", "Obituary"],
  "AL:Shelby": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Divorce", "Bankruptcy", "Sheriff Sale", "FSBO", "Obituary"],
  "AL:Morgan": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Divorce", "Bankruptcy", "Sheriff Sale", "FSBO", "Obituary"],
  "AL:Limestone": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Divorce", "Bankruptcy", "Sheriff Sale", "FSBO", "Obituary"],
  // Montgomery = roll-backed (KCS GIS) → Out-of-State/Absentee available; Divorce covered by AlaCourt.
  "AL:Montgomery": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Divorce", "Bankruptcy", "Sheriff Sale", "FSBO", "Out-of-State Owner", "Absentee Owner", "Obituary"],
  // Autauga/Elmore: outside the AL Divorce scraper's county list → Divorce omitted (NOT covered).
  "AL:Autauga": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Bankruptcy", "Sheriff Sale", "FSBO", "Obituary"],
  "AL:Elmore": ["Probate", "Pre-Foreclosure", "Tax Delinquent", "Bankruptcy", "Sheriff Sale", "FSBO", "Obituary"],
};

// GLOBAL alias map (applies across all MO/AL/OH counties). Only add an alias here when it is
// correct for EVERY configured county; where states disagree, the per-county lead_types above are
// the state-correct mechanism. All 12 priority names normalize to a dispatchable canonical type.
const LEAD_TYPE_ALIASES: Record<string, string> = {
  "Probate/Estate": "Probate",
  "Vacant Abandoned": "Vacant/Abandoned",
  Vacant: "Vacant/Abandoned",
  "Tax Lien": "Tax Delinquent",
  "Tax Liens": "Tax Delinquent",
  // The completed foreclosure AUCTION. MO/AL trustee's sales and OH sheriff sales are all read by
  // the Sheriff Sale scrapers (foreclosure-sale notices), so the bare "Trustee Sale" maps here.
  "Trustee Sale": "Sheriff Sale",
  // The pre-auction NOTICE (and NOD) is the pre-foreclosure filing. In non-judicial MO/AL the
  // recorded Notice of Trustee's Sale IS the pre-foreclosure record; no separate NOD is recorded.
  // In judicial OH there is no recorded NTS/NOD — the alias still resolves to the dispatchable
  // Pre-Foreclosure (foreclosure-filed registry). Distinct from "Trustee Sale" (the auction) above.
  "Notice of Trustee Sale": "Pre-Foreclosure",
  "Notice of Trustee's Sale": "Pre-Foreclosure",
  "Notice of Default": "Pre-Foreclosure",
  // Evictions ride the same court-docket scraper as Divorce.
  Eviction: "Divorce",
  Obituaries: "Obituary",
};

/** Lead types emitted by scrapers that satisfy a requested canonical type. */
const LEAD_TYPE_MATCHES: Record<string, string[]> = {
  Probate: ["Probate", "Probate/Estate"],
  "Pre-Foreclosure": ["Pre-Foreclosure", "Lis Pendens"],
};

export function normalizeLeadType(type: string): string {
  const trimmed = type.trim();
  return LEAD_TYPE_ALIASES[trimmed] ?? trimmed;
}

export function normalizeLeadTypes(types: string[]): string[] {
  return [...new Set(types.map(normalizeLeadType).filter(Boolean))];
}

export function leadMatchesRequestedType(leadType: string, requestedTypes: string[]): boolean {
  const normalized = normalizeLeadTypes(requestedTypes);
  const leadNorm = leadType.trim();
  if (normalized.includes(leadNorm)) return true;
  for (const requested of normalized) {
    const variants = LEAD_TYPE_MATCHES[requested];
    if (variants?.includes(leadNorm)) return true;
  }
  return false;
}

export function filterLeadsByTypes<T extends { lead_type: string }>(
  leads: T[],
  requestedTypes: string[],
): T[] {
  if (!requestedTypes.length) return leads;
  return leads.filter((l) => leadMatchesRequestedType(l.lead_type, requestedTypes));
}

function countyKey(state: string, name: string): string {
  return `${state.toUpperCase()}:${name}`;
}

export function resolveCountyLeadTypes(county: ClientCounty): string[] {
  const explicit = county.lead_types?.length ? normalizeLeadTypes(county.lead_types) : undefined;
  if (explicit?.length) return explicit;

  const name = county.name || county.county;
  const preset = COUNTY_DEFAULT_LEAD_TYPES[countyKey(county.state, name)];
  if (preset?.length) return [...preset];

  return [...FALLBACK_LEAD_TYPES];
}

export function unionLeadTypes(counties: Array<{ leadTypes?: string[] }>): string[] {
  return normalizeLeadTypes(counties.flatMap((c) => c.leadTypes ?? []));
}
