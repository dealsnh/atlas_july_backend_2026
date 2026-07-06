// @ts-nocheck
/**
 * Roll-derived leads — keyless, always-current, complete (owner + situs + mailing).
 *
 * For counties whose public assessment roll is a queryable ArcGIS FeatureServer
 * (see ROLL_SPECS in assessor.ts), we derive motivated-seller lead types directly
 * from the roll — no court site, proxy, or annual list required:
 *   - Out-of-State Owner: mailing state ≠ property state (absentee investor signal)
 *   - Probate:            owner recorded as a deceased person's estate / heirs
 *
 * Every row already carries owner + situs + mailing, so these pass the strict save
 * gate without enrichment. Government/municipal owners are excluded.
 */

import { Lead, makeId } from "./base.js";
import {
  rollSupportsCounty,
  scanEstateOwners,
  scanOutOfStateOwners,
  type AssessorProperty,
} from "./assessor.js";

const ROLL_SOURCE = "https://atlas.local/source/county-assessment-roll";

function propToLead(
  p: AssessorProperty,
  county: string,
  state: string,
  leadType: string,
  note: string,
): Lead {
  return {
    id: makeId(county, state, leadType, p.parcelId || `${p.ownerName}|${p.address}`),
    county,
    state,
    lead_type: leadType,
    owner_name: p.ownerName || null,
    address: p.address || null,
    city: p.city || null,
    zip: p.zip || null,
    mailing_address: p.mailingAddress || null,
    mailing_city: p.mailingCity || null,
    mailing_state: p.mailingState || null,
    mailing_zip: p.mailingZip || null,
    case_number: p.parcelId || null,
    filing_date: null,
    assessed_value: null,
    tax_year: null,
    lender: null,
    loan_amount: null,
    sale_date: null,
    sale_amount: null,
    description: `${leadType} — ${county} County ${state} — ${note}`,
    source_url: ROLL_SOURCE,
    raw_data: JSON.stringify({ parcelId: p.parcelId, mailingState: p.mailingState }),
  };
}

/** Roll-derived lead types this module can produce (for a roll-backed county). */
export const ROLL_DERIVED_TYPES = ["Out-of-State Owner", "Probate"] as const;

export async function scrapeRollDerived(
  county: string,
  state: string,
  leadTypes?: string[],
): Promise<Lead[]> {
  if (!rollSupportsCounty(county, state)) return [];
  const want = (t: string) => !leadTypes?.length || leadTypes.includes(t);
  const leads: Lead[] = [];

  if (want("Out-of-State Owner")) {
    const props = await scanOutOfStateOwners(county, state, 250);
    leads.push(
      ...props.map((p) =>
        propToLead(p, county, state, "Out-of-State Owner", "mailing state differs from property"),
      ),
    );
  }

  if (want("Probate")) {
    const props = await scanEstateOwners(county, state, 200);
    leads.push(
      ...props.map((p) => propToLead(p, county, state, "Probate", "owner of record is an estate/heirs")),
    );
  }

  return leads;
}
