/**
 * Property Condition AI — satellite + street-level photo scoring.
 *
 * Both Google Static Maps and Street View Static accept a free-text address
 * directly (verified live) — no separate geocoding call is needed.
 *
 * Street View coverage is checked via the free `/streetview/metadata`
 * endpoint BEFORE paying for the actual image, since not every address has
 * street-level imagery (private roads, rural addresses). A missing Street
 * View photo does not block analysis — the vision model still scores off
 * the satellite photo alone, with adjusted weighting (see the prompt).
 *
 * One combined vision call (both photos together) does the actual scoring,
 * not two separate calls — cheaper and the model can cross-reference both
 * views. Results cache in `property_condition_cache`, keyed by a normalized
 * address, and expire after 3 months (`PROPERTY_CONDITION_CACHE_TTL_SQL`,
 * purged by a daily cron — see `cleanupExpiredPropertyConditionCache`).
 */
import cron from "node-cron";
import { execute, queryOne } from "../db/query.js";
import { PROPERTY_CONDITION_CACHE_TTL_SQL } from "../db/schema.js";
import { ApiError } from "../utils/api-error.js";
import { logger } from "../utils/logger.js";

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const IMAGE_SIZE = "400x400";

export interface PropertyConditionResult {
  address: string;
  score: number;
  condition: string;
  roofScore: number;
  exteriorScore: number;
  landscapeScore: number;
  notes: string;
  satelliteImageBase64: string | null;
  streetViewImageBase64: string | null;
  streetViewAvailable: boolean;
  analyzedAt: string;
  cached: boolean;
}

interface CacheRow {
  address: string;
  score: number;
  condition: string;
  roof_score: number;
  exterior_score: number;
  landscape_score: number;
  notes: string;
  satellite_image_base64: string | null;
  street_view_image_base64: string | null;
  street_view_available: boolean;
  analyzed_at: Date;
}

/** Collapses whitespace/punctuation variance so "123 Main St." and "123 main st" hit the same cache row. */
function normalizeAddress(address: string): string {
  return address.trim().toUpperCase().replace(/[.,]/g, "").replace(/\s+/g, " ");
}

function rowToResult(row: CacheRow, cached: boolean): PropertyConditionResult {
  return {
    address: row.address,
    score: row.score,
    condition: row.condition,
    roofScore: row.roof_score,
    exteriorScore: row.exterior_score,
    landscapeScore: row.landscape_score,
    notes: row.notes,
    satelliteImageBase64: row.satellite_image_base64,
    streetViewImageBase64: row.street_view_image_base64,
    streetViewAvailable: row.street_view_available,
    analyzedAt: row.analyzed_at.toISOString(),
    cached,
  };
}

async function getCached(normalizedAddress: string): Promise<CacheRow | undefined> {
  return queryOne<CacheRow>(
    `SELECT * FROM property_condition_cache
     WHERE address = $1 AND analyzed_at > NOW() - INTERVAL '3 months'`,
    [normalizedAddress],
  );
}

async function saveCache(
  normalizedAddress: string,
  r: Omit<PropertyConditionResult, "address" | "analyzedAt" | "cached">,
): Promise<void> {
  await execute(
    `INSERT INTO property_condition_cache
      (address, score, condition, roof_score, exterior_score, landscape_score, notes,
       satellite_image_base64, street_view_image_base64, street_view_available, analyzed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
     ON CONFLICT (address) DO UPDATE SET
       score = EXCLUDED.score, condition = EXCLUDED.condition,
       roof_score = EXCLUDED.roof_score, exterior_score = EXCLUDED.exterior_score,
       landscape_score = EXCLUDED.landscape_score, notes = EXCLUDED.notes,
       satellite_image_base64 = EXCLUDED.satellite_image_base64,
       street_view_image_base64 = EXCLUDED.street_view_image_base64,
       street_view_available = EXCLUDED.street_view_available,
       analyzed_at = NOW()`,
    [
      normalizedAddress,
      r.score,
      r.condition,
      r.roofScore,
      r.exteriorScore,
      r.landscapeScore,
      r.notes,
      r.satelliteImageBase64,
      r.streetViewImageBase64,
      r.streetViewAvailable,
    ],
  );
}

/** This workstation has shown occasional transient connection resets to Google's
 * static-image endpoints (confirmed during setup — retrying immediately clears it),
 * so a real fetch failure gets two extra attempts before it's treated as final. */
async function fetchImageBase64(
  url: string,
): Promise<{ ok: true; base64: string } | { ok: false; status: number; body: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, status: res.status, body: body.slice(0, 300) };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, base64: buf.toString("base64") };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return { ok: false, status: 0, body: lastError instanceof Error ? lastError.message : String(lastError) };
}

async function checkStreetViewAvailable(address: string, apiKey: string): Promise<boolean> {
  try {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(address)}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === "OK";
  } catch (error) {
    logger.warn({ err: error }, "Street View availability check failed — treating as unavailable");
    return false;
  }
}

interface ClaudeScoreResponse {
  score: number;
  condition: string;
  roofScore: number;
  exteriorScore: number;
  landscapeScore: number;
  notes: string;
}

