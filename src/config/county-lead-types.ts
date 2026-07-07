import type { ClientCounty } from "./constants.js";

/** Fallback when a county has no preset and no explicit `lead_types` in config. */
export const FALLBACK_LEAD_TYPES = [
  "Pre-Foreclosure",
  "Tax Delinquent",
  "Sheriff Sale",
  "Probate",
  "FSBO",
] as const;

/** Tina client — high-yield lead types per county. "Out-of-State Owner" is a
 *  keyless, always-current roll-derived type for counties with an ArcGIS roll. */
// Lead types are listed only where the county has a completer (parcel roll / E-Ring)
// able to produce a full owner + situs + mailing lead. FSBO / Code Violation /
// Vacant / Pre-Foreclosure require the completer's MAILING address, so they are
// omitted for counties whose free roll exposes owner+situs but no mailing
// (Jackson MO, Madison AL, Montgomery AL).
export const COUNTY_DEFAULT_LEAD_TYPES: Record<string, readonly string[]> = {
  "MO:Jackson": ["Tax Delinquent", "Sheriff Sale", "Probate", "Pre-Foreclosure", "Out-of-State Owner", "Absentee Owner", "Code Violation", "Vacant/Abandoned", "FSBO"],
  "MO:Clay": ["Tax Delinquent", "Sheriff Sale", "Probate", "Pre-Foreclosure", "Out-of-State Owner", "Absentee Owner", "FSBO"],
  "MO:Platte": ["Tax Delinquent", "Sheriff Sale", "Probate", "Pre-Foreclosure", "Out-of-State Owner", "Absentee Owner", "FSBO"],
  "MO:Cass": ["Tax Delinquent", "Sheriff Sale", "Probate", "Pre-Foreclosure", "Out-of-State Owner", "Absentee Owner", "FSBO"],
  "OH:Hamilton": ["Tax Delinquent", "Sheriff Sale", "Probate", "Pre-Foreclosure", "Out-of-State Owner", "Absentee Owner", "Long-Time Owner", "Senior Owner", "Code Violation", "Vacant/Abandoned", "FSBO"],
  "AL:Jefferson": ["Tax Delinquent", "Sheriff Sale", "Probate", "FSBO"],
  "AL:Madison": ["Tax Delinquent", "Sheriff Sale", "Probate", "FSBO"],
  "AL:Shelby": ["Tax Delinquent", "Sheriff Sale", "Probate", "FSBO"],
  "AL:Morgan": ["Tax Delinquent", "Sheriff Sale", "Probate", "FSBO"],
  "AL:Limestone": ["Tax Delinquent", "Sheriff Sale", "Probate", "FSBO"],
  "AL:Montgomery": ["Tax Delinquent", "Sheriff Sale", "Probate", "Out-of-State Owner", "Absentee Owner", "FSBO"],
  "AL:Autauga": ["Tax Delinquent", "Sheriff Sale", "Probate", "FSBO"],
  "AL:Elmore": ["Tax Delinquent", "Sheriff Sale", "Probate", "FSBO"],
};

const LEAD_TYPE_ALIASES: Record<string, string> = {
  "Probate/Estate": "Probate",
  "Vacant Abandoned": "Vacant/Abandoned",
  "Tax Lien": "Tax Delinquent",
  "Tax Liens": "Tax Delinquent",
  "Trustee Sale": "Sheriff Sale",
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
