import type { Lead as ScraperLead } from "../scrapers/base.js";
import {
  hasMailingAddress,
  hasRealOwnerName,
  isValidStreetAddress,
} from "../services/enrichment.service.js";
import { isPlaceholderOwner } from "../services/owner-placeholders.js";

/** Why a scraped row did not become a portal lead. */
export const RAW_REJECT_REASON = {
  SAVED: "saved",
  NO_OWNER_AFTER_ENRICHMENT: "no_owner_after_enrichment",
  PLACEHOLDER_OWNER: "placeholder_owner",
  MISSING_ADDRESS_AND_OWNER: "missing_address_and_owner",
  MISSING_PROPERTY_LOCATION: "missing_property_location",
  MISSING_MAILING_ADDRESS: "missing_mailing_address",
  GOVERNMENT_OWNER: "government_owner",
  DUPLICATE: "duplicate",
  DUPLICATE_IN_BATCH: "duplicate_in_batch",
} as const;

export type RawRejectReason = (typeof RAW_REJECT_REASON)[keyof typeof RAW_REJECT_REASON];

/**
 * Classify why an enriched row failed the strict save gate
 * (owner name + situs street address + mailing address).
 */
export function resolveRejectReason(lead: ScraperLead): string {
  const name = (lead.owner_name || "").trim();

  if (name.length >= 2 && isPlaceholderOwner(lead.owner_name)) {
    return RAW_REJECT_REASON.PLACEHOLDER_OWNER;
  }

  const hasOwner = hasRealOwnerName(lead);
  const hasStreet = isValidStreetAddress(lead.address);

  if (!hasOwner && !hasStreet) {
    return RAW_REJECT_REASON.MISSING_ADDRESS_AND_OWNER;
  }
  if (!hasOwner) {
    return RAW_REJECT_REASON.NO_OWNER_AFTER_ENRICHMENT;
  }
  if (!hasStreet) {
    return RAW_REJECT_REASON.MISSING_PROPERTY_LOCATION;
  }
  if (!hasMailingAddress(lead)) {
    return RAW_REJECT_REASON.MISSING_MAILING_ADDRESS;
  }

  return RAW_REJECT_REASON.SAVED;
}
