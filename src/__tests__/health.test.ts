import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { closeDb, initDb, resetDbForTests } from "../db/connection.js";
import { createApp } from "../app.js";

describe("health routes", () => {
  const app = createApp();

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    await resetDbForTests();
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns root metadata", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.name).toBe("Atlas County Scraper API");
    expect(response.body.data.docs).toBe("/api/docs");
  });

  it("returns health status", async () => {
    const response = await request(app).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("ok");
  });
});
