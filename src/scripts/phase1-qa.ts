/**
 * Phase 1 closure QA — validates all target county × lead-type combos on live API.
 * Usage: BASE_URL=https://web-production-62118.up.railway.app pnpm test:phase1
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

const BASE = process.env.BASE_URL ?? "https://web-production-62118.up.railway.app";
const EMAIL = process.env.ADMIN_EMAIL ?? "tina@nationalhouses.com";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "Tina1074$";

const CASES = [
  { county: "Jackson", state: "MO", lead_type: "Water Shutoff" },
  { county: "Jackson", state: "MO", lead_type: "Fire Damage" },
  { county: "Jackson", state: "MO", lead_type: "Code Violation" },
  { county: "Jackson", state: "MO", lead_type: "Tax Delinquent" },
  { county: "Hamilton", state: "OH", lead_type: "Tax Delinquent" },
  { county: "Hamilton", state: "OH", lead_type: "Code Violation" },
  { county: "Madison", state: "AL", lead_type: "Tax Delinquent" },
  { county: "Madison", state: "AL", lead_type: "Sheriff Sale" },
] as const;

type Case = (typeof CASES)[number];

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await res.json()) as { data?: { token?: string } };
  const token = body.data?.token;
  if (!token) throw new Error("Login failed");
  return token;
}

async function validateCase(
  token: string,
  c: Case,
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
    body: JSON.stringify({ ...c, days_back: 14 }),
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
  const pass = res.ok && (saveable > 0 || total > 0);
  return { total, saveable, errors, ms: Date.now() - t0, pass };
}

async function main(): Promise<void> {
  console.log(`\n=== Phase 1 QA → ${BASE} ===\n`);
  const token = await login();
  let passed = 0;
  const rows: string[] = [];

  for (const c of CASES) {
    process.stdout.write(`  … ${c.county} ${c.state} / ${c.lead_type}`);
    try {
      const r = await validateCase(token, c);
      const ok = r.pass && r.saveable > 0;
      if (ok) passed++;
      const mark = ok ? "✓" : r.total > 0 ? "~" : "✗";
      const line = `${mark} ${c.county} ${c.state} | ${c.lead_type} — total=${r.total} saveable=${r.saveable} errors=${r.errors} (${Math.round(r.ms / 1000)}s)`;
      rows.push(line);
      process.stdout.write(`\r${line}\n`);
    } catch (e) {
      const line = `✗ ${c.county} ${c.state} | ${c.lead_type} — ${(e as Error).message}`;
      rows.push(line);
      process.stdout.write(`\r${line}\n`);
    }
  }

  console.log(`\n=== ${passed}/${CASES.length} passed (saveable owner required) ===\n`);
  if (passed < CASES.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
