import { normalizeCounty, normalizeLeadType } from "../db/schema.js";
import { execute, query, queryOne } from "../db/query.js";
import { isLeadSaveable } from "../services/enrichment.service.js";
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

export async function insertLeadIfNotExists(lead: Record<string, string | null>): Promise<boolean> {
  if (!isLeadSaveable(lead as never)) return false;

  const existing = await queryOne<{ id: string }>("SELECT id FROM leads WHERE id = $1", [lead.id]);
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

  const inserted = await execute(
    `
    INSERT INTO leads (
      id, county, state, lead_type, owner_name, address, city, zip,
      mailing_address, mailing_city, mailing_state, mailing_zip,
      case_number, filing_date, assessed_value, tax_year, lender,
      loan_amount, sale_date, sale_amount, description, source_url, raw_data,
      scraped_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23,
      COALESCE($24::timestamptz, NOW())
    )
    ON CONFLICT (id) DO NOTHING
  `,
    [
      safeLead.id,
      safeLead.county,
      safeLead.state,
      safeLead.lead_type,
      safeLead.owner_name,
      safeLead.address,
      safeLead.city,
      safeLead.zip,
      safeLead.mailing_address,
      safeLead.mailing_city,
      safeLead.mailing_state,
      safeLead.mailing_zip,
      safeLead.case_number,
      safeLead.filing_date,
      safeLead.assessed_value,
      safeLead.tax_year,
      safeLead.lender,
      safeLead.loan_amount,
      safeLead.sale_date,
      safeLead.sale_amount,
      safeLead.description,
      safeLead.source_url,
      safeLead.raw_data,
      scrapedAt,
    ],
  );

  return inserted > 0;
}

function buildFilterClause(
  filters: Omit<LeadFilters, "limit" | "offset">,
  startIndex = 1,
): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  let clause = "";
  let i = startIndex;

  if (filters.county) {
    clause += ` AND county = $${i++}`;
    params.push(filters.county);
  }
  if (filters.lead_type) {
    clause += ` AND lead_type = $${i++}`;
    params.push(filters.lead_type);
  }
  if (filters.status) {
    clause += ` AND status = $${i++}`;
    params.push(filters.status);
  }
  if (filters.from_date) {
    clause += ` AND filing_date >= $${i++}`;
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    clause += ` AND filing_date <= $${i++}`;
    params.push(filters.to_date);
  }

  return { clause, params };
}

export async function countLeads(filters: Omit<LeadFilters, "limit" | "offset">): Promise<number> {
  const { clause, params } = buildFilterClause(filters);
  const row = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM leads WHERE 1=1${clause}`,
    params,
  );
  return Number(row?.c ?? 0);
}

export async function findLeads(filters: LeadFilters): Promise<Lead[]> {
  const { clause, params } = buildFilterClause(filters);
  let sql = `SELECT * FROM leads WHERE 1=1${clause} ORDER BY filing_date DESC NULLS LAST, scraped_at DESC`;
  const allParams = [...params];

  if (filters.limit !== undefined) {
    sql += ` LIMIT $${allParams.length + 1} OFFSET $${allParams.length + 2}`;
    allParams.push(filters.limit, filters.offset ?? 0);
  }

  return query<Lead>(sql, allParams);
}

export async function updateLeadStatus(id: string, status: string, notes?: string): Promise<void> {
  await execute("UPDATE leads SET status = $1, notes = $2, updated_at = NOW() WHERE id = $3", [
    status,
    notes ?? null,
    id,
  ]);
}

export async function updateLeadSkipTrace(
  id: string,
  data: { phone?: string; email?: string; mailing?: string },
): Promise<void> {
  await execute(
    `
    UPDATE leads SET
      skip_traced = TRUE,
      st_phone    = COALESCE($1, st_phone),
      st_email    = COALESCE($2, st_email),
      st_mailing  = COALESCE($3, st_mailing),
      updated_at  = NOW()
    WHERE id = $4
  `,
    [data.phone ?? null, data.email ?? null, data.mailing ?? null, id],
  );
}

export async function findLeadById(id: string): Promise<Lead | undefined> {
  return queryOne<Lead>("SELECT * FROM leads WHERE id = $1", [id]);
}

export async function getLeadStats(): Promise<LeadStats> {
  const totalRow = await queryOne<{ c: string }>("SELECT COUNT(*)::int AS c FROM leads");
  const byType = await query<{ lead_type: string; count: number }>(
    "SELECT lead_type, COUNT(*)::int AS count FROM leads GROUP BY lead_type ORDER BY count DESC",
  );
  const byCounty = await query<{ county: string; count: number }>(
    "SELECT county, COUNT(*)::int AS count FROM leads GROUP BY county ORDER BY count DESC",
  );
  const todayRow = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM leads
     WHERE (scraped_at AT TIME ZONE 'America/New_York')::date
       = (NOW() AT TIME ZONE 'America/New_York')::date`,
  );
  const lastRunRow = await queryOne<{ t: string | null }>(
    "SELECT MAX(finished_at) AS t FROM scrape_runs WHERE status = 'success'",
  );

  return {
    total: Number(totalRow?.c ?? 0),
    byType,
    byCounty,
    today: Number(todayRow?.c ?? 0),
    lastRun: lastRunRow?.t ?? null,
  };
}

