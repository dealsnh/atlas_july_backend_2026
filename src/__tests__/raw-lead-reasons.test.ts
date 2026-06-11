import { describe, expect, it } from "vitest";
import { RAW_REJECT_REASON, resolveRejectReason } from "../config/raw-lead-reasons.js";

describe("resolveRejectReason", () => {
  it("detects placeholder owner", () => {
    expect(resolveRejectReason({ owner_name: "FSBO Seller" } as never)).toBe(
      RAW_REJECT_REASON.PLACEHOLDER_OWNER,
    );
  });

  it("detects missing owner after enrichment", () => {
    expect(
      resolveRejectReason({
        owner_name: null,
        address: "123 Main St",
        city: "Birmingham",
      } as never),
    ).toBe(RAW_REJECT_REASON.NO_OWNER_AFTER_ENRICHMENT);
  });

  it("detects missing address and owner", () => {
    expect(resolveRejectReason({ owner_name: null, address: null } as never)).toBe(
      RAW_REJECT_REASON.MISSING_ADDRESS_AND_OWNER,
    );
  });
});
