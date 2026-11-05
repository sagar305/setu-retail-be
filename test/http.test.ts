import request from "supertest";
import { describe, expect, it } from "vitest";
import { testApp } from "./helpers.js";

describe("unknown routes", () => {
  it("return a JSON 404", async () => {
    const res = await request(testApp()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: "No route for GET /nope" } });
  });
});

describe("malformed JSON", () => {
  it("is a 400, not a 500", async () => {
    const res = await request(testApp())
      .post("/health")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });
});

describe("CORS", () => {
  it("allows the app origin with credentials", async () => {
    const res = await request(testApp())
      .get("/health")
      .set("Origin", "https://app.retail-pos.setutechnology.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.retail-pos.setutechnology.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not allow other origins", async () => {
    const res = await request(testApp()).get("/health").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("GET /openapi.json", () => {
  it("describes the API", async () => {
    const res = await request(testApp()).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(["/health", "/health/db"]));
    expect(res.body.components.schemas).toHaveProperty("HealthResponse");
  });
});
