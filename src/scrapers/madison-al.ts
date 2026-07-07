// @ts-nocheck
/**
 * Madison County AL (Huntsville) completer — AssuranceWeb "Property" portal.
 * Madison has no ArcGIS roll or E-Ring tenant; this server-rendered ASP.NET portal
 * (madisonproperty.countygovservices.com) is the only free/keyless owner+situs+MAILING
 * source. Search-only (like E-Ring): completes address/owner leads, can't full-scan.
 *
 * Flow (verified 2026-07-07): GET /Property/Property/Search → __RequestVerificationToken
 * + session cookie; POST same URL (address or name) → inline Kendo grid carrying
 * owner (pt-sr-name), situs (pt-sr-address), ParcelInfoID, Account; GET
 * /Property/Property/Summary?pcliID&pan → MAILING ADDRESS.
 */
import { fetchWithRetry } from "./base.js";
import type { AssessorProperty } from "./assessor.js";

const BASE = "https://madisonproperty.countygovservices.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let cachedSession: { cookie: string; token: string; at: number } | null = null;

async function getSession(force = false): Promise<{ cookie: string; token: string } | null> {
  if (!force && cachedSession && Date.now() - cachedSession.at < 10 * 60 * 1000) {
    return cachedSession;
  }
  try {
    const res = await fetchWithRetry(`${BASE}/Property/Property/Search`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const cookies: string[] =
      typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
        : (res.headers.get("set-cookie") || "").split(/,(?=\s*[^;,\s]+=)/);
    const setCookie = cookies
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
    const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!m) return null;
    cachedSession = { cookie: setCookie, token: m[1], at: Date.now() };
    return cachedSession;
  } catch {
    return null;
  }
}

function decodeEscapes(s: string): string {
  return s
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u0027/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/gi, " ");
}

async function search(
  type: "address" | "name",
  c1: string,
  c2: string,
): Promise<Array<{ pid: string; acct: string; owner: string; situs: string }>> {
  const sess = await getSession();
  if (!sess) return [];
  const body = new URLSearchParams({
    PropertySearchYear: "2025",
    PropertySearchType: type,
    UseContains: "True",
    "SearchCriteria.Criteria1": c1,
    "SearchCriteria.Criteria2": c2,
    SelectedParcels: "",
    __RequestVerificationToken: sess.token,
  });
  let res;
  try {
    res = await fetchWithRetry(`${BASE}/Property/Property/Search`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sess.cookie,
      },
      body: body.toString(),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const html = decodeEscapes(await res.text());

  // Each data row: "ParcelInfoID":N,"Description":"<span pt-sr-name>OWNER</span>…
  // <span pt-sr-address>SITUS</span>",…"FullName":"OWNER","Account":"…". Anchoring on
  // `"ParcelInfoID":N,"Description":` matches only data rows, not column definitions.
  const out: Array<{ pid: string; acct: string; owner: string; situs: string }> = [];
  const recRe =
    /"ParcelInfoID":(\d+),"Description":"[\s\S]*?pt-sr-address[^>]*>([^<]+)<[\s\S]*?"FullName":"([^"]*)","Account":"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = recRe.exec(html)) !== null) {
    out.push({
      pid: m[1],
      acct: m[4],
      owner: m[3].replace(/\s+/g, " ").trim(),
      situs: m[2].replace(/\s+/g, " ").trim(),
    });
    if (out.length >= 12) break;
  }
  return out;
}

function parseMailing(raw: string): {
  mailingAddress?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingZip?: string;
} {
  const str = raw.replace(/\s+/g, " ").trim();
  const m = str.match(/^(.*?),?\s*([A-Za-z .'-]+),\s*([A-Z]{2})\.?\s+(\d{5})/);
  if (!m) return { mailingAddress: str || undefined };
  return {
    mailingAddress: m[1].replace(/,\s*$/, "").trim(),
    mailingCity: m[2].trim(),
    mailingState: m[3].toUpperCase(),
    mailingZip: m[4],
  };
}

async function fetchMailing(pid: string, acct: string): Promise<string> {
  try {
    const res = await fetchWithRetry(
      `${BASE}/Property/Property/Summary?pcliID=${encodeURIComponent(pid)}&pan=${encodeURIComponent(acct)}`,
      { headers: { "User-Agent": UA } },
    );
    if (!res.ok) return "";
    const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ");
    const m = text.match(/MAILING ADDRESS([\s\S]+?)PROPERTY ADDRESS/i);
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

function toProp(
  rec: { owner: string; situs: string; pid: string; acct: string },
  mailingRaw: string,
): AssessorProperty | null {
  if (!rec.owner || !/^\d+\s+\S/.test(rec.situs)) return null;
  const mail = parseMailing(mailingRaw);
  if (!mail.mailingAddress) return null;
  return {
    address: rec.situs,
    city: "Huntsville",
    state: "AL",
    parcelId: rec.acct || undefined,
    ownerName: rec.owner,
    mailingAddress: mail.mailingAddress,
    mailingCity: mail.mailingCity,
    mailingState: mail.mailingState || "AL",
    mailingZip: mail.mailingZip,
  };
}

export async function madisonLookupByAddress(
  streetNum: string,
  streetName: string,
): Promise<AssessorProperty | null> {
  if (!streetNum || !streetName) return null;
  const recs = await search("address", streetNum, streetName.split(/\s+/)[0] || streetName);
  const rec = recs.find((r) => r.situs.toUpperCase().startsWith(`${streetNum} `)) || recs[0];
  if (!rec) return null;
  const mailing = await fetchMailing(rec.pid, rec.acct);
  return toProp(rec, mailing);
}

export async function madisonLookupByOwner(ownerName: string): Promise<AssessorProperty[]> {
  const parts = ownerName.trim().toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const recs = await search("name", parts[0], parts[1] || "");
  const out: AssessorProperty[] = [];
  for (const rec of recs.slice(0, 5)) {
    const mailing = await fetchMailing(rec.pid, rec.acct);
    const p = toProp(rec, mailing);
    if (p) out.push(p);
  }
  return out;
}
