import {
  countLeads,
  deleteLeadsByFilter,
  findLeadById,
  findLeads,
  getLeadStats,
  insertLeadIfNotExists,
  updateLeadSkipTrace,
  updateLeadStatus,
} from "../repositories/leads.repository.js";
import type { Lead, LeadFilters } from "../types/lead.js";
import { leadsToCsv } from "./csv.service.js";

export async function listLeads(
  filters: LeadFilters,
): Promise<{ leads: Lead[]; total: number }> {
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
  await updateLeadStatus(id, status, notes);
}

export async function importLeads(leads: Array<Record<string, string | null>>): Promise<{
  inserted: number;
  skipped: number;
  total: number;
}> {
  let inserted = 0;
  let skipped = 0;

  for (const lead of leads) {
    try {
      if (await insertLeadIfNotExists(lead)) inserted++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  return { inserted, skipped, total: leads.length };
}

export async function seedDemoLeads(): Promise<{ inserted: number; total: number }> {
  const today = new Date().toISOString().split("T")[0] ?? null;
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split("T")[0] ?? null;

  const seedLeads: Array<Record<string, string | null>> = [
    {
      id: "MO-JACKSON-PREFC-001",
      county: "Jackson",
      state: "MO",
      lead_type: "Pre-Foreclosure",
      owner_name: "Darnell & Keisha Washington",
      address: "3812 Prospect Ave",
      city: "Kansas City",
      zip: "64128",
      mailing_address: "3812 Prospect Ave",
      mailing_city: "Kansas City",
      mailing_state: "MO",
      mailing_zip: "64128",
      case_number: "2026CV-04821",
      filing_date: twoDaysAgo,
      assessed_value: "142000",
      tax_year: "2025",
      lender: "Ocwen Loan Servicing",
      loan_amount: "118000",
      sale_date: null,
      sale_amount: null,
      description: "Jackson County Pre-Foreclosure — Case 2026CV-04821",
      source_url: "https://www.jacksongov.org/sheriff",
      scraped_at: today,
    },
    {
      id: "AL-MADISON-PREFC-001",
      county: "Madison",
      state: "AL",
      lead_type: "Pre-Foreclosure",
      owner_name: "Anthony & Brenda Simmons",
      address: "4401 Whitesburg Dr S",
      city: "Huntsville",
      zip: "35802",
      mailing_address: "4401 Whitesburg Dr S",
      mailing_city: "Huntsville",
      mailing_state: "AL",
      mailing_zip: "35802",
      case_number: "CV-2026-000891",
      filing_date: today,
      assessed_value: "198000",
      tax_year: "2025",
      lender: "Freedom Mortgage",
      loan_amount: "164000",
      sale_date: null,
      sale_amount: null,
      description: "Madison County Pre-Foreclosure — CV-2026-000891",
      source_url: "https://www.madisoncountyal.gov/sheriff",
      scraped_at: today,
    },
    {
      id: "OH-HAMILTON-PREFC-001",
      county: "Hamilton",
      state: "OH",
      lead_type: "Pre-Foreclosure",
      owner_name: "David & Connie Reardon",
      address: "5512 Glenway Ave",
      city: "Cincinnati",
      zip: "45238",
      mailing_address: "5512 Glenway Ave",
      mailing_city: "Cincinnati",
      mailing_state: "OH",
      mailing_zip: "45238",
      case_number: "A2600891",
      filing_date: today,
      assessed_value: "178000",
      tax_year: "2025",
      lender: "Lakeview Loan Servicing",
      loan_amount: "149000",
      sale_date: null,
      sale_amount: null,
      description: "Hamilton County Pre-Foreclosure — A2600891",
      source_url: "https://www.hamiltoncountyohio.gov/sheriff",
      scraped_at: today,
    },
  ];

  let inserted = 0;
  for (const lead of seedLeads) {
    if (await insertLeadIfNotExists(lead)) inserted++;
  }

  return { inserted, total: seedLeads.length };
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

export async function skipTraceLead(id: string): Promise<never> {
  const lead = await findLeadById(id);
  if (!lead) {
    throw new Error("Lead not found");
  }
  await updateLeadSkipTrace(id, {});
  throw new Error("NOT_IMPLEMENTED");
}

export { getLeadStats, findLeadById };
