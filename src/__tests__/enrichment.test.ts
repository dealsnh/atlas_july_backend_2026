import { describe, expect, it } from "vitest";
import { isLeadSaveable, isValidStreetAddress } from "../services/enrichment.service.js";
import { extractAddressFromListing } from "../services/owner-placeholders.js";

describe("isValidStreetAddress", () => {
  it("accepts normal street lines", () => {
    expect(isValidStreetAddress("123 Main St")).toBe(true);
    expect(isValidStreetAddress("6915 Mountain View Dr")).toBe(true);
  });

  it("rejects marketing copy", () => {
    expect(
      isValidStreetAddress(
        "2 unit duplex offers the chance to add 24K to your annual revenue stream",
      ),
    ).toBe(false);
  });
});

describe("extractAddressFromListing", () => {
  it("pulls street from embedded Craigslist text", () => {
    expect(
      extractAddressFromListing(
        "35 Acres 15246 Sq Ft 6915 Mountain View Dr",
      ),
    ).toBe("6915 Mountain View Dr");
  });
});

describe("isLeadSaveable", () => {
  const complete = {
    owner_name: "SMITH JOHN",
    address: "123 Main St",
    city: "Birmingham",
    state: "AL",
    mailing_address: "456 Oak Ave",
    mailing_city: "Birmingham",
    mailing_state: "AL",
  };

  it("requires owner, address, and mailing", () => {
    expect(isLeadSaveable(complete as never)).toBe(true);
    expect(isLeadSaveable({ ...complete, owner_name: null } as never)).toBe(false);
    expect(isLeadSaveable({ ...complete, address: null } as never)).toBe(false);
    expect(isLeadSaveable({ ...complete, mailing_address: null } as never)).toBe(false);
  });

  it("rejects placeholder owners", () => {
    expect(isLeadSaveable({ ...complete, owner_name: "FSBO Seller" } as never)).toBe(false);
  });
});
