import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db, harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

type Agent = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!TEST_DB)("connected money tools (Postgres)", () => {
  let h: H;
  let o: Agent;
  let ravi: Agent;
  let branchId: string;
  let m: Record<"CASH" | "UPI" | "CREDIT", string>;
  let tea: string;
  let atta: string;
  let meera: string;

  beforeEach(async () => {
    await resetDb();
    h = harness();
    const owner = await signUpOwner(h, { taxNumber: "29ABCDE1234F1Z5" });
    o = await signIn(h, owner.username);
    branchId = o.me.branches[0].id;
    const methods = (await o.as("get", "/payment-methods")).body.methods as { id: string; kind: "CASH" | "UPI" | "CREDIT" }[];
    m = Object.fromEntries(methods.map((x) => [x.kind, x.id])) as typeof m;
    tea = (await o.as("post", "/products").send({ name: "Tea 250 g", hsn: "0902", gstRateBp: 500, price: 14500, costPrice: 12000, openingStock: [{ branchId, qtyMilli: 10_000 }] })).body.product.id;
    atta = (await o.as("post", "/products").send({ name: "Atta 5 kg", hsn: "1101", gstRateBp: 0, price: 28500, openingStock: [{ branchId, qtyMilli: 5_000 }] })).body.product.id;
    meera = (await o.as("post", "/customers").send({ name: "Meera", phone: "9900011111" })).body.customer.id;
    await o.as("post", "/staff").send({ name: "Ravi", email: "ravi@example.com", username: "ravi", role: "CASHIER", branchIds: [branchId] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink("ravi@example.com")), password: "staff-pass-1" });
    ravi = await signIn(h, "ravi", "staff-pass-1");
  });

  async function counter() {
    const c = await o.as("post", "/counters").send({ branchId });
    return c.body as { counter: { id: string }; deviceKey: string };
  }

  it("udhaar: credit bills and opening dues; payments clear the oldest first", async () => {
    const { counter: c } = await counter();
    const bill = await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId: c.id, customerId: meera, lines: [{ productId: tea, qtyMilli: 2000 }], payments: [{ methodId: m.CREDIT, amount: 29000 }] });
    expect(bill.status).toBe(201);
    // Cashiers can't add old dues, owners can.
    expect((await ravi.as("post", `/customers/${meera}/opening`).send({ id: randomUUID(), amount: 30000, date: "2026-10-01" })).status).toBe(403);
    expect((await o.as("post", `/customers/${meera}/opening`).send({ id: randomUUID(), amount: 30000, date: "2026-10-01", note: "From the old notebook" })).status).toBe(201);

    const list = (await ravi.as("get", "/ledger/customers")).body;
    expect(list).toMatchObject({ owed: 59000, customers: [{ customer: { name: "Meera" }, balance: 59000 }] });

    // A cashier receives ₹400 in cash: the October dues go first, then the bill.
    const pay = await ravi.as("post", `/customers/${meera}/payments`).send({ id: randomUUID(), branchId, amount: 40000, methodId: m.CASH, note: "Paid at the counter" });
    expect(pay.status).toBe(201);
    expect(pay.body).toMatchObject({ balance: 19000, open: 19000, advance: 0 });
    expect(pay.body.openItems).toEqual([expect.objectContaining({ type: "bill", amount: 29000, paid: 10000, open: 19000 })]);
    expect(pay.body.rows.map((r: { type: string; balance: number }) => [r.type, r.balance])).toEqual([["payment", 19000], ["bill", 59000], ["opening", 30000]]);

    // Same payment again (retry) doesn't count twice.
    const again = await ravi.as("post", `/customers/${meera}/payments`).send({ id: pay.body.rows[0].id, branchId, amount: 40000, methodId: m.CASH });
    expect(again.body.balance).toBe(19000);
    // Udhaar can't pay udhaar.
    expect((await ravi.as("post", `/customers/${meera}/payments`).send({ id: randomUUID(), branchId, amount: 100, methodId: m.CREDIT })).body.error.code).toBe("bad_payment_method");

    // Cash received shows in the cash book.
    const book = (await o.as("get", `/cash-book?branchId=${branchId}&from=2026-11-04&to=2026-11-04`)).body;
    expect(book.days[0].lines).toEqual([expect.objectContaining({ direction: "IN", amount: 40000, source: "customer_payment", label: "From Meera" })]);

    // Voiding the payment brings the dues back.
    const voided = await o.as("post", `/ledger/customer-entries/${pay.body.rows[0].id}/void`).send({ reason: "Bounced" });
    expect(voided.body.balance).toBe(59000);
  });

  it("the owner can switch tools off; Udhaar goes with Customer Ledger", async () => {
    const s = await o.as("patch", "/settings").send({ tools: { "customer-ledger": false, "barcode-generator": false } });
    expect(s.body.tools).toMatchObject({ "customer-ledger": false, "barcode-generator": false, "cash-book": true });
    expect((await o.as("post", `/customers/${meera}/payments`).send({ id: randomUUID(), branchId, amount: 100, methodId: m.CASH })).body.error.code).toBe("tool_off");
    // Balances stay readable while Invoice Aging (which reads them) is on.
    expect((await o.as("get", "/ledger/customers")).status).toBe(200);
    const { counter: c } = await counter();
    const credit = await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId: c.id, customerId: meera, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: m.CREDIT, amount: 14500 }] });
    expect(credit.body.error.code).toBe("udhaar_off");
    expect((await ravi.as("patch", "/settings").send({ tools: { "cash-book": false } })).status).toBe(403);
    const back = await o.as("patch", "/settings").send({ tools: { "customer-ledger": true } });
    expect(back.body.tools).toMatchObject({ "customer-ledger": true, "barcode-generator": false });
  });

  it("supplier bill: stock, cost, input GST, part-paid; returns and cancel", async () => {
    const local = (await o.as("post", "/suppliers").send({ name: "Bharat Traders", gstin: "29AAACB1234C1Z2", phone: "98450 12345" })).body.supplier;
    expect(local).toMatchObject({ stateCode: "29", phone: "9845012345", balance: 0 });
    const expectedTotal = 61034;
    const body = {
      id: randomUUID(),
      branchId,
      supplierId: local.id,
      billNumber: "BT/1021",
      billDate: "2026-11-02",
      dueDate: "2026-11-30",
      lines: [
        { productId: tea, qtyMilli: 10_000, unitCost: 4_250, gstRateBp: 500 },
        { name: "Carry bags", qtyMilli: 3_000, unitCost: 1_999, gstRateBp: 1_800 },
        { productId: atta, qtyMilli: 2_500, unitCost: 3_333, gstRateBp: 1_200 },
      ],
      paidAmount: 20000,
      paidMethodId: m.CASH,
      expectedTotal,
    };
    const r = await o.as("post", "/purchases").send(body);
    expect(r.status).toBe(201);
    expect(r.body.purchase).toMatchObject({ interState: false, taxableTotal: 56_830, cgstTotal: 2_102, sgstTotal: 2_102, igstTotal: 0, total: expectedTotal, paidAmount: 20000 });
    // Same id again: no second bill. Same bill number: refused.
    expect((await o.as("post", "/purchases").send(body)).body.replayed).toBe(true);
    expect((await o.as("post", "/purchases").send({ ...body, id: randomUUID() })).body.error.code).toBe("duplicate_bill");
    expect((await o.as("post", "/purchases").send({ ...body, id: randomUUID(), billNumber: "X", expectedTotal: 1 })).body.error.code).toBe("total_mismatch");
    expect((await ravi.as("get", "/purchases")).status).toBe(403);

    const stock = async (id: string) => (await o.as("get", `/products/${id}`)).body.branches[0].stockMilli as number;
    expect(await stock(tea)).toBe(20_000);
    // GST-registered: cost is before GST.
    expect((await o.as("get", `/products/${tea}`)).body.product.costPrice).toBe(4_250);

    const sup = async () => (await o.as("get", `/suppliers/${local.id}/ledger`)).body;
    expect((await sup()).balance).toBe(expectedTotal - 20000);
    const book = (await o.as("get", `/cash-book?branchId=${branchId}&from=2026-11-04&to=2026-11-04`)).body;
    expect(book.days[0].lines).toEqual([expect.objectContaining({ direction: "OUT", amount: 20000, source: "purchase", label: "Bharat Traders bill BT/1021" })]);

    // 2 packs of tea back for a credit note: owed and stock both drop.
    const teaItem = r.body.purchase.items[0].id;
    const ret = await o.as("post", `/purchases/${body.id}/returns`).send({ id: randomUUID(), mode: "CREDIT_NOTE", items: [{ purchaseItemId: teaItem, qtyMilli: 2_000 }], note: "Damaged" });
    expect(ret.status).toBe(201);
    expect(ret.body.purchase.returns[0]).toMatchObject({ status: "SETTLED", total: 8_925 });
    expect(await stock(tea)).toBe(18_000);
    expect((await sup()).balance).toBe(expectedTotal - 20000 - 8_925);
    expect((await o.as("post", `/purchases/${body.id}/returns`).send({ id: randomUUID(), mode: "CREDIT_NOTE", items: [{ purchaseItemId: teaItem, qtyMilli: 9_000 }] })).body.error.code).toBe("too_many");

    // Replacement: stock out now, back in when it arrives; money unchanged.
    const rep = await o.as("post", `/purchases/${body.id}/returns`).send({ id: randomUUID(), mode: "REPLACEMENT", items: [{ purchaseItemId: teaItem, qtyMilli: 1_000 }] });
    expect(await stock(tea)).toBe(17_000);
    const pending = rep.body.purchase.returns.find((x: { mode: string }) => x.mode === "REPLACEMENT");
    expect(pending.status).toBe("PENDING");
    expect((await o.as("post", `/purchase-returns/${pending.id}/receive`).send({})).body.purchase.returns[1].status).toBe("RECEIVED");
    expect(await stock(tea)).toBe(18_000);
    expect((await sup()).balance).toBe(expectedTotal - 20000 - 8_925);

    // A bill with returns can't be cancelled; a fresh one can, and its stock goes back out.
    expect((await o.as("post", `/purchases/${body.id}/cancel`).send({ reason: "Wrong" })).body.error.code).toBe("has_returns");
    const other = (await o.as("post", "/suppliers").send({ name: "Delhi Foods", stateCode: "07" })).body.supplier;
    const igst = await o.as("post", "/purchases").send({ id: randomUUID(), branchId, supplierId: other.id, billNumber: "DF-9", billDate: "2026-11-03", lines: [{ productId: atta, qtyMilli: 1_000, unitCost: 10_001, gstRateBp: 1_800 }], paidAmount: 0 });
    expect(igst.body.purchase).toMatchObject({ interState: true, igstTotal: 1_800, cgstTotal: 0, total: 11_801 });
    expect(await stock(atta)).toBe(8_500);
    const cancelled = await o.as("post", `/purchases/${igst.body.purchase.id}/cancel`).send({ reason: "Entered twice" });
    expect(cancelled.body.purchase.cancelledAt).not.toBeNull();
    expect(await stock(atta)).toBe(7_500);
    expect((await o.as("get", `/suppliers/${other.id}/ledger`)).body.balance).toBe(0);
    const reg = (await o.as("get", "/purchases")).body;
    expect(reg.totals).toMatchObject({ bills: 1, total: expectedTotal, inputGst: 4_204 });
  });

  it("supplier ledger: opening dues first, then bills; payments made show in the cash book", async () => {
    const s = (await o.as("post", "/suppliers").send({ name: "Bharat Traders" })).body.supplier;
    await o.as("post", `/suppliers/${s.id}/opening`).send({ id: randomUUID(), amount: 50000, date: "2026-09-15", dueDate: "2026-10-15" });
    await o.as("post", "/purchases").send({ id: randomUUID(), branchId, supplierId: s.id, billNumber: "B-1", billDate: "2026-11-01", lines: [{ productId: atta, qtyMilli: 1000, unitCost: 20000, gstRateBp: 0 }], paidAmount: 0 });
    const paid = await o.as("post", `/suppliers/${s.id}/payments`).send({ id: randomUUID(), branchId, amount: 60000, methodId: m.CASH });
    expect(paid.body).toMatchObject({ balance: 10000, open: 10000 });
    expect(paid.body.openItems).toEqual([expect.objectContaining({ type: "purchase", ref: "B-1", open: 10000 })]);
    expect((await ravi.as("post", `/suppliers/${s.id}/payments`).send({ id: randomUUID(), branchId, amount: 100, methodId: m.CASH })).status).toBe(403);
    expect((await o.as("get", "/ledger/suppliers")).body).toMatchObject({ owed: 10000 });
    expect((await o.as("delete", `/suppliers/${s.id}`)).body.error.code).toBe("has_balance");
  });

  it("expenses and the cash book: opening carried day to day", async () => {
    expect((await ravi.as("post", "/expenses").send({})).status).toBe(403);
    await o.as("put", "/cash-book/opening").send({ branchId, day: "2026-11-03", amount: 100000 });
    // Yesterday: a manual cash-in.
    await o.as("post", "/cash-book/entries").send({ id: randomUUID(), branchId, type: "IN", amount: 5000, description: "Owner added change", occurredAt: "2026-11-03T06:00:00.000Z" });
    // Today: a cash sale, a UPI sale, a cash expense and a UPI expense.
    const { counter: c } = await counter();
    await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId: c.id, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: m.CASH, amount: 14500 }] });
    await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId: c.id, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: m.UPI, amount: 14500 }] });
    const rent = randomUUID();
    expect((await o.as("post", "/expenses").send({ id: rent, branchId, category: "Rent", description: "November", amount: 20000, methodId: m.CASH })).status).toBe(201);
    await o.as("post", "/expenses").send({ id: randomUUID(), branchId, category: "Electricity", amount: 3000, methodId: m.UPI });

    const ex = (await o.as("get", `/expenses?branchId=${branchId}&from=2026-11-01&to=2026-11-04`)).body;
    expect(ex).toMatchObject({ total: 23000, byCategory: [{ category: "Rent", amount: 20000 }, { category: "Electricity", amount: 3000 }] });
    expect((await o.as("get", "/expense-categories")).body.categories).toContain("Rent");

    const book = (await o.as("get", `/cash-book?branchId=${branchId}&from=2026-11-02&to=2026-11-04`)).body;
    expect(book.opening).toEqual({ day: "2026-11-03", amount: 100000 });
    expect(book.days.map((d: { day: string; opening: number; in: number; out: number; closing: number }) => [d.day, d.opening, d.in, d.out, d.closing])).toEqual([
      ["2026-11-02", 0, 0, 0, 0],
      ["2026-11-03", 100000, 5000, 0, 105000],
      ["2026-11-04", 105000, 14500, 20000, 99500],
    ]);
    expect(book.days[2].lines.map((l: { label: string }) => l.label)).toEqual(["Cash sales (1 bills)", "Rent: November"]);
    // Only today: the opening is carried in.
    expect((await o.as("get", `/cash-book?branchId=${branchId}&from=2026-11-04&to=2026-11-04`)).body.days[0].opening).toBe(105000);

    await o.as("delete", `/expenses/${rent}`);
    expect((await o.as("get", `/cash-book?branchId=${branchId}&from=2026-11-04&to=2026-11-04`)).body.days[0].closing).toBe(119500);
  });

  it("offline: the pack carries balances; expenses and payments sync once; roles are checked", async () => {
    const { counter: c, deviceKey } = await counter();
    await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId: c.id, customerId: meera, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: m.CREDIT, amount: 14500 }] });
    const s = (await o.as("post", "/suppliers").send({ name: "Bharat Traders" })).body.supplier;
    await o.as("post", `/suppliers/${s.id}/opening`).send({ id: randomUUID(), amount: 9000, date: "2026-10-01" });

    const pack = (await request(h.app).get("/sync/pack").set("X-Device-Key", deviceKey)).body;
    expect(pack.customerBalances).toEqual([{ customerId: meera, balance: 14500 }]);
    expect(pack.suppliers).toEqual([{ id: s.id, name: "Bharat Traders", phone: "", balance: 9000 }]);
    expect(pack.expenseCategories).toContain("Rent");
    expect(pack.settings.tools["expense-tracker"]).toBe(true);

    const at = "2026-11-04T08:00:00.000Z";
    const ops = [
      { kind: "customer_payment", id: randomUUID(), userId: ravi.me.user.id, at, customerId: meera, amount: 5000, methodId: m.CASH },
      { kind: "expense", id: randomUUID(), userId: o.me.user.id, at, category: "Tea for staff", amount: 1200, methodId: m.CASH },
      { kind: "supplier_payment", id: randomUUID(), userId: ravi.me.user.id, at, supplierId: s.id, amount: 1000, methodId: m.CASH },
      { kind: "customer_payment", id: randomUUID(), userId: ravi.me.user.id, at, customerId: randomUUID(), amount: 100, methodId: m.CASH },
    ];
    const push = (x: unknown[]) => request(h.app).post("/sync/money").set("X-Device-Key", deviceKey).send({ ops: x });
    const r = await push(ops);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(["saved", "saved", "rejected", "retry"]);
    expect((await push(ops.slice(0, 2))).body.results.map((x: { status: string }) => x.status)).toEqual(["duplicate", "duplicate"]);
    expect((await o.as("get", `/customers/${meera}/ledger`)).body.balance).toBe(9500);
    const ex = (await o.as("get", `/expenses?branchId=${branchId}`)).body.expenses;
    expect(ex).toEqual([expect.objectContaining({ category: "Tea for staff", offline: true, userName: o.me.user.name })]);

    await db().subscription.updateMany({ data: { endsAt: new Date("2026-11-01T00:00:00Z") } });
    expect((await push([{ ...ops[1], id: randomUUID() }])).status).toBe(402);
  });

  it("free POS backup brings the tools' history, once", async () => {
    const backup = {
      app: "setu-free-pos",
      version: 1,
      data: {
        products: [{ id: "p1", name: "Sugar 1 kg", sellingPrice: 48, stock: 10 }],
        customers: [{ id: "c1", name: "Kiran", phone: "98111 22233" }],
        suppliers: [{ id: "s1", name: "Shree Agencies", phone: "98450 00001", gstin: "29AAACS1234C1Z1" }],
        purchases: [
          { id: "pu1", supplierId: "s1", supplierName: "Shree Agencies", billNumber: "SA-1", date: "2026-08-10", items: [{ productId: "p1", name: "Sugar 1 kg", quantity: 50, unitCost: 40 }], total: 2000, paymentMode: "Credit", expenseId: "e-mirror" },
          { id: "pu2", supplierId: "s1", supplierName: "Shree Agencies", billNumber: "SA-2", date: "2026-08-20", items: [], total: 500, paymentMode: "Cash" },
        ],
        purchase_returns: [{ id: "r1", purchaseId: "pu1", date: "2026-08-12", mode: "credit-note", items: [{ itemIndex: 0, name: "Sugar 1 kg", quantity: 5, unitCost: 40 }], amount: 200, status: "settled" }],
        supplier_ledger: [{ id: "sl1", supplierId: "s1", supplierName: "Shree Agencies", type: "payment", amount: 800, date: "2026-09-01", paymentMode: "UPI" }],
        expenses: [
          { id: "e1", date: "2026-09-05", category: "Rent", amount: 5000, paymentMode: "Cash" },
          { id: "e-mirror", date: "2026-08-10", category: "Purchases", amount: 2000, paymentMode: "Credit" },
        ],
        cashbook: [{ id: "cb1", date: "2026-09-01", type: "in", amount: 1000, description: "Opening cash" }],
        ledger: [
          { id: "l1", customerId: "c1", customerName: "Kiran", type: "credit", amount: 700, date: "2026-07-01" },
          { id: "l2", customerId: "c1", customerName: "Kiran", type: "payment", amount: 200, date: "2026-07-15" },
        ],
      },
    };
    const r = await o.as("post", "/imports/free-pos").send({ branchId, backup });
    expect(r.status).toBe(200);
    expect(r.body.books).toEqual({ suppliers: 1, expenses: 1, cashEntries: 1, customerLedger: 2, supplierLedger: 1, purchases: 2, purchaseReturns: 1 });
    const again = (await o.as("post", "/imports/free-pos").send({ branchId, backup })).body.books;
    expect(again).toEqual({ suppliers: 0, expenses: 0, cashEntries: 0, customerLedger: 0, supplierLedger: 0, purchases: 0, purchaseReturns: 0 });

    const kiran = (await o.as("get", "/ledger/customers")).body.customers[0];
    expect(kiran).toMatchObject({ customer: { name: "Kiran" }, balance: 50000 });
    const shree = (await o.as("get", "/ledger/suppliers")).body.suppliers[0];
    // 2000 on credit − 200 credit note − 800 paid; the cash bill is settled.
    expect(shree).toMatchObject({ supplier: { name: "Shree Agencies", gstin: "29AAACS1234C1Z1" }, balance: 100000 });
    // History doesn't move stock again.
    const sugar = (await o.as("get", `/products?branchId=${branchId}&q=Sugar`)).body.products[0];
    expect(sugar.stockMilli).toBe(10_000);
  });
});
