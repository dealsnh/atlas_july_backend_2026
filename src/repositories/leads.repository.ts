import { getDb } from "../db/connection.js";
import { normalizeCounty, normalizeLeadType } from "../db/schema.js";
import type { Lead, LeadFilters, LeadStats } from "../types/lead.js";

const LEAD_FIELDS = [
  "id",
  "county",
  "state",
  "lead_type",
  "owner_name",
  "address",
  "city",
  "zip",
  "mailing_address",
  "mailing_city",
  "mailing_state",
  "mailing_zip",
  "case_number",
  "filing_date",
  "assessed_value",
  "tax_year",
  "lender",
  "loan_amount",
  "sale_date",
  "sale_amount",
  "description",
  "source_url",
  "raw_data",
] as const;

export function insertLeadIfNotExists(lead: Record<string, string | null>): boolean {
  const addr = (lead.address || "").trim();
  const name = (lead.owner_name || "").trim();
  if ((!addr || addr.length < 5) && (!name || name.length < 2)) return false;

  const db = getDb();
  const existing = db.prepare("SELECT id FROM leads WHERE id = ?").get(lead.id);
  if (existing) return false;

  const normalized: Record<string, string | null> = { ...lead };
  normalized.lead_type = normalizeLeadType(lead.lead_type);
  normalized.county = normalizeCounty(lead.county);

  const safeLead: Record<string, string | null> = {};
  for (const field of LEAD_FIELDS) {
    safeLead[field] = normalized[field] !== undefined ? normalized[field] : null;
  }

  const scrapedAt =
    lead.scraped_at && typeof lead.scraped_at === "string" && lead.scraped_at.length > 0
      ? lead.scraped_at
      : null;

  db.prepare(`
    INSERT INTO leads (
      id, county, state, lead_type, owner_name, address, city, zip,
      mailing_address, mailing_city, mailing_state, mailing_zip,
      case_number, filing_date, assessed_value, tax_year, lender,
      loan_amount, sale_date, sale_amount, description, source_url, raw_data,
      scraped_at
    ) VALUES (
      @id, @county, @state, @lead_type, @owner_name, @address, @city, @zip,
      @mailing_address, @mailing_city, @mailing_state, @mailing_zip,
      @case_number, @filing_date, @assessed_value, @tax_year, @lender,
      @loan_amount, @sale_date, @sale_amount, @description, @source_url, @raw_data,
      COALESCE(@scraped_at, datetime('now'))
    )
  `).run({ ...safeLead, scraped_at: scrapedAt });

  return true;
}

export function countLeads(filters: Omit<LeadFilters, "limit" | "offset">): number {
  const db = getDb();
  let query = "SELECT COUNT(*) as c FROM leads WHERE 1=1";
  const params: Record<string, string> = {};

  if (filters.county) {
    query += " AND county = @county";
    params.county = filters.county;
  }
  if (filters.lead_type) {
    query += " AND lead_type = @lead_type";
    params.lead_type = filters.lead_type;
  }
  if (filters.status) {
    query += " AND status = @status";
    params.status = filters.status;
  }
  if (filters.from_date) {
    query += " AND filing_date >= @from_date";
    params.from_date = filters.from_date;
  }
  if (filters.to_date) {
    query += " AND filing_date <= @to_date";
    params.to_date = filters.to_date;
  }

  const row = db.prepare(query).get(params) as { c: number };
  return row.c;
}

export function findLeads(filters: LeadFilters): Lead[] {
  const db = getDb();
  let query = "SELECT * FROM leads WHERE 1=1";
  const params: Record<string, string | number> = {};

  if (filters.county) {
    query += " AND county = @county";
    params.county = filters.county;
  }
  if (filters.lead_type) {
    query += " AND lead_type = @lead_type";
    params.lead_type = filters.lead_type;
  }
  if (filters.status) {
    query += " AND status = @status";
    params.status = filters.status;
  }
  if (filters.from_date) {
    query += " AND filing_date >= @from_date";
    params.from_date = filters.from_date;
  }
  if (filters.to_date) {
    query += " AND filing_date <= @to_date";
    params.to_date = filters.to_date;
  }

  query += " ORDER BY filing_date DESC, scraped_at DESC";

  if (filters.limit !== undefined) {
    query += " LIMIT @limit OFFSET @offset";
    params.limit = filters.limit;
    params.offset = filters.offset ?? 0;
  }

  return db.prepare(query).all(params) as Lead[];
}

export function updateLeadStatus(id: string, status: string, notes?: string): void {
  getDb()
    .prepare("UPDATE leads SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, notes ?? null, id);
}

export function updateLeadSkipTrace(
  id: string,
  data: { phone?: string; email?: string; mailing?: string },
): void {
  getDb()
    .prepare(`
    UPDATE leads SET
      skip_traced = 1,
      st_phone    = COALESCE(?, st_phone),
      st_email    = COALESCE(?, st_email),
      st_mailing  = COALESCE(?, st_mailing),
      updated_at  = datetime('now')
    WHERE id = ?
  `)
    .run(data.phone ?? null, data.email ?? null, data.mailing ?? null, id);
}

export function findLeadById(id: string): Lead | undefined {
  return getDb().prepare("SELECT * FROM leads WHERE id = ?").get(id) as Lead | undefined;
}

export function getLeadStats(): LeadStats {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) as c FROM leads").get() as { c: number }).c;
  const byType = db
    .prepare(
      "SELECT lead_type, COUNT(*) as count FROM leads GROUP BY lead_type ORDER BY count DESC",
    )
    .all() as Array<{ lead_type: string; count: number }>;
  const byCounty = db
    .prepare("SELECT county, COUNT(*) as count FROM leads GROUP BY county ORDER BY count DESC")
    .all() as Array<{ county: string; count: number }>;
  const today = db
    .prepare(
      "SELECT COUNT(*) as c FROM leads WHERE date(scraped_at, '-5 hours') = date('now', '-5 hours')",
    )
    .get() as { c: number };
  const lastRun = db
    .prepare("SELECT MAX(finished_at) as t FROM scrape_runs WHERE status = 'success'")
    .get() as { t: string | null };

  return { total, byType, byCounty, today: today.c, lastRun: lastRun?.t ?? null };
}

export function deleteLeadsByFilter(filter: {
  county?: string;
  source_url?: string;
  owner_name_contains?: string;
}): number {
  const db = getDb();
  let sql = "DELETE FROM leads WHERE 1=1";
  const params: string[] = [];

  if (filter.county) {
    sql += " AND LOWER(county) = LOWER(?)";
    params.push(filter.county);
  }
  if (filter.source_url) {
    sql += " AND source_url = ?";
    params.push(filter.source_url);
  }
  if (filter.owner_name_contains) {
    sql += " AND owner_name LIKE ?";
    params.push(`%${filter.owner_name_contains}%`);
  }

  return db.prepare(sql).run(...params).changes;
}
