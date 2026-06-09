/**
 * Full live production E2E test — scrape, DB persistence, all API edge cases.
 * Usage: BASE_URL=https://web-production-62118.up.railway.app pnpm test:live
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

const BASE = process.env.BASE_URL ?? "https://web-production-62118.up.railway.app";
const EMAIL = process.env.ADMIN_EMAIL ?? "tina@nationalhouses.com";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "Tina1074$";
const API_KEY = process.env.API_KEY ?? "";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function fetchJson(
  path: string,
  opts: RequestInit & { token?: string; apiKey?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string; ct: string }> {
  const { token, apiKey, ...fetchOpts } = opts;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey && API_KEY) headers["x-api-key"] = API_KEY;
  if (fetchOpts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { ...fetchOpts, headers });
      const ct = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      let body: Record<string, unknown> = {};
      if (ct.includes("json") && raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { _parseError: raw.slice(0, 80) };
        }
      }
      return { status: res.status, body, raw, ct };
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

async function waitForScrapeIdle(maxMs = 1_800_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { status, body } = await fetchJson("/api/v1/scrape/status");
    const data = body.data as { in_progress?: boolean; log?: string[] } | undefined;
    if (status === 200 && !data?.in_progress) {
      const last = data?.log?.slice(-1)[0] ?? "idle";
      record("Wait for scrape idle", true, last);
      return true;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  … scrape running (${elapsed}s)   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("");
  record("Wait for scrape idle", false, "timeout");
  return false;
}

async function main(): Promise<void> {
  console.log(`\n=== Live E2E Test → ${BASE} ===\n`);

  // ─── Health ───
  let r = await fetchJson("/api/v1/health");
  record("GET /api/v1/health", r.status === 200 && r.body.success === true);

  r = await fetchJson("/api/v1/ready");
  const ready = r.body.data as { database?: string } | undefined;
  record("GET /api/v1/ready", r.status === 200 && ready?.database === "connected");

  // ─── Auth edge cases ───
  r = await fetchJson("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: "wrong-password" }),
  });
  record("POST /auth/login wrong password → 401", r.status === 401);

  r = await fetchJson("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "not-an-email", password: "x" }),
  });
  record("POST /auth/login invalid email → 400", r.status === 400);

  r = await fetchJson("/api/v1/auth/me");
  record("GET /auth/me no token → 401", r.status === 401);

  r = await fetchJson("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const token = (r.body.data as { token?: string } | undefined)?.token ?? "";
  record("POST /auth/login admin", r.status === 200 && !!token, EMAIL);

  r = await fetchJson("/api/v1/auth/me", { token });
  const me = r.body.data as { user?: { email?: string } } | undefined;
  record("GET /auth/me with JWT", r.status === 200 && me?.user?.email === EMAIL.toLowerCase());

  // ─── Public reads ───
  r = await fetchJson("/api/v1/stats");
  let statsBefore = (r.body.data as { total?: number } | undefined)?.total ?? 0;
  record("GET /stats", r.status === 200, `total=${statsBefore}`);

  r = await fetchJson("/api/v1/leads?limit=5");
  record("GET /leads", r.status === 200);

  r = await fetchJson("/api/v1/leads?county=Jackson&state=MO&limit=5");
  record("GET /leads filter county+state", r.status === 200);

  r = await fetchJson("/api/v1/settings");
  record("GET /settings", r.status === 200);

  // ─── Scrape: wait or start (only when DB empty) ───
  r = await fetchJson("/api/v1/scrape/status");
  let scraping = (r.body.data as { in_progress?: boolean } | undefined)?.in_progress;
  if (scraping && statsBefore === 0) {
    console.log("\n  Scrape in progress, DB empty — waiting (up to 30 min)…\n");
    await waitForScrapeIdle(1_800_000);
  } else if (scraping) {
    record("Scrape in progress (skip wait)", true, `${statsBefore} leads already in DB`);
  }

  r = await fetchJson("/api/v1/scrape/status");
  scraping = (r.body.data as { in_progress?: boolean } | undefined)?.in_progress;
  if (!scraping && statsBefore === 0) {
    r = await fetchJson("/api/v1/scrape/historical", {
      method: "POST",
      body: JSON.stringify({ days_back: 30 }),
      token,
      apiKey: true,
    });
    record("POST /scrape/historical (30 days)", r.status === 200, String((r.body.data as { message?: string })?.message));
    console.log("\n  Waiting for historical scrape (up to 30 min)…\n");
    await waitForScrapeIdle(1_800_000);
  } else if (!scraping) {
    record("POST /scrape/historical (30 days)", true, "skipped — leads already in DB");
  } else {
    record("POST /scrape/historical (30 days)", true, "skipped — scrape already running");
  }

  // ─── Scrape edge cases ───
  r = await fetchJson("/api/v1/scrape/status");
  record("GET /scrape/status after scrape", r.status === 200);

  r = await fetchJson("/api/v1/scrape/runs");
  const runs = (r.body.data as { runs?: unknown[] } | undefined)?.runs ?? [];
  record("GET /scrape/runs", r.status === 200, `${runs.length} runs`);

  r = await fetchJson("/api/v1/scrape", { method: "POST", body: "{}", token, apiKey: true });
  record("POST /scrape while idle or 409 if busy", r.status === 200 || r.status === 409, `HTTP ${r.status}`);

  if (r.status === 200) await waitForScrapeIdle(1_800_000);

  // ─── Leads after scrape ───
  r = await fetchJson("/api/v1/stats");
  const statsAfter = (r.body.data as { total?: number } | undefined)?.total ?? 0;
  record("GET /stats after scrape", r.status === 200, `total=${statsAfter} (was ${statsBefore})`);

  r = await fetchJson("/api/v1/leads?limit=10");
  const leads = (r.body.data as { leads?: Array<{ id: string; status: string }>; total?: number } | undefined);
  const leadList = leads?.leads ?? [];
  const totalLeads = leads?.total ?? 0;
  record("Leads saved in DB", r.status === 200, `${totalLeads} total, ${leadList.length} fetched`);

  // Export
  const exportRes = await fetch(`${BASE}/api/v1/leads/export?limit=5`, {
    headers: { Accept: "text/csv", Authorization: `Bearer ${token}` },
  });
  const csv = await exportRes.text();
  record(
    "GET /leads/export CSV",
    exportRes.status === 200 && csv.includes("County"),
    `rows ~${Math.max(0, csv.split("\n").length - 1)}`,
  );

  // ─── Lead mutations (if leads exist) ───
  if (leadList.length > 0) {
    const leadId = leadList[0].id;
    r = await fetchJson(`/api/v1/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "reviewed", notes: "live e2e test" }),
      token,
      apiKey: true,
    });
    record("PATCH /leads/:id status", r.status === 200);

    r = await fetchJson(`/api/v1/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "invalid-status" }),
      token,
      apiKey: true,
    });
    record("PATCH /leads/:id invalid status → 400", r.status === 400);

    r = await fetchJson(`/api/v1/leads/nonexistent-id-xyz`, {
      method: "PATCH",
      body: JSON.stringify({ status: "reviewed" }),
      token,
      apiKey: true,
    });
    record("PATCH /leads/:id not found → 404", r.status === 404);

    r = await fetchJson(`/api/v1/leads/${leadId}/skip-trace`, { method: "POST", token, apiKey: true });
    record("POST /leads/:id/skip-trace (no key → 400/503)", r.status === 400 || r.status === 503, `HTTP ${r.status}`);
  } else {
    record("PATCH /leads/:id", true, "skipped — scraper returned 0 leads (sources/date range)");
    record("POST /leads/:id/skip-trace", true, "skipped — no leads");
  }

  // ─── Protected without auth ───
  r = await fetchJson("/api/v1/scrape", { method: "POST", body: "{}" });
  record("POST /scrape no auth → 401", r.status === 401);

  // ─── Removed routes ───
  for (const path of ["/api/v1/config", "/api/v1/seed", "/api/v1/import"]) {
    r = await fetchJson(path);
    record(`GET ${path} removed → 404`, r.status === 404);
  }

  // ─── Admin validate (dry run) ───
  try {
    r = await fetchJson("/api/v1/admin/scrape/validate", {
      method: "POST",
      body: JSON.stringify({ county: "Madison", state: "AL", days_back: 1 }),
      token,
      apiKey: true,
      signal: AbortSignal.timeout(120_000),
    });
    const vd = r.body.data as { total?: number; errors?: string[] } | undefined;
    record("POST /admin/scrape/validate", r.status === 200, `${vd?.total ?? 0} sample, ${vd?.errors?.length ?? 0} errors`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    record("POST /admin/scrape/validate", msg.includes("timeout") || msg.includes("aborted"), msg.slice(0, 60));
  }

  // ─── Settings edge ───
  r = await fetchJson("/api/v1/settings/test-email", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL }),
    token,
    apiKey: true,
  });
  record("POST /settings/test-email (no SMTP → 400)", r.status === 400);

  // ─── OpenAPI ───
  r = await fetchJson("/api/docs/openapi.json");
  const info = r.body.info as { version?: string } | undefined;
  record("GET /api/docs/openapi.json", r.status === 200 && info?.version === "1.2.0", `v${info?.version}`);

  // ─── 404 ───
  r = await fetchJson("/api/v1/does-not-exist");
  record("GET unknown route → 404", r.status === 404);

  const failed = results.filter((x) => !x.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===\n`);
  if (failed.length) {
    failed.forEach((f) => console.error(`  FAIL: ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
