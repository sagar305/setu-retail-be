import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

type S = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!TEST_DB)("reports (Postgres)", () => {
  let h: H;
  let o: S;
  let branchId: string;
  let b2: string;
  let bill1: { id: string; items: { id: string; name: string }[] };
  const range = "from=2026-11-03T18:30:00.000Z&to=2026-11-04T18:30:00.000Z";

  beforeAll(async () => {
    await resetDb();
    h = harness("2026-11-04T06:00:00Z");
    const owner = await signUpOwner(h, { taxNumber: "29ABCDE1234F1Z5" });
    o = await signIn(h, owner.username);
    branchId = o.me.branches[0].id;
    await o.as("post", "/account/license/redeem").send({ key: h.key("gold", 365), choice: "now" });
    b2 = (await o.as("post", "/branches").send({ name: "Second", stateCode: "29" })).body.branch.id;
    o = await signIn(h, owner.username);
    const counter = (await o.as("post", "/counters").send({ branchId })).body.counter.id;
    const methods = (await o.as("get", "/payment-methods")).body.methods as { id: string; kind: string }[];
    const [cash, upi] = [methods.find((m) => m.kind === "CASH")!.id, methods.find((m) => m.kind === "UPI")!.id];
    const mk = async (body: Record<string, unknown>) => (await o.as("post", "/products").send(body)).body.product.id as string;
    const atta = await mk({ name: "Atta", hsn: "1101", gstRateBp: 500, price: 28500, costPrice: 24800, openingStock: [{ branchId, qtyMilli: 10_000 }] });
    const tea = await mk({ name: "Tea", hsn: "0902", gstRateBp: 500, price: 14500, openingStock: [{ branchId, qtyMilli: 2_000 }] });
    const det = await mk({ name: "Detergent", hsn: "3402", gstRateBp: 1800, price: 12000, costPrice: 9000, openingStock: [{ branchId, qtyMilli: 5_000 }] });
    const sell = async (lines: unknown[], payments: unknown[], extra: Record<string, unknown> = {}) => (await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId: counter, lines, payments, ...extra })).body.order;

    bill1 = await sell([{ productId: atta, qtyMilli: 1000 }, { productId: tea, qtyMilli: 2000 }, { productId: det, qtyMilli: 1000 }], [{ methodId: upi, amount: 69500 }]);
    const pune = (await o.as("post", "/customers").send({ name: "Pune Traders", gstin: "27ABCDE1234F1Z5" })).body.customer;
    await sell([{ productId: det, qtyMilli: 2000 }], [{ methodId: cash, amount: 24000 }], { customerId: pune.id });
    const cancelled = await sell([{ productId: atta, qtyMilli: 1000 }], [{ methodId: cash, amount: 28500 }]);
    await o.as("post", `/orders/${cancelled.id}/cancel`).send({ reason: "x" });
    const teaLine = bill1.items.find((i) => i.name === "Tea")!;
    await o.as("post", `/orders/${bill1.id}/returns`).send({ counterId: counter, items: [{ orderItemId: teaLine.id, qtyMilli: 1000 }], refundMethodId: cash, reason: "Damaged" });
  });

  it("sales summary: bills, sales, returns, net, payments, top products, by day", async () => {
    const r = (await o.as("get", `/reports/sales?${range}`)).body;
    expect(r).toMatchObject({ bills: 2, sales: 93500, returns: 14500, returnCount: 1, net: 79000, cancelled: { count: 1, total: 28500 }, averageBill: 46750 });
    expect(r.byPayment).toEqual([
      { method: "UPI", kind: "UPI", amount: 69500 },
      { method: "Cash", kind: "CASH", amount: 24000 },
    ]);
    expect(r.refundsByMethod).toEqual([{ method: "Cash", amount: 14500 }]);
    expect(r.topProducts[0]).toMatchObject({ name: "Detergent", qtyMilli: 3000, amount: 36000 });
    expect(r.byDay).toEqual([{ day: "2026-11-04", bills: 2, sales: 93500 }]);
    expect((await o.as("get", `/reports/sales?${range}&branchId=${b2}`)).body.bills).toBe(0);
  });

  it("GST: by rate with credit notes netted, by HSN, B2B vs B2C", async () => {
    const g = (await o.as("get", `/reports/gst?${range}`)).body;
    const five = g.byRate.find((r: { rateBp: number }) => r.rateBp === 500);
    expect(five.sales_taxable).toBe(54762);
    expect(five.returns_total).toBe(14500);
    expect(five.net_total).toBe(57500 - 14500);
    const eighteen = g.byRate.find((r: { rateBp: number }) => r.rateBp === 1800);
    expect(eighteen.sales_igst).toBeGreaterThan(0); // the Pune bill is inter-state
    expect(g.byHsn.map((x: { hsn: string; qtyMilli: number }) => [x.hsn, x.qtyMilli])).toEqual([["0902", 2000], ["1101", 1000], ["3402", 3000]]);
    expect(g.b2b).toEqual([expect.objectContaining({ customerGstin: "27ABCDE1234F1Z5", placeOfSupply: "27", interState: true, total: 24000 })]);
    expect(g.b2c).toEqual([expect.objectContaining({ interState: false, placeOfSupply: "29", bills: 1, total: 69500 })]);
    expect(g.creditNotes).toEqual([expect.objectContaining({ number: "CN-B1-C1-00001", invoiceNumber: "B1-C1-00001", total: 14500 })]);
  });

  it("stock: value at cost, low/out, missing cost", async () => {
    const s = (await o.as("get", `/reports/stock?branchId=${branchId}`)).body;
    expect(s.counts).toMatchObject({ tracked: 3, low: 2 });
    expect(s.missingCost).toBe(1);
    expect(s.value).toBe(9 * 24800 + 2 * 9000);
  });

  it("staff & margin", async () => {
    const r = (await o.as("get", `/reports/staff?${range}`)).body;
    expect(r.byCashier).toEqual([expect.objectContaining({ bills: 2, sales: 93500, returns: 14500 })]);
    expect(r.byCounter[0].code).toBe("B1-C1");
    const det = r.margin.find((m: { name: string }) => m.name === "Detergent");
    expect(det).toMatchObject({ qtyMilli: 3000, cost: 27000 });
    expect(det.margin).toBe(det.revenue - 27000);
    expect(r.margin.find((m: { name: string }) => m.name === "Tea")).toMatchObject({ qtyMilli: 1000, cost: null, margin: null });
  });

  it("stock log and dashboard", async () => {
    const log = (await o.as("get", `/reports/stock-log?branchId=${branchId}&${range}`)).body.log;
    expect(log.map((l: { type: string }) => l.type)).toEqual(expect.arrayContaining(["OPENING", "SALE", "CANCEL", "RETURN"]));
    const d = (await o.as("get", "/reports/dashboard")).body;
    expect(d.today).toMatchObject({ sales: 93500, net: 79000, bills: 2 });
    expect(d.week).toHaveLength(7);
    expect(d.week.at(-1)).toEqual({ day: "2026-11-04", sales: 93500, bills: 2 });
    expect(d.lowStock.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(["Tea", "Detergent"]));
  });

  it("cashiers can't open reports; managers only see their branches", async () => {
    await o.as("post", "/staff").send({ name: "Meena", email: "meena@example.com", username: "meena", role: "MANAGER", branchIds: [b2] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink("meena@example.com")), password: "staff-pass-1" });
    const m = await signIn(h, "meena", "staff-pass-1");
    expect((await m.as("get", `/reports/sales?${range}`)).body.bills).toBe(0);
    expect((await m.as("get", `/reports/sales?${range}&branchId=${branchId}`)).status).toBe(404);
    await o.as("post", "/staff").send({ name: "Ravi", email: "ravi@example.com", username: "ravi", role: "CASHIER", branchIds: [branchId] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink("ravi@example.com")), password: "staff-pass-1" });
    const c = await signIn(h, "ravi", "staff-pass-1");
    expect((await c.as("get", "/reports/dashboard")).status).toBe(403);
  });
});
