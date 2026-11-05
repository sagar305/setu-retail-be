import { describe, expect, it } from "vitest";
import { blendedUnitCost, expiryStatus, fromDay, planTake, sortFefo } from "../src/services/batches.js";

const b = (id: string, expiry: string | null, qty: number, cost: number | null = null, received = "2026-01-01") => ({
  id,
  expiry: expiry ? fromDay(expiry) : null,
  receivedAt: fromDay(received),
  qtyMilli: qty,
  costPrice: cost,
});

describe("batches", () => {
  it("sorts earliest expiry first, no-expiry last", () => {
    expect(sortFefo([b("n", null, 1), b("late", "2027-06-01", 1), b("early", "2026-12-01", 1)]).map((x) => x.id)).toEqual(["early", "late", "n"]);
  });

  it("takes FEFO across batches and reports a shortfall", () => {
    const r = planTake([b("late", "2027-06-01", 5000), b("early", "2026-12-01", 2000)], 4000);
    expect(r.take.map((t) => [t.batch.id, t.qtyMilli])).toEqual([["early", 2000], ["late", 2000]]);
    expect(planTake([b("a", null, 1000)], 3000).shortfall).toBe(2000);
  });

  it("takes the cashier's batch first", () => {
    const r = planTake([b("late", "2027-06-01", 5000), b("early", "2026-12-01", 2000)], 3000, "late");
    expect(r.take.map((t) => [t.batch.id, t.qtyMilli])).toEqual([["late", 3000]]);
  });

  it("blends cost", () => {
    expect(blendedUnitCost([{ batchId: "a", qtyMilli: 1000, unitCost: 100 }, { batchId: "b", qtyMilli: 1000, unitCost: 200 }], 0, 999)).toBe(150);
    expect(blendedUnitCost([{ batchId: "a", qtyMilli: 1000, unitCost: 100 }], 1000, 300)).toBe(200);
    expect(blendedUnitCost([], 1000, null)).toBeNull();
  });

  it("expiry status", () => {
    expect(expiryStatus(fromDay("2026-11-03"), "2026-11-04")).toBe("expired");
    expect(expiryStatus(fromDay("2026-11-20"), "2026-11-04")).toBe("soon");
    expect(expiryStatus(fromDay("2027-11-20"), "2026-11-04")).toBe("ok");
    expect(expiryStatus(null, "2026-11-04")).toBe("none");
  });
});
