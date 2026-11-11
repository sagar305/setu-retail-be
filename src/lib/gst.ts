// ---------------------------------------------------------------------------
// Bill maths for Setu Retail. Pure, integer-only:
//   money = paise, quantity = milli-units (1.5 kg = 1500), rates = basis points
//   (5% = 500). No round-off: totals are exact to the paisa.
//
// THE SAME FILE LIVES IN setu-retail-fe/src/lib/gst.ts so the counter shows
// exactly what the server will charge. Change both together; the shared
// vectors in test/gst.test.ts must pass in both repos.
//
// Per line:
//   gross    = unit price × qty
//   discount = the line's share of the bill discount (by gross, largest
//              remainder, so shares add up to the bill discount exactly)
//   net      = gross − discount
//   inclusive:  taxable = net × 10000 / (10000 + rate);  tax = net − taxable
//   exclusive:  taxable = net;                           tax = net × rate / 10000
//   intra-state: CGST + SGST = tax, halves (odd paisa alternates);  inter-state: IGST = tax
//
// Custom taxes (any country): a line carries its taxes, each a % of the price
// before tax (no tax on tax). rate = their sum; tax is worked out as above and
// split across the taxes by rate (largest remainder). CGST/SGST/IGST stay 0.
// ---------------------------------------------------------------------------

/** One of a line's custom taxes, e.g. { name: "VAT", rateBp: 2000 }. */
export type TaxPart = { name: string; rateBp: number };
export type TaxAmount = TaxPart & { amount: number };

export type LineInput = {
  unitPrice: number;
  qtyMilli: number;
  gstRateBp: number;
  taxInclusive: boolean;
  /** Custom tax mode: the line's taxes. gstRateBp is then ignored (their sum is used). */
  taxes?: TaxPart[];
};
export type Discount = { type: "flat"; value: number } | { type: "percent"; value: number };

export type LineAmounts = { gross: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; total: number };
export type Bill = {
  lines: (Omit<LineInput, "taxes"> & LineAmounts & { taxes: TaxAmount[] })[];
  subtotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  /** Custom taxes summed over the bill, by name and rate. */
  taxTotals: TaxAmount[];
  total: number;
};

const rnd = (n: number) => Math.round(n);

export function lineGross(unitPrice: number, qtyMilli: number): number {
  return rnd((unitPrice * qtyMilli) / 1000);
}

/** Bill discount in paise, never more than the subtotal. */
export function discountAmount(subtotal: number, d: Discount): number {
  const v = Math.max(0, Math.trunc(d.value));
  if (d.type === "percent") return rnd((subtotal * Math.min(v, 10_000)) / 10_000);
  return Math.min(v, subtotal);
}

/** Split `amount` across `weights` in proportion, exactly (largest remainder). */
export function allocate(amount: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || amount === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / sum);
  const out = raw.map(Math.floor);
  let left = amount - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/** Rate of a set of custom taxes: their sum. */
export const taxesRate = (taxes: readonly TaxPart[]) => taxes.reduce((s, t) => s + Math.max(0, t.rateBp), 0);

/** Split a line's tax across its taxes by rate, exactly. */
export function splitTax(tax: number, taxes: readonly TaxPart[]): TaxAmount[] {
  const shares = allocate(tax, taxes.map((t) => Math.max(0, t.rateBp)));
  return taxes.map((t, i) => ({ name: t.name, rateBp: t.rateBp, amount: shares[i]! }));
}

/** Sum custom tax amounts by name and rate, in first-seen order. */
export function sumTaxes(lists: readonly (readonly TaxAmount[])[]): TaxAmount[] {
  const out: TaxAmount[] = [];
  for (const list of lists)
    for (const t of list) {
      const same = out.find((x) => x.name === t.name && x.rateBp === t.rateBp);
      if (same) same.amount += t.amount;
      else out.push({ name: t.name, rateBp: t.rateBp, amount: t.amount });
    }
  return out;
}

function taxOf(net: number, rateBp: number, inclusive: boolean, taxEnabled: boolean) {
  if (!taxEnabled || rateBp <= 0) return { taxable: net, tax: 0, total: net };
  if (inclusive) {
    const taxable = rnd((net * 10_000) / (10_000 + rateBp));
    return { taxable, tax: net - taxable, total: net };
  }
  const tax = rnd((net * rateBp) / 10_000);
  return { taxable: net, tax, total: net + tax };
}

