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

/** Valid situs street line — rejects Craigslist marketing copy used as address. */
export function isValidStreetAddress(address: string | null | undefined): boolean {
  const a = (address || "").trim();
  if (a.length < 5 || a.length > 120) return false;
  if (!/^\d+/.test(a)) return false;
  if (a.split(/\s+/).length > 14) return false;
  if (/^\d+\s+unit\b/i.test(a)) return false;
  if (/^\d+\s+acres?\b/i.test(a)) return false;
  const hasStreetSuffix =
    /\b(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Ct|Court|Way|Pl|Place|Cir|Hwy|Pkwy)\.?$/i.test(
      a,
    );
  if (!hasStreetSuffix && a.split(/\s+/).length > 6) return false;
  return true;
}

function hasMailingAddress(lead: Lead): boolean {
  return (lead.mailing_address || "").trim().length >= 5;
}

function addressVariants(addr: string): string[] {
  const base = addr.trim();
  const out = new Set<string>([base]);
  const noCity = base
    .replace(
      /\s+(Kansas City|KC|Cincinnati|Birmingham|Huntsville|Liberty|Platte City|Harrisonville|Pinson|Madison|Decatur|Moulton)\b.*$/i,
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
  const missingAddress = !isValidStreetAddress(lead.address);
  const missingMailing = !hasMailingAddress(lead);
  return missingOwner || missingAddress || missingMailing;
}

/** Client requirement: owner name + property address + mailing (situs OK when assessor has no mail). */
export function isLeadSaveable(lead: Lead): boolean {
  const name = (lead.owner_name || "").trim();
  if (name.length < 2) return false;
  if (isPlaceholderOwner(name)) return false;
  if (!isValidStreetAddress(lead.address)) return false;
  if (!hasMailingAddress(lead)) return false;
  return true;
}

function applyAssessorMatch(lead: Lead, match: AssessorProperty, state: string): Lead {
  const situsAddress = match.address || lead.address;
  const situsCity = match.city || lead.city;
  const situsZip = match.zip || lead.zip;
  const mailAddr = match.mailingAddress?.trim();
  const useAssessorMail = mailAddr && mailAddr.length >= 5;

  return {
    ...lead,
    owner_name: match.ownerName || lead.owner_name,
    address: situsAddress,
    city: situsCity,
    zip: situsZip,
    mailing_address: useAssessorMail
      ? mailAddr
      : lead.mailing_address || situsAddress || null,
    mailing_city: useAssessorMail
      ? match.mailingCity || lead.mailing_city || situsCity
      : lead.mailing_city || situsCity,
    mailing_state: useAssessorMail
      ? match.mailingState || lead.mailing_state || state
      : lead.mailing_state || state,
    mailing_zip: useAssessorMail
      ? match.mailingZip || lead.mailing_zip || situsZip || null
      : lead.mailing_zip || situsZip || null,
  };
}

/** When assessor returns situs only, copy to mailing so the lead is complete. */
function ensureMailingFromSitus(lead: Lead, state: string): Lead {
  if (hasMailingAddress(lead)) return lead;
  if (!isValidStreetAddress(lead.address)) return lead;
  return {
    ...lead,
    mailing_address: lead.address,
    mailing_city: lead.mailing_city || lead.city,
    mailing_state: lead.mailing_state || state,
    mailing_zip: lead.mailing_zip || lead.zip || null,
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
  const candidates: string[] = [];

  if (lead.address?.trim()) candidates.push(lead.address.trim());
  if (lead.description?.trim()) candidates.push(lead.description.trim());

  if (lead.raw_data) {
    try {
      const raw = JSON.parse(lead.raw_data) as Record<string, string>;
      if (raw.detailAddress?.trim()) candidates.push(raw.detailAddress.trim());
      if (raw.title?.trim()) candidates.push(raw.title.trim());
      if (raw.location?.trim()) candidates.push(raw.location.trim());
    } catch {
      /* ignore */
    }
  }

  for (const text of candidates) {
    const extracted = extractAddressFromListing(text);
    if (extracted) return extracted;
    if (isValidStreetAddress(text)) return text;
  }

  return null;
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

    const stillMissingOwner =
      !current.owner_name?.trim() || isPlaceholderOwner(current.owner_name);
    const stillMissingAddress = !isValidStreetAddress(current.address);
    const stillMissingMailing = !hasMailingAddress(current);
    const hasRealOwner =
      !!current.owner_name?.trim() && !isPlaceholderOwner(current.owner_name);

    if (hasRealOwner && (stillMissingAddress || stillMissingMailing)) {
      const properties = await lookupOwnerProperties(current.owner_name!, county, state);
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

  return ensureMailingFromSitus(current, state);
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
  onProgress?.(
    `✓ Assessor enriched ${leads.length} leads (${saveable} complete with owner+address+mailing)`,
  );
  if (skipped > 0) {
    onProgress?.(`⚠ ${skipped} leads incomplete after assessor enrichment`);
  }

  return results;
}

/** Re-run assessor enrichment on existing DB rows (admin / post-scrape cleanup). */
export async function enrichExistingLeads(opts: {
  county?: string;
  state?: string;
  limit?: number;
}): Promise<{
  processed: number;
  updated: number;
  stillIncomplete: number;
  stillMissingOwner: number;
  stillMissingAddress: number;
  stillMissingMailing: number;
}> {
  const limit = Math.min(opts.limit ?? 500, 5000);
  const rows = await findLeadsNeedingEnrichment({ ...opts, limit });
  let updated = 0;
  let stillIncomplete = 0;
  let stillMissingOwner = 0;
  let stillMissingAddress = 0;
  let stillMissingMailing = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((l) => enrichOne(dbLeadToScraperLead(l))));
    for (let j = 0; j < batch.length; j++) {
      const before = batch[j]!;
      const after = results[j]!;

      const changed =
        after.owner_name !== before.owner_name ||
        after.address !== before.address ||
        after.city !== before.city ||
        after.zip !== before.zip ||
        after.mailing_address !== before.mailing_address ||
        after.mailing_city !== before.mailing_city ||
        after.mailing_state !== before.mailing_state ||
        after.mailing_zip !== before.mailing_zip;

      if (changed) {
        await updateLeadEnrichment(after.id, after);
        updated++;
      }

      if (!isLeadSaveable(after)) {
        stillIncomplete++;
        const name = (after.owner_name || "").trim();
        if (name.length < 2 || isPlaceholderOwner(name)) stillMissingOwner++;
        if (!isValidStreetAddress(after.address)) stillMissingAddress++;
        if (!hasMailingAddress(after)) stillMissingMailing++;
      }
    }
  }

  return {
    processed: rows.length,
    updated,
    stillIncomplete,
    stillMissingOwner,
    stillMissingAddress,
    stillMissingMailing,
  };
}

export { countLeadsNeedingEnrichment, isPlaceholderOwner, needsEnrichment };
