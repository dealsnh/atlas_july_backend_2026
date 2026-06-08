import { describe, expect, it } from "vitest";
import { parseSkipTraceResponse } from "../services/skip-trace.service.js";

describe("parseSkipTraceResponse", () => {
  it("parses flat Easy Button shape", () => {
    const result = parseSkipTraceResponse({
      phone: "555-0100",
      email: "owner@example.com",
      mailing_address: "123 Main St",
    });
    expect(result).toEqual({
      phone: "555-0100",
      email: "owner@example.com",
      mailing: "123 Main St",
    });
  });

  it("parses nested data envelope", () => {
    const result = parseSkipTraceResponse({
      data: {
        phones: ["555-0200"],
        emails: ["a@b.com"],
        mailing: "456 Oak Ave",
      },
    });
    expect(result.phone).toBe("555-0200");
    expect(result.email).toBe("a@b.com");
    expect(result.mailing).toBe("456 Oak Ave");
  });
});