export function computeBill(lines: LineInput[], discount: Discount, opts: { taxEnabled: boolean; interState: boolean }): Bill {
  const grosses = lines.map((l) => lineGross(l.unitPrice, l.qtyMilli));
  const subtotal = grosses.reduce((a, b) => a + b, 0);
  const discountTotal = discountAmount(subtotal, discount);
  const shares = allocate(discountTotal, grosses);

  // An odd paisa of tax goes alternately to SGST and CGST, so the bill's CGST
  // and SGST totals never differ by more than one paisa.
  let odd = 0;
  const out = lines.map((l, i) => {
    const gross = grosses[i]!;
    const disc = shares[i]!;
    if (l.taxes) {
      const rate = taxesRate(l.taxes);
      const { taxable, tax, total } = taxOf(gross - disc, rate, l.taxInclusive, opts.taxEnabled);
      const { taxes: _t, ...rest } = l;
      return { ...rest, gstRateBp: rate, gross, discount: disc, taxable, cgst: 0, sgst: 0, igst: 0, taxes: tax > 0 ? splitTax(tax, l.taxes) : [], total };
    }
    const { taxable, tax, total } = taxOf(gross - disc, l.gstRateBp, l.taxInclusive, opts.taxEnabled);
    let cgst = 0;
    if (!opts.interState) {
      cgst = Math.floor(tax / 2);
      if (tax % 2 === 1 && odd++ % 2 === 1) cgst += 1;
    }
    const sgst = opts.interState ? 0 : tax - cgst;
    const igst = opts.interState ? tax : 0;
    const { taxes: _t, ...rest } = l;
    return { ...rest, gross, discount: disc, taxable, cgst, sgst, igst, taxes: [] as TaxAmount[], total };
  });

  const sum = (k: keyof LineAmounts) => out.reduce((a, l) => a + l[k], 0);
  return {
    lines: out,
    subtotal,
    discountTotal,
    taxableTotal: sum("taxable"),
    cgstTotal: sum("cgst"),
    sgstTotal: sum("sgst"),
    igstTotal: sum("igst"),
    taxTotals: sumTaxes(out.map((l) => l.taxes)),
    total: sum("total"),
  };
}

/**
 * Amounts for returning `qtyMilli` of a line when `prevMilli` was already
 * returned. Computed on the cumulative quantity, so returning everything in
 * any number of steps adds up to the line's amounts exactly.
 */
export function returnAmounts(line: { qtyMilli: number; taxes?: readonly TaxAmount[] } & Omit<LineAmounts, "gross" | "discount">, prevMilli: number, qtyMilli: number) {
  const custom = line.taxes ?? [];
  const cum = (q: number) => {
    const f = (v: number) => rnd((v * q) / line.qtyMilli);
    const total = f(line.total);
    const taxable = f(line.taxable);
    if (custom.length) {
      // The last tax takes the rounding so the parts always add up to the total.
      const parts = custom.map((t) => f(t.amount));
      parts[parts.length - 1] = total - taxable - parts.slice(0, -1).reduce((x, y) => x + y, 0);
      return { taxable, cgst: 0, sgst: 0, igst: 0, total, parts };
    }
    const cgst = f(line.cgst);
    const igst = f(line.igst);
    // SGST takes the rounding so the parts always add up to the total.
    return { taxable, cgst, sgst: total - taxable - cgst - igst, igst, total, parts: [] as number[] };
  };
  const a = cum(prevMilli);
  const b = cum(prevMilli + qtyMilli);
  const taxes: TaxAmount[] = custom.map((t, i) => ({ name: t.name, rateBp: t.rateBp, amount: b.parts[i]! - a.parts[i]! }));
  return { taxable: b.taxable - a.taxable, cgst: b.cgst - a.cgst, sgst: b.sgst - a.sgst, igst: b.igst - a.igst, taxes, total: b.total - a.total };
}

/** Place of supply: the customer's state when known, else the branch's. */
export function placeOfSupply(branchState: string | null, customerState: string | null): { placeOfSupply: string | null; interState: boolean } {
  const pos = customerState || branchState || null;
  return { placeOfSupply: pos, interState: Boolean(branchState && pos && pos !== branchState) };
}
