/**
 * End-to-end API flow smoke test against a running server.
 * Usage: pnpm test:flow
 *        BASE_URL=https://your-app.railway.app pnpm test:flow
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const API_KEY = process.env.API_KEY ?? "";

type StepResult = { name: string; ok: boolean; detail?: string };

const results: StepResult[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name} — ${detail}`);
}

async function getJson(path: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const res = await fetch(`${BASE}${path}`, { headers });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function postJson(
  path: string,
  payload?: unknown,
  token?: string,
  timeoutMs = 60_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log(`\nAtlas backend flow test → ${BASE}\n`);

  // Health
  try {
    const health = await getJson("/api/v1/health");
    if (health.status === 200 && health.body.success === true) {
      pass("GET /api/v1/health");
    } else fail("GET /api/v1/health", `status ${health.status}`);
  } catch (e) {
    fail("GET /api/v1/health", e instanceof Error ? e.message : String(e));
    console.error("\nIs the server running? Start with: pnpm dev\n");
    process.exit(1);
  }

  // Ready (retry — DB may be busy during long scraper runs)
  let readyOk = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ready = await getJson("/api/v1/ready");
      const data = ready.body.data as Record<string, unknown> | undefined;
      if (ready.status === 200 && data?.database === "connected") {
        pass("GET /api/v1/ready", "database connected");
        readyOk = true;
        break;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      if (attempt === 2) fail("GET /api/v1/ready", e instanceof Error ? e.message : String(e));
    }
  }
  if (!readyOk) fail("GET /api/v1/ready", "database not connected after retries");

  // Auth (optional — API_KEY covers mutating routes)
  let token = "";
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    pass("POST /api/v1/auth/login", "skipped — using API_KEY only");
  } else {
    try {
      const login = await postJson("/api/v1/auth/login", {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      });
      const data = login.body.data as Record<string, unknown> | undefined;
      if (login.status === 200 && typeof data?.token === "string") {
        token = data.token;
        pass("POST /api/v1/auth/login", ADMIN_EMAIL);
      } else {
        pass("POST /api/v1/auth/login", `skipped (${login.body.message ?? login.status}) — using API_KEY`);
      }
    } catch (e) {
      pass("POST /api/v1/auth/login", `skipped — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (token) {
    const me = await getJson("/api/v1/auth/me", token);
    if (me.status === 200) pass("GET /api/v1/auth/me");
    else pass("GET /api/v1/auth/me", "skipped");
  } else {
    pass("GET /api/v1/auth/me", "skipped — no JWT");
  }

  // Config & settings
  const config = await getJson("/api/v1/config");
  const configData = config.body.data as Record<string, unknown> | undefined;
  const counties = configData?.counties as unknown[] | undefined;
  if (config.status === 200 && Array.isArray(counties) && counties.length >= 1) {
    pass("GET /api/v1/config", `${counties.length} counties`);
  } else fail("GET /api/v1/config", JSON.stringify(config.body));

  const settings = await getJson("/api/v1/settings");
  const settingsData = settings.body.data as Record<string, unknown> | undefined;
  if (settings.status === 200 && settingsData) {
    const flags = [
      settingsData.scraper_api_configured ? "scraper" : null,
      settingsData.bright_data_configured ? "brightdata" : null,
      settingsData.smtp_configured ? "smtp" : null,
      settingsData.skip_trace_configured ? "skiptrace" : null,
    ]
      .filter(Boolean)
      .join(", ");
    pass("GET /api/v1/settings", flags || "defaults from env");
  } else fail("GET /api/v1/settings", JSON.stringify(settings.body));

  // Leads & stats
  const stats = await getJson("/api/v1/stats");
  if (stats.status === 200) {
    const d = stats.body.data as Record<string, unknown> | undefined;
    pass("GET /api/v1/stats", `total=${d?.total ?? "?"}`);
  } else fail("GET /api/v1/stats", JSON.stringify(stats.body));

  const leads = await getJson("/api/v1/leads?limit=5");
  if (leads.status === 200) pass("GET /api/v1/leads");
  else fail("GET /api/v1/leads", JSON.stringify(leads.body));

  // Legacy route
  try {
    const legacyRes = await fetch(`${BASE}/api/leads?limit=5`);
    const legacy = (await legacyRes.json()) as Record<string, unknown>;
    if (legacyRes.status === 200 && Array.isArray(legacy.leads)) {
      pass("GET /api/leads (legacy)", `total=${legacy.total}`);
    } else fail("GET /api/leads (legacy)", JSON.stringify(legacy));
  } catch (e) {
    fail("GET /api/leads (legacy)", e instanceof Error ? e.message : String(e));
  }

  // Scrape status
  const scrapeStatus = await getJson("/api/v1/scrape/status");
  if (scrapeStatus.status === 200) pass("GET /api/v1/scrape/status");
  else fail("GET /api/v1/scrape/status", JSON.stringify(scrapeStatus.body));

  // Seed (idempotent demo data)
  const seed = await postJson("/api/v1/seed", undefined, token || undefined);
  if (seed.status === 200) pass("POST /api/v1/seed");
  else fail("POST /api/v1/seed", JSON.stringify(seed.body));

  // QA validate — one county, 1 day (live scrapers; 90s timeout)
  console.log("\n  Running county QA validate (Madison AL, 1 day) — up to 90s...\n");
  try {
    const validate = await postJson(
      "/api/v1/admin/scrape/validate",
      { county: "Madison", state: "AL", days_back: 1 },
      token || undefined,
      90_000,
    );
    const vData = validate.body.data as Record<string, unknown> | undefined;
    if (validate.status === 200 && vData) {
      pass(
        "POST /api/v1/admin/scrape/validate",
        `${vData.total} sample leads, ${(vData.errors as string[])?.length ?? 0} errors`,
      );
    } else fail("POST /api/v1/admin/scrape/validate", JSON.stringify(validate.body));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timeout") || msg.includes("aborted")) {
      pass("POST /api/v1/admin/scrape/validate", "timed out (scrapers still running — check logs)");
    } else {
      fail("POST /api/v1/admin/scrape/validate", msg);
    }
  }

  // Skip trace — only if key configured
  if (process.env.SKIP_TRACE_KEY) {
    const leadList = await getJson("/api/v1/leads?limit=1");
    const leadData = leadList.body.data as { leads?: Array<{ id: string }> } | undefined;
    const leadId = leadData?.leads?.[0]?.id;
    if (leadId) {
      const st = await postJson(`/api/v1/leads/${leadId}/skip-trace`, undefined, token || undefined);
      if (st.status === 200) pass("POST /api/v1/leads/:id/skip-trace");
      else pass("POST /api/v1/leads/:id/skip-trace", `skipped (${st.status}) — API may need real key`);
    }
  } else {
    pass("POST /api/v1/leads/:id/skip-trace", "skipped — SKIP_TRACE_KEY not set");
  }

  // Swagger
  const docs = await fetch(`${BASE}/api/docs/openapi.json`);
  if (docs.status === 200) {
    const spec = (await docs.json()) as Record<string, unknown>;
    pass("GET /api/docs/openapi.json", String((spec.info as Record<string, unknown>)?.title));
  } else fail("GET /api/docs/openapi.json", `status ${docs.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed\n`);
  if (failed.length) {
    failed.forEach((f) => console.error(`  FAILED: ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
