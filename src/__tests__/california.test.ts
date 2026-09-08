import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCountyLeadTypes } from "../config/county-lead-types.js";
import { lookupByAddress, lookupOwnerProperties } from "../scrapers/assessor.js";
import {
  parseCaliforniaBankruptcyRss,
  parseCaPublicNoticeProbate,
  scrapeCaliforniaProbate,
} from "../scrapers/california.js";

// Trimmed from a real, live-fetched www.capublicnotice.com search-results page
// (2026-09-08 pull). Field shapes (the `location` div, the truncated ~200-char
// description, the hidden advert* inputs) are copied verbatim from real rows;
// only the surrounding boilerplate/script noise between rows is cut for length.
const CAPN_HTML = `<html><body>
<div data-bs-target="#ajax_preview" data-uuid="Notices_1006445" data-bs-toggle="offcanvas" href="https://www.capublicnotice.com/advert/-Notices_1006445" id="advert_1006445" class="list"><div class="panel panel-result"><div class="panel-heading"><h4>Orange County Register</h4><div><span class="badge rounded-pill category">Court Filing</span></div></div><div class="panel-body"><span class="description media-body linkify">NOTICE OF PETITION TO ADMINISTER ESTATE OF: HANNA CHANG CASE# 30-2026-01593650-PR-PW-CMC To all heirs, beneficiaries, creditors, contingent creditors, and persons who may otherwise be interested in th</span></div><div class="panel-footer"><div class="location">Orange</div><div class="panel-footer-controls"><span class="time-stamp"><time datetime="2026-09-08 00:00:00.0">Post Date: 09/08/2026</time></span></div><div class="print"><span class="refcode">Refcode: #column_82_09082026_103052_COLUMN-8</span></div><input value="Notices_1006445" id="advertId_Notices_1006445" type="hidden"/><input value="Orange County Register" id="advertSource_Notices_1006445" type="hidden"/><input value="Legals" id="advertCategory_Notices_1006445" type="hidden"/><input value="Court Filing" id="advertSubCategory_Notices_1006445" type="hidden"/><input value="Orange" id="advertLocation_Notices_1006445" type="hidden"/></div></div></div>
<div data-bs-target="#ajax_preview" data-uuid="Notices_1006434" data-bs-toggle="offcanvas" href="https://www.capublicnotice.com/advert/-Notices_1006434" id="advert_1006434" class="list"><div class="panel panel-result"><div class="panel-heading"><h4>Lodi News-Sentinel</h4><div><span class="badge rounded-pill category">Court Filing</span></div></div><div class="panel-body"><span class="description media-body linkify">STK-PR-EST-2026-0001103 NOTICE OF PETITION TO ADMINISTER ESTATE OF Don A. Nordstrom To all heirs, beneficiaries, creditors, contingent creditors, and persons who may otherwise be interested in the wil</span></div><div class="panel-footer"><div class="location">San Joaquin</div><div class="panel-footer-controls"><span class="time-stamp"><time datetime="2026-09-08 00:00:00.0">Post Date: 09/08/2026</time></span></div><div class="print"><span class="refcode">Refcode: #column_63_09082026_103051_COLUMN-4</span></div><input value="Notices_1006434" id="advertId_Notices_1006434" type="hidden"/><input value="Lodi News-Sentinel" id="advertSource_Notices_1006434" type="hidden"/><input value="Legals" id="advertCategory_Notices_1006434" type="hidden"/><input value="Court Filing" id="advertSubCategory_Notices_1006434" type="hidden"/><input value="San Joaquin" id="advertLocation_Notices_1006434" type="hidden"/></div></div></div>
<div data-bs-target="#ajax_preview" data-uuid="Notices_1006442" data-bs-toggle="offcanvas" href="https://www.capublicnotice.com/advert/-Notices_1006442" id="advert_1006442" class="list"><div class="panel panel-result"><div class="panel-heading"><h4>Orange County Register</h4><div><span class="badge rounded-pill category">Public Sales, and Auctions, Notice of Sheriff's Sale</span></div></div><div class="panel-body"><span class="description media-body linkify">NOTICE OF PUBLIC LIEN SALE Notice is hereby given that the undersigned intends to sell the property described below to enforce a lien imposed on said property under the California Self-Service Storage</span></div><div class="panel-footer"><div class="location">Orange</div><div class="panel-footer-controls"><span class="time-stamp"><time datetime="2026-09-08 00:00:00.0">Post Date: 09/08/2026</time></span></div><div class="print"><span class="refcode">Refcode: #column_82_09082026_103052_COLUMN-12</span></div><input value="Notices_1006442" id="advertId_Notices_1006442" type="hidden"/><input value="Orange County Register" id="advertSource_Notices_1006442" type="hidden"/><input value="Legals" id="advertCategory_Notices_1006442" type="hidden"/><input value="Public Sales, and Auctions, Notice of Sheriff's Sale" id="advertSubCategory_Notices_1006442" type="hidden"/><input value="Orange" id="advertLocation_Notices_1006442" type="hidden"/></div></div></div>
<div data-bs-target="#ajax_preview" data-uuid="Notices_1005980" data-bs-toggle="offcanvas" href="https://www.capublicnotice.com/advert/-Notices_1005980" id="advert_1005980" class="list"><div class="panel panel-result"><div class="panel-heading"><h4>Auburn Journal</h4><div><span class="badge rounded-pill category">Legal Notice</span></div></div><div class="panel-body"><span class="description media-body linkify">L0011262 FILE NO. 26-01734 FILED JULY 29, 2026 FICTITIOUS BUSINESS NAME STATEMENT</span></div><div class="panel-footer"><div class="location"></div><div class="panel-footer-controls"><span class="time-stamp"><time datetime="2026-09-09 00:00:00.0">Post Date: 09/09/2026</time></span></div><div class="print"><span class="refcode">Refcode: #L00112620</span></div><input value="Notices_1005980" id="advertId_Notices_1005980" type="hidden"/><input value="Auburn Journal" id="advertSource_Notices_1005980" type="hidden"/><input value="Legals" id="advertCategory_Notices_1005980" type="hidden"/><input value="Legal Notice" id="advertSubCategory_Notices_1005980" type="hidden"/><input value="" id="advertLocation_Notices_1005980" type="hidden"/></div></div></div>
</body></html>`;

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title><![CDATA[8:26-bk-12345 JOHN A SMITH]]></title>
    <link>https://ecf.cacb.uscourts.gov/cgi-bin/DktRpt.pl?12345</link>
    <description><![CDATA[Voluntary Petition<br />Chapter: 7]]></description>
    <pubDate>Wed, 02 Sep 2026 14:10:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[8:26-bk-12345 JOHN A SMITH]]></title>
    <link>https://ecf.cacb.uscourts.gov/cgi-bin/DktRpt.pl?12345</link>
    <description><![CDATA[Meeting of Creditors]]></description>
    <pubDate>Wed, 02 Sep 2026 16:10:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[8:26-bk-22222 OUT OF WINDOW]]></title>
    <description><![CDATA[Voluntary Petition<br />Chapter: 13]]></description>
    <pubDate>Mon, 24 Aug 2026 08:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

