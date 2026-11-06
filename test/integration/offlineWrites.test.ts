import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db, harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

describe.skipIf(!TEST_DB)("changes made offline (Postgres)", () => {
  let h: H;
  let o: Awaited<ReturnType<typeof signIn>>;
  let branchId: string;

  beforeEach(async () => {
    await resetDb();
    h = harness();
    o = await signIn(h, (await signUpOwner(h)).username);
    branchId = o.me.branches[0].id;
  });

  const key = () => randomUUID().replace(/-/g, "");

  it("Idempotency-Key: the same change sent twice is applied once, with the same answer", async () => {
    const k = key();
    const id = randomUUID();
    const first = await o.as("post", "/customers").set("Idempotency-Key", k).send({ id, name: "Meera", phone: "9000011111" });
    expect(first.status).toBe(201);
    expect(first.body.customer.id).toBe(id);
    const again = await o.as("post", "/customers").set("Idempotency-Key", k).send({ id, name: "Meera", phone: "9000011111" });
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(await db().customer.count()).toBe(1);
    // A rejected change is remembered too.
    const bad = key();
    expect((await o.as("post", "/customers").set("Idempotency-Key", bad).send({ name: "" })).status).toBe(400);
    expect((await o.as("post", "/customers").set("Idempotency-Key", bad).send({ name: "" })).status).toBe(400);
    // Someone else can't reuse the key.
    const other = await signIn(h, (await signUpOwner(h)).username);
    expect((await other.as("post", "/customers").set("Idempotency-Key", k).send({ name: "X" })).body.error.code).toBe("idempotency_key_reused");
    expect((await o.as("post", "/customers").set("Idempotency-Key", "short").send({ name: "X" })).status).toBe(400);
  });

  it("edits to different fields merge; the same field changed on two devices goes to review", async () => {
    const p = (await o.as("post", "/products").send({ name: "Tea", price: 10000, gstRateBp: 500 })).body.product;
    // Device B (synced first) changes the price; device A, offline from the same starting point, changes the name and the price.
    const b = await o.as("patch", `/products/${p.id}`).send({ price: 12000, _base: { price: 10000 } });
    expect(b.body.conflicts).toBe(0);
    const a = await o.as("patch", `/products/${p.id}`).send({ name: "Tea 250 g", price: 11000, _base: { name: "Tea", price: 10000 }, _changedAt: "2026-11-04T09:00:00.000Z" });
    expect(a.body).toMatchObject({ conflicts: 1, product: { name: "Tea 250 g", price: 12000 } });
    // Same value on both: nothing to review.
    const c = await o.as("patch", `/products/${p.id}`).send({ price: 12000, _base: { price: 10000 } });
    expect(c.body.conflicts).toBe(0);

    const list = await o.as("get", "/conflicts");
    expect(list.body.conflicts).toEqual([expect.objectContaining({ kind: "field", entityType: "product", field: "price", label: "Tea", baseValue: 10000, cloudValue: 12000, deviceValue: 11000, changedAt: "2026-11-04T09:00:00.000Z" })]);
    expect((await o.as("get", "/conflicts/count")).body.open).toBe(1);

    const r = await o.as("post", `/conflicts/${list.body.conflicts[0].id}/resolve`).send({ choice: "device" });
    expect(r.body.conflict).toMatchObject({ status: "RESOLVED", resolution: "device" });
    expect((await o.as("get", `/products/${p.id}`)).body.product.price).toBe(11000);
    expect((await o.as("post", `/conflicts/${list.body.conflicts[0].id}/resolve`).send({ choice: "cloud" })).body.error.code).toBe("already_resolved");
    // Without _base (older clients) the edit applies as before.
    expect((await o.as("patch", `/products/${p.id}`).send({ price: 9000 })).body.product.price).toBe(9000);
  });

  it("branch prices clash the same way", async () => {
    const p = (await o.as("post", "/products").send({ name: "Atta", price: 5000 })).body.product;
    await o.as("put", `/products/${p.id}/branches/${branchId}`).send({ price: 5200, _base: { price: null } });
    const late = await o.as("put", `/products/${p.id}/branches/${branchId}`).send({ price: 5100, _base: { price: null } });
    expect(late.body.conflicts).toBe(1);
    const [c] = (await o.as("get", "/conflicts")).body.conflicts;
    expect(c).toMatchObject({ entityType: "branch_price", relatedId: branchId, cloudValue: 5200, deviceValue: 5100 });
    await o.as("post", `/conflicts/${c.id}/resolve`).send({ choice: "device" });
    expect((await db().branchProduct.findFirstOrThrow({ where: { productId: p.id } })).price).toBe(5100);
  });

  it("an edit to something removed meanwhile waits for the owner: restore or discard", async () => {
    const p = (await o.as("post", "/products").send({ name: "Soap", price: 3000 })).body.product;
    await o.as("delete", `/products/${p.id}`);
    const r = await o.as("patch", `/products/${p.id}`).send({ price: 3500, _base: { price: 3000 } });
    expect(r.body.conflicts).toBe(1);
    const [c] = (await o.as("get", "/conflicts")).body.conflicts;
    expect(c).toMatchObject({ kind: "removed", deviceValue: { price: 3500 } });
    expect((await o.as("post", `/conflicts/${c.id}/resolve`).send({ choice: "device" })).body.error.code).toBe("bad_choice");
    await o.as("post", `/conflicts/${c.id}/resolve`).send({ choice: "restore" });
    expect(await db().product.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ archivedAt: null, price: 3500 });
  });

  it("two new customers with the same phone: merge moves bills and udhaar to the older one", async () => {
    const first = (await o.as("post", "/customers").send({ name: "Meera", phone: "9000011111" })).body.customer;
    const second = (await o.as("post", "/customers").send({ name: "Meera S", phone: "+91 90000 11111" })).body.customer;
    await db().customerLedgerEntry.create({ data: { id: randomUUID(), accountId: o.me.account.id, customerId: second.id, type: "CREDIT", amount: 5000, occurredAt: new Date(), methodName: "", note: "x" } });
    const [c] = (await o.as("get", "/conflicts")).body.conflicts;
    expect(c).toMatchObject({ kind: "duplicate_customer", entityId: second.id, relatedId: first.id, label: "Meera S and Meera (9000011111)" });
    await o.as("post", `/conflicts/${c.id}/resolve`).send({ choice: "merge" });
    expect(await db().customerLedgerEntry.count({ where: { customerId: first.id } })).toBe(1);
    expect((await db().customer.findUniqueOrThrow({ where: { id: second.id } })).archivedAt).not.toBeNull();
    // A different phone is no duplicate.
    await o.as("post", "/customers").send({ name: "Ravi", phone: "9000022222" });
    expect((await o.as("get", "/conflicts/count")).body.open).toBe(0);
  });

  it("only the owner opens and resolves the review list; staff see the count", async () => {
    await o.as("post", "/staff").send({ name: "Ravi", email: "ravi@example.com", username: "ravi", role: "CASHIER", branchIds: [branchId] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink("ravi@example.com")), password: "staff-pass-1" });
    const ravi = await signIn(h, "ravi", "staff-pass-1");
    expect((await ravi.as("get", "/conflicts")).status).toBe(403);
    expect((await ravi.as("get", "/conflicts/count")).body).toEqual({ open: 0 });
    expect((await ravi.as("post", `/conflicts/${randomUUID()}/resolve`).send({ choice: "cloud" })).status).toBe(403);
  });
});