export async function deleteLeadsByFilter(filter: {
  county?: string;
  source_url?: string;
  owner_name_contains?: string;
}): Promise<number> {
  let sql = "DELETE FROM leads WHERE 1=1";
  const params: unknown[] = [];
  let i = 1;

  if (filter.county) {
    sql += ` AND LOWER(county) = LOWER($${i++})`;
    params.push(filter.county);
  }
  if (filter.source_url) {
    sql += ` AND source_url = $${i++}`;
    params.push(filter.source_url);
  }
  if (filter.owner_name_contains) {
    sql += ` AND owner_name ILIKE $${i++}`;
    params.push(`%${filter.owner_name_contains}%`);
  }

  return execute(sql, params);
}

const NEEDS_ENRICHMENT_WHERE = `
  (owner_name IS NULL OR trim(owner_name) = '' OR length(trim(owner_name)) < 2
   OR owner_name ILIKE '%fsbo seller%'
   OR owner_name ILIKE '%unknown%craigslist%'
   OR owner_name ILIKE 'tax sale%'
   OR owner_name ILIKE 'clay county tax sale%'
   OR address IS NULL OR trim(address) = '' OR length(trim(address)) < 5
   OR mailing_address IS NULL OR trim(mailing_address) = '')
`;

export async function countLeadsNeedingEnrichment(filter: {
  county?: string;
  state?: string;
}): Promise<number> {
  let sql = `SELECT COUNT(*)::int AS c FROM leads WHERE ${NEEDS_ENRICHMENT_WHERE}`;
  const params: unknown[] = [];
  let i = 1;
  if (filter.county) {
    sql += ` AND LOWER(county) = LOWER($${i++})`;
    params.push(filter.county);
  }
  if (filter.state) {
    sql += ` AND UPPER(state) = UPPER($${i++})`;
    params.push(filter.state);
  }
  const row = await queryOne<{ c: number }>(sql, params);
  return Number(row?.c ?? 0);
}

export async function findLeadsNeedingEnrichment(filter: {
  county?: string;
  state?: string;
  limit?: number;
}): Promise<Lead[]> {
  let sql = `SELECT * FROM leads WHERE ${NEEDS_ENRICHMENT_WHERE}`;
  const params: unknown[] = [];
  let i = 1;
  if (filter.county) {
    sql += ` AND LOWER(county) = LOWER($${i++})`;
    params.push(filter.county);
  }
  if (filter.state) {
    sql += ` AND UPPER(state) = UPPER($${i++})`;
    params.push(filter.state);
  }
  sql += ` ORDER BY scraped_at DESC LIMIT $${i}`;
  params.push(filter.limit ?? 500);
  return query<Lead>(sql, params);
}

export async function updateLeadEnrichment(
  id: string,
  lead: Pick<
    Lead,
    | "owner_name"
    | "address"
    | "city"
    | "zip"
    | "mailing_address"
    | "mailing_city"
    | "mailing_state"
    | "mailing_zip"
  >,
): Promise<void> {
  await execute(
    `
    UPDATE leads SET
      owner_name       = COALESCE($1, owner_name),
      address          = COALESCE($2, address),
      city             = COALESCE($3, city),
      zip              = COALESCE($4, zip),
      mailing_address  = COALESCE($5, mailing_address),
      mailing_city     = COALESCE($6, mailing_city),
      mailing_state    = COALESCE($7, mailing_state),
      mailing_zip      = COALESCE($8, mailing_zip),
      updated_at       = NOW()
    WHERE id = $9
  `,
    [
      lead.owner_name,
      lead.address,
      lead.city,
      lead.zip,
      lead.mailing_address,
      lead.mailing_city,
      lead.mailing_state,
      lead.mailing_zip,
      id,
    ],
  );
}
