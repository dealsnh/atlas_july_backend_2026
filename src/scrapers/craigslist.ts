// @ts-nocheck
import * as cheerio from "cheerio";
import { extractAddressFromListing } from "../services/owner-placeholders.js";
import { fetchBlockedPage } from "./base.js";

export interface CraigslistSearchItem {
  url: string;
  title: string;
  price: string;
  date: string;
  location: string;
}

export interface CraigslistListingDetail {
  title: string;
  address: string | null;
  city: string | null;
  zip: string | null;
  price: string | null;
}

export function splitMapAddress(full: string): {
  street: string;
  city: string | null;
  zip: string | null;
} {
  const cleaned = full.replace(/\s+/g, " ").trim();
  const zip = cleaned.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || null;
  const parts = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const stateZip = last.match(/^([A-Z]{2})\s*(\d{5})?/i);
    let city: string | null = null;
    if (stateZip && parts.length >= 3) {
      city = parts[parts.length - 2] || null;
    } else if (!/^[A-Z]{2}\s*\d{5}/i.test(last)) {
      city = last.replace(/\s*[A-Z]{2}\s*\d{5}.*$/i, "").trim() || null;
    }
    const streetParts =
      city && parts.length >= 3 ? parts.slice(0, -2) : parts.length >= 2 ? [parts[0]] : parts;
    const street = streetParts.join(", ").trim() || cleaned;
    return { street, city, zip };
  }
  const street = extractAddressFromListing(cleaned) || cleaned;
  return { street, city: null, zip };
}

export function collectCraigslistSearchItems(html: string, baseHost: string): CraigslistSearchItem[] {
  const $ = cheerio.load(html);
  const items: CraigslistSearchItem[] = [];
  const seen = new Set<string>();

  const push = (title: string, link: string, price: string, date: string, location: string) => {
    if (!title || title.length < 3) return;
    const href = link.startsWith("http") ? link : `${baseHost}${link.startsWith("/") ? "" : "/"}${link}`;
    if (!href.includes("craigslist.org") || seen.has(href)) return;
    if (!/\/(rea|reo)\/d\//i.test(href)) return;
    seen.add(href);
    items.push({ url: href, title, price, date, location });
  };

  $("li.cl-static-search-result, li.result-row, .cl-search-result").each((_, el) => {
    const title = $(el)
      .find(".title, .result-title, a.posting-title, .title-blob")
      .first()
      .text()
      .trim();
    const price = $(el).find(".price, .result-price, .priceinfo").first().text().trim();
    const date = $(el).find("time").attr("datetime") || "";
    const link = $(el).find("a").first().attr("href") || "";
    const location = $(el)
      .find(".location, .result-hood, .meta .location, .supertitle")
      .first()
      .text()
      .trim()
      .replace(/[()]/g, "");
    push(title, link, price, date, location);
  });

  $("a[href*='/rea/d/'], a[href*='/reo/d/']").each((_, el) => {
    const link = $(el).attr("href") || "";
    const title =
      $(el).find(".title").first().text().trim() ||
      $(el).text().trim() ||
      $(el).attr("title") ||
      "";
    push(title, link, "", "", "");
  });

  return items;
}

export function parseCraigslistListingDetail(html: string): CraigslistListingDetail {
  if (!html || html.length < 200) {
    return { title: "", address: null, city: null, zip: null, price: null };
  }

  const $ = cheerio.load(html);
  const title =
    $("#titletextonly").text().trim() ||
    $(".postingtitletext #titletextonly").text().trim() ||
    $("title").text().split(" / ")[0]?.trim() ||
    "";

  const price =
    $(".postingtitletext .price").text().trim() ||
    $("span.price").first().text().trim() ||
    null;

  let mapRaw =
    $(".mapaddress").first().text().trim() ||
    $("#mapaddress").text().trim() ||
    $('meta[property="og:street-address"]').attr("content")?.trim() ||
    "";

  const bodyText = $("#postingbody").text().replace(/\s+/g, " ").trim();
  if (!mapRaw) {
    mapRaw =
      extractAddressFromListing(bodyText) ||
      bodyText.match(/\b\d+\s+[\w\s.'-]+(?:St|Street|Ave|Road|Rd|Dr|Drive|Ln|Blvd|Way|Ct)\.?[^,]*/i)?.[0] ||
      "";
  }
  if (!mapRaw) {
    mapRaw = extractAddressFromListing(title) || "";
  }

  if (!mapRaw) {
    return { title, address: null, city: null, zip: null, price };
  }

  const { street, city, zip } = splitMapAddress(mapRaw);
  return {
    title,
    address: street.length >= 5 ? street : null,
    city,
    zip,
    price,
  };
}

/** Fetch Craigslist listing detail pages in batches (real browser proxy). */
export async function fetchCraigslistListingDetails(
  items: CraigslistSearchItem[],
  maxListings = 25,
): Promise<Array<CraigslistSearchItem & CraigslistListingDetail>> {
  const slice = items.slice(0, maxListings);
  const CONCURRENCY = 5;
  const out: Array<CraigslistSearchItem & CraigslistListingDetail> = [];

  for (let i = 0; i < slice.length; i += CONCURRENCY) {
    const batch = slice.slice(i, i + CONCURRENCY);
    const pages = await Promise.all(batch.map((item) => fetchBlockedPage(item.url)));
    for (let j = 0; j < batch.length; j++) {
      const detail = parseCraigslistListingDetail(pages[j] || "");
      out.push({
        ...batch[j],
        ...detail,
        title: detail.title || batch[j].title,
        price: detail.price || batch[j].price,
      });
    }
  }

  return out;
}
