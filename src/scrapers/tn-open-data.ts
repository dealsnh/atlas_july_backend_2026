// @ts-nocheck
/**
 * Chattanooga open data → Hamilton County TN leads.
 *
 * Source: the City of Chattanooga ArcGIS Online org (OIAIimblRxPs0xxc), surfaced
 * through chattadata-chattgis.hub.arcgis.com. The lead-bearing datasets are hosted
 * *CSV items*, not feature layers, so they are read as whole-file streams via
 * tn-datasets.streamCsvRows rather than queried with a where-clause.
 *
 *   Code Enforcement Violations — 98,320 rows; carries flag_dangerous
 *   All Permits                 — 214,920 rows; carries fire-damage repair work
 *
 * TWO CAVEATS THAT SHAPE THIS FILE:
 *
 * 1. CITY LIMITS ONLY. These are City of Chattanooga datasets. Signal Mountain,
 *    Soddy-Daisy, Collegedale, East Ridge and unincorporated Hamilton County have
 *    no equivalent public feed, so Code Violation / Vacant / Fire Damage coverage
 *    stops at the city line. There is no second source to fall back to.
 *
 * 2. THE CODE ENFORCEMENT EXPORT LAGS. It is rebuilt in bulk on an irregular
 *    cadence; when checked on 2026-08-13 the newest date_entered was 2026-02-02,
 *    roughly six months behind. A literal 7-day daily window would therefore return
 *    zero every day and read as a broken scraper. The window is instead computed
 *    relative to the newest row in the file (see the LAGGING_* constants), so the
 *    scraper keeps surfacing real distressed properties whatever the lag, and logs
 *    a warning when the file is stale so a zero is never mistaken for "no
 *    violations". Re-emitting across runs is safe — lead ids are deterministic
 *    (makeId over the case number) and the repository inserts ON CONFLICT (id) DO
 *    NOTHING, so a violation already saved is a no-op rather than a duplicate.
 */

import { Lead, makeId, formatDate } from "./base.js";
import { lookupByAddress, isGovernmentOwner } from "./assessor.js";
import { streamCsvRows, headerIndex, arcgisItemCsvUrl } from "./tn-datasets.js";
import { logger } from "../utils/logger.js";

const COUNTY = "Hamilton";
const STATE = "TN";

/** ArcGIS Online hosted-CSV item ids (verified live 2026-08-13). */
const ITEMS = {
  codeViolations: "19f35e4e09c041718905088a1fc7a6bb",
  permits: "9937e99e93de467eae5f592061c2672c",
};

const HUB_SOURCE = "https://chattadata-chattgis.hub.arcgis.com";

/**
 * See caveat 2. The export's lag is not a fixed quantity — it depends on when the
 * city last rebuilt the file — so a wall-clock lookback is the wrong instrument:
 * 180 days still resolved to a `from` NEWER than the newest row on 2026-08-13 and
 * produced zero leads. Instead, rows are collected against a generous ceiling and
 * then re-filtered relative to the newest date actually present in the file. That
 * self-corrects whether the export is same-day fresh or half a year behind.
 */
const LAGGING_CEILING_DAYS = 420;
/** How much of the data, counting back from its own newest row, counts as current. */
const LAGGING_RECENT_SPAN_DAYS = 120;

/** Completer calls are the expensive part of a run — bound them like ohio.ts does. */
const COMPLETER_CONCURRENCY = 10;
const COMPLETER_CAP = 250;

/**
 * Vacant/Abandoned detection.
 *
 * Keyword-matching the description fields does NOT work here, and the trap is
 * worth spelling out. `description` is the ordinance TITLE and
 * `description_extended` is the statute TEXT — neither says anything about the
 * specific property. Ordinance 21-133 is titled "Litter on occupied or vacant
 * property" and is the most-cited code in the county (30,667 of 98,320 rows, 1,221
 * in a typical window); its statute text repeats "occupied or vacant" again. So a
 * /vacant/ test over those fields tags every litter citation — explicitly OCCUPIED
 * ones included — as a vacancy lead.
 *
 * The signals that actually describe THIS property are:
 *   1. flag_dangerous — a real per-record flag
 *   2. the ordinance being a structure-condition code (condemned / unsafe /
 *      boarded / dangerous), as opposed to litter, overgrowth or junk vehicles
 *   3. the inspector's free-text comments
 */
