import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

type Session = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!TEST_DB)("custom taxes (Postgres)", () => {
  let h: H;
  let o: Session;
  let branchId: string;
  let counterId: string;
  let cash: string;

  beforeEach(async () => {
    await resetDb();
    h = harness();
    o = await signIn(h, (await signUpOwner(h)).username);
    branchId = o.me.branches[0].id;
    counterId = (await o.as("post", "/counters").send({ branchId })).body.counter.id;
    cash = ((await o.as("get", "/payment-methods")).body.methods as { id: string; kind: string }[]).find((m) => m.kind === "CASH")!.id;
  });

  async function product(body: Record<string, unknown>) {
    const r = await o.as("post", "/products").send({ openingStock: [{ branchId, qtyMilli: 10_000 }], ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.product as { id: string; taxGroupId: string | null };
  }

  /** A shop in Dubai: VAT 5%, AED, its own labels. */
  async function goCustom() {
    const r = await o.as("patch", "/settings").send({ taxEnabled: true, taxMode: "CUSTOM", taxLabel: "VAT", taxNumberLabel: "TRN", itemCodeLabel: "HS code", invoiceTitle: "TAX INVOICE", currency: "aed", timezone: "Asia/Dubai" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  }

  it("India GST stays the default; owners set the mode, labels, currency and time zone", async () => {
    expect((await o.as("get", "/settings")).body).toMatchObject({ taxMode: "INDIA_GST", taxLabel: "GST", taxNumberLabel: "GSTIN", itemCodeLabel: "HSN", invoiceTitle: "TAX INVOICE" });
    const s = await goCustom();
    expect(s).toMatchObject({ taxMode: "CUSTOM", taxLabel: "VAT", taxNumberLabel: "TRN", itemCodeLabel: "HS code", business: { currency: "AED", timezone: "Asia/Dubai" } });
    expect((await o.as("patch", "/settings").send({ currency: "XYZ" })).status).toBe(400);
    expect((await o.as("patch", "/settings").send({ timezone: "Mars/Base" })).status).toBe(400);
    expect((await o.as("patch", "/settings").send({ taxLabel: "" })).status).toBe(400);
  });

  it("the first switch makes one group per GST rate in use and moves products into it", async () => {
    await product({ name: "Atta", hsn: "1101", gstRateBp: 500, price: 10500 });
    await product({ name: "Rice", hsn: "1006", gstRateBp: 500, price: 21000 });
    await product({ name: "Soap", hsn: "3401", gstRateBp: 1800, price: 11800 });
    await goCustom();
    const groups = (await o.as("get", "/tax-groups")).body.groups as { id: string; name: string; isDefault: boolean; rateBp: number; products: number }[];
    expect(groups.map((g) => [g.name, g.isDefault, g.rateBp, g.products])).toEqual([
      ["VAT 5%", true, 500, 2],
      ["VAT 18%", false, 1800, 1],
    ]);
  });

  it("bills, returns, supplier bills and the tax report use the shop's taxes", async () => {
    await goCustom();
    const vat = (await o.as("post", "/tax-groups").send({ name: "Standard", taxes: [{ name: "VAT", rateBp: 500 }] })).body.group;
    expect(vat.isDefault).toBe(true); // the first group
    const hotel = (await o.as("post", "/tax-groups").send({ name: "Hotel", taxes: [{ name: "VAT", rateBp: 500 }, { name: "Tourism fee", rateBp: 200 }] })).body.group;
    expect(hotel).toMatchObject({ isDefault: false, rateBp: 700 });

    const dates = await product({ name: "Dates 1 kg", hsn: "0804.10", price: 10500 }); // no group: the default
    const room = await product({ name: "Room night", taxGroupId: hotel.id, price: 10700, trackStock: false });
    expect(dates.taxGroupId).toBeNull();

    const r = await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId, lines: [{ productId: dates.id, qtyMilli: 2000 }, { productId: room.id, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 31700 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const order = r.body.order;
    expect(order).toMatchObject({ taxMode: "CUSTOM", taxableTotal: 30000, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, placeOfSupply: null, total: 31700 });
    expect(order.taxTotals).toEqual([
      { name: "VAT", rateBp: 500, amount: 1500 },
      { name: "Tourism fee", rateBp: 200, amount: 200 },
    ]);
    expect(order.items[1]).toMatchObject({ gstRateBp: 700, taxes: [{ name: "VAT", rateBp: 500, amount: 500 }, { name: "Tourism fee", rateBp: 200, amount: 200 }] });

    // Changing a group later doesn't change bills already made.
    await o.as("patch", `/tax-groups/${hotel.id}`).send({ taxes: [{ name: "VAT", rateBp: 500 }, { name: "Tourism fee", rateBp: 1000 }] });
    expect((await o.as("get", `/orders/${order.id}`)).body.order.items[1].taxes[1].amount).toBe(200);

    const ret = await o.as("post", `/orders/${order.id}/returns`).send({ counterId, items: [{ orderItemId: order.items[0].id, qtyMilli: 1000 }], refundMethodId: cash, reason: "Damaged" });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    expect(ret.body.order.creditNotes[0]).toMatchObject({ total: 10500, taxableTotal: 10000, taxTotals: [{ name: "VAT", rateBp: 500, amount: 500 }] });

    const supplier = (await o.as("post", "/suppliers").send({ name: "Gulf Foods", gstin: "100-2345-6789-003" })).body.supplier;
    expect(supplier.gstin).toBe("100-2345-6789-003");
    const p = await o.as("post", "/purchases").send({ id: randomUUID(), branchId, supplierId: supplier.id, billNumber: "GF-1", billDate: "2026-11-04", lines: [{ productId: dates.id, qtyMilli: 10_000, unitCost: 6000, gstRateBp: 0 }], paidAmount: 0 });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body.purchase).toMatchObject({ taxMode: "CUSTOM", taxableTotal: 60000, cgstTotal: 0, total: 63000, taxTotals: [{ name: "VAT", rateBp: 500, amount: 3000 }] });

    const rep = await o.as("get", "/reports/taxes?from=2026-11-01&to=2026-11-30");
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body).toMatchObject({ bills: 1, taxableSales: 20000, totalSales: 21200 });
    expect(rep.body.byTax).toEqual([
      { name: "Tourism fee", rateBp: 200, sales: 200, returns: 0, collected: 200, purchases: 0, purchaseReturns: 0, paid: 0, net: 200 },
      { name: "VAT", rateBp: 500, sales: 1500, returns: 500, collected: 1000, purchases: 3000, purchaseReturns: 0, paid: 3000, net: -2000 },
    ]);
    // The GST report leaves custom-tax bills out.
    expect((await o.as("get", "/reports/gst?from=2026-11-01&to=2026-11-30")).body.byRate).toEqual([]);
  });

  it("tax numbers: any tax ID in custom mode, a GSTIN in India GST mode; item codes too", async () => {
    expect((await o.as("post", "/customers").send({ name: "Acme", gstin: "100234567890003" })).body.error.message).toBe("Enter a valid 15-character GSTIN.");
    expect((await o.as("post", "/products").send({ name: "X", hsn: "0804.10", price: 100 })).body.error.code).toBe("invalid_item_code");
    await goCustom();
    const c = await o.as("post", "/customers").send({ name: "Acme LLC", gstin: "100234567890003" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.customer).toMatchObject({ gstin: "100234567890003", stateCode: null });
    expect((await o.as("post", "/customers").send({ name: "Bad", gstin: "?" })).body.error.message).toBe("Enter a valid TRN.");
  });

  it("tax groups: only the owner changes them; the default can't be removed; removing moves products to the default", async () => {
    await goCustom();
    const a = (await o.as("post", "/tax-groups").send({ name: "Standard", taxes: [{ name: "VAT", rateBp: 500 }] })).body.group;
    const zero = (await o.as("post", "/tax-groups").send({ name: "Exempt", taxes: [] })).body.group;
    const p = await product({ name: "Bread", price: 500, taxGroupId: zero.id });
    expect((await o.as("delete", `/tax-groups/${a.id}`)).body.error.code).toBe("is_default");
    expect((await o.as("delete", `/tax-groups/${zero.id}`)).status).toBe(204);
    expect((await o.as("get", `/products/${p.id}`)).body.product.taxGroupId).toBeNull();
    expect((await o.as("post", "/tax-groups").send({ name: "Six", taxes: Array.from({ length: 6 }, (_, i) => ({ name: `T${i}`, rateBp: 100 })) })).status).toBe(400);

    await o.as("post", "/staff").send({ name: "Ravi", email: "ravi@example.com", username: "ravi", role: "MANAGER", branchIds: [branchId] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink("ravi@example.com")), password: "staff-pass-1" });
    const ravi = await signIn(h, "ravi", "staff-pass-1");
    expect((await ravi.as("get", "/tax-groups")).status).toBe(200);
    expect((await ravi.as("post", "/tax-groups").send({ name: "Mine", taxes: [] })).status).toBe(403);
  });

  it("an offline bill keeps the taxes the counter charged; the pack carries the groups", async () => {
    await goCustom();
    await o.as("post", "/tax-groups").send({ name: "Standard", taxes: [{ name: "VAT", rateBp: 500 }] });
    const dates = await product({ name: "Dates", price: 10500 });
    const c = await o.as("post", "/counters").send({ branchId });
    const key = c.body.deviceKey as string;
    const pack = await request(h.app).get("/sync/pack").set("X-Device-Key", key);
    expect(pack.body.taxGroups).toMatchObject([{ name: "Standard", isDefault: true, rateBp: 500 }]);
    expect(pack.body.settings).toMatchObject({ taxMode: "CUSTOM", taxLabel: "VAT" });
    const id = randomUUID();
    const push = await request(h.app)
      .post("/sync/orders")
      .set("X-Device-Key", key)
      .send({
        orders: [
          {
            id,
            cashierId: o.me.user.id,
            invoiceNumber: `B1-${c.body.counter.code}-00001`,
            createdAt: "2026-11-04T09:30:00.000Z",
            taxEnabled: true,
            taxMode: "CUSTOM",
            discount: { type: "flat", value: 0 },
            lines: [{ productId: dates.id, name: "Dates", hsn: "", unit: "pcs", unitPrice: 10500, gstRateBp: 500, taxInclusive: true, taxes: [{ name: "VAT", rateBp: 500 }], qtyMilli: 1000 }],
            payments: [{ methodId: cash, amount: 10500 }],
            total: 10500,
          },
        ],
      });
    expect(push.body.results[0], JSON.stringify(push.body)).toMatchObject({ status: "saved" });
    const saved = (await o.as("get", `/orders/${id}`)).body.order;
    expect(saved).toMatchObject({ taxMode: "CUSTOM", taxTotals: [{ name: "VAT", rateBp: 500, amount: 500 }] });
  });
});
