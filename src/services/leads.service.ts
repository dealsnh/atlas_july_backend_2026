import {
  countLeads,
  deleteLeadsByFilter,
  findLeadById,
  findLeads,
  getLeadStats,
  updateLeadSkipTrace,
  updateLeadStatus,
} from "../repositories/leads.repository.js";
import type { Lead, LeadFilters } from "../types/lead.js";
import { leadsToCsv } from "./csv.service.js";
import { getRawSettings } from "./settings.service.js";
import { runSkipTrace } from "./skip-trace.service.js";
import { ApiError } from "../utils/api-error.js";

export async function listLeads(filters: LeadFilters): Promise<{ leads: Lead[]; total: number }> {
  const { limit = 100, offset = 0, ...rest } = filters;
  const total = await countLeads(rest);
  const leads = await findLeads({ ...rest, limit, offset });
  return { leads, total };
}

export async function exportLeadsCsv(
  filters: Omit<LeadFilters, "limit" | "offset">,
): Promise<string> {
  const leads = await findLeads(filters);
  return leadsToCsv(leads as unknown as Array<Record<string, string | number | null | undefined>>);
}

export async function patchLead(id: string, status: string, notes?: string): Promise<void> {
  const lead = await findLeadById(id);
  if (!lead) {
    throw ApiError.notFound("Lead not found");
  }
  await updateLeadStatus(id, status, notes);
}

export async function purgeLeads(filter: {
  county?: string;
  source_url?: string;
  owner_name_contains?: string;
}): Promise<number> {
  return deleteLeadsByFilter(filter);
}

export async function getStatsWithLastScrape(lastScrapeTime: string | null) {
  return { ...(await getLeadStats()), lastScrapeTime };
}

export async function skipTraceLead(id: string) {
  const lead = await findLeadById(id);
  if (!lead) {
    throw ApiError.notFound("Lead not found");
  }

  const settings = await getRawSettings();
  if (!settings.skip_trace_key) {
    throw ApiError.badRequest(
      "Easy Button Skip Trace API key not configured. Go to Settings to add it.",
    );
  }

  const result = await runSkipTrace(lead, settings.skip_trace_key);
  await updateLeadSkipTrace(id, result);
  return result;
}

export { getLeadStats, findLeadById };