function buildScoringPrompt(address: string, hasStreetView: boolean): string {
  const intro = hasStreetView
    ? `The first image is a satellite/aerial photo of a property at "${address}". The second image is a street-level photo of the same property. Score the property's condition using both images together.`
    : `This is a satellite/aerial photo of a property at "${address}". No street-level photo is available for this address, so score based on the aerial view only — weight roof and lot/landscape condition more heavily, and keep the exterior score conservative since curb-level detail and visible damage can't be directly observed from above.`;

  return (
    `${intro}\n\n` +
    "Respond with ONLY a single JSON object, no other text, no markdown code fences, matching exactly this shape:\n" +
    '{"score": <0-100 overall integer>, "condition": "<Excellent|Good|Fair|Poor>", ' +
    '"roofScore": <0-100 integer>, "exteriorScore": <0-100 integer>, "landscapeScore": <0-100 integer>, ' +
    '"notes": "<1-2 sentence summary of condition and any visible issues>"}'
  );
}

async function scoreWithClaude(
  apiKey: string,
  address: string,
  satelliteBase64: string,
  streetViewBase64: string | null,
): Promise<ClaudeScoreResponse> {
  const content: Array<Record<string, unknown>> = [
    { type: "image", source: { type: "base64", media_type: "image/png", data: satelliteBase64 } },
  ];
  if (streetViewBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: streetViewBase64 },
    });
  }
  content.push({ type: "text", text: buildScoringPrompt(address, !!streetViewBase64) });

  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw ApiError.internal(`Vision AI request failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((c) => c.type === "text")?.text;
  if (!textBlock) throw ApiError.internal("Vision AI returned no text content");

  const jsonMatch = textBlock.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw ApiError.internal("Vision AI response did not contain a JSON object");

  let parsed: Partial<ClaudeScoreResponse>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Partial<ClaudeScoreResponse>;
  } catch {
    throw ApiError.internal("Vision AI response JSON was malformed");
  }

  const clamp = (n: unknown): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  return {
    score: clamp(parsed.score),
    condition: typeof parsed.condition === "string" && parsed.condition ? parsed.condition : "Unknown",
    roofScore: clamp(parsed.roofScore),
    exteriorScore: clamp(parsed.exteriorScore),
    landscapeScore: clamp(parsed.landscapeScore),
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

export async function analyzeProperty(address: string): Promise<PropertyConditionResult> {
  const normalized = normalizeAddress(address);

  const cached = await getCached(normalized);
  if (cached) return rowToResult(cached, true);

  // Read process.env directly, not the frozen `env` snapshot from config/env.js — a key
  // saved through Settings only ever lands in process.env at runtime (syncRuntimeConfig),
  // never in the one-time-parsed `env` object. Same reason Bright Data creds are read
  // this way in scrapers/base.ts.
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!mapsKey) throw ApiError.badRequest("Google Maps API key is not configured in Settings");
  if (!anthropicKey) throw ApiError.badRequest("Anthropic API key is not configured in Settings");

  const satelliteUrl =
    `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(address)}` +
    `&zoom=20&size=${IMAGE_SIZE}&maptype=satellite&key=${mapsKey}`;
  const satelliteFetch = await fetchImageBase64(satelliteUrl);
  if (!satelliteFetch.ok) {
    throw ApiError.badRequest(
      `Could not fetch satellite imagery for this address — check that it's a valid, complete address (${satelliteFetch.body || `HTTP ${satelliteFetch.status}`})`,
    );
  }

  const streetViewAvailable = await checkStreetViewAvailable(address, mapsKey);
  let streetViewBase64: string | null = null;
  if (streetViewAvailable) {
    const streetViewUrl =
      `https://maps.googleapis.com/maps/api/streetview?location=${encodeURIComponent(address)}` +
      `&size=${IMAGE_SIZE}&key=${mapsKey}`;
    const streetViewFetch = await fetchImageBase64(streetViewUrl);
    if (streetViewFetch.ok) {
      streetViewBase64 = streetViewFetch.base64;
    } else {
      logger.warn({ address, body: streetViewFetch.body }, "Street View image fetch failed after metadata said OK");
    }
  }

  const scored = await scoreWithClaude(anthropicKey, address, satelliteFetch.base64, streetViewBase64);

  const toCache = {
    score: scored.score,
    condition: scored.condition,
    roofScore: scored.roofScore,
    exteriorScore: scored.exteriorScore,
    landscapeScore: scored.landscapeScore,
    notes: scored.notes,
    satelliteImageBase64: satelliteFetch.base64,
    streetViewImageBase64: streetViewBase64,
    streetViewAvailable,
  };

  await saveCache(normalized, toCache);

  return { address: normalized, ...toCache, analyzedAt: new Date().toISOString(), cached: false };
}

/** Purges cache rows past the 3-month TTL. */
export async function cleanupExpiredPropertyConditionCache(): Promise<void> {
  const deleted = await execute(PROPERTY_CONDITION_CACHE_TTL_SQL);
  if (deleted > 0) logger.info({ deleted }, "Purged expired Property Condition AI cache entries");
}

/** Runs once a day — same off-peak cadence as the lead scrape cron, just offset an hour later. */
export function startPropertyConditionCacheCleanupCron(): void {
  cron.schedule(
    "0 10 * * *",
    () => {
      cleanupExpiredPropertyConditionCache().catch((error) => {
        logger.error({ err: error }, "Property Condition AI cache cleanup failed");
      });
    },
    { timezone: "America/Los_Angeles" },
  );
}