const orangeParcelFeature = {
  features: [
    {
      attributes: {
        OWNER_NAME: "JANE M DOE",
        SITE_ADDR_: "225",
        SITE_STREE: "W",
        SITE_STR_1: "CARL KARCHER",
        SITE_STR_2: "WAY",
        SITE_CITY_: "ANAHEIM CA",
        SITE_ZIP5: "92801",
        ASSESSMENT: "073-083-22",
        MAIL_ADDR_: "124",
        MAIL_PREFI: "N",
        MAIL_STREE: "MAIN",
        MAIL_UNIT_: "STE 4",
        MAIL_SUFFI: "ST",
        MAIL_CITY_: "SANTA ANA CA",
        MAIL_ZIP5: "92701",
      },
    },
  ],
};

describe("Orange County California scraping configuration", () => {
  it("enables only the verified Bankruptcy and Probate lead types", () => {
    expect(resolveCountyLeadTypes({ county: "Orange", name: "Orange", state: "CA" })).toEqual([
      "Probate",
      "Bankruptcy",
    ]);
  });

  it("keeps only in-window bankruptcy petition entries and deduplicates the case", () => {
    const parsed = parseCaliforniaBankruptcyRss(rss, "2026-09-01", "2026-09-03");

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      caseNumber: "8:26-bk-12345",
      caseName: "JOHN A SMITH",
      chapter: "7",
      sourceUrl: "https://ecf.cacb.uscourts.gov/cgi-bin/DktRpt.pl?12345",
    });
  });

  it("does not treat a non-petition docket event as a new lead candidate", () => {
    const nonPetition = rss.replace(/Voluntary Petition/g, "Notice of Hearing");
    expect(parseCaliforniaBankruptcyRss(nonPetition, "2026-09-01", "2026-09-03")).toEqual([]);
  });

  it("maps the official Orange County parcel fields into a complete property record", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(orangeParcelFeature), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const byAddress = await lookupByAddress("225 W Carl Karcher Way", "Orange", "CA");
    const byOwner = await lookupOwnerProperties("Jane Doe", "Orange", "CA");

    expect(byAddress).toMatchObject({
      ownerName: "JANE M DOE",
      address: "225 W CARL KARCHER WAY",
      city: "ANAHEIM",
      state: "CA",
      zip: "92801",
      mailingAddress: "124 N MAIN STE 4 ST",
      mailingCity: "SANTA ANA",
      mailingState: "CA",
      mailingZip: "92701",
      parcelId: "073-083-22",
    });
    expect(byOwner).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("parses only the genuine Orange County probate notice out of a mixed results page", () => {
    const parsed = parseCaPublicNoticeProbate(CAPN_HTML);

    // Excludes: San Joaquin probate (wrong county, real "location" field says so),
    // the Orange lien sale (right county, wrong notice type), and the Auburn
    // Journal FBN filing (wrong county AND wrong notice type).
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      caseNumber: "30-2026-01593650-PR-PW-CMC",
      decedentName: "HANNA CHANG",
      publisher: "Orange County Register",
      postDate: "2026-09-08",
      sourceUrl: "https://www.capublicnotice.com/advert/-Notices_1006445",
    });
  });

  it("scrapes a probate lead end to end, resolving the decedent's address off the county roll", async () => {
    const hannaChangParcel = {
      features: [
        {
          attributes: {
            OWNER_NAME: "HANNA CHANG",
            SITE_ADDR_: "18",
            SITE_STREE: "ROSE",
            SITE_STR_1: "",
            SITE_STR_2: "LN",
            SITE_CITY_: "IRVINE CA",
            SITE_ZIP5: "92620",
            ASSESSMENT: "555-111-09",
            MAIL_ADDR_: "18",
            MAIL_PREFI: "",
            MAIL_STREE: "ROSE",
            MAIL_UNIT_: "",
            MAIL_SUFFI: "LN",
            MAIL_CITY_: "IRVINE CA",
            MAIL_ZIP5: "92620",
          },
        },
      ],
    };

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("capublicnotice.com/search/query")) {
        return new Response(CAPN_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("capublicnotice.com")) {
        return new Response("<html><body>landing page</body></html>", { status: 200 });
      }
      if (url.includes("ocgis.com")) {
        return new Response(JSON.stringify(hannaChangParcel), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const leads = await scrapeCaliforniaProbate("2026-09-01", "2026-09-09");

    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      county: "Orange",
      state: "CA",
      lead_type: "Probate",
      owner_name: "HANNA CHANG",
      address: "18 ROSE LN",
      city: "IRVINE",
      mailing_address: "18 ROSE LN",
      case_number: "30-2026-01593650-PR-PW-CMC",
      filing_date: "2026-09-08",
    });
  });
});
