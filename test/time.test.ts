import { describe, expect, it } from "vitest";
import { startOfDay, startOfMonth } from "../src/lib/time.js";

describe("shop-time boundaries", () => {
  it("IST day starts at 18:30 UTC the previous day", () => {
    expect(startOfDay(new Date("2026-11-04T10:00:00Z"), "Asia/Kolkata").toISOString()).toBe("2026-11-03T18:30:00.000Z");
    // 20:00 UTC is already the 5th in India.
    expect(startOfDay(new Date("2026-11-04T20:00:00Z"), "Asia/Kolkata").toISOString()).toBe("2026-11-04T18:30:00.000Z");
  });
  it("month start", () => {
    expect(startOfMonth(new Date("2026-11-04T10:00:00Z"), "Asia/Kolkata").toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(startOfMonth(new Date("2026-11-04T10:00:00Z"), "UTC").toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
