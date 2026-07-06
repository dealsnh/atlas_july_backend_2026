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
/** Assessor calls capped per batch so large county dumps do not block the pipeline. */
const MAX_ENRICH_PER_BATCH = 250;

/** Valid situs street line — rejects Craigslist marketing copy used as address. */
export function isValidStreetAddress(address: string | null | undefined): boolean {
  const a = (address || "").trim();
  if (a.length < 5 || a.length > 200) return false;
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

/** Legal description, partial street, or other property location text. */
export function isLegalOrPartialAddress(text: string | null | undefined): boolean {
  const a = (text || "").trim();
  if (a.length < 5 || a.length > 300) return false;
  if (isValidStreetAddress(a)) return true;
  if (
    /\b(lot|block|parcel|tract|subdivision|legal|sec|section|acres?|unit|platted|estate)\b/i.test(a)
  ) {
    return true;
  }
  // Partial street without number (e.g. "ALLEN AVE")
  if (/^[A-Za-z0-9][A-Za-z0-9\s.'-]{2,79}$/.test(a) && /[A-Za-z]{2,}/.test(a)) return true;
  return false;
}

function leadLocationCandidates(lead: Lead): string[] {
  const out: string[] = [];
  if (lead.address?.trim()) out.push(lead.address.trim());
  if (lead.description?.trim()) out.push(lead.description.trim());
  if (lead.raw_data) {
    try {
      const raw = JSON.parse(lead.raw_data) as Record<string, string>;
      for (const key of ["detailAddress", "title", "location", "address"]) {
        if (raw[key]?.trim()) out.push(raw[key].trim());
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Property address, legal description, or partial location from address/description. */
export function hasUsablePropertyLocation(lead: Lead): boolean {
  for (const text of leadLocationCandidates(lead)) {
    const normalized = text.replace(/[—–]/g, "-").trim();
    if (isLegalOrPartialAddress(normalized)) return true;
    if (
      normalized.length >= 10 &&
      /county.*(probate|lis pendens|foreclosure|sheriff|tax|estate)/i.test(normalized)
    ) {
      return true;
    }
  }
  return false;
}

/** Owner name, case number, or court-style case name in description. */
export function hasUsableIdentity(lead: Lead): boolean {
  const name = (lead.owner_name || "").trim();
  if (name.length >= 2 && !isPlaceholderOwner(name)) return true;

  const caseNum = (lead.case_number || "").trim();
  if (caseNum.length >= 3) return true;

  const desc = (lead.description || "").trim();
  if (desc.length >= 8 && /\b(v\.|vs\.|estate|probate|foreclos|deceased|in re)\b/i.test(desc)) {
    return true;
  }
  if (desc.length >= 10 && /county.*(probate|lis pendens|foreclosure|sheriff|tax)/i.test(desc)) {
    return true;
  }

  return false;
}

/** Real owner name — a person/entity name that is not a placeholder. */
export function hasRealOwnerName(lead: Lead): boolean {
  const name = (lead.owner_name || "").trim();
  return name.length >= 2 && !isPlaceholderOwner(name);
}

/**
 * Save gate (strict): a promotable lead MUST have all three of
 * owner name + situs street address + mailing address. Rows missing any are
 * not skip-traceable — they stay in raw_leads and are never promoted to `leads`.
 */
export function isLeadSaveable(lead: Lead): boolean {
  return hasRealOwnerName(lead) && isValidStreetAddress(lead.address) && hasMailingAddress(lead);
}

/** complete = street address + real owner; partial = saved but missing enriched fields. */
export function enrichmentStatus(lead: Lead): "complete" | "partial" {
  const hasOwner = (lead.owner_name || "").trim().length >= 2 && !isPlaceholderOwner(lead.owner_name);
  const hasStreet = isValidStreetAddress(lead.address);
  return hasOwner && hasStreet ? "complete" : "partial";
}

export function hasMailingAddress(lead: Lead): boolean {
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
  const missingStreet = !isValidStreetAddress(lead.address);
  const missingMailing = !hasMailingAddress(lead);
  return missingOwner || missingStreet || missingMailing;
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
    mailing_address: useAssessorMail ? mailAddr : lead.mailing_address || null,
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

function resolveLookupAddress(lead: Lead): string | null {
  for (const text of leadLocationCandidates(lead)) {
    const extracted = extractAddressFromListing(text);
    if (extracted) return extracted;
    if (isValidStreetAddress(text)) return text;
    if (isLegalOrPartialAddress(text) && /^\d+/.test(text)) return text;
  }
  return null;
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
  // Already complete (real owner + situs street + mailing) — e.g. roll-derived leads
  // come straight from the authoritative assessment roll. Re-querying risks a fuzzy
  // address match overwriting correct owner/mailing with the wrong parcel; skip it.
  if (isLeadSaveable(lead)) return { ...lead };

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
    const stillMissingStreet = !isValidStreetAddress(current.address);
    const hasRealOwner =
      !!current.owner_name?.trim() && !isPlaceholderOwner(current.owner_name);

    if (hasRealOwner && stillMissingStreet) {
      const properties = await lookupOwnerProperties(current.owner_name!, county, state);
      const first = properties[0];
      if (first) current = applyAssessorMatch(current, first, state);
    } else if (stillMissingOwner || stillMissingStreet) {
      const hints = [current.description, current.case_number, current.owner_name].filter(
        (h): h is string => !!h && h.trim().length >= 3,
      );
      for (const hint of hints) {
        const properties = await lookupOwnerProperties(hint, county, state);
        const first = properties[0];
        if (first) {
          current = applyAssessorMatch(current, first, state);
          break;
        }
      }
    }

    // Best-effort mailing only — never required for save
    if (!hasMailingAddress(current) && isValidStreetAddress(current.address)) {
      current = {
        ...current,
        mailing_address: current.mailing_address || current.address,
        mailing_city: current.mailing_city || current.city,
        mailing_state: current.mailing_state || state,
        mailing_zip: current.mailing_zip || current.zip || null,
      };
    }
  } catch (error) {
    logger.debug({ leadId: lead.id, err: error }, "Assessor enrichment failed");
  }

  // Guaranteed mailing backfill: a lead with a valid situs but no separate mailing
  // is mailable at the property itself. Runs even if the assessor lookup above threw,
  // so the strict save gate never drops an otherwise-complete owner+situs lead.
  if (!hasMailingAddress(current) && isValidStreetAddress(current.address)) {
    current = {
      ...current,
      mailing_address: current.address,
      mailing_city: current.mailing_city || current.city,
      mailing_state: current.mailing_state || state,
      mailing_zip: current.mailing_zip || current.zip || null,
    };
  }

  if (isPlaceholderOwner(current.owner_name)) {
    current.owner_name = null;
  }

  return current;
}

/** Best-effort county assessor enrichment — never blocks saving. */
export async function enrichLeads(
  leads: Lead[],
  onProgress?: (msg: string) => void,
): Promise<Lead[]> {
  if (!leads.length) return leads;

  const toEnrich = leads.length > MAX_ENRICH_PER_BATCH ? leads.slice(0, MAX_ENRICH_PER_BATCH) : leads;
  const passthrough = leads.length > MAX_ENRICH_PER_BATCH ? leads.slice(MAX_ENRICH_PER_BATCH) : [];

  onProgress?.(
    `Enriching ${toEnrich.length} leads via county assessor (best-effort)${passthrough.length ? ` — ${passthrough.length} passed through without assessor` : ""}...`,
  );

  const results: Lead[] = [];
  for (let i = 0; i < toEnrich.length; i += CONCURRENCY) {
    const batch = toEnrich.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(batch.map(enrichOne));
    results.push(...enriched);
  }
  results.push(...passthrough);

  const saveable = results.filter(isLeadSaveable).length;
  const complete = results.filter((l) => enrichmentStatus(l) === "complete").length;
  onProgress?.(
    `✓ Enriched ${leads.length} leads (${saveable} usable, ${complete} fully enriched)`,
  );

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

      if (enrichmentStatus(after) === "partial") {
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
