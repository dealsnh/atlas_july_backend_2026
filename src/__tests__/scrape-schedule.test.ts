import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const stored: Record<string, string> = {};

vi.mock("../repositories/settings.repository.js", () => ({
  getSettings: vi.fn(async () => ({
    smtp_host: "",
    smtp_port: "587",
    smtp_user: "",
    smtp_pass: "",
    smtp_from: "",
    email_recipients: "",
    scraper_api_key: "",
    skip_trace_key: "",
    auto_skip_trace: "false",
    bright_data_user: "",
    bright_data_pass: "",
    attom_api_key: "",
    daily_scrape_paused: stored.daily_scrape_paused ?? "false",
  })),
  saveSettings: vi.fn(async (partial: Record<string, string>) => {
    Object.assign(stored, partial);
  }),
}));

const { createApp } = await import("../app.js");
const { isDailyScrapePaused } = await import("../services/settings.service.js");

describe("daily scrape pause toggle", () => {
  const app = createApp();

  beforeEach(() => {
    for (const key of Object.keys(stored)) delete stored[key];
  });

  it("defaults to not paused", async () => {
    const res = await request(app).get("/api/v1/scrape/schedule");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paused).toBe(false);
    expect(res.body.data.cron).toBe("0 9 * * *");
    expect(res.body.data.timezone).toBe("America/Los_Angeles");
  });

  it("pauses and resumes the daily run", async () => {
    const paused = await request(app).post("/api/v1/scrape/schedule").send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.data.paused).toBe(true);
    expect(stored.daily_scrape_paused).toBe("true");
    expect(await isDailyScrapePaused()).toBe(true);

    const afterPause = await request(app).get("/api/v1/scrape/schedule");
    expect(afterPause.body.data.paused).toBe(true);

    const resumed = await request(app).post("/api/v1/scrape/schedule").send({ paused: false });
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.paused).toBe(false);
    expect(stored.daily_scrape_paused).toBe("false");
    expect(await isDailyScrapePaused()).toBe(false);
  });

  it("rejects a non-boolean paused value", async () => {
    const res = await request(app).post("/api/v1/scrape/schedule").send({ paused: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
