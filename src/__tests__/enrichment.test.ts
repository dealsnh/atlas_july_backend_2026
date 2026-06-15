import { describe, expect, it } from "vitest";
import {
  enrichmentStatus,
  hasUsableIdentity,
  hasUsablePropertyLocation,
  isLeadSaveable,
  isValidStreetAddress,
} from "../services/enrichment.service.js";
import { extractAddressFromListing } from "../services/owner-placeholders.js";
import { leadMatchesRequestedType } from "../config/county-lead-types.js";

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
  it("requires identity + location; mailing optional", () => {
    const complete = {
      owner_name: "SMITH JOHN",
      address: "123 Main St",
      city: "Birmingham",
      state: "AL",
      mailing_address: null,
    };
    expect(isLeadSaveable(complete as never)).toBe(true);
    expect(isLeadSaveable({ ...complete, mailing_address: "456 Oak Ave" } as never)).toBe(true);
  });

  it("accepts case number + legal description", () => {
    expect(
      isLeadSaveable({
        owner_name: null,
        case_number: "22-PR-1234",
        address: null,
        description: "Clay County MO Probate — Estate of John Smith",
      } as never),
    ).toBe(true);
  });

  it("accepts legal description as address", () => {
    expect(
      isLeadSaveable({
        owner_name: "Sandra Chadd",
        address: "Lot 4, Block 14, Carriage Hill subdivision",
        description: "Clay County MO Sheriff Sale",
      } as never),
    ).toBe(true);
  });

  it("rejects placeholder owners without case fallback", () => {
    expect(isLeadSaveable({ owner_name: "FSBO Seller", address: "123 Main St" } as never)).toBe(
      false,
    );
  });

  it("rejects rows with neither identity nor location", () => {
    expect(isLeadSaveable({ owner_name: null, address: null, description: null } as never)).toBe(
      false,
    );
  });
});

describe("enrichmentStatus", () => {
  it("marks partial when street or owner missing", () => {
    expect(
      enrichmentStatus({
        owner_name: "SMITH",
        address: "Lot 4 Block 14",
      } as never),
    ).toBe("partial");
    expect(
      enrichmentStatus({
        owner_name: "SMITH",
        address: "123 Main St",
      } as never),
    ).toBe("complete");
  });
});

describe("leadMatchesRequestedType", () => {
  it("maps Lis Pendens to Pre-Foreclosure", () => {
    expect(leadMatchesRequestedType("Lis Pendens", ["Pre-Foreclosure"])).toBe(true);
    expect(leadMatchesRequestedType("Probate/Estate", ["Probate"])).toBe(true);
  });
});

describe("hasUsableIdentity and hasUsablePropertyLocation", () => {
  it("detects court case rows", () => {
    const lead = {
      owner_name: "ESTATE OF JOHN SMITH",
      address: null,
      description: "Jackson County MO Probate — Estate of John Smith",
      case_number: "22P1234",
    };
    expect(hasUsableIdentity(lead as never)).toBe(true);
    expect(hasUsablePropertyLocation(lead as never)).toBe(true);
  });
});
