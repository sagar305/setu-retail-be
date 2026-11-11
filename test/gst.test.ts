// Shared vectors: the same cases run in setu-retail-fe/src/lib/gst.test.ts.
import { describe, expect, it } from "vitest";
import { allocate, computeBill, placeOfSupply, returnAmounts } from "../src/lib/gst.js";

const line = (unitPrice: number, qty: number, rate: number, taxInclusive = true) => ({ unitPrice, qtyMilli: qty * 1000, gstRateBp: rate * 100, taxInclusive });
const GST = { taxEnabled: true, interState: false };

describe("computeBill", () => {
  it("the prototype receipt: atta ×1, tea ×2 at 5%, detergent ×1 at 18%, prices incl. GST", () => {
    const b = computeBill([line(28500, 1, 5), line(14500, 2, 5), line(12000, 1, 18)], { type: "flat", value: 0 }, GST);
    expect(b.total).toBe(69500);
    expect(b.taxableTotal).toBe(64931);
    expect(b.cgstTotal + b.sgstTotal).toBe(4569);
    expect(Math.abs(b.cgstTotal - b.sgstTotal)).toBeLessThanOrEqual(1);
    expect([b.cgstTotal, b.sgstTotal]).toEqual([2284, 2285]);
    expect(b.igstTotal).toBe(0);
  });

  it("tax added on top for exclusive prices", () => {
    const b = computeBill([line(10000, 3, 18, false)], { type: "flat", value: 0 }, GST);
    expect(b).toMatchObject({ subtotal: 30000, taxableTotal: 30000, cgstTotal: 2700, sgstTotal: 2700, total: 35400 });
  });

  it("IGST for an inter-state sale", () => {
    const b = computeBill([line(11800, 1, 18)], { type: "flat", value: 0 }, { taxEnabled: true, interState: true });
    expect(b).toMatchObject({ taxableTotal: 10000, igstTotal: 1800, cgstTotal: 0, sgstTotal: 0, total: 11800 });
  });

  it("splits a bill discount across lines exactly, before tax", () => {
    const b = computeBill([line(10000, 1, 5), line(20000, 1, 18)], { type: "percent", value: 1000 }, GST);
    expect(b.discountTotal).toBe(3000);
    expect(b.lines.map((l) => l.discount)).toEqual([1000, 2000]);
    expect(b.total).toBe(27000);
    const flat = computeBill([line(100, 1, 0), line(100, 1, 0), line(100, 1, 0)], { type: "flat", value: 100 }, GST);
    expect(flat.lines.map((l) => l.discount).reduce((a, x) => a + x, 0)).toBe(100);
  });

  it("caps a discount at the subtotal", () => {
    const b = computeBill([line(5000, 1, 0)], { type: "flat", value: 999999 }, GST);
    expect(b.total).toBe(0);
    expect(computeBill([line(5000, 1, 0)], { type: "percent", value: 20000 }, GST).total).toBe(0);
  });

  it("weighs loose items by milli-units (1.25 kg at ₹48/kg = ₹60)", () => {
    const b = computeBill([{ unitPrice: 4800, qtyMilli: 1250, gstRateBp: 0, taxInclusive: true }], { type: "flat", value: 0 }, GST);
    expect(b.total).toBe(6000);
  });

  it("charges no GST when the shop has GST off", () => {
    const b = computeBill([line(10000, 1, 18, false)], { type: "flat", value: 0 }, { taxEnabled: false, interState: false });
    expect(b).toMatchObject({ taxableTotal: 10000, cgstTotal: 0, sgstTotal: 0, total: 10000 });
  });

  it("every line's parts add up: taxable + tax = total", () => {
    const b = computeBill([line(9999, 7, 12), line(3333, 3, 28), line(101, 13, 3, false)], { type: "percent", value: 750 }, GST);
    for (const l of b.lines) expect(l.taxable + l.cgst + l.sgst + l.igst).toBe(l.total);
    expect(b.taxableTotal + b.cgstTotal + b.sgstTotal + b.igstTotal).toBe(b.total);
  });
});

describe("allocate", () => {
  it("always sums to the amount", () => {
    for (const [amount, weights] of [[7, [1, 1, 1]], [100, [3, 3, 3]], [1, [5, 5]], [0, [1]], [10, [0, 0]]] as const) {
      const out = allocate(amount, [...weights]);
      expect(out.reduce((a, b) => a + b, 0)).toBe(weights.some((w) => w > 0) ? amount : 0);
    }
  });
});

