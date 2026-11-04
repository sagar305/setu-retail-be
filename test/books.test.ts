// Shared vectors: the same cases run in setu-retail-fe/src/lib/books.test.ts.
import { describe, expect, it } from "vitest";
import { computePurchase, settleOldestFirst } from "../src/lib/books.js";

describe("computePurchase", () => {
  it("adds GST on top of the cost and splits it within the state", () => {
    const b = computePurchase(
      [
        { qtyMilli: 10_000, unitCost: 4_250, gstRateBp: 500 }, // 10 × ₹42.50 @5%
        { qtyMilli: 3_000, unitCost: 1_999, gstRateBp: 1_800 }, // 3 × ₹19.99 @18%
        { qtyMilli: 2_500, unitCost: 3_333, gstRateBp: 1_200 }, // 2.5 kg × ₹33.33 @12%
      ],
      false,
    );
    expect(b.lines.map((l) => [l.taxable, l.cgst, l.sgst, l.total])).toEqual([
      [42_500, 1_062, 1_063, 44_625],
      [5_997, 540, 539, 7_076],
      [8_333, 500, 500, 9_333],
    ]);
    expect(b).toMatchObject({ taxableTotal: 56_830, cgstTotal: 2_102, sgstTotal: 2_102, igstTotal: 0, total: 61_034 });
  });

  it("charges IGST from another state and nothing at 0%", () => {
    const b = computePurchase([{ qtyMilli: 1_000, unitCost: 10_001, gstRateBp: 1_800 }, { qtyMilli: 2_000, unitCost: 500, gstRateBp: 0 }], true);
    expect(b.lines.map((l) => [l.igst, l.cgst, l.total])).toEqual([[1_800, 0, 11_801], [0, 0, 1_000]]);
    expect(b.total).toBe(12_801);
  });
});

describe("settleOldestFirst", () => {
  const dues = [
    { id: "b", at: "2026-02-10T00:00:00.000Z", amount: 5_000 },
    { id: "a", at: "2026-01-05T00:00:00.000Z", amount: 3_000 },
    { id: "c", at: "2026-03-01T00:00:00.000Z", amount: 2_000 },
  ];
  it("clears the oldest dues first", () => {
    const r = settleOldestFirst(dues, 6_500);
    expect(r.dues.map((d) => [d.id, d.paid, d.open])).toEqual([["a", 3_000, 0], ["b", 3_500, 1_500], ["c", 0, 2_000]]);
    expect(r).toMatchObject({ open: 3_500, advance: 0 });
  });
  it("keeps overpayment as an advance", () => {
    expect(settleOldestFirst(dues, 12_000)).toMatchObject({ open: 0, advance: 2_000 });
    expect(settleOldestFirst([], 500)).toMatchObject({ open: 0, advance: 500 });
  });
});
