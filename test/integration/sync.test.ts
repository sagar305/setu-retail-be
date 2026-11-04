import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { checkPin } from "../../src/lib/pin.js";
import { db, harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

describe.skipIf(!TEST_DB)("offline sync (Postgres)", () => {
  let h: H;
  let o: Awaited<ReturnType<typeof signIn>>;
  let branchId: string;
  let counter: { id: string; code: string };
  let key: string;
  let cash: string;
  let tea: string;
  let cashierId: string;

  beforeEach(async () => {
    await resetDb();
    h = harness();
    const owner = await signUpOwner(h, { taxNumber: "29ABCDE1234F1Z5" });
    o = await signIn(h, owner.username);
    branchId = o.me.branches[0].id;
    const c = await o.as("post", "/counters").send({ branchId, name: "Front desk" });
    counter = c.body.counter;
    key = c.body.deviceKey;
    cash = ((await o.as("get", "/payment-methods")).body.methods as { id: string; kind: string }[]).find((m) => m.kind === "CASH")!.id;
    tea = (await o.as("post", "/products").send({ name: "Tea 250 g", hsn: "0902", gstRateBp: 500, price: 14500, costPrice: 12000, openingStock: [{ branchId, qtyMilli: 1000 }] })).body.product.id;
    await o.as("post", "/staff").send({ name: "Ravi", email: "ravi@example.com", username: "ravi", role: "CASHIER", branchIds: [branchId] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink("ravi@example.com")), password: "staff-pass-1" });
    const ravi = await signIn(h, "ravi", "staff-pass-1");
    cashierId = ravi.me.user.id;
    expect((await ravi.as("put", "/me/pin").send({ pin: "4321", password: "wrong" })).status).toBe(403);
    expect((await ravi.as("put", "/me/pin").send({ pin: "4321", password: "staff-pass-1" })).status).toBe(200);
  });

  const pack = (k = key) => request(h.app).get("/sync/pack").set("X-Device-Key", k);
  const push = (orders: unknown[]) => request(h.app).post("/sync/orders").set("X-Device-Key", key).send({ orders });
  const bill = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    cashierId,
    invoiceNumber: `B1-${counter.code}-00001`,
    createdAt: "2026-11-04T09:30:00.000Z",
    taxEnabled: true,
    discount: { type: "flat", value: 0 },
    lines: [{ productId: tea, name: "Tea 250 g", hsn: "0902", unit: "pcs", unitPrice: 14500, gstRateBp: 500, taxInclusive: true, qtyMilli: 2000 }],
    payments: [{ methodId: cash, amount: 29000 }],
    total: 29000,
    ...over,
  });

  it("the offline pack has what the counter needs, PIN verifiers but no costs", async () => {
    const r = await pack();
    expect(r.status).toBe(200);
    expect(r.body.counter).toMatchObject({ id: counter.id, code: "C1", nextInvoiceNumber: 1 });
    expect(r.body.products[0]).toMatchObject({ name: "Tea 250 g", price: 14500, stockMilli: 1000 });
    expect(r.body.products[0]).not.toHaveProperty("costPrice");
    expect(r.body.users.map((u: { username: string }) => u.username)).toEqual(["ravi"]); // the owner has no PIN yet
    expect(await checkPin("4321", { pinHash: r.body.users[0].pin.hash, pinSalt: r.body.users[0].pin.salt, pinIterations: r.body.users[0].pin.iterations })).toBe(true);
    expect((await pack(`${counter.id}.not-the-key`)).status).toBe(401);
    expect((await request(h.app).get("/sync/pack")).status).toBe(401);
  });

  it("offline bills sync as charged: number kept, stock below zero allowed, price change flagged", async () => {
    await o.as("patch", "/settings").send({ allowNegativeStock: false });
    await o.as("put", `/products/${tea}/branches/${branchId}`).send({ price: 15000 }); // changed while the counter was offline
    const b = bill();
    const r = await push([b]);
    expect(r.body.results).toEqual([{ id: b.id, status: "saved", invoiceNumber: "B1-C1-00001" }]);
    const saved = await db().order.findUniqueOrThrow({ where: { id: b.id } });
    expect(saved).toMatchObject({ offline: true, priceDiffers: true, total: 29000, cashierId, createdAt: new Date("2026-11-04T09:30:00.000Z") });
    expect((await db().branchProduct.findFirstOrThrow({ where: { productId: tea } })).stockMilli).toBe(-1000);
    expect((await db().counter.findUniqueOrThrow({ where: { id: counter.id } })).nextInvoiceNumber).toBe(2);

    // Sending it again is harmless.
    expect((await push([b])).body.results[0]).toMatchObject({ status: "duplicate", invoiceNumber: "B1-C1-00001" });
    expect(await db().order.count()).toBe(1);
  });

  it("online bills can carry the device's number too; numbers can't be reused or forged", async () => {
    const online = await o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId: counter.id, invoiceNumber: "B1-C1-00007", lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId: cash, amount: 14500 }] });
    expect(online.status, JSON.stringify(online.body)).toBe(201);
    expect(online.body.order.invoiceNumber).toBe("B1-C1-00007");
    expect((await db().counter.findUniqueOrThrow({ where: { id: counter.id } })).nextInvoiceNumber).toBe(8);

    const reused = await push([bill({ invoiceNumber: "B1-C1-00007" })]);
    expect(reused.body.results[0]).toMatchObject({ status: "rejected", message: "Bill number already used by another bill." });
    const forged = await push([bill({ invoiceNumber: "B1-C9-00001" })]);
    expect(forged.body.results[0].status).toBe("rejected");
    const wrong = await push([bill({ total: 999 })]);
    expect(wrong.body.results[0]).toMatchObject({ status: "rejected" });
    expect(wrong.body.results[0].message).toMatch(/adds up to/);
  });

  it("customers made offline sync first; a bill waiting on its customer is retried", async () => {
    const customerId = randomUUID();
    const b = bill({ customerId, invoiceNumber: "B1-C1-00002" });
    expect((await push([b])).body.results[0].status).toBe("retry");
    const c = await request(h.app).post("/sync/customers").set("X-Device-Key", key).send({ customers: [{ id: customerId, name: "Meera", phone: "+91 99000 11111" }] });
    expect(c.body.results).toEqual([{ id: customerId, status: "saved" }]);
    expect((await push([b])).body.results[0].status).toBe("saved");
    expect((await db().order.findUniqueOrThrow({ where: { id: b.id } })).customerName).toBe("Meera");
  });

  it("refuses to sync while the plan has ended, then syncs after renewal", async () => {
    h.advanceDays(93);
    const blocked = await push([bill()]);
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe("plan_expired");
    expect((await pack()).status).toBe(200); // the counter can still refresh its offline pack
    const owner = await signIn(h, o.me.user.username);
    await owner.as("post", "/account/license/redeem").send({ key: h.key("basic", 30) });
    expect((await push([bill()])).body.results[0].status).toBe("saved");
  });

  it("a new device key replaces the old one", async () => {
    const r = await o.as("post", `/counters/${counter.id}/device-key`);
    expect(r.body.deviceKey).toMatch(new RegExp(`^${counter.id}\\.`));
    expect((await pack()).status).toBe(401);
    expect((await pack(r.body.deviceKey)).status).toBe(200);
  });
});
