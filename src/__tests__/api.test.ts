import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { closeDb, initDb, resetDbForTests } from "../db/connection.js";
import { createApp } from "../app.js";
import { insertLeadIfNotExists } from "../repositories/leads.repository.js";

describe("API routes", () => {
  const app = createApp();

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    await resetDbForTests();
    await initDb();
    await insertLeadIfNotExists({
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

  afterAll(async () => {
    await closeDb();
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
      expect(res.body.data).toHaveProperty("lastScrapeTime");
    });

    it("GET /api/v1/settings", async () => {
      const res = await request(app).get("/api/v1/settings");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("smtp_configured");
    });

    it("PATCH /api/v1/leads/:id updates status", async () => {
      const res = await request(app)
        .patch("/api/v1/leads/test-lead-001")
        .send({ status: "reviewed" });
      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(true);
    });

    it("GET /api/v1/scrape/status", async () => {
      const res = await request(app).get("/api/v1/scrape/status");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("in_progress");
    });

    it("returns 404 for unknown routes", async () => {
      const res = await request(app).get("/api/v1/unknown-route");
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe("auth API", () => {
    const testEmail = `auth-test-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";
    let token = "";

    it("POST /api/v1/auth/signup creates a user", async () => {
      const res = await request(app)
        .post("/api/v1/auth/signup")
        .send({ email: testEmail, password: testPassword, name: "Test User" });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeTruthy();
      expect(res.body.data.user.email).toBe(testEmail.toLowerCase());
      token = res.body.data.token;
    });

    it("POST /api/v1/auth/login returns token", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: testEmail, password: testPassword });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeTruthy();
      token = res.body.data.token;
    });

    it("GET /api/v1/auth/me returns current user", async () => {
      const res = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe(testEmail.toLowerCase());
    });

    it("PATCH /api/v1/leads/:id accepts JWT bearer", async () => {
      const res = await request(app)
        .patch("/api/v1/leads/test-lead-001")
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "contacted" });
      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(true);
    });
  });

  describe("OpenAPI docs", () => {
    it("GET /api/docs/openapi.json returns valid OpenAPI spec", async () => {
      const res = await request(app).get("/api/docs/openapi.json");
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe("3.0.3");
      expect(res.body.info.title).toBe("Atlas County Scraper API");
      expect(res.body.info.version).toBe("1.2.0");
      expect(res.body.paths["/api/v1/leads"]).toBeDefined();
      expect(res.body.paths["/api/v1/auth/login"]).toBeDefined();
      expect(res.body.paths["/api/v1/leads/{id}/skip-trace"]).toBeDefined();
      expect(res.body.paths["/api/v1/admin/scrape/validate"]).toBeDefined();
      expect(res.body.paths["/api/v1/config"]).toBeUndefined();
      expect(res.body.paths["/api/v1/import"]).toBeUndefined();
      expect(res.body.paths["/api/v1/seed"]).toBeUndefined();
      expect(res.body.paths["/api/auth/login"]).toBeUndefined();
      expect(res.body.components.securitySchemes.ApiKeyAuth).toBeDefined();
      expect(res.body.components.securitySchemes.UserJwtAuth).toBeDefined();
    });

    it("GET /api/docs serves Swagger UI", async () => {
      const res = await request(app).get("/api/docs/");
      expect(res.status).toBe(200);
      expect(res.text).toContain("swagger-ui");
    });
  });
});
