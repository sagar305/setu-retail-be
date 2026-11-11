import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { lastBoundary, nextBoundary, parentsFirst } from "../src/services/demoReset.js";
import { testApp } from "./helpers.js";

describe("demo reset schedule", () => {
  it("counts reset times from midnight UTC", () => {
    const now = new Date("2026-11-07T05:30:00Z");
    expect(lastBoundary(now, 2).toISOString()).toBe("2026-11-07T04:00:00.000Z");
    expect(nextBoundary(now, 2).toISOString()).toBe("2026-11-07T06:00:00.000Z");
    expect(nextBoundary(now, 0.5).toISOString()).toBe("2026-11-07T06:00:00.000Z");
    expect(nextBoundary(new Date("2026-11-07T06:00:00Z"), 2).toISOString()).toBe("2026-11-07T08:00:00.000Z");
  });

  it("orders tables parents first, ignoring self references", () => {
    const order = parentsFirst(["orders", "accounts", "order_items", "branches"], [
      { child: "orders", parent: "branches" },
      { child: "orders", parent: "accounts" },
      { child: "branches", parent: "accounts" },
      { child: "order_items", parent: "orders" },
      { child: "orders", parent: "orders" },
    ]);
    expect(order).toEqual(["accounts", "branches", "orders", "order_items"]);
    expect(() => parentsFirst(["a", "b"], [{ child: "a", parent: "b" }, { child: "b", parent: "a" }])).toThrow(/loop/);
  });

  it("won't turn on without the demo database's name", () => {
    expect(() => loadEnv({ NODE_ENV: "test", DEMO_RESET_ENABLED: "1" })).toThrow(/DEMO_RESET_EXPECT_DB/);
    expect(loadEnv({ NODE_ENV: "test", DEMO_RESET_ENABLED: "true", DEMO_RESET_EXPECT_DB: "demo" }).DEMO_RESET_ENABLED).toBe(true);
    expect(loadEnv({ NODE_ENV: "test" }).DEMO_RESET_ENABLED).toBe(false);
  });

  it("reports no reset outside the demo", async () => {
    const res = await request(testApp()).get("/demo/reset");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, intervalHours: null, nextResetAt: null, secondsUntilReset: null, resetting: false });
  });
});
