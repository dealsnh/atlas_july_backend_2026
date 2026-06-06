export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS leads (
    id            TEXT PRIMARY KEY,
    county        TEXT NOT NULL,
    state         TEXT NOT NULL,
    lead_type     TEXT NOT NULL,
    owner_name    TEXT,
    address       TEXT,
    city          TEXT,
    zip           TEXT,
    mailing_address TEXT,
    mailing_city  TEXT,
    mailing_state TEXT,
    mailing_zip   TEXT,
    case_number   TEXT,
    filing_date   TEXT,
    assessed_value TEXT,
    tax_year      TEXT,
    lender        TEXT,
    loan_amount   TEXT,
    sale_date     TEXT,
    sale_amount   TEXT,
    description   TEXT,
    source_url    TEXT,
    raw_data      TEXT,
    status        TEXT NOT NULL DEFAULT 'new',
    notes         TEXT,
    skip_traced   INTEGER NOT NULL DEFAULT 0,
    st_phone      TEXT,
    st_email      TEXT,
    st_mailing    TEXT,
    scraped_at    TEXT NOT NULL DEFAULT (datetime('now')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_county ON leads(county);
  CREATE INDEX IF NOT EXISTS idx_leads_lead_type ON leads(lead_type);
  CREATE INDEX IF NOT EXISTS idx_leads_filing_date ON leads(filing_date);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_scraped_at ON leads(scraped_at);

  CREATE TABLE IF NOT EXISTS scrape_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    county      TEXT NOT NULL,
    state       TEXT NOT NULL,
    lead_type   TEXT NOT NULL,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    leads_found INTEGER DEFAULT 0,
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export const MIGRATIONS = [
  "ALTER TABLE leads ADD COLUMN skip_traced INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE leads ADD COLUMN st_phone TEXT",
  "ALTER TABLE leads ADD COLUMN st_email TEXT",
  "ALTER TABLE leads ADD COLUMN st_mailing TEXT",
];

export const LEAD_TYPE_MAP: Record<string, string> = {
  CV: "Code Violation",
  code: "Code Violation",
  DIV: "Divorce",
  divorce: "Divorce",
  VAC: "Vacant/Abandoned",
  vacant: "Vacant/Abandoned",
  OOS: "Out-of-State Owner",
  oos: "Out-of-State Owner",
  "Probate/Estate": "Probate",
  "Estate/Inherited": "Probate",
  "Obituary/Estate": "Obituary",
  "Fire Damaged": "Fire Damage",
  Foreclosure: "Pre-Foreclosure",
};

export const STATE_COUNTY_MAP: Record<string, string> = {
  AL: "Alabama (Statewide)",
  MO: "Missouri (Statewide)",
  OH: "Ohio (Statewide)",
  TX: "Texas (Statewide)",
  WI: "Wisconsin (Statewide)",
  SC: "South Carolina (Statewide)",
  NY: "New York (Statewide)",
  GA: "Georgia (Statewide)",
  FL: "Florida (Statewide)",
};

export function normalizeLeadType(raw: string | null | undefined): string {
  if (!raw) return "Other";
  return LEAD_TYPE_MAP[raw] ?? raw;
}

export function normalizeCounty(county: string | null | undefined): string {
  if (!county) return "Unknown";
  return STATE_COUNTY_MAP[county] ?? county;
}
