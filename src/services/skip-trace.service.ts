import { env } from "../config/env.js";
import { updateLeadSkipTrace } from "../repositories/leads.repository.js";
import type { Lead } from "../types/lead.js";
import { isPlaceholderOwner } from "./owner-placeholders.js";
import { ApiError } from "../utils/api-error.js";
import { logger } from "../utils/logger.js";

export interface SkipTraceResult {
  phone?: string;
  email?: string;
  mailing?: string;
}

const TRACERFY_DEFAULT_URL = "https://tracerfy.com/v1/api/trace/lookup/";

type SkipTraceProvider = "tracerfy" | "generic";

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = firstString(item);
      if (s) return s;
    }
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return (
      firstString(obj.number) ||
      firstString(obj.phone) ||
      firstString(obj.email) ||
      firstString(obj.address) ||
      firstString(obj.value)
    );
  }
  return undefined;
}

function resolveApiUrl(): string {
  return env.SKIP_TRACE_API_URL || TRACERFY_DEFAULT_URL;
}

function resolveProvider(apiUrl: string): SkipTraceProvider {
  if (env.SKIP_TRACE_PROVIDER === "tracerfy") return "tracerfy";
  if (env.SKIP_TRACE_PROVIDER === "generic") return "generic";
  if (apiUrl.includes("tracerfy.com")) return "tracerfy";
  return "generic";
}

function formatMailingAddress(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const m = value as Record<string, unknown>;
  const parts = [m.street, m.city, m.state, m.zip]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** Generic / legacy JSON shape (Easy Button and similar). */
export function parseSkipTraceResponse(data: Record<string, unknown>): SkipTraceResult {
  const nested =
    (data.data && typeof data.data === "object" ? (data.data as Record<string, unknown>) : null) ||
    (data.result && typeof data.result === "object"
      ? (data.result as Record<string, unknown>)
      : null) ||
    data;

  const phone =
    firstString(nested.phone) ||
    firstString(nested.phones) ||
    firstString(nested.mobile) ||
    firstString(nested.phone_number);

  const email =
    firstString(nested.email) || firstString(nested.emails) || firstString(nested.email_address);

  const mailing =
    firstString(nested.mailing) ||
    firstString(nested.mailing_address) ||
    firstString(nested.mailingAddress) ||
    firstString(nested.owner_mailing_address) ||
    formatMailingAddress(nested.mailing_address);

  return { phone, email, mailing };
}

/** Tracerfy POST /v1/api/trace/lookup/ response — see official docs. */
export function parseTracerfyResponse(data: Record<string, unknown>): SkipTraceResult {
  if (data.hit === false) return {};

  const persons = Array.isArray(data.persons) ? data.persons : [];
  if (!persons.length) return {};

  const person =
    (persons.find(
      (p) => p && typeof p === "object" && (p as Record<string, unknown>).property_owner === true,
    ) as Record<string, unknown> | undefined) ||
    (persons[0] as Record<string, unknown>);

  const phones = Array.isArray(person.phones)
    ? ([...person.phones] as Record<string, unknown>[]).sort(
        (a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99),
      )
    : [];
  const preferredPhone =
    phones.find((p) => p.dnc !== true && typeof p.number === "string") ||
    phones.find((p) => typeof p.number === "string");

  const emails = Array.isArray(person.emails)
    ? ([...person.emails] as Record<string, unknown>[]).sort(
        (a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99),
      )
    : [];
  const preferredEmail = emails.find((e) => typeof e.email === "string");

  const mailing =
    formatMailingAddress(person.mailing_address) ||
    [person.mailing_street, person.mailing_city, person.mailing_state, person.mailing_zip]
      .filter((v) => typeof v === "string" && v.trim())
      .join(", ") ||
    undefined;

  return {
    phone: preferredPhone?.number as string | undefined,
    email: preferredEmail?.email as string | undefined,
    mailing,
  };
}

function resolveTraceCity(lead: Lead): string | null {
  const city = lead.city?.trim() || lead.mailing_city?.trim();
  if (city) return city;

  const addr = lead.address?.trim();
  if (!addr) return null;

  const commaParts = addr.split(",").map((s) => s.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    const last = commaParts[commaParts.length - 1]
      .replace(/\s+[A-Z]{2}\s*(\d{5}(-\d{4})?)?\s*$/i, "")
      .trim();
    if (last.length >= 2) return last;
  }

  return null;
}

function buildTracerfyBody(lead: Lead): Record<string, unknown> {
  const address = lead.address?.trim();
  const state = lead.state?.trim();
  const city = resolveTraceCity(lead);
  const zip = lead.zip?.trim() || lead.mailing_zip?.trim();

  if (!address || address.length < 5) {
    throw ApiError.badRequest("Lead has no property address for Tracerfy skip trace");
  }
  if (!city) {
    throw ApiError.badRequest("Lead has no city for Tracerfy skip trace (city is required)");
  }
  if (!state) {
    throw ApiError.badRequest("Lead has no state for Tracerfy skip trace");
  }

  const body: Record<string, unknown> = {
    address,
    city,
    state,
    find_owner: true,
  };
  if (zip) body.zip = zip;
  return body;
}

function buildGenericBody(lead: Lead): Record<string, unknown> {
  return {
    name: lead.owner_name,
    address: lead.address,
    city: lead.city,
    zip: lead.zip,
    state: lead.state,
  };
}

export async function runSkipTrace(lead: Lead, apiKey: string): Promise<SkipTraceResult> {
  const apiUrl = resolveApiUrl();
  const provider = resolveProvider(apiUrl);

  if (provider === "generic" && !lead.owner_name && !lead.address) {
    throw ApiError.badRequest("Lead has no owner name or address to skip trace");
  }
  if (provider === "tracerfy" && !lead.address?.trim()) {
    throw ApiError.badRequest("Lead has no property address for Tracerfy skip trace");
  }

  const body = provider === "tracerfy" ? buildTracerfyBody(lead) : buildGenericBody(lead);

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    logger.error({ err: error, leadId: lead.id, provider }, "Skip trace request failed");
    throw ApiError.internal("Skip trace service unreachable");
  }

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw ApiError.internal("Skip trace service returned invalid JSON");
    }
  }

  if (!response.ok) {
    const message =
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.detail === "string" && parsed.detail) ||
      `Skip trace failed (${response.status})`;
    throw new ApiError(response.status >= 500 ? 502 : response.status, message);
  }

  const result =
    provider === "tracerfy" ? parseTracerfyResponse(parsed) : parseSkipTraceResponse(parsed);

  if (!result.phone && !result.email && !result.mailing) {
    throw ApiError.notFound("No contact information found for this lead");
  }

  return result;
}

export async function skipTraceLeadsBatch(
  leadIds: string[],
  lookupLead: (id: string) => Promise<Lead | undefined>,
  apiKey: string,
  onProgress?: (msg: string) => void,
): Promise<{ traced: number; failed: number }> {
  let traced = 0;
  let failed = 0;

  for (const id of leadIds) {
    try {
      const lead = await lookupLead(id);
      if (!lead || lead.skip_traced) continue;
      if (isPlaceholderOwner(lead.owner_name)) continue;

      const result = await runSkipTrace(lead, apiKey);
      await updateLeadSkipTrace(id, result);
      traced++;
      onProgress?.(`✓ Skip traced ${id}`);
    } catch (error) {
      failed++;
      const msg = error instanceof Error ? error.message : String(error);
      onProgress?.(`✗ Skip trace failed for ${id}: ${msg}`);
      logger.warn({ leadId: id, err: error }, "Auto skip trace failed");
    }
  }

  return { traced, failed };
}
