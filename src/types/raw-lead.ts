export interface RawLead {
  id: string;
  scrape_run_id: number;
  county: string;
  state: string;
  lead_type: string;
  owner_name: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  description: string | null;
  source_url: string | null;
  raw_data: string | null;
  promoted_to_lead: boolean;
  reject_reason: string | null;
  scraped_at: string;
}

export interface RawLeadStatsRow {
  county: string;
  state: string;
  scraped: number;
  saved: number;
  rejected: number;
  by_reason: Record<string, number>;
}
