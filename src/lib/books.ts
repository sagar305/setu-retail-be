// ---------------------------------------------------------------------------
// Books maths for the connected tools. Pure, integer-only (paise, milli-units,
// basis points), like lib/gst.ts.
//
// THE SAME FILE LIVES IN setu-retail-fe/src/lib/books.ts so a supplier bill
// shows exactly what the server will save. Change both together; the shared
// vectors in test/books.test.ts must pass in both repos.
// ---------------------------------------------------------------------------

export type PurchaseLineInput = { qtyMilli: number; unitCost: number; gstRateBp: number };
export type PurchaseLineAmounts = { taxable: number; cgst: number; sgst: number; igst: number; total: number };
export type PurchaseBill = {
  lines: (PurchaseLineInput & PurchaseLineAmounts)[];
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  total: number;
};

const rnd = (v: number) => Math.round(v);

/**
 * A supplier bill. Costs are before GST, as printed on the bill:
 *   taxable = unit cost × qty;  GST = taxable × rate
 *   same state: CGST + SGST halves (odd paisa alternates); other state: IGST.
 */
export function computePurchase(lines: PurchaseLineInput[], interState: boolean): PurchaseBill {
  let odd = 0;
  const out = lines.map((l) => {
    const taxable = rnd((l.unitCost * l.qtyMilli) / 1000);
    const tax = l.gstRateBp > 0 ? rnd((taxable * l.gstRateBp) / 10_000) : 0;
    let cgst = 0;
    if (!interState) {
      cgst = Math.floor(tax / 2);
      if (tax % 2 === 1 && odd++ % 2 === 1) cgst += 1;
    }
    const sgst = interState ? 0 : tax - cgst;
    const igst = interState ? tax : 0;
    return { ...l, taxable, cgst, sgst, igst, total: taxable + tax };
  });
  const sum = (k: keyof PurchaseLineAmounts) => out.reduce((a, l) => a + l[k], 0);
  return { lines: out, taxableTotal: sum("taxable"), cgstTotal: sum("cgst"), sgstTotal: sum("sgst"), igstTotal: sum("igst"), total: sum("total") };
}

export type Due = { id: string; at: string; amount: number };
export type OpenDue = Due & { paid: number; open: number };

/**
 * Oldest dues first: `credits` (payments, credit notes) clear the earliest
 * dues; whatever is left over is an advance. `at` sorts as text (ISO).
 */
export function settleOldestFirst(dues: Due[], credits: number): { dues: OpenDue[]; open: number; advance: number } {
  let left = Math.max(0, credits);
  const sorted = [...dues].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  const out = sorted.map((d) => {
    const paid = Math.min(Math.max(0, d.amount), left);
    left -= paid;
    return { ...d, paid, open: Math.max(0, d.amount) - paid };
  });
  return { dues: out, open: out.reduce((s, d) => s + d.open, 0), advance: left };
}
