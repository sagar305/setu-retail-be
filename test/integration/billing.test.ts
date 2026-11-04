import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db, harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

type Session = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!TEST_DB)("billing (Postgres)", () => {
  let h: H;
  let o: Session;
  let branchId: string;
  let counterId: string;
  let cash: string;
  let upi: string;
  let credit: string;
  let atta: string;
  let tea: string;
  let detergent: string;

  async function product(body: Record<string, unknown>) {
    const r = await o.as("post", "/products").send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.product.id as string;
  }
  function sell(s: Session, body: Record<string, unknown>) {
    return s.as("post", "/orders").send({ id: randomUUID(), branchId, counterId, ...body });
  }
  async function stock(id: string) {
    return (await db().branchProduct.findUnique({ where: { branchId_productId: { branchId, productId: id } } }))?.stockMilli;
  }
  async function staff(role: "CASHIER" | "MANAGER", username: string) {
    await o.as("post", "/staff").send({ name: username, email: `${username}@example.com`, username, role, branchIds: [branchId] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink(`${username}@example.com`)), password: "staff-pass-1" });
    return signIn(h, username, "staff-pass-1");
  }

  beforeEach(async () => {
    await resetDb();
    h = harness();
    const owner = await signUpOwner(h, { taxNumber: "29ABCDE1234F1Z5" });
    o = await signIn(h, owner.username);
    branchId = o.me.branches[0].id;
    counterId = (await o.as("post", "/counters").send({ branchId, name: "Front desk" })).body.counter.id;
    const methods = (await o.as("get", "/payment-methods")).body.methods as { id: string; kind: string }[];
    cash = methods.find((m) => m.kind === "CASH")!.id;
    upi = methods.find((m) => m.kind === "UPI")!.id;
    credit = methods.find((m) => m.kind === "CREDIT")!.id;
    atta = await product({ name: "Wheat Atta 5 kg", hsn: "1101", gstRateBp: 500, price: 28500, costPrice: 24800, openingStock: [{ branchId, qtyMilli: 10_000 }] });
    tea = await product({ name: "Tea 250 g", hsn: "0902", gstRateBp: 500, price: 14500, openingStock: [{ branchId, qtyMilli: 5_000 }] });
    detergent = await product({ name: "Detergent 1 kg", hsn: "3402", gstRateBp: 1800, price: 12000, openingStock: [{ branchId, qtyMilli: 3_000 }] });
  });

  const protoLines = () => [
    { productId: atta, qtyMilli: 1000 },
    { productId: tea, qtyMilli: 2000 },
    { productId: detergent, qtyMilli: 1000 },
  ];

  it("bills the prototype receipt with CGST/SGST, numbers per counter, and takes stock", async () => {
    const r = await sell(o, { lines: protoLines(), payments: [{ methodId: upi, amount: 69500 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.order).toMatchObject({ invoiceNumber: "B1-C1-00001", total: 69500, taxableTotal: 64931, placeOfSupply: "29", interState: false, igstTotal: 0 });
    expect(r.body.order.cgstTotal + r.body.order.sgstTotal).toBe(4569);
    expect(await stock(tea)).toBe(3000);

    const next = await sell(o, { lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14500 }] });
    expect(next.body.order.invoiceNumber).toBe("B1-C1-00002");

    const c2 = (await o.as("post", "/counters").send({ branchId })).body.counter;
    expect(c2.code).toBe("C2");
    const other = await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId: c2.id, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14500 }] });
    expect(other.body.order.invoiceNumber).toBe("B1-C2-00001");

    const log = await db().inventoryLog.findFirst({ where: { productId: atta, type: "SALE" } });
    expect(log).toMatchObject({ changeMilli: -1000, stockAfterMilli: 9000 });
  });

  it("a retried bill is saved once", async () => {
    const id = randomUUID();
    const body = { id, branchId, counterId, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14500 }] };
    const first = await o.as("post", "/orders").send(body);
    const again = await o.as("post", "/orders").send(body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.order.invoiceNumber).toBe(first.body.order.invoiceNumber);
    expect(await db().order.count()).toBe(1);
    expect(await stock(tea)).toBe(4000);
  });

  it("checks payments: must equal the total; credit needs a customer", async () => {
    const short = await sell(o, { lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 10000 }] });
    expect(short.body.error.code).toBe("payment_mismatch");
    const split = await sell(o, { lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 4500 }, { methodId: upi, amount: 10000 }] });
    expect(split.status).toBe(201);
    expect(split.body.order.payments).toHaveLength(2);

    const noCustomer = await sell(o, { lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: credit, amount: 14500 }] });
    expect(noCustomer.body.error.code).toBe("credit_needs_customer");
    const cust = (await o.as("post", "/customers").send({ name: "Meera", phone: "+91 99000 11111" })).body.customer;
    expect(cust.phone).toBe("9900011111");
    const udhaar = await sell(o, { customerId: cust.id, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: credit, amount: 14500 }] });
    expect(udhaar.status).toBe(201);
    expect(udhaar.body.order.customer.name).toBe("Meera");
  });

  it("charges IGST to a customer from another state", async () => {
    const cust = (await o.as("post", "/customers").send({ name: "Pune Traders", gstin: "27ABCDE1234F1Z5" })).body.customer;
    expect(cust.stateCode).toBe("27");
    const r = await sell(o, { customerId: cust.id, lines: [{ productId: detergent, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 12000 }] });
    expect(r.body.order).toMatchObject({ placeOfSupply: "27", interState: true, igstTotal: 1831, cgstTotal: 0, sgstTotal: 0, total: 12000 });
    expect(r.body.order.customer.gstin).toBe("27ABCDE1234F1Z5");
  });

  it("no GST when the owner turns it off", async () => {
    await o.as("patch", "/settings").send({ taxEnabled: false });
    const me = await signIn(h, o.me.user.username);
    const r = await sell(me, { lines: [{ productId: detergent, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 12000 }] });
    expect(r.body.order).toMatchObject({ taxEnabled: false, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, taxableTotal: 12000, placeOfSupply: null });
  });

  it("uses the branch's own price when set", async () => {
    await o.as("put", `/products/${tea}/branches/${branchId}`).send({ price: 14900 });
    const r = await sell(o, { lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14900 }] });
    expect(r.status).toBe(201);
    expect(r.body.order.items[0].unitPrice).toBe(14900);
  });

  it("caps a cashier's discount; hides cost from cashiers", async () => {
    const cashier = await staff("CASHIER", "ravi");
    const lines = [{ productId: atta, qtyMilli: 1000 }];
    const tooMuch = await sell(cashier, { lines, discount: { type: "percent", value: 1500 }, payments: [{ methodId: cash, amount: 24225 }] });
    expect(tooMuch.body.error.code).toBe("discount_too_high");
    const ok = await sell(cashier, { lines, discount: { type: "percent", value: 1000 }, payments: [{ methodId: cash, amount: 25650 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.order.discountTotal).toBe(2850);

    const list = await cashier.as("get", `/products?branchId=${branchId}`);
    expect(list.body.products[0]).not.toHaveProperty("costPrice");
    expect((await o.as("get", `/products?branchId=${branchId}`)).body.products.find((p: { id: string }) => p.id === atta).costPrice).toBe(24800);
    expect((await cashier.as("post", "/products").send({ name: "X", price: 100 })).status).toBe(403);
  });

  it("selling below zero follows the owner's setting", async () => {
    const big = [{ productId: detergent, qtyMilli: 5000 }];
    const allowed = await sell(o, { lines: big, payments: [{ methodId: cash, amount: 60000 }] });
    expect(allowed.status).toBe(201);
    expect(await stock(detergent)).toBe(-2000);

    await o.as("patch", "/settings").send({ allowNegativeStock: false });
    const strict = await signIn(h, o.me.user.username);
    const blocked = await sell(strict, { lines: [{ productId: detergent, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 12000 }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("out_of_stock");
    expect(await stock(detergent)).toBe(-2000);
    // Stock that exists still sells, and nothing half-saves on failure.
    expect((await sell(strict, { lines: [{ productId: tea, qtyMilli: 5000 }], payments: [{ methodId: cash, amount: 72500 }] })).status).toBe(201);
    expect(await stock(tea)).toBe(0);
  });

  it("cancel puts stock back; only managers/owners; once", async () => {
    const cashier = await staff("CASHIER", "ravi");
    const r = await sell(o, { lines: protoLines(), payments: [{ methodId: cash, amount: 69500 }] });
    const id = r.body.order.id;
    expect((await cashier.as("post", `/orders/${id}/cancel`).send({ reason: "x" })).status).toBe(403);
    const c = await o.as("post", `/orders/${id}/cancel`).send({ reason: "Customer changed mind" });
    expect(c.body.order.status).toBe("CANCELLED");
    expect(await stock(tea)).toBe(5000);
    expect((await o.as("post", `/orders/${id}/cancel`).send({ reason: "again" })).status).toBe(409);
  });

  it("partial returns issue credit notes that add up to the bill", async () => {
    const r = await sell(o, { lines: protoLines(), payments: [{ methodId: upi, amount: 69500 }] });
    const order = r.body.order;
    const teaLine = order.items.find((i: { name: string }) => i.name.startsWith("Tea"));

    const ret = await o.as("post", `/orders/${order.id}/returns`).send({ counterId, items: [{ orderItemId: teaLine.id, qtyMilli: 1000 }], refundMethodId: cash, reason: "Damaged pack" });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const cn = ret.body.order.creditNotes[0];
    expect(cn).toMatchObject({ number: "CN-B1-C1-00001", total: 14500, refundMethodName: "Cash" });
    expect(cn.taxableTotal + cn.cgstTotal + cn.sgstTotal + cn.igstTotal).toBe(cn.total);
    expect(ret.body.order.returnedTotal).toBe(14500);
    expect(await stock(tea)).toBe(4000);

    const tooMany = await o.as("post", `/orders/${order.id}/returns`).send({ counterId, items: [{ orderItemId: teaLine.id, qtyMilli: 2000 }], refundMethodId: cash, reason: "x" });
    expect(tooMany.body.error.code).toBe("too_many");

    const rest = await o.as("post", `/orders/${order.id}/returns`).send({ counterId, items: order.items.map((i: { id: string; qtyMilli: number; returnedQtyMilli: number; name: string }) => ({ orderItemId: i.id, qtyMilli: i.name.startsWith("Tea") ? 1000 : i.qtyMilli })), refundMethodId: upi, reason: "All back" });
    expect(rest.body.order.creditNotes[1].number).toBe("CN-B1-C1-00002");
    expect(rest.body.order.returnedTotal).toBe(order.total);
    const cns = rest.body.order.creditNotes as { cgstTotal: number; sgstTotal: number }[];
    expect(cns.reduce((s, c) => s + c.cgstTotal + c.sgstTotal, 0)).toBe(order.cgstTotal + order.sgstTotal);

    expect((await o.as("post", `/orders/${order.id}/cancel`).send({ reason: "x" })).body.error.code).toBe("has_returns");
  });

  it("cashiers see only their own bills from today", async () => {
    const cashier = await staff("CASHIER", "ravi");
    await sell(o, { lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14500 }] });
    const mine = await sell(cashier, { lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14500 }] });
    const list = await cashier.as("get", "/orders");
    expect(list.body.orders.map((x: { id: string }) => x.id)).toEqual([mine.body.order.id]);
    expect((await o.as("get", "/orders")).body.orders).toHaveLength(2);

    h.advanceDays(1);
    const tomorrow = await signIn(h, "ravi", "staff-pass-1");
    expect((await tomorrow.as("get", "/orders")).body.orders).toHaveLength(0);
    expect((await tomorrow.as("get", `/orders/${mine.body.order.id}`)).status).toBe(200);
  });

  it("held bills: park and recall", async () => {
    const held = await o.as("post", "/held-carts").send({ branchId, label: "Table by door", payload: { lines: [{ productId: tea, qtyMilli: 2000 }] } });
    expect(held.status).toBe(201);
    const list = await o.as("get", `/held-carts?branchId=${branchId}`);
    expect(list.body.carts[0]).toMatchObject({ label: "Table by door" });
    expect((await o.as("delete", `/held-carts/${held.body.cart.id}`)).status).toBe(204);
  });

  it("stock adjustments are logged", async () => {
    await o.as("post", `/products/${tea}/stock`).send({ branchId, type: "ADD", qtyMilli: 10_000, note: "Supplier delivery" });
    await o.as("post", `/products/${tea}/stock`).send({ branchId, type: "SET", qtyMilli: 12_000, note: "Stock count" });
    expect(await stock(tea)).toBe(12_000);
    const hist = await o.as("get", `/products/${tea}/stock-history?branchId=${branchId}`);
    expect(hist.body.history.map((x: { type: string }) => x.type)).toEqual(["SET", "ADD", "OPENING"]);
  });

  it("another account can't see or touch these bills", async () => {
    const r = await sell(o, { lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14500 }] });
    const other = await signIn(h, (await signUpOwner(h)).username);
    expect((await other.as("get", `/orders/${r.body.order.id}`)).status).toBe(404);
    expect((await other.as("post", `/orders/${r.body.order.id}/cancel`).send({ reason: "x" })).status).toBe(404);
    const theirs = await other.as("post", "/orders").send({ id: randomUUID(), branchId: other.me.branches[0].id, counterId, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14500 }] });
    expect(theirs.status).toBe(400);
  });
});
