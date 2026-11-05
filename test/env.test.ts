import { describe, expect, it } from "vitest";
import { corsOrigins, loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv({});
    expect(env).toMatchObject({ NODE_ENV: "development", PORT: 4000, LOG_LEVEL: "info" });
  });

  it("refuses to run production without real secrets", () => {
    const prod = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://x",
      JWT_SECRET: "x".repeat(40),
      RETAIL_LICENSE_SECRET: "y".repeat(40),
      RESEND_API_KEY: "re_123",
      APP_URL: "https://app.retail-pos.setutechnology.com",
    };
    expect(() => loadEnv(prod)).not.toThrow();
    for (const key of ["DATABASE_URL", "JWT_SECRET", "RETAIL_LICENSE_SECRET", "RESEND_API_KEY"] as const) {
      const { [key]: _drop, ...rest } = prod;
      expect(() => loadEnv(rest), key).toThrow(new RegExp(key));
    }
    expect(() => loadEnv({ ...prod, APP_URL: "http://insecure.example" })).toThrow(/APP_URL/);
  });

  it("treats blank values as unset", () => {
    expect(() => loadEnv({ JWT_SECRET: "", RESEND_API_KEY: "" })).not.toThrow();
  });

  it("rejects a bad port", () => {
    expect(() => loadEnv({ PORT: "abc" })).toThrow(/PORT/);
  });

  it("splits CORS origins", () => {
    const env = loadEnv({ CORS_ORIGINS: " https://a.example ,https://b.example,, " });
    expect(corsOrigins(env)).toEqual(["https://a.example", "https://b.example"]);
  });
});
