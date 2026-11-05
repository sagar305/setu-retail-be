import { describe, expect, it } from "vitest";
import { PUBLIC_PLANS, TRIAL_MONTHS, TRIAL_PLAN } from "../src/config/plans.js";

describe("public plans", () => {
  it("have the agreed branch limits", () => {
    const branches = Object.fromEntries(PUBLIC_PLANS.map((p) => [p.code, p.maxBranches]));
    expect(branches).toEqual({ basic: 1, gold: 10, platinum: 100 });
  });

  it("never shrink from one tier to the next", () => {
    const keys = ["maxBranches", "maxStaff", "maxProducts", "maxCustomers", "maxOrdersPerMonth"] as const;
    const asNumber = (v: number | null) => v ?? Number.POSITIVE_INFINITY;
    for (let i = 1; i < PUBLIC_PLANS.length; i++) {
      for (const key of keys) {
        expect(asNumber(PUBLIC_PLANS[i]![key])).toBeGreaterThanOrEqual(asNumber(PUBLIC_PLANS[i - 1]![key]));
      }
    }
  });

  it("trial is 3 months of Basic", () => {
    expect(TRIAL_PLAN).toBe("basic");
    expect(TRIAL_MONTHS).toBe(3);
  });
});
