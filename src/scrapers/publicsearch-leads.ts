// @ts-nocheck
import { leadMatchesRequestedType } from "../config/county-lead-types.js";
import { Lead, makeId, formatDate } from "./base.js";
import { extractAddressFromDoc, scrapePublicSearch, type PublicSearchDoc } from "./publicsearch.js";
import { lookupByAddress } from "./assessor.js";

const DOC_SEARCHES: Array<{ leadType: string; searchValue: string }> = [
  { leadType: "Pre-Foreclosure", searchValue: "LIS PENDENS" },
  { leadType: "Probate", searchValue: "PROBATE" },
  { leadType: "Divorce", searchValue: "DIVORCE" },
];

function docToLead(
  doc: PublicSearchDoc,
  county: string,
  state: string,
  leadType: string,
  searchValue: string,
  baseUrl: string,
): Lead {
  const grantor = doc.grantor[0] || null;
  const address = extractAddressFromDoc(doc);
  const recorded = doc.recordedDate
    ? formatDate(doc.recordedDate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"))
    : null;

  return {
    id: makeId(state, county, leadType, doc.instrumentNumber || String(doc.docId)),
    county,
    state,
    lead_type: leadType,
    owner_name: grantor,
    address,
    city: null,
    zip: null,
    mailing_address: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    case_number: doc.instrumentNumber || doc.docNumber || null,
    filing_date: recorded,
    assessed_value: null,
    tax_year: null,
    lender: doc.grantee[0] || null,
    loan_amount: null,
    sale_date: null,
    sale_amount: null,
    description: `${county} ${leadType} — ${doc.docType || searchValue}`,
    source_url: doc.downloadLink || baseUrl,
    raw_data: JSON.stringify({ docType: doc.docType, grantor: doc.grantor, grantee: doc.grantee }),
  };
}

/**
 * Scrape county recorder documents via publicsearch.us for supplemental lead types.
 */
export async function scrapePublicSearchLeads(
  county: string,
  state: string,
  slug: string,
  stateCode: string,
  fromDate: string,
  toDate: string,
  leadTypes?: string[],
): Promise<Lead[]> {
  const baseUrl = `https://${slug}.${stateCode}.publicsearch.us`;
  const leads: Lead[] = [];

  for (const { leadType, searchValue } of DOC_SEARCHES) {
    if (leadTypes?.length && !leadMatchesRequestedType(leadType, leadTypes)) continue;
    const docs = await scrapePublicSearch(slug, stateCode, searchValue, fromDate, toDate);
    for (const doc of docs) {
      let lead = docToLead(doc, county, state, leadType, searchValue, baseUrl);

      if (!lead.owner_name && lead.address) {
        const enriched = await lookupByAddress(lead.address, county, state);
        if (enriched?.ownerName) {
          lead = {
            ...lead,
            owner_name: enriched.ownerName,
            city: enriched.city,
            zip: enriched.zip,
          };
        }
      }

      leads.push(lead);
    }
  }

  return leads;
}
