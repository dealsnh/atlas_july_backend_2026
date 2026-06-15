import { normalizeCounty, normalizeLeadType } from "../db/schema.js";
import { execute, query, queryOne } from "../db/query.js";
import type { Lead as ScraperLead } from "../scrapers/base.js";
import type { RawLead, RawLeadStatsRow } from "../types/raw-lead.js";

const RAW_FIELDS = [
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

function leadToRow(lead: ScraperLead): Record<string, string | null> {
  const row: Record<string, string | null> = {
    id: lead.id,
    county: normalizeCounty(lead.county),
    state: lead.state,
    lead_type: normalizeLeadType(lead.lead_type),
  };
  for (const field of RAW_FIELDS) {
    row[field] = lead[field] ?? null;
  }
  return row;
}

/** Store scraped row before/after enrichment (one row per scrape run + lead id). */
export async function upsertRawLead(scrapeRunId: number, lead: ScraperLead): Promise<void> {
  const row = leadToRow(lead);
  await execute(
    `
    INSERT INTO raw_leads (
      id, scrape_run_id, county, state, lead_type,
      owner_name, address, city, zip,
      mailing_address, mailing_city, mailing_state, mailing_zip,
      case_number, filing_date, assessed_value, tax_year, lender,
      loan_amount, sale_date, sale_amount, description, source_url, raw_data,
      promoted_to_lead, reject_reason
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13,
      $14, $15, $16, $17, $18,
      $19, $20, $21, $22, $23, $24,
      FALSE, NULL
    )
    ON CONFLICT (scrape_run_id, id) DO UPDATE SET
      owner_name = EXCLUDED.owner_name,
      address = EXCLUDED.address,
      city = EXCLUDED.city,
      zip = EXCLUDED.zip,
      mailing_address = EXCLUDED.mailing_address,
      mailing_city = EXCLUDED.mailing_city,
      mailing_state = EXCLUDED.mailing_state,
      mailing_zip = EXCLUDED.mailing_zip,
      case_number = EXCLUDED.case_number,
      filing_date = EXCLUDED.filing_date,
      assessed_value = EXCLUDED.assessed_value,
      tax_year = EXCLUDED.tax_year,
      lender = EXCLUDED.lender,
      loan_amount = EXCLUDED.loan_amount,
      sale_date = EXCLUDED.sale_date,
      sale_amount = EXCLUDED.sale_amount,
      description = EXCLUDED.description,
      source_url = EXCLUDED.source_url,
      raw_data = EXCLUDED.raw_data
  `,
    [
      row.id,
      scrapeRunId,
      row.county,
      row.state,
      row.lead_type,
      row.owner_name,
      row.address,
      row.city,
      row.zip,
      row.mailing_address,
      row.mailing_city,
      row.mailing_state,
      row.mailing_zip,
      row.case_number,
      row.filing_date,
      row.assessed_value,
      row.tax_year,
      row.lender,
      row.loan_amount,
      row.sale_date,
      row.sale_amount,
      row.description,
      row.source_url,
      row.raw_data,
    ],
  );
}

export async function finalizeRawLead(
  scrapeRunId: number,
  lead: ScraperLead,
  outcome: { promoted: boolean; rejectReason: string | null },
): Promise<void> {
  const row = leadToRow(lead);
  await execute(
    `
    UPDATE raw_leads SET
      owner_name = $3,
      address = $4,
      city = $5,
      zip = $6,
      mailing_address = $7,
      mailing_city = $8,
      mailing_state = $9,
      mailing_zip = $10,
      case_number = $11,
      filing_date = $12,
      description = $13,
      source_url = $14,
      raw_data = $15,
      promoted_to_lead = $16,
      reject_reason = $17
    WHERE scrape_run_id = $1 AND id = $2
  `,
    [
      scrapeRunId,
      lead.id,
      row.owner_name,
      row.address,
      row.city,
      row.zip,
      row.mailing_address,
      row.mailing_city,
      row.mailing_state,
      row.mailing_zip,
      row.case_number,
      row.filing_date,
      row.description,
      row.source_url,
      row.raw_data,
      outcome.promoted,
      outcome.rejectReason,
    ],
  );
}

export async function countRawLeadsForRun(scrapeRunId: number): Promise<{
  scraped: number;
  saved: number;
  rejected: number;
}> {
  const row = await queryOne<{ scraped: string; saved: string; rejected: string }>(
    `
    SELECT
      COUNT(*)::int AS scraped,
      COUNT(*) FILTER (WHERE promoted_to_lead)::int AS saved,
      COUNT(*) FILTER (WHERE NOT promoted_to_lead)::int AS rejected
    FROM raw_leads
    WHERE scrape_run_id = $1
  `,
    [scrapeRunId],
  );
  return {
    scraped: Number(row?.scraped ?? 0),
    saved: Number(row?.saved ?? 0),
    rejected: Number(row?.rejected ?? 0),
  };
}

export async function getRawLeadStatsByCounty(scrapeRunId: number): Promise<RawLeadStatsRow[]> {
  const rows = await query<{
    county: string;
    state: string;
    scraped: number;
    saved: number;
    rejected: number;
    reject_reason: string | null;
    cnt: number;
  }>(
    `
    WITH base AS (
      SELECT county, state, promoted_to_lead, reject_reason
      FROM raw_leads
      WHERE scrape_run_id = $1
    )
    SELECT b.county, b.state, b.reject_reason, COUNT(*)::int AS cnt,
      (SELECT COUNT(*)::int FROM base b2 WHERE b2.county = b.county AND b2.state = b.state) AS scraped,
      (SELECT COUNT(*)::int FROM base b2 WHERE b2.county = b.county AND b2.state = b.state AND b2.promoted_to_lead) AS saved,
      (SELECT COUNT(*)::int FROM base b2 WHERE b2.county = b.county AND b2.state = b.state AND NOT b2.promoted_to_lead) AS rejected
    FROM base b
    GROUP BY b.county, b.state, b.reject_reason
    ORDER BY b.county
  `,
    [scrapeRunId],
  );

  const map = new Map<string, RawLeadStatsRow>();
  for (const row of rows) {
    const key = `${row.state}:${row.county}`;
    if (!map.has(key)) {
      map.set(key, {
        county: row.county,
        state: row.state,
        scraped: row.scraped,
        saved: row.saved,
        rejected: row.rejected,
        by_reason: {},
      });
    }
    const entry = map.get(key)!;
    const reason = row.reject_reason ?? "unknown";
    entry.by_reason[reason] = (entry.by_reason[reason] ?? 0) + row.cnt;
  }

  return [...map.values()].sort((a, b) => b.scraped - a.scraped);
}

export async function listRawLeads(filters: {
  scrape_run_id?: number;
  county?: string;
  state?: string;
  promoted?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ rows: RawLead[]; total: number }> {
  let sql = `
    SELECT id, scrape_run_id, county, state, lead_type,
           owner_name, address, city, zip, description, source_url, raw_data,
           promoted_to_lead, reject_reason, scraped_at
    FROM raw_leads WHERE 1=1
  `;
  let countSql = "SELECT COUNT(*)::int AS c FROM raw_leads WHERE 1=1";
  const params: unknown[] = [];
  let i = 1;

  if (filters.scrape_run_id) {
    sql += ` AND scrape_run_id = $${i}`;
    countSql += ` AND scrape_run_id = $${i}`;
    params.push(filters.scrape_run_id);
    i++;
  }
  if (filters.county) {
    sql += ` AND county ILIKE $${i}`;
    countSql += ` AND county ILIKE $${i}`;
    params.push(filters.county);
    i++;
  }
  if (filters.state) {
    sql += ` AND state = $${i}`;
    countSql += ` AND state = $${i}`;
    params.push(filters.state);
    i++;
  }
  if (filters.promoted === true) {
    sql += " AND promoted_to_lead = TRUE";
    countSql += " AND promoted_to_lead = TRUE";
  } else if (filters.promoted === false) {
    sql += " AND promoted_to_lead = FALSE";
    countSql += " AND promoted_to_lead = FALSE";
  }

  const countParams = [...params];
  const totalRow = await queryOne<{ c: number }>(countSql, countParams);

  sql += ` ORDER BY scraped_at DESC LIMIT $${i} OFFSET $${i + 1}`;
  params.push(filters.limit ?? 100, filters.offset ?? 0);

  const rows = await query<RawLead>(sql, params);
  return { rows, total: totalRow?.c ?? 0 };
}

export async function getLatestScrapeRunId(): Promise<number | null> {
  const row = await queryOne<{ id: number }>(
    "SELECT id FROM scrape_runs ORDER BY started_at DESC LIMIT 1",
  );
  return row?.id ?? null;
}

export async function countPendingRawLeads(filters: {
  county?: string;
  state?: string;
  lead_type?: string;
  from_date?: string;
  to_date?: string;
}): Promise<number> {
  let sql = `
    SELECT COUNT(*)::int AS c FROM raw_leads r
    WHERE r.promoted_to_lead = FALSE
      AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = r.id)
  `;
  const params: unknown[] = [];
  let i = 1;

  if (filters.county) {
    sql += ` AND r.county ILIKE $${i++}`;
    params.push(filters.county);
  }
  if (filters.state) {
    sql += ` AND r.state = $${i++}`;
    params.push(filters.state);
  }
  if (filters.lead_type) {
    sql += ` AND r.lead_type = $${i++}`;
    params.push(filters.lead_type);
  }
  if (filters.from_date) {
    sql += ` AND r.scraped_at >= $${i++}::date`;
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    sql += ` AND r.scraped_at < ($${i++}::date + INTERVAL '1 day')`;
    params.push(filters.to_date);
  }

  const row = await queryOne<{ c: number }>(sql, params);
  return row?.c ?? 0;
}

export async function getPendingRawByCounty(): Promise<
  Array<{ county: string; state: string; count: number }>
> {
  return query<{ county: string; state: string; count: number }>(
    `
    SELECT r.county, r.state, COUNT(*)::int AS count
    FROM raw_leads r
    WHERE r.promoted_to_lead = FALSE
      AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = r.id)
    GROUP BY r.county, r.state
    ORDER BY count DESC
  `,
  );
}

export async function findPendingRawLeads(filters: {
  county?: string;
  state?: string;
  lead_type?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}): Promise<RawLead[]> {
  let sql = `
    SELECT r.id, r.scrape_run_id, r.county, r.state, r.lead_type,
           r.owner_name, r.address, r.city, r.zip, r.description, r.source_url, r.raw_data,
           r.promoted_to_lead, r.reject_reason, r.scraped_at
    FROM raw_leads r
    WHERE r.promoted_to_lead = FALSE
      AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = r.id)
  `;
  const params: unknown[] = [];
  let i = 1;

  if (filters.county) {
    sql += ` AND r.county ILIKE $${i++}`;
    params.push(filters.county);
  }
  if (filters.state) {
    sql += ` AND r.state = $${i++}`;
    params.push(filters.state);
  }
  if (filters.lead_type) {
    sql += ` AND r.lead_type = $${i++}`;
    params.push(filters.lead_type);
  }
  if (filters.from_date) {
    sql += ` AND r.scraped_at >= $${i++}::date`;
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    sql += ` AND r.scraped_at < ($${i++}::date + INTERVAL '1 day')`;
    params.push(filters.to_date);
  }

  sql += ` ORDER BY r.scraped_at DESC LIMIT $${i} OFFSET $${i + 1}`;
  params.push(filters.limit ?? 500, filters.offset ?? 0);

  return query<RawLead>(sql, params);
}
