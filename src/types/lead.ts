export interface Lead {
  id: string;
  county: string;
  state: string;
  lead_type: string;
  owner_name: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  case_number: string | null;
  filing_date: string | null;
  assessed_value: string | null;
  tax_year: string | null;
  lender: string | null;
  loan_amount: string | null;
  sale_date: string | null;
  sale_amount: string | null;
  description: string | null;
  source_url: string | null;
  raw_data: string | null;
  status?: string;
  notes?: string | null;
  skip_traced?: number | boolean;
  st_phone?: string | null;
  st_email?: string | null;
  st_mailing?: string | null;
  scraped_at?: string;
  created_at?: string;
  updated_at?: string;
  /** Present when merged from raw_leads via include_pending */
  pipeline_status?: "complete" | "pending";
  reject_reason?: string | null;
  /** complete = street + owner enriched; partial = saved with gaps */
  enrichment_status?: "complete" | "partial";
}

export interface LeadFilters {
  county?: string;
  /** Required to disambiguate same-named counties across states (Hamilton OH vs Hamilton TN). */
  state?: string;
  lead_type?: string;
  status?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
  include_pending?: boolean | string;
}

export interface LeadStats {
  total: number;
  byType: Array<{ lead_type: string; count: number }>;
  byCounty: Array<{ county: string; count: number }>;
  today: number;
  lastRun: string | null;
  pending_raw?: number;
  pendingByCounty?: Array<{ county: string; state: string; count: number }>;
}

export interface ScrapeRun {
  id: number;
  county: string;
  state: string;
  lead_type: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  leads_found: number;
  error: string | null;
}
