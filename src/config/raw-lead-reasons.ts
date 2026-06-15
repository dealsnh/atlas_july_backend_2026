import type { Lead as ScraperLead } from "../scrapers/base.js";
import {
  hasUsableIdentity,
  hasUsablePropertyLocation,
  isLeadSaveable,
} from "../services/enrichment.service.js";
import { isPlaceholderOwner } from "../services/owner-placeholders.js";

/** Why a scraped row did not become a portal lead. */
export const RAW_REJECT_REASON = {
  SAVED: "saved",
  NO_OWNER_AFTER_ENRICHMENT: "no_owner_after_enrichment",
  PLACEHOLDER_OWNER: "placeholder_owner",
  MISSING_ADDRESS_AND_OWNER: "missing_address_and_owner",
  MISSING_PROPERTY_LOCATION: "missing_property_location",
  DUPLICATE: "duplicate",
  DUPLICATE_IN_BATCH: "duplicate_in_batch",
} as const;

export type RawRejectReason = (typeof RAW_REJECT_REASON)[keyof typeof RAW_REJECT_REASON];

export function resolveRejectReason(lead: ScraperLead): string {
  const name = (lead.owner_name || "").trim();

  if (name.length >= 2 && isPlaceholderOwner(lead.owner_name)) {
    return RAW_REJECT_REASON.PLACEHOLDER_OWNER;
  }

  if (!hasUsableIdentity(lead) && !hasUsablePropertyLocation(lead)) {
    return RAW_REJECT_REASON.MISSING_ADDRESS_AND_OWNER;
  }

  if (!hasUsableIdentity(lead)) {
    return RAW_REJECT_REASON.NO_OWNER_AFTER_ENRICHMENT;
  }

  if (!hasUsablePropertyLocation(lead)) {
    return RAW_REJECT_REASON.MISSING_PROPERTY_LOCATION;
  }

  if (!isLeadSaveable(lead)) return RAW_REJECT_REASON.MISSING_ADDRESS_AND_OWNER;

  return RAW_REJECT_REASON.MISSING_ADDRESS_AND_OWNER;
}
