/**
 * Frontend E2E — tests Vercel proxy → Railway backend (same paths the React app uses).
 * Usage: FRONTEND_URL=https://atlas-county-scraper-tina-frontend.vercel.app pnpm test:frontend
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

const FRONTEND =
  process.env.FRONTEND_URL ?? "https://atlas-county-scraper-tina-frontend.vercel.app";
const API = `${FRONTEND}/api/v1`;
const EMAIL = process.env.ADMIN_EMAIL ?? "tina@nationalhouses.com";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "Tina1074$";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit & { token?: string } = {},
): Promise<{ status: number; data?: T; message?: string; raw: string; ct: string }> {
  const { token, ...fetchOpts } = opts;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (fetchOpts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, { ...fetchOpts, headers });
      const ct = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      let data: T | undefined;
      let message: string | undefined;
      if (ct.includes("json") && raw) {
        const body = JSON.parse(raw) as { success?: boolean; data?: T; message?: string };
        data = body.data;
        message = body.message;
      }
      return { status: res.status, data, message, raw: raw.slice(0, 200), ct };
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
    const { status, data } = await apiFetch<{ in_progress?: boolean; log?: string[] }>(
      "/scrape/status",
    );
    if (status === 200 && !data?.in_progress) {
      const last = data?.log?.slice(-1)[0] ?? "idle";
      record("Scrape completed", true, last);
      return true;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  … scraping via frontend proxy (${elapsed}s)   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("");
  record("Scrape completed", false, "timeout");
  return false;
}

async function main(): Promise<void> {
  console.log(`\n=== Frontend E2E (Vercel proxy) → ${FRONTEND} ===\n`);

  // ─── Proxy returns JSON (not HTML) ───
  let r = await apiFetch("/health");
  record(
    "Proxy /api/v1/health → JSON",
    r.status === 200 && r.ct.includes("json") && !r.raw.startsWith("<!"),
    `HTTP ${r.status}`,
  );

  r = await apiFetch("/ready");
  const ready = r.data as { database?: string } | undefined;
  record("GET /ready", r.status === 200 && ready?.database === "connected");

  // ─── Login (Login.tsx flow) ───
  r = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: "wrong" }),
  });
  record("Login wrong password → 401", r.status === 401);

  r = await apiFetch<{ token?: string; user?: { email?: string } }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const token = r.data?.token ?? "";
  record("Login admin (frontend auth)", r.status === 200 && !!token, EMAIL);

  r = await apiFetch<{ user?: { email?: string } }>("/auth/me", { token });
  record("GET /auth/me", r.status === 200 && r.data?.user?.email === EMAIL.toLowerCase());

  // ─── CountyScraper initial load ───
  r = await apiFetch<{ total?: number }>("/stats");
  const statsBefore = r.data?.total ?? 0;
  record("CountyScraper stats bar", r.status === 200, `total=${statsBefore}`);

  r = await apiFetch<{ leads?: unknown[]; total?: number }>("/leads?limit=50");
  const leadsBefore = r.data?.leads?.length ?? 0;
  record(
    "CountyScraper leads table fetch",
    r.status === 200 && Array.isArray(r.data?.leads),
    `${leadsBefore} rows (total ${r.data?.total ?? 0})`,
  );

  r = await apiFetch<{ in_progress?: boolean; log?: string[] }>("/scrape/status");
  let scraping = r.data?.in_progress;
  record("Scrape status on mount", r.status === 200, scraping ? "in progress" : "idle");

  // ─── Trigger scrape if idle and DB empty ───
  if (!scraping && statsBefore === 0) {
    r = await apiFetch("/scrape/historical", {
      method: "POST",
      body: JSON.stringify({ days_back: 7 }),
      token,
    });
    record("Historical scrape (7 days)", r.status === 200, r.message ?? "");
    console.log("\n  Waiting for scrape to finish and populate table…\n");
    await waitForScrapeIdle(1_800_000);
  } else if (scraping && statsBefore === 0) {
    console.log("\n  Scrape running, DB empty — waiting…\n");
    await waitForScrapeIdle(1_800_000);
  } else if (scraping) {
    record("Scrape in progress (skip wait)", true, `${statsBefore} leads already in table`);
  } else {
    record("Historical scrape", true, `skipped — ${statsBefore} leads already in DB`);
  }

  // ─── Table data after scrape ───
  r = await apiFetch<{ total?: number; byType?: unknown[]; byCounty?: unknown[] }>("/stats");
  const statsAfter = r.data?.total ?? 0;
  record(
    "Stats after scrape (table header counts)",
    r.status === 200,
    `total=${statsAfter}${statsAfter > statsBefore ? ` (+${statsAfter - statsBefore})` : ""}`,
  );

  r = await apiFetch<{ leads?: Array<{ id: string; county: string; lead_type: string; owner_name: string | null; address: string | null; status: string }>; total?: number }>(
    "/leads?limit=10",
  );
  const leadList = r.data?.leads ?? [];
  const hasTableRows = leadList.length > 0;
  const sample = leadList[0];
  record(
    "Leads in table (CountyScraper rows)",
    r.status === 200 && hasTableRows,
    hasTableRows
      ? `${leadList.length} shown — e.g. ${sample.lead_type} / ${sample.county} / ${sample.owner_name?.slice(0, 30) ?? "—"}`
      : "0 rows — scrape may still be running or sources returned nothing",
  );

  // ─── CountyScraper PATCH status (if leads exist) ───
  if (leadList.length > 0) {
    const id = leadList[0].id;
    r = await apiFetch(`/leads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "reviewed" }),
      token,
    });
    record("PATCH lead status (table dropdown)", r.status === 200);

    r = await apiFetch(`/leads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "new" }),
      token,
    });
    record("PATCH lead status revert", r.status === 200);
  }

  // ─── Export (CountyScraper export button) ───
  const exportRes = await fetch(`${API}/leads/export?limit=5`, {
    headers: { Accept: "text/csv", Authorization: `Bearer ${token}` },
  });
  const csv = await exportRes.text();
  record(
    "Export CSV via proxy",
    exportRes.status === 200 && csv.includes("County"),
    `~${Math.max(0, csv.split("\n").length - 1)} rows`,
  );

  // ─── SSE stream (CountyScraper progress) — quick probe ───
  try {
    const streamRes = await fetch(`${API}/scrape/stream`, {
      signal: AbortSignal.timeout(3000),
    });
    const streamCt = streamRes.headers.get("content-type") ?? "";
    record(
      "SSE /scrape/stream reachable",
      streamRes.ok && streamCt.includes("text/event-stream"),
      streamCt || `HTTP ${streamRes.status}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    record("SSE /scrape/stream reachable", msg.includes("timeout") || msg.includes("aborted"), "probe OK");
  }

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
