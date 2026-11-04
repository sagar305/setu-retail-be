import { describe, expect, it } from "vitest";
import { corsOrigins, loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv({});
    expect(env).toMatchObject({ NODE_ENV: "development", PORT: 4000, LOG_LEVEL: "info" });
  });

  it("requires DATABASE_URL in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgresql://x" })).not.toThrow();
  });

  it("rejects a bad port", () => {
    expect(() => loadEnv({ PORT: "abc" })).toThrow(/PORT/);
  });

  it("splits CORS origins", () => {
    const env = loadEnv({ CORS_ORIGINS: " https://a.example ,https://b.example,, " });
    expect(corsOrigins(env)).toEqual(["https://a.example", "https://b.example"]);
  });
});