const VACANT_RE =
  /\b(vacant|abandon(ed|ment)?|unfit|uninhabitable|condemn(ed|ation)?|dilapidat(ed|ion)|derelict|boarded[- ]?up|unsecured|open and vacant|demolition)\b/i;

/**
 * Structure-condition ordinances. 21-76(e) Dangerous Structure, 21-80 Occupancy of
 * Condemned Structure, 21-82 Certificate of Occupancy, 21-84 Repair or Demolition
 * of Unsafe Structures, 21-87 Boarding procedures / duty to secure.
 */
const VACANT_CODE_RE = /^\s*21-(76|80|82|84|87)\b/;

function looksVacant(description: string, comments: string, dangerous: boolean): boolean {
  if (dangerous) return true;
  if (VACANT_CODE_RE.test(description)) return true;
  // Comments are the inspector's notes on this address — property-specific, so a
  // keyword here is meaningful in a way the statute text never is.
  return !!comments && VACANT_RE.test(comments);
}

/**
 * Fire-damage repair work. Deliberately narrow: bare "fire" matches fire alarms,
 * sprinklers, firewalls, fire districts and fire marshals — none of which indicate
 * a damaged property.
 */
const FIRE_DAMAGE_RE =
  /\b(fire[- ]damage[ds]?|damaged? by fire|fire restoration|smoke damage|burn(ed|t) (unit|house|structure|building|out)|repair .{0,20}fire)\b/i;

const NOT_FIRE_RE =
  /\b(fire (alarm|sprinkler|protection|suppress\w*|line|marshal|district|wall|rated|department|escape|pump|hydrant)|firewall|fireplace)\b/i;

function widenFrom(fromDate: string, minDays: number): string {
  const floor = new Date(Date.now() - minDays * 86_400_000).toISOString().slice(0, 10);
  return fromDate < floor ? fromDate : floor;
}