describe("returnAmounts", () => {
  it("returns in steps add up to the line exactly", () => {
    const [l] = computeBill([line(9999, 3, 18)], { type: "flat", value: 0 }, GST).lines;
    const r1 = returnAmounts(l!, 0, 1000);
    const r2 = returnAmounts(l!, 1000, 1000);
    const r3 = returnAmounts(l!, 2000, 1000);
    expect(r1.total + r2.total + r3.total).toBe(l!.total);
    expect(r1.cgst + r2.cgst + r3.cgst).toBe(l!.cgst);
    for (const r of [r1, r2, r3]) expect(r.taxable + r.cgst + r.sgst + r.igst).toBe(r.total);
    expect(r1.sgst + r2.sgst + r3.sgst).toBe(l!.sgst);
  });
});

describe("placeOfSupply", () => {
  it("uses the customer's state, else the branch's", () => {
    expect(placeOfSupply("29", null)).toEqual({ placeOfSupply: "29", interState: false });
    expect(placeOfSupply("29", "27")).toEqual({ placeOfSupply: "27", interState: true });
    expect(placeOfSupply(null, null)).toEqual({ placeOfSupply: null, interState: false });
  });
});

// Custom taxes (any country): each tax a % of the price before tax.
describe("custom taxes", () => {
  const VAT_CITY = [
    { name: "VAT", rateBp: 500 },
    { name: "City tax", rateBp: 200 },
  ];
  const custom = (unitPrice: number, qty: number, taxes: { name: string; rateBp: number }[], taxInclusive = true) => ({ unitPrice, qtyMilli: qty * 1000, gstRateBp: 0, taxInclusive, taxes });

  it("works the tax out on the sum of the rates and splits it by rate; no CGST/SGST/IGST", () => {
    const b = computeBill([custom(10700, 1, VAT_CITY)], { type: "flat", value: 0 }, GST);
    expect(b).toMatchObject({ taxableTotal: 10000, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, total: 10700 });
    expect(b.lines[0]!.gstRateBp).toBe(700);
    expect(b.taxTotals).toEqual([
      { name: "VAT", rateBp: 500, amount: 500 },
      { name: "City tax", rateBp: 200, amount: 200 },
    ]);
  });

  it("adds the tax on top for exclusive prices", () => {
    const b = computeBill([custom(10000, 3, [{ name: "VAT", rateBp: 2000 }], false)], { type: "flat", value: 0 }, GST);
    expect(b).toMatchObject({ taxableTotal: 30000, total: 36000, taxTotals: [{ name: "VAT", rateBp: 2000, amount: 6000 }] });
  });

  it("splits an odd paisa by the largest remainder, so parts add up to the tax", () => {
    const b = computeBill([custom(1443, 1, VAT_CITY, false)], { type: "flat", value: 0 }, GST);
    expect(b.lines[0]!.taxes.map((t) => t.amount)).toEqual([72, 29]);
    expect(b.total).toBe(1443 + 101);
  });

  it("adds up taxes of the same name and rate across lines; a line with no taxes pays none", () => {
    const b = computeBill([custom(10700, 1, VAT_CITY), custom(10500, 1, [{ name: "VAT", rateBp: 500 }]), custom(5000, 1, [])], { type: "flat", value: 0 }, GST);
    expect(b.taxTotals).toEqual([
      { name: "VAT", rateBp: 500, amount: 1000 },
      { name: "City tax", rateBp: 200, amount: 200 },
    ]);
    expect(b.lines[2]).toMatchObject({ taxable: 5000, total: 5000, taxes: [] });
  });

  it("returns in steps add up to the line's taxes exactly", () => {
    const l = computeBill([custom(10700, 3, VAT_CITY)], { type: "flat", value: 0 }, GST).lines[0]!;
    const first = returnAmounts(l, 0, 1000);
    const rest = returnAmounts(l, 1000, 2000);
    expect(first).toMatchObject({ taxable: 10000, total: 10700, cgst: 0, sgst: 0, igst: 0 });
    expect(first.taxes.map((t) => t.amount)).toEqual([500, 200]);
    expect(rest.taxes.map((t) => t.amount)).toEqual([1000, 400]);
  });

  it("no tax at all while tax is off", () => {
    const b = computeBill([custom(10700, 1, VAT_CITY)], { type: "flat", value: 0 }, { taxEnabled: false, interState: false });
    expect(b).toMatchObject({ taxableTotal: 10700, total: 10700, taxTotals: [] });
  });
});
