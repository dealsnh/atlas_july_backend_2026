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

const DEFAULT_API_URL = "https://api.easybuttonskiptrace.com/v1/trace";

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

/** Normalize Easy Button (and similar) API JSON into phone / email / mailing. */
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
    firstString(nested.owner_mailing_address);

  return { phone, email, mailing };
}

export async function runSkipTrace(lead: Lead, apiKey: string): Promise<SkipTraceResult> {
  if (!lead.owner_name && !lead.address) {
    throw ApiError.badRequest("Lead has no owner name or address to skip trace");
  }

  const apiUrl = env.SKIP_TRACE_API_URL || DEFAULT_API_URL;

  const body = {
    name: lead.owner_name,
    address: lead.address,
    city: lead.city,
    zip: lead.zip,
    state: lead.state,
  };

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
    logger.error({ err: error, leadId: lead.id }, "Skip trace request failed");
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
      `Skip trace failed (${response.status})`;
    throw new ApiError(response.status >= 500 ? 502 : response.status, message);
  }

  const result = parseSkipTraceResponse(parsed);
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
