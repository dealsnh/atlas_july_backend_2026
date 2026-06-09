// @ts-nocheck
import {
  countLeadsNeedingEnrichment,
  findLeadsNeedingEnrichment,
  updateLeadEnrichment,
} from "../repositories/leads.repository.js";
import { lookupByAddress, lookupOwnerProperties } from "../scrapers/assessor.js";
import type { AssessorProperty } from "../scrapers/assessor.js";
import type { Lead } from "../scrapers/base.js";
import { logger } from "../utils/logger.js";

const CONCURRENCY = 5;

function addressVariants(addr: string): string[] {
  const base = addr.trim();
  const out = new Set<string>([base]);
  const noCity = base.replace(/\s+(Kansas City|KC|Cincinnati|Birmingham|Huntsville)\b.*$/i, "").trim();
  if (noCity.length >= 5) out.add(noCity);
  const noZip = base.replace(/\s+\d{5}(-\d{4})?\s*$/i, "").trim();
  if (noZip.length >= 5) out.add(noZip);
  const streetOnly = noZip.replace(/\s+(Kansas City|KC|MO|OH|AL)\s*$/i, "").trim();
  if (streetOnly.length >= 5) out.add(streetOnly);
  return [...out];
}

function needsEnrichment(lead: Lead): boolean {
  const missingOwner = !lead.owner_name?.trim() || lead.owner_name.trim().length < 2;
  const missingAddress = !lead.address?.trim() || lead.address.startsWith("[");
  const missingMailing = !lead.mailing_address?.trim();
  return missingOwner || missingAddress || missingMailing;
}

/** Client requirement: every saved lead must have an assessor-verified owner name. */
export function isLeadSaveable(lead: Lead): boolean {
  const name = (lead.owner_name || "").trim();
  return name.length >= 2;
}

function applyAssessorMatch(lead: Lead, match: AssessorProperty, state: string): Lead {
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

async function lookupByAddressVariants(
  address: string,
  county: string,
  state: string,
): Promise<AssessorProperty | null> {
  for (const variant of addressVariants(address)) {
    const match = await lookupByAddress(variant, county, state);
    if (match?.ownerName || match?.address) return match;
  }
  return null;
}

async function enrichOne(lead: Lead): Promise<Lead> {
  const county = lead.county;
  const state = lead.state;
  let current = { ...lead };

  try {
    if (current.address?.trim() && !current.address.startsWith("[")) {
      const match = await lookupByAddressVariants(current.address, county, state);
      if (match) current = applyAssessorMatch(current, match, state);
    }

    const stillMissingOwner = !current.owner_name?.trim() || current.owner_name.trim().length < 2;
    const stillMissingAddress =
      !current.address?.trim() || current.address.startsWith("[");

    if (current.owner_name?.trim() && stillMissingAddress) {
      const properties = await lookupOwnerProperties(current.owner_name, county, state);
      const first = properties[0];
      if (first) current = applyAssessorMatch(current, first, state);
    }
  } catch (error) {
    logger.debug({ leadId: lead.id, err: error }, "Assessor enrichment failed");
  }

  return current;
}

/** Best-effort assessor enrichment for leads missing owner, address, or mailing. */
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
  const saveable = merged.filter(isLeadSaveable).length;
  if (improved > 0) {
    onProgress?.(`✓ Assessor enriched ${improved} leads (${saveable} saveable with owner)`);
  }

  return merged;
}

/** Re-run assessor enrichment on existing DB rows (admin / post-scrape cleanup). */
export async function enrichExistingLeads(opts: {
  county?: string;
  state?: string;
  limit?: number;
}): Promise<{ processed: number; updated: number; stillMissingOwner: number }> {
  const limit = Math.min(opts.limit ?? 500, 5000);
  const leads = await findLeadsNeedingEnrichment({ ...opts, limit });
  let updated = 0;
  let stillMissingOwner = 0;

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(enrichOne));
    for (let j = 0; j < batch.length; j++) {
      const before = batch[j];
      const after = results[j];
      if (!isLeadSaveable(after)) {
        stillMissingOwner++;
        continue;
      }
      const changed =
        after.owner_name !== before.owner_name ||
        after.address !== before.address ||
        after.mailing_address !== before.mailing_address;
      if (changed) {
        await updateLeadEnrichment(after.id, after);
        updated++;
      }
    }
  }

  return { processed: leads.length, updated, stillMissingOwner };
}

export { countLeadsNeedingEnrichment };
