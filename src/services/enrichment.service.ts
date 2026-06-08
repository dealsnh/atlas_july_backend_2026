// @ts-nocheck
import { lookupByAddress, lookupOwnerProperties } from "../scrapers/assessor.js";
import type { Lead } from "../scrapers/base.js";
import { logger } from "../utils/logger.js";

const CONCURRENCY = 5;

function needsEnrichment(lead: Lead): boolean {
  const missingOwner = !lead.owner_name?.trim();
  const missingAddress = !lead.address?.trim() || lead.address.startsWith("[");
  return missingOwner || missingAddress;
}

async function enrichOne(lead: Lead): Promise<Lead> {
  const county = lead.county;
  const state = lead.state;

  try {
    if (!lead.owner_name?.trim() && lead.address?.trim() && !lead.address.startsWith("[")) {
      const match = await lookupByAddress(lead.address, county, state);
      if (match) {
        return {
          ...lead,
          owner_name: match.ownerName || lead.owner_name,
          address: match.address || lead.address,
          city: match.city || lead.city,
          zip: match.zip || lead.zip,
          mailing_address: lead.mailing_address || match.address,
          mailing_city: lead.mailing_city || match.city,
          mailing_state: lead.mailing_state || state,
          mailing_zip: lead.mailing_zip || match.zip,
        };
      }
    }

    if (lead.owner_name?.trim() && (!lead.address?.trim() || lead.address.startsWith("["))) {
      const properties = await lookupOwnerProperties(lead.owner_name, county, state);
      const first = properties[0];
      if (first) {
        return {
          ...lead,
          owner_name: first.ownerName || lead.owner_name,
          address: first.address || lead.address,
          city: first.city || lead.city,
          zip: first.zip || lead.zip,
          mailing_address: lead.mailing_address || first.address,
          mailing_city: lead.mailing_city || first.city,
          mailing_state: lead.mailing_state || state,
          mailing_zip: lead.mailing_zip || first.zip,
        };
      }
    }
  } catch (error) {
    logger.debug({ leadId: lead.id, err: error }, "Assessor enrichment failed");
  }

  return lead;
}

/** Best-effort assessor enrichment for leads missing owner or property address. */
export async function enrichLeads(
  leads: Lead[],
  onProgress?: (msg: string) => void,
): Promise<Lead[]> {
  const toEnrich = leads.filter(needsEnrichment);
  if (!toEnrich.length) return leads;

  onProgress?.(`Enriching ${toEnrich.length} leads via county assessor...`);

  const enrichedById = new Map<string, Lead>();
  for (let i = 0; i < toEnrich.length; i += CONCURRENCY) {
    const batch = toEnrich.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(enrichOne));
    for (const lead of results) {
      enrichedById.set(lead.id, lead);
    }
  }

  const merged = leads.map((lead) => enrichedById.get(lead.id) ?? lead);
  const improved = merged.filter((l, idx) => l !== leads[idx]).length;
  if (improved > 0) {
    onProgress?.(`✓ Assessor enriched ${improved} leads`);
  }

  return merged;
}
