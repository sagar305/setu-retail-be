import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { ean13CheckDigit } from "../../src/routes/receipts.js";
import { harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

type Agent = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!TEST_DB)("report tools, receipt designs, barcodes (Postgres)", () => {
  let h: H;
  let o: Agent;
  let branchId: string;
  let counterId: string;
  let m: Record<"CASH" | "UPI" | "CREDIT", string>;
  let tea: string;

  beforeEach(async () => {
    await resetDb();
    h = harness();
    const owner = await signUpOwner(h, { taxNumber: "29ABCDE1234F1Z5" });
    o = await signIn(h, owner.username);
    branchId = o.me.branches[0].id;
    m = Object.fromEntries(((await o.as("get", "/payment-methods")).body.methods as { id: string; kind: string }[]).map((x) => [x.kind, x.id])) as typeof m;
    counterId = (await o.as("post", "/counters").send({ branchId })).body.counter.id;
    tea = (await o.as("post", "/products").send({ name: "Tea 250 g", hsn: "0902", gstRateBp: 500, price: 14500, costPrice: 12000, openingStock: [{ branchId, qtyMilli: 10_000 }] })).body.product.id;
  });

  const sell = (lines: { productId: string; qtyMilli: number }[], payments: { methodId: string; amount: number }[], customerId: string | null = null) =>
    o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId, customerId, lines, payments });

  it("Invoice Aging: udhaar is due after credit days; customers can have their own", async () => {
    await o.as("patch", "/settings").send({ creditDays: 15 });
    const meera = (await o.as("post", "/customers").send({ name: "Meera" })).body.customer.id;
    const ravi = (await o.as("post", "/customers").send({ name: "Ravi", creditDays: 0 })).body.customer;
    expect(ravi.creditDays).toBe(0);
    await o.as("post", `/customers/${meera}/opening`).send({ id: randomUUID(), amount: 50000, date: "2026-09-05" });
    await sell([{ productId: tea, qtyMilli: 1000 }], [{ methodId: m.CREDIT, amount: 14500 }], meera);
    await o.as("post", `/customers/${ravi.id}/opening`).send({ id: randomUUID(), amount: 20000, date: "2026-10-30" });

    const r = (await o.as("get", "/reports/aging/customers")).body;
    expect(r).toMatchObject({ asOf: "2026-11-04", creditDays: 15, total: 84500, totals: { current: 14500, d30: 20000, d60: 50000, d90: 0, d90plus: 0 } });
    const mrow = r.parties.find((p: { name: string }) => p.name === "Meera");
    // Opening on 5 Sep + 15 days = due 20 Sep → 45 days overdue.
    expect(mrow.items.map((i: { dueDay: string; daysOverdue: number; bucket: string }) => [i.dueDay, i.daysOverdue, i.bucket])).toEqual([["2026-09-20", 45, "d60"], ["2026-11-19", 0, "current"]]);
    expect(r.parties[0].name).toBe("Meera"); // most overdue first

    // Paying clears the oldest first: the old dues leave the 31–60 bucket.
    await o.as("post", `/customers/${meera}/payments`).send({ id: randomUUID(), branchId, amount: 50000, methodId: m.CASH });
    expect((await o.as("get", "/reports/aging/customers")).body.totals).toMatchObject({ current: 14500, d60: 0 });
    await o.as("patch", "/settings").send({ tools: { "invoice-aging": false } });
    expect((await o.as("get", "/reports/aging/customers")).body.error.code).toBe("tool_off");
  });

  it("Payables Aging: by due date, and what falls due this week", async () => {
    const s = (await o.as("post", "/suppliers").send({ name: "Bharat Traders" })).body.supplier;
    await o.as("post", "/purchases").send({ id: randomUUID(), branchId, supplierId: s.id, billNumber: "B-1", billDate: "2026-10-01", dueDate: "2026-10-10", lines: [{ productId: tea, qtyMilli: 1000, unitCost: 10000, gstRateBp: 0 }], paidAmount: 0 });
    await o.as("post", "/purchases").send({ id: randomUUID(), branchId, supplierId: s.id, billNumber: "B-2", billDate: "2026-11-01", dueDate: "2026-11-08", lines: [{ productId: tea, qtyMilli: 1000, unitCost: 5000, gstRateBp: 0 }], paidAmount: 0 });
    const r = (await o.as("get", "/reports/aging/suppliers")).body;
    expect(r).toMatchObject({ total: 15000, totals: { current: 5000, d30: 10000 } });
    expect(r.dueThisWeek).toEqual([expect.objectContaining({ ref: "B-2", dueDay: "2026-11-08", open: 5000, name: "Bharat Traders" })]);
  });

  it("Profit: net sales before GST − cost of goods − expenses; returns and unknown costs handled", async () => {
    const bill = await sell([{ productId: tea, qtyMilli: 2000 }], [{ methodId: m.CASH, amount: 29000 }]);
    expect(bill.body.order.taxableTotal).toBe(27619);
    await o.as("post", `/orders/${bill.body.order.id}/returns`).send({ counterId, items: [{ orderItemId: bill.body.order.items[0].id, qtyMilli: 1000 }], refundMethodId: m.CASH, reason: "Torn" });
    const misc = (await o.as("post", "/products").send({ name: "Gift wrap", gstRateBp: 0, price: 2000, trackStock: false })).body.product.id;
    await sell([{ productId: misc, qtyMilli: 1000 }], [{ methodId: m.UPI, amount: 2000 }]);
    await o.as("post", "/expenses").send({ id: randomUUID(), branchId, category: "Electricity", amount: 1000, methodId: m.UPI });

    const r = (await o.as("get", "/reports/profit?from=2026-11-01&to=2026-11-04")).body;
    // 27,619 − 13,810 returned + 2,000 gift wrap; cost 24,000 − 12,000; gift wrap has no cost.
    expect(r).toMatchObject({ period: "day", revenue: 15809, cost: 12000, grossProfit: 3809, expenses: 1000, netProfit: 2809, uncosted: { lines: 1, revenue: 2000 } });
    expect(r.byPeriod).toEqual([expect.objectContaining({ period: "2026-11-04", netProfit: 2809 })]);
    expect(r.byBranch).toEqual([expect.objectContaining({ branchId, netProfit: 2809 })]);
    expect(r.expensesByCategory).toEqual([{ category: "Electricity", amount: 1000 }]);
    expect((await o.as("get", "/reports/profit?from=2026-01-01&to=2026-11-04")).body.period).toBe("month");
  });

  it("Stock Register: opening, in, out, closing from the stock movements", async () => {
    const s = (await o.as("post", "/suppliers").send({ name: "Bharat Traders" })).body.supplier;
    await sell([{ productId: tea, qtyMilli: 2000 }], [{ methodId: m.CASH, amount: 29000 }]);
    await o.as("post", "/purchases").send({ id: randomUUID(), branchId, supplierId: s.id, billNumber: "B-1", billDate: "2026-11-04", lines: [{ productId: tea, qtyMilli: 5000, unitCost: 11000, gstRateBp: 500 }], paidAmount: 0 });
    const today = (await o.as("get", `/reports/stock-register?branchId=${branchId}&from=2026-11-04&to=2026-11-04`)).body;
    expect(today.items).toEqual([expect.objectContaining({ name: "Tea 250 g", opening: 0, adjustments: 10000, sales: -2000, purchases: 5000, closing: 13000, value: 143000 })]);
    // Tomorrow opens with today's closing.
    const next = (await o.as("get", `/reports/stock-register?branchId=${branchId}&from=2026-11-05&to=2026-11-05`)).body;
    expect(next.items).toEqual([expect.objectContaining({ opening: 13000, sales: 0, closing: 13000 })]);
    const log = (await o.as("get", `/reports/stock-log?branchId=${branchId}&productId=${tea}&from=2026-11-04T00:00:00Z&to=2026-11-06T00:00:00Z`)).body.log;
    expect(log.map((l: { type: string }) => l.type)).toEqual(["PURCHASE", "SALE", "OPENING"]);
  });

  it("receipt designs: default, per-branch choice, in the offline pack; cashiers can read", async () => {
    const a = (await o.as("post", "/receipt-templates").send({ name: "Classic", paperSize: "80mm", accentColor: "#26306B", footerText: "Thank you!" })).body.template;
    const b = (await o.as("post", "/receipt-templates").send({ name: "Big A4", paperSize: "a4", accentColor: "#F2A03D", showLogo: true })).body.template;
    expect([a.isDefault, b.isDefault]).toEqual([true, false]);
    await o.as("post", `/receipt-templates/${b.id}/default`);
    expect((await o.as("get", "/receipt-templates")).body.templates.map((t: { name: string; isDefault: boolean }) => [t.name, t.isDefault])).toEqual([["Big A4", true], ["Classic", false]]);
    await o.as("put", `/receipt-templates/branches/${branchId}`).send({ templateId: a.id });
    const me = (await o.as("get", "/me")).body;
    expect(me.branches[0].receiptTemplateId).toBe(a.id);

    const { deviceKey } = (await o.as("post", "/counters").send({ branchId })).body;
    const pack = (await request(h.app).get("/sync/pack").set("X-Device-Key", deviceKey)).body;
    expect(pack.branch.receiptTemplateId).toBe(a.id);
    expect(pack.receiptTemplates.map((t: { name: string }) => t.name)).toEqual(["Classic", "Big A4"]);

    // A logo for receipts.
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    expect((await o.as("patch", "/settings").send({ logoDataUrl: logo })).body.logoDataUrl).toBe(logo);
    expect((await o.as("patch", "/settings").send({ logoDataUrl: "javascript:alert(1)" })).status).toBe(400);

    await o.as("post", "/staff").send({ name: "Ravi", email: "ravi@example.com", username: "ravi", role: "CASHIER", branchIds: [branchId] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink("ravi@example.com")), password: "staff-pass-1" });
    const ravi = await signIn(h, "ravi", "staff-pass-1");
    expect((await ravi.as("get", "/receipt-templates")).body.templates).toHaveLength(2);
    expect((await ravi.as("post", "/receipt-templates").send({ name: "X", paperSize: "58mm", accentColor: "#000000" })).status).toBe(403);

    // Deleting the default makes another one the default; the branch falls back.
    await o.as("delete", `/receipt-templates/${b.id}`);
    await o.as("delete", `/receipt-templates/${a.id}`);
    expect((await o.as("get", "/receipt-templates")).body.templates).toEqual([]);
    expect((await o.as("get", "/me")).body.branches[0].receiptTemplateId).toBeNull();
  });

  it("makes in-store barcodes only for products without one", async () => {
    const scanned = (await o.as("post", "/products").send({ name: "Atta", price: 28500, barcode: "8901234567890" })).body.product.id;
    const r = (await o.as("post", "/products/barcodes").send({ productIds: [tea, scanned] })).body;
    expect(r.skipped).toBe(1);
    expect(r.generated).toHaveLength(1);
    const code = r.generated[0].barcode as string;
    expect(code).toMatch(/^2\d{12}$/);
    expect(Number(code[12])).toBe(ean13CheckDigit(code.slice(0, 12)));
    expect((await o.as("get", `/products/${tea}`)).body.product.barcode).toBe(code);
    expect((await o.as("post", "/products/barcodes").send({ productIds: [tea] })).body.generated).toEqual([]);
  });
});
