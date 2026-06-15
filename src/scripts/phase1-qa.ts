/**
 * Phase 1 closure QA — validates county × lead-type combos on live API.
 * Usage: BASE_URL=https://web-production-62118.up.railway.app pnpm test:phase1
 *
 * Requires ADMIN_EMAIL and ADMIN_PASSWORD in env (no hardcoded credentials).
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

import { COUNTY_DEFAULT_LEAD_TYPES } from "../config/county-lead-types.js";

const BASE = process.env.BASE_URL ?? "https://web-production-62118.up.railway.app";
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const DAYS_BACK = Math.min(parseInt(process.env.DAYS_BACK ?? "14", 10) || 14, 90);

function buildCases(): Array<{ county: string; state: string; lead_type: string }> {
  const cases: Array<{ county: string; state: string; lead_type: string }> = [];
  for (const [key, leadTypes] of Object.entries(COUNTY_DEFAULT_LEAD_TYPES)) {
    const parts = key.split(":");
    const state = parts[0];
    const county = parts[1];
    if (!state || !county) continue;
    for (const lead_type of leadTypes) {
      cases.push({ county, state, lead_type });
    }
  }
  return cases;
}

const CASES = buildCases();

async function login(): Promise<string> {
  if (!EMAIL || !PASSWORD) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in environment");
  }
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await res.json()) as { data?: { token?: string } };
  const token = body.data?.token;
  if (!token) throw new Error("Login failed — check ADMIN_EMAIL / ADMIN_PASSWORD");
  return token;
}

async function validateCase(
  token: string,
  c: { county: string; state: string; lead_type: string },
): Promise<{
  total: number;
  saveable: number;
  errors: number;
  ms: number;
  pass: boolean;
}> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const res = await fetch(`${BASE}/api/v1/admin/scrape/validate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ ...c, days_back: DAYS_BACK }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  const raw = await res.text();
  let body: {
    data?: {
      total?: number;
      saveable?: number;
      errors?: string[];
      sample?: { owner_name?: string | null }[];
    };
  } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new Error(raw.slice(0, 120) || `HTTP ${res.status}`);
  }
  const total = body.data?.total ?? 0;
  const saveable =
    body.data?.saveable ??
    (body.data?.sample ?? []).filter((l) => (l.owner_name || "").trim().length >= 2).length;
  const errors = body.data?.errors?.length ?? 0;
  const pass = res.ok && saveable > 0;
  return { total, saveable, errors, ms: Date.now() - t0, pass };
}

async function main(): Promise<void> {
  console.log(`\n=== Phase 1 QA → ${BASE} (${CASES.length} cases, ${DAYS_BACK}d) ===\n`);
  const token = await login();
  let passed = 0;
  let scrapeOnly = 0;

  for (const c of CASES) {
    process.stdout.write(`  … ${c.county} ${c.state} / ${c.lead_type}`);
    try {
      const r = await validateCase(token, c);
      if (r.pass) passed++;
      else if (r.total > 0) scrapeOnly++;
      const mark = r.pass ? "✓" : r.total > 0 ? "~" : "✗";
      const line = `${mark} ${c.county} ${c.state} | ${c.lead_type} — total=${r.total} saveable=${r.saveable} errors=${r.errors} (${Math.round(r.ms / 1000)}s)`;
      process.stdout.write(`\r${line}\n`);
    } catch (e) {
      const line = `✗ ${c.county} ${c.state} | ${c.lead_type} — ${(e as Error).message}`;
      process.stdout.write(`\r${line}\n`);
    }
  }

  console.log(
    `\n=== ${passed}/${CASES.length} PASS (saveable), ${scrapeOnly} scrape-only, ${CASES.length - passed - scrapeOnly} fail ===\n`,
  );
  if (passed < CASES.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
