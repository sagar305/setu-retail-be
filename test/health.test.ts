import request from "supertest";
import { describe, expect, it } from "vitest";
import { testApp } from "./helpers.js";

describe("GET /health", () => {
  it("reports the service is up", async () => {
    const res = await request(testApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "setu-retail-be" });
    expect(Date.parse(res.body.time)).not.toBeNaN();
  });

  it("sends security headers and hides Express", async () => {
    const res = await request(testApp()).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("GET /health/db", () => {
  it("is 503 when no database is configured", async () => {
    const res = await request(testApp()).get("/health/db");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("db_not_configured");
  });

  it("is 200 when the database answers", async () => {
    const res = await request(testApp({ checkDb: async () => {} })).get("/health/db");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("is 503 when the database check fails, without leaking the error", async () => {
    const res = await request(
      testApp({
        checkDb: async () => {
          throw new Error("password authentication failed for user admin");
        },
      }),
    ).get("/health/db");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("db_unreachable");
    expect(JSON.stringify(res.body)).not.toContain("password");
  });
});