/** `date` (YYYY-MM-DD) shifted back by `days`. */
function minusDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** "2115  GARFIELD ST" / "5750 LAKE RESORT DR K109" → normalized single-line street. */
function cleanStreet(raw: string): string {
  return String(raw || "")
    .replace(/&nbsp;?/gi, " ")
    .replace(/\s*,\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Candidate {
  address: string;
  city: string;
  zip: string | null;
  caseNumber: string;
  filedDate: string;
  description: string;
  leadType: string;
  sourceUrl: string;
  raw: Record<string, unknown>;
}

/**
 * Enrich each candidate against the Hamilton TN parcel roll and emit only rows
 * that complete to owner + mailing. Incomplete rows are dropped rather than saved
 * thin — the save gate would reject them anyway, and a lead with no mailing
 * address is not mailable.
 */
async function completeCandidates(candidates: Candidate[]): Promise<Lead[]> {
  const leads: Lead[] = [];
  const emitted = new Set<string>();
  // One case can be cited under several subsections of the same ordinance
  // (21-87(b) and 21-87(d) on the same boarding order), which collapses to one
  // lead id. Drop the repeats here so the run's reported count is the real count.
  const seenCandidates = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.leadType}|${c.caseNumber || c.address}`;
    if (seenCandidates.has(key)) return false;
    seenCandidates.add(key);
    return true;
  });
  const capped = unique.slice(0, COMPLETER_CAP);

  for (let i = 0; i < capped.length; i += COMPLETER_CONCURRENCY) {
    const batch = capped.slice(i, i + COMPLETER_CONCURRENCY);
    const props = await Promise.all(
      batch.map((c) => lookupByAddress(c.address, COUNTY, STATE).catch(() => null)),
    );
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      const prop = props[j];
      if (!prop?.ownerName || !prop.mailingAddress) continue;
      if (isGovernmentOwner(prop.ownerName)) continue;

      const id = makeId(COUNTY, STATE, c.leadType, c.caseNumber || c.address);
      if (emitted.has(id)) continue;
      emitted.add(id);

      leads.push({
        id,
        county: COUNTY,
        state: STATE,
        lead_type: c.leadType,
        owner_name: prop.ownerName,
        address: prop.address || c.address,
        city: prop.city || c.city,
        zip: prop.zip || c.zip,
        mailing_address: prop.mailingAddress,
        mailing_city: prop.mailingCity || null,
        mailing_state: prop.mailingState || null,
        mailing_zip: prop.mailingZip || null,
        case_number: c.caseNumber || null,
        filing_date: formatDate(c.filedDate),
        assessed_value: null,
        tax_year: null,
        lender: null,
        loan_amount: null,
        sale_date: null,
        sale_amount: null,
        description: c.description,
        source_url: c.sourceUrl,
        raw_data: JSON.stringify({ ...c.raw, parcelId: prop.parcelId }),
      });
    }
  }

  if (unique.length > COMPLETER_CAP) {
    logger.info(
      { county: COUNTY, state: STATE, matched: unique.length, capped: COMPLETER_CAP },
      "[TN] completer cap reached — remaining candidates deferred to the next run",
    );
  }
  return leads;
}

/**
 * Single streamed pass over the code enforcement export, splitting rows into the
 * Code Violation and Vacant/Abandoned buckets. One pass because the file is 82 MB
 * and both lead types read the same columns.
 */
async function readCodeEnforcement(
  fromDate: string,
  toDate: string,
): Promise<{ violations: Candidate[]; vacant: Candidate[] }> {
  const ceiling = widenFrom(fromDate, LAGGING_CEILING_DAYS);
  const violations: Candidate[] = [];
  const vacant: Candidate[] = [];
  let idx: ReturnType<typeof headerIndex> | null = null;
  let newest = "";

  const rows = await streamCsvRows(arcgisItemCsvUrl(ITEMS.codeViolations), (row, i) => {
    if (i === 0) {
      idx = headerIndex(row);
      return;
    }
    const g = (name: string) => String(row[idx!(name)] ?? "").trim();

    const entered = g("date_entered").slice(0, 10);
    if (!entered) return;
    if (entered > newest) newest = entered;
    // Collect against the ceiling; the real cut-off is applied below, once the
    // file's own newest date is known.
    if (entered < ceiling || entered > toDate) return;

    const num = g("street_number");
    const street = g("street_name");
    if (!num || !street) return;
    const address = cleanStreet(`${num} ${street}`);
    if (!/^\d+\s+\S/.test(address)) return;

    const desc = g("description");
    const comments = g("comments");
    const dangerous = g("flag_dangerous").toLowerCase() === "true";
    const caseNumber = g("case_number");

    const base = {
      address,
      city: g("city") || "Chattanooga",
      zip: null,
      caseNumber,
      filedDate: entered,
      sourceUrl: HUB_SOURCE,
      raw: { caseNumber, entered, description: desc, dangerous, status: g("status") },
    };

    violations.push({
      ...base,
      leadType: "Code Violation",
      description: `Hamilton County TN Code Violation — ${desc || "violation"}`,
    });

    if (looksVacant(desc, comments, dangerous)) {
      vacant.push({
        ...base,
        // Distinct id namespace from the Code Violation row above.
        caseNumber: caseNumber ? `${caseNumber}-VAC` : "",
        leadType: "Vacant/Abandoned",
        description: `Hamilton County TN Vacant/Abandoned — ${
          dangerous
            ? "flagged dangerous"
            : VACANT_CODE_RE.test(desc)
              ? "unsafe/condemned structure citation"
              : "inspector noted vacancy"
        }: ${desc || "violation"}`,
      });
    }
  });

  if (rows <= 1) throw new Error("Hamilton TN code enforcement export returned no rows");

  // Cut off relative to the newest row present, never to wall-clock — see the
  // LAGGING_* constants. Newest-first so the completer cap keeps the freshest.
  const cutoff = newest ? minusDays(newest, LAGGING_RECENT_SPAN_DAYS) : ceiling;
  const recent = (list: Candidate[]) =>
    list.filter((c) => c.filedDate >= cutoff).sort((a, b) => b.filedDate.localeCompare(a.filedDate));

  const result = { violations: recent(violations), vacant: recent(vacant) };
  const lagDays = newest
    ? Math.round((Date.now() - new Date(`${newest}T00:00:00Z`).getTime()) / 86_400_000)
    : null;

  logger.info(
    {
      rows,
      newest,
      lagDays,
      cutoff,
      violations: result.violations.length,
      vacant: result.vacant.length,
    },
    "[TN] code enforcement export read",
  );
  if (lagDays !== null && lagDays > 60) {
    logger.warn(
      { newest, lagDays },
      "[TN] code enforcement export is stale — leads reflect the city's last bulk refresh, not today",
    );
  }
  return result;
}

/** Cache the single pass so Code Violation + Vacant/Abandoned don't each stream 82 MB. */
let codeCache: { key: string; promise: Promise<{ violations: Candidate[]; vacant: Candidate[] }> } | null =
  null;

function readCodeEnforcementCached(fromDate: string, toDate: string) {
  const key = `${fromDate}|${toDate}`;
  if (codeCache?.key !== key) {
    codeCache = { key, promise: readCodeEnforcement(fromDate, toDate) };
    // A failed pass must not be cached as a permanent failure for later runs.
    codeCache.promise.catch(() => {
      if (codeCache?.key === key) codeCache = null;
    });
  }
  return codeCache.promise;
}

export async function scrapeCodeViolations(fromDate: string, toDate: string): Promise<Lead[]> {
  const { violations } = await readCodeEnforcementCached(fromDate, toDate);
  return completeCandidates(violations);
}

export async function scrapeVacantAbandoned(fromDate: string, toDate: string): Promise<Lead[]> {
  const { vacant } = await readCodeEnforcementCached(fromDate, toDate);
  return completeCandidates(vacant);
}

/**
 * Fire Damage — building permits describing fire-damage repair.
 *
 * Chattanooga has no live fire-incident feed: the ChattaData "All Calls" NFIRS
 * layer looks right (it even carries incident type 111 "Building fire") but is a
 * frozen 2021-07 → 2022-06 snapshot, so it is deliberately not used here. The
 * permit is the durable public trace of a fire-damaged property, and unlike the
 * code export the permit file IS current (verified through 2026-08-12).
 */
export async function scrapeFireDamage(fromDate: string, toDate: string): Promise<Lead[]> {
  // Permits are current, so only a light widening — a fire-repair permit pulled a
  // few weeks ago still marks a distressed property.
  const from = widenFrom(fromDate, 90);
  const candidates: Candidate[] = [];
  let idx: ReturnType<typeof headerIndex> | null = null;

  const rows = await streamCsvRows(arcgisItemCsvUrl(ITEMS.permits), (row, i) => {
    if (i === 0) {
      idx = headerIndex(row);
      return;
    }
    const g = (name: string) => String(row[idx!(name)] ?? "").trim();

    const applied = g("applieddate").slice(0, 10);
    if (!applied || applied < from || applied > toDate) return;

    const desc = cleanStreet(g("description"));
    if (!FIRE_DAMAGE_RE.test(desc) || NOT_FIRE_RE.test(desc)) return;

    const address = cleanStreet(g("originaladdress1"));
    if (!/^\d+\s+\S/.test(address)) return;

    const permit = g("permitnum");
    candidates.push({
      address,
      city: g("originalcity") || "Chattanooga",
      zip: g("originalzip") || null,
      caseNumber: permit,
      filedDate: applied,
      leadType: "Fire Damage",
      description: `Hamilton County TN Fire Damage — permit ${permit}: ${desc.slice(0, 160)}`,
      sourceUrl: g("link") || HUB_SOURCE,
      raw: { permit, applied, description: desc, status: g("statuscurrent") },
    });
  });

  if (rows <= 1) throw new Error("Hamilton TN permit export returned no rows");
  logger.info({ rows, matched: candidates.length, from }, "[TN] permit export read");
  return completeCandidates(candidates);
}
