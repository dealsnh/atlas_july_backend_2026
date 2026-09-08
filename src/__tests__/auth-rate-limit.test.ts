import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { closeDb, initDb, resetDbForTests } from "../db/connection.js";
import { createApp } from "../app.js";

describe("auth rate limiting", () => {
  const app = createApp();

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    await resetDbForTests();
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("throttles repeated login attempts against the same email from the same source", async () => {
    const email = "ratelimit-login@example.com";
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email, password: "wrong-password" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("throttles repeated signup attempts against the same email from the same source", async () => {
    const email = "ratelimit-signup@example.com";
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post("/api/v1/auth/signup")
        .send({ email, password: "TestPass123!", name: "Rate Limit Test" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("does not throttle a fresh email + source combination", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "someone-else@example.com", password: "whatever" });
    expect(res.status).not.toBe(429);
  });
});
