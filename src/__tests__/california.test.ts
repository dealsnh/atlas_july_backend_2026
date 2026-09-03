import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCountyLeadTypes } from "../config/county-lead-types.js";
import { lookupByAddress, lookupOwnerProperties } from "../scrapers/assessor.js";
import { parseCaliforniaBankruptcyRss } from "../scrapers/california.js";

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
  it("enables only the verified Bankruptcy lead type", () => {
    expect(resolveCountyLeadTypes({ county: "Orange", name: "Orange", state: "CA" })).toEqual([
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
});
