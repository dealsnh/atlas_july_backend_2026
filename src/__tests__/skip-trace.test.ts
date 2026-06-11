import { describe, expect, it } from "vitest";
import { parseSkipTraceResponse, parseTracerfyResponse } from "../services/skip-trace.service.js";

describe("parseSkipTraceResponse", () => {
  it("parses flat generic shape", () => {
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

describe("parseTracerfyResponse", () => {
  it("parses owner lookup hit per official docs", () => {
    const result = parseTracerfyResponse({
      hit: true,
      persons_count: 1,
      persons: [
        {
          full_name: "Jane Doe",
          property_owner: true,
          mailing_address: {
            street: "PO Box 111",
            city: "Austin",
            state: "TX",
            zip: "78702",
          },
          phones: [
            { number: "5125550200", type: "Landline", dnc: true, rank: 2 },
            { number: "5125550100", type: "Mobile", dnc: false, rank: 1 },
          ],
          emails: [{ email: "jane@example.com", rank: 1 }],
        },
      ],
    });

    expect(result).toEqual({
      phone: "5125550100",
      email: "jane@example.com",
      mailing: "PO Box 111, Austin, TX, 78702",
    });
  });

  it("returns empty on miss", () => {
    expect(parseTracerfyResponse({ hit: false, persons: [] })).toEqual({});
  });
});
