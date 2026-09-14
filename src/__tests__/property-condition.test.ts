import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, initDb, resetDbForTests } from "../db/connection.js";
import { analyzeProperty } from "../services/property-condition.service.js";

const FAKE_PNG_BYTES = Buffer.from("fake-satellite-png");
const FAKE_JPEG_BYTES = Buffer.from("fake-streetview-jpeg");

function claudeResponse(json: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
  };
}

/** Routes the mocked fetch by URL, mirroring the real three-endpoint contract. */
function mockFetchWith(opts: {
  streetViewStatus?: string;
  claudeBody?: Record<string, unknown>;
  claudeStatus?: number;
  satelliteOk?: boolean;
}) {
  const {
    streetViewStatus = "OK",
    claudeBody = { score: 78, condition: "Good", roofScore: 80, exteriorScore: 75, landscapeScore: 80, notes: "Looks fine." },
    claudeStatus = 200,
    satelliteOk = true,
  } = opts;

  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("streetview/metadata")) {
      return new Response(JSON.stringify({ status: streetViewStatus }), { status: 200 });
    }
    if (url.includes("staticmap")) {
      if (!satelliteOk) return new Response("bad request", { status: 400 });
      return new Response(FAKE_PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.includes("/streetview?")) {
      return new Response(FAKE_JPEG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (url.includes("api.anthropic.com")) {
      return new Response(JSON.stringify(claudeResponse(claudeBody)), { status: claudeStatus });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("Property Condition AI service", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    await resetDbForTests();
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // `process.env.X = undefined` coerces to the STRING "undefined" (still truthy!) —
    // delete is the only way to genuinely unset a process.env key between tests.
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("rejects when Google Maps is not configured", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    await expect(analyzeProperty("1 Test St, Testville, CA")).rejects.toThrow(/Google Maps/i);
  });

  it("rejects when Anthropic is not configured", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "maps-test-key";
    await expect(analyzeProperty("2 Test St, Testville, CA")).rejects.toThrow(/Anthropic/i);
  });

  it("runs the full pipeline and caches the result", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "maps-test-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    const fetchMock = mockFetchWith({});
    vi.stubGlobal("fetch", fetchMock);

    const address = "100 Cache Test Ave, Testville, CA";
    const result = await analyzeProperty(address);

    expect(result.cached).toBe(false);
    expect(result.score).toBe(78);
    expect(result.condition).toBe("Good");
    expect(result.roofScore).toBe(80);
    expect(result.exteriorScore).toBe(75);
    expect(result.landscapeScore).toBe(80);
    expect(result.streetViewAvailable).toBe(true);
    expect(result.satelliteImageBase64).toBe(FAKE_PNG_BYTES.toString("base64"));
    expect(result.streetViewImageBase64).toBe(FAKE_JPEG_BYTES.toString("base64"));
    // satellite + streetview-metadata + streetview-image + claude = 4 calls
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("serves the second call from cache with no new external calls", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "maps-test-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    const fetchMock = mockFetchWith({});
    vi.stubGlobal("fetch", fetchMock);

    const address = "200 Second Call Rd, Testville, CA";
    await analyzeProperty(address);
    fetchMock.mockClear();

    const second = await analyzeProperty(address);
    expect(second.cached).toBe(true);
    expect(second.score).toBe(78);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to satellite-only scoring when Street View has no coverage", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "maps-test-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    const fetchMock = mockFetchWith({ streetViewStatus: "ZERO_RESULTS" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeProperty("300 No Coverage Ln, Testville, CA");

    expect(result.streetViewAvailable).toBe(false);
    expect(result.streetViewImageBase64).toBeNull();
    expect(result.satelliteImageBase64).toBe(FAKE_PNG_BYTES.toString("base64"));

    // Never actually requested the streetview image itself, only checked metadata.
    const calledUrls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(calledUrls.some((u) => u.includes("streetview/metadata"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("/streetview?"))).toBe(false);
  });

  it("rejects a bad/unresolvable address when the satellite fetch itself fails", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "maps-test-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    vi.stubGlobal("fetch", mockFetchWith({ satelliteOk: false }));

    await expect(analyzeProperty("Not A Real Address")).rejects.toThrow(/satellite imagery/i);
  });

  it("surfaces a clear error when the vision API call fails", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "maps-test-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    vi.stubGlobal("fetch", mockFetchWith({ claudeStatus: 500 }));

    await expect(analyzeProperty("400 Vision Fail Dr, Testville, CA")).rejects.toThrow(/Vision AI/i);
  });

  it("clamps out-of-range scores from the vision model instead of trusting them blindly", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "maps-test-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    vi.stubGlobal(
      "fetch",
      mockFetchWith({
        claudeBody: { score: 150, condition: "Good", roofScore: -20, exteriorScore: 50, landscapeScore: 60, notes: "n/a" },
      }),
    );

    const result = await analyzeProperty("500 Clamp Test Way, Testville, CA");
    expect(result.score).toBe(100);
    expect(result.roofScore).toBe(0);
  });
});
