import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { closeDb, getDb, resetDbForTests } from "../db/connection.js";
import { createApp } from "../app.js";
import { insertLeadIfNotExists } from "../repositories/leads.repository.js";

describe("API routes", () => {
  const app = createApp();

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    resetDbForTests();
    getDb();
    insertLeadIfNotExists({
      id: "test-lead-001",
      county: "Jackson",
      state: "MO",
      lead_type: "Pre-Foreclosure",
      owner_name: "Test Owner",
      address: "123 Test St",
      city: "Kansas City",
      zip: "64101",
      filing_date: "2026-01-01",
      source_url: "https://example.com",
    });
  });

  afterAll(() => {
    closeDb();
  });

  describe("v1 API", () => {
    it("GET /api/v1/health", async () => {
      const res = await request(app).get("/api/v1/health");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ok");
    });

    it("GET /api/v1/ready checks database", async () => {
      const res = await request(app).get("/api/v1/ready");
      expect(res.status).toBe(200);
      expect(res.body.data.database).toBe("connected");
    });

    it("GET /api/v1/leads returns paginated leads", async () => {
      const res = await request(app).get("/api/v1/leads?limit=10");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total).toBeGreaterThanOrEqual(1);
      expect(res.body.data.leads.length).toBeGreaterThanOrEqual(1);
    });

    it("GET /api/v1/stats", async () => {
      const res = await request(app).get("/api/v1/stats");
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBeGreaterThanOrEqual(1);
    });

    it("PATCH /api/v1/leads/:id updates status", async () => {
      const res = await request(app)
        .patch("/api/v1/leads/test-lead-001")
        .send({ status: "reviewed" });
      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(true);
    });

    it("POST /api/v1/seed inserts demo leads", async () => {
      const res = await request(app).post("/api/v1/seed");
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
    });

    it("GET /api/v1/scrape/status", async () => {
      const res = await request(app).get("/api/v1/scrape/status");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("in_progress");
    });
  });

  describe("legacy API (frontend compatibility)", () => {
    it("GET /api/leads returns flat response", async () => {
      const res = await request(app).get("/api/leads?limit=10");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("leads");
      expect(res.body).toHaveProperty("total");
      expect(Array.isArray(res.body.leads)).toBe(true);
    });

    it("GET /api/stats returns flat response", async () => {
      const res = await request(app).get("/api/stats");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("lastScrapeTime");
    });

    it("GET /api/config", async () => {
      const res = await request(app).get("/api/config");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("name");
      expect(res.body).toHaveProperty("counties");
    });

    it("GET /api/settings", async () => {
      const res = await request(app).get("/api/settings");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("smtp_configured");
    });

    it("returns 404 for unknown routes", async () => {
      const res = await request(app).get("/api/v1/unknown-route");
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });
});
