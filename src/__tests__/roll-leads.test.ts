import { afterEach, describe, expect, it, vi } from "vitest";
import { scrapeRollDerived } from "../scrapers/roll-leads.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockRollFetch(features: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ features: features.map((attributes) => ({ attributes })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("roll-derived estate scan labeling", () => {
  it("labels California's roll-estate signal Pre-Probate, not Probate", async () => {
    mockRollFetch([
      {
        OWNER_NAME: "ESTATE OF MARIA GARCIA",
        SITE_ADDR_: "42",
        SITE_STREE: "S",
        SITE_STR_1: "MAIN",
        SITE_STR_2: "ST",
        SITE_CITY_: "SANTA ANA CA",
        SITE_ZIP5: "92701",
        ASSESSMENT: "111-222-33",
        MAIL_ADDR_: "42",
        MAIL_PREFI: "S",
        MAIL_STREE: "MAIN",
        MAIL_UNIT_: "",
        MAIL_SUFFI: "ST",
        MAIL_CITY_: "SANTA ANA CA",
        MAIL_ZIP5: "92701",
      },
    ]);

    const leads = await scrapeRollDerived("Orange", "CA", ["Pre-Probate"]);

    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      county: "Orange",
      state: "CA",
      lead_type: "Pre-Probate",
      owner_name: "ESTATE OF MARIA GARCIA",
    });
  });

  it("does not run the estate scan for California when only Probate (not Pre-Probate) is requested", async () => {
    const fetchMock = mockRollFetch([]);
    const leads = await scrapeRollDerived("Orange", "CA", ["Probate"]);
    expect(leads).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps every other state's roll-estate signal labeled Probate, unchanged", async () => {
    mockRollFetch([
      {
        OWNNM1: "ESTATE OF JOHN DOE",
        ADDRNO: "100",
        ADDRST: "OAK",
        ADDRSF: "AVE",
        OWNAD1: "100 OAK AVE",
        OWNADCITY: "CINCINNATI",
        OWNADSTATE: "OH",
        OWNADZIP: "45202",
        PARCELID: "0123456789",
      },
    ]);

    const leads = await scrapeRollDerived("Hamilton", "OH", ["Probate"]);

    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      county: "Hamilton",
      state: "OH",
      lead_type: "Probate",
      owner_name: "ESTATE OF JOHN DOE",
    });
  });
});
