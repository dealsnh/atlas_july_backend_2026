import {
  countLeads,
  deleteLeadsByFilter,
  findLeadById,
  findLeads,
  getLeadStats,
  updateLeadSkipTrace,
  updateLeadStatus,
} from "../repositories/leads.repository.js";
import {
  countPendingRawLeads,
  findPendingRawLeads,
  getPendingRawByCounty,
} from "../repositories/raw-leads.repository.js";
import type { Lead, LeadFilters } from "../types/lead.js";
import type { RawLead } from "../types/raw-lead.js";
import { leadsToCsv } from "./csv.service.js";
import { getRawSettings } from "./settings.service.js";
import { runSkipTrace } from "./skip-trace.service.js";
import { ApiError } from "../utils/api-error.js";

function rawLeadToPendingLead(row: RawLead): Lead {
  return {
    id: row.id,
    county: row.county,
    state: row.state,
    lead_type: row.lead_type,
    owner_name: row.owner_name,
    address: row.address,
    city: row.city,
    zip: row.zip,
    mailing_address: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    case_number: null,
    filing_date: null,
    assessed_value: null,
    tax_year: null,
    lender: null,
    loan_amount: null,
    sale_date: null,
    sale_amount: null,
    description: row.description,
    source_url: row.source_url,
    raw_data: row.raw_data,
    status: "new",
    scraped_at: row.scraped_at,
    pipeline_status: "pending",
    reject_reason: row.reject_reason,
  };
}

export async function listLeads(
  filters: LeadFilters & { include_pending?: string | boolean },
): Promise<{ leads: Lead[]; total: number }> {
  const includePending =
    filters.include_pending === true || filters.include_pending === "true";
  const { limit = 100, offset = 0, include_pending: _ip, ...rest } = filters;

  if (!includePending) {
    const total = await countLeads(rest);
    const leads = await findLeads({ ...rest, limit, offset });
    return {
      leads: leads.map((l) => ({ ...l, pipeline_status: "complete" as const })),
      total,
    };
  }

  const pendingFilters = {
    county: rest.county,
    state: undefined as string | undefined,
    lead_type: rest.lead_type,
    from_date: rest.from_date,
    to_date: rest.to_date,
  };

  const [completeTotal, pendingTotal, completeLeads, pendingRows] = await Promise.all([
    countLeads(rest),
    countPendingRawLeads(pendingFilters),
    findLeads({ ...rest, limit: 5000, offset: 0 }),
    findPendingRawLeads({ ...pendingFilters, limit: 5000, offset: 0 }),
  ]);

  const completeIds = new Set(completeLeads.map((l) => l.id));
  const pendingLeads = pendingRows
    .filter((r) => !completeIds.has(r.id))
    .map(rawLeadToPendingLead);

  const merged = [
    ...completeLeads.map((l) => ({ ...l, pipeline_status: "complete" as const })),
    ...pendingLeads,
  ];

  const total = completeTotal + pendingTotal;
  const page = merged.slice(offset, offset + limit);
  return { leads: page, total };
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
  const stats = await getLeadStats();
  const pending_raw = await countPendingRawLeads({});
  const pendingByCounty = await getPendingRawByCounty();
  return { ...stats, lastScrapeTime, pending_raw, pendingByCounty };
}

export async function skipTraceLead(id: string) {
  const lead = await findLeadById(id);
  if (!lead) {
    throw ApiError.notFound("Lead not found");
  }

  const settings = await getRawSettings();
  if (!settings.skip_trace_key) {
    throw ApiError.badRequest(
      "Skip trace API key not configured. Go to Settings to add your Tracerfy key.",
    );
  }

  const result = await runSkipTrace(lead, settings.skip_trace_key);
  await updateLeadSkipTrace(id, result);
  return result;
}

export { getLeadStats, findLeadById };
