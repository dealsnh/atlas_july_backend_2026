import type { Lead } from "../types/lead.js";

const HEADERS = [
  "Lead Type",
  "County",
  "State",
  "Owner Name",
  "Property Address",
  "City",
  "Zip",
  "Mailing Address",
  "Mailing City",
  "Mailing State",
  "Mailing Zip",
  "Case Number",
  "Filing Date",
  "Assessed Value",
  "Tax Year",
  "Lender",
  "Loan Amount",
  "Sale Date",
  "Sale Amount",
  "Description",
  "Source URL",
  "Status",
  "Skip Traced",
  "Phone",
  "Email",
  "Skip Trace Mailing",
];

const FIELDS = [
  "lead_type",
  "county",
  "state",
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
  "status",
  "skip_traced",
  "st_phone",
  "st_email",
  "st_mailing",
];

function escapeCsv(value: string | null | undefined): string {
  if (!value) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function leadsToCsv(
  leads: Array<Record<string, string | number | null | undefined>>,
): string {
  const rows = leads.map((lead) =>
    FIELDS.map((field) => escapeCsv(lead[field] as string | null | undefined)).join(","),
  );
  return [HEADERS.join(","), ...rows].join("\n");
}

export function leadsToEmailCsv(leads: Lead[]): string {
  return leadsToCsv(
    leads.map((lead) => ({
      lead_type: lead.lead_type,
      county: lead.county,
      state: lead.state,
      owner_name: lead.owner_name,
      address: lead.address,
      city: lead.city,
      zip: lead.zip,
      mailing_address: lead.mailing_address,
      mailing_city: lead.mailing_city,
      mailing_state: lead.mailing_state,
      mailing_zip: lead.mailing_zip,
      case_number: lead.case_number,
      filing_date: lead.filing_date,
      assessed_value: lead.assessed_value,
      tax_year: lead.tax_year,
      lender: lead.lender,
      loan_amount: lead.loan_amount,
      sale_date: lead.sale_date,
      sale_amount: lead.sale_amount,
      description: lead.description,
      source_url: lead.source_url,
    })),
  );
}
