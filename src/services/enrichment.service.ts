import {
  countLeadsNeedingEnrichment,
  findLeadsNeedingEnrichment,
  updateLeadEnrichment,
} from "../repositories/leads.repository.js";
import { lookupByAddress, lookupOwnerProperties } from "../scrapers/assessor.js";
import type { AssessorProperty } from "../scrapers/assessor.js";
import type { Lead as ScraperLead } from "../scrapers/base.js";
import type { Lead as DbLead } from "../types/lead.js";
import { logger } from "../utils/logger.js";
import { extractAddressFromListing, isPlaceholderOwner } from "./owner-placeholders.js";

type Lead = ScraperLead;

function dbLeadToScraperLead(row: DbLead): Lead {
  return {
    id: row.id,
    county: row.county,
    state: row.state,
    lead_type: row.lead_type,
    owner_name: row.owner_name,
    address: row.address,
    city: row.city,
    zip: row.zip,
    mailing_address: row.mailing_address,
    mailing_city: row.mailing_city,
    mailing_state: row.mailing_state,
    mailing_zip: row.mailing_zip,
    case_number: row.case_number,
    filing_date: row.filing_date,
    assessed_value: row.assessed_value,
    tax_year: row.tax_year,
    lender: row.lender,
    loan_amount: row.loan_amount,
    sale_date: row.sale_date,
    sale_amount: row.sale_amount,
    description: row.description,
    source_url: row.source_url,
    raw_data: row.raw_data,
  };
}

const CONCURRENCY = 5;

function addressVariants(addr: string): string[] {
  const base = addr.trim();
  const out = new Set<string>([base]);
  const noCity = base
    .replace(
      /\s+(Kansas City|KC|Cincinnati|Birmingham|Huntsville|Liberty|Platte City|Harrisonville)\b.*$/i,
      "",
    )
    .trim();
  if (noCity.length >= 5) out.add(noCity);
  const noZip = base.replace(/\s+\d{5}(-\d{4})?\s*$/i, "").trim();
  if (noZip.length >= 5) out.add(noZip);
  const streetOnly = noZip.replace(/\s+(Kansas City|KC|MO|OH|AL)\s*$/i, "").trim();
  if (streetOnly.length >= 5) out.add(streetOnly);
  return [...out];
}

function needsEnrichment(lead: Lead): boolean {
  const missingOwner = isPlaceholderOwner(lead.owner_name);
  const missingAddress = !lead.address?.trim() || lead.address.startsWith("[");
  const missingMailing = !lead.mailing_address?.trim();
  return missingOwner || missingAddress || missingMailing;
}

/** Client requirement: saved leads must have a real assessor-verified owner name. */
export function isLeadSaveable(lead: Lead): boolean {
  const name = (lead.owner_name || "").trim();
  if (name.length < 2) return false;
  if (isPlaceholderOwner(name)) return false;
  return true;
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
    mailing_zip: lead.mailing_zip || match.zip || null,
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

function resolveLookupAddress(lead: Lead): string | null {
  const addr = lead.address?.trim();
  if (addr && !addr.startsWith("[") && addr.length >= 5) {
    const fromListing = extractAddressFromListing(addr);
    return fromListing || addr;
  }
  return extractAddressFromListing(lead.description) || extractAddressFromListing(lead.address);
}

async function enrichOne(lead: Lead): Promise<Lead> {
  const county = lead.county;
  const state = lead.state;
  let current = { ...lead };

  if (isPlaceholderOwner(current.owner_name)) {
    current.owner_name = null;
  }

  try {
    const lookupAddr = resolveLookupAddress(current);
    if (lookupAddr) {
      const match = await lookupByAddressVariants(lookupAddr, county, state);
      if (match) current = applyAssessorMatch(current, match, state);
    }

    const stillMissingOwner = isPlaceholderOwner(current.owner_name);
    const stillMissingAddress =
      !current.address?.trim() || current.address.startsWith("[") || !/\d/.test(current.address);

    if (stillMissingOwner && current.owner_name?.trim()) {
      const properties = await lookupOwnerProperties(current.owner_name, county, state);
      const first = properties[0];
      if (first) current = applyAssessorMatch(current, first, state);
    } else if (stillMissingOwner || stillMissingAddress) {
      const hint = current.description || current.case_number || "";
      if (hint.length >= 3) {
        const properties = await lookupOwnerProperties(hint, county, state);
        const first = properties[0];
        if (first) current = applyAssessorMatch(current, first, state);
      }
    }
  } catch (error) {
    logger.debug({ leadId: lead.id, err: error }, "Assessor enrichment failed");
  }

  if (isPlaceholderOwner(current.owner_name)) {
    current.owner_name = null;
  }

  return current;
}

/** County assessor enrichment — runs on every lead in the batch (FSBO included). */
export async function enrichLeads(
  leads: Lead[],
  onProgress?: (msg: string) => void,
): Promise<Lead[]> {
  if (!leads.length) return leads;

  onProgress?.(`Enriching ${leads.length} leads via county assessor...`);

  const results: Lead[] = [];
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(batch.map(enrichOne));
    results.push(...enriched);
  }

  const saveable = results.filter(isLeadSaveable).length;
  const skipped = leads.length - saveable;
  onProgress?.(`✓ Assessor enriched ${leads.length} leads (${saveable} saveable with real owner)`);
  if (skipped > 0) {
    onProgress?.(`⚠ ${skipped} leads lack assessor owner after enrichment`);
  }

  return results;
}

/** Re-run assessor enrichment on existing DB rows (admin / post-scrape cleanup). */
export async function enrichExistingLeads(opts: {
  county?: string;
  state?: string;
  limit?: number;
}): Promise<{ processed: number; updated: number; stillMissingOwner: number }> {
  const limit = Math.min(opts.limit ?? 500, 5000);
  const rows = await findLeadsNeedingEnrichment({ ...opts, limit });
  let updated = 0;
  let stillMissingOwner = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((l) => enrichOne(dbLeadToScraperLead(l))));
    for (let j = 0; j < batch.length; j++) {
      const before = batch[j]!;
      const after = results[j]!;
      if (!after || !isLeadSaveable(after)) {
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

  return { processed: rows.length, updated, stillMissingOwner };
}

export { countLeadsNeedingEnrichment, isPlaceholderOwner, needsEnrichment };
