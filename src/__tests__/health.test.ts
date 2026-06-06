import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { closeDb, getDb, resetDbForTests } from "../db/connection.js";
import { createApp } from "../app.js";

describe("health routes", () => {
  const app = createApp();

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    resetDbForTests();
    getDb();
  });

  afterAll(() => {
    closeDb();
  });

  it("returns root metadata", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.name).toBe("Atlas County Scraper API");
  });

  it("returns health status", async () => {
    const response = await request(app).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("ok");
  });

  it("returns client config", async () => {
    const response = await request(app).get("/api/v1/config");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveProperty("name");
    expect(response.body.data).toHaveProperty("counties");
  });
});
