import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db, harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

type Agent = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!TEST_DB)("multi-branch: transfers, branch reports, audit log (Postgres)", () => {
  let h: H;
  let o: Agent;
  let b1: string;
  let b2: string;
  let b3: string;
  let tea: string;
  let syrup: string;

  beforeEach(async () => {
    await resetDb();
    h = harness();
    const owner = await signUpOwner(h, { taxNumber: "29ABCDE1234F1Z5" });
    o = await signIn(h, owner.username);
    await o.as("post", "/account/license/redeem").send({ key: h.key("gold", 365), choice: "now" });
    b1 = o.me.branches[0].id;
    b2 = (await o.as("post", "/branches").send({ name: "Indiranagar" })).body.branch.id;
    b3 = (await o.as("post", "/branches").send({ name: "Jayanagar" })).body.branch.id;
    tea = (await o.as("post", "/products").send({ name: "Tea 250 g", price: 14500, costPrice: 12000, lowStockMilli: 3000, openingStock: [{ branchId: b1, qtyMilli: 20_000 }, { branchId: b2, qtyMilli: 1_000 }] })).body.product.id;
    syrup = (await o.as("post", "/products").send({ name: "Cough syrup", price: 9000, costPrice: 6000, openingStock: [{ branchId: b1, qtyMilli: 10_000 }] })).body.product.id;
  });

  const stock = async (productId: string, branchId: string) => ((await o.as("get", `/products/${productId}`)).body.branches as { branchId: string; stockMilli: number }[]).find((b) => b.branchId === branchId)!.stockMilli;
  const send = (lines: unknown[], from = b1, to = b2) => o.as("post", "/transfers").send({ id: randomUUID(), fromBranchId: from, toBranchId: to, note: "Weekly top-up", lines });

  it("send → in transit → receive with a short line back to the sender and one written off", async () => {
    expect((await send([{ productId: tea, qtyMilli: 99_000 }])).body.error.code).toBe("not_enough_stock");
    expect((await send([{ productId: tea, qtyMilli: 1000 }], b1, b1)).body.error.code).toBe("same_branch");
    const r = await send([{ productId: tea, qtyMilli: 10_000 }, { productId: syrup, qtyMilli: 4_000 }]);
    expect(r.status).toBe(201);
    const t = r.body.transfer;
    expect(t).toMatchObject({ number: "T-00001", status: "SENT", value: 144000 });
    // Stock left B1 and isn't in B2 yet.
    expect(await stock(tea, b1)).toBe(10_000);
    expect(await stock(tea, b2)).toBe(1_000);

    const teaItem = t.items.find((i: { name: string }) => i.name === "Tea 250 g").id;
    const syrupItem = t.items.find((i: { name: string }) => i.name === "Cough syrup").id;
    expect((await o.as("post", `/transfers/${t.id}/receive`).send({ lines: [{ itemId: teaItem, receivedMilli: 8_000 }] })).body.error.code).toBe("short_needs_action");
    const got = await o.as("post", `/transfers/${t.id}/receive`).send({ note: "2 torn", lines: [{ itemId: teaItem, receivedMilli: 8_000, short: "RETURN" }, { itemId: syrupItem, receivedMilli: 3_000, short: "WRITE_OFF" }] });
    expect(got.status).toBe(200);
    expect(got.body.transfer).toMatchObject({ status: "RECEIVED", shortMilli: 3_000 });
    expect(await stock(tea, b2)).toBe(9_000);
    expect(await stock(tea, b1)).toBe(12_000); // 2 came back
    expect(await stock(syrup, b1)).toBe(6_000); // 1 written off
    expect(await stock(syrup, b2)).toBe(3_000);
    expect((await o.as("post", `/transfers/${t.id}/receive`).send({})).body.error.code).toBe("not_in_transit");
    expect((await o.as("post", `/transfers/${t.id}/cancel`).send({})).body.error.code).toBe("not_in_transit");

    const report = (await o.as("get", "/reports/transfers?from=2026-11-01&to=2026-11-04")).body;
    expect(report.totals).toMatchObject({ sent: 1, sentValue: 144000, inTransit: 0, returnedValue: 24000, writtenOffValue: 6000 });
  });

  it("cancel puts the stock back; the same batch, expiry and cost arrive at the other branch", async () => {
    const c = await send([{ productId: tea, qtyMilli: 5_000 }]);
    await o.as("post", `/transfers/${c.body.transfer.id}/cancel`).send({});
    expect(await stock(tea, b1)).toBe(20_000);

    await o.as("patch", "/settings").send({ batchTracking: true });
    await o.as("post", `/products/${syrup}/batches`).send({ branchId: b1, batchNo: "SY-01", expiry: "2027-03-31", qtyMilli: 5_000, costPrice: 6100 });
    await o.as("post", `/products/${syrup}/batches`).send({ branchId: b1, batchNo: "SY-00", expiry: "2026-12-31", qtyMilli: 2_000, costPrice: 5900 });
    // Earliest expiry first: SY-00 (2) then the opening stock without details… then SY-01.
    const t = (await send([{ productId: syrup, qtyMilli: 3_000 }])).body.transfer;
    expect(t.items[0].batches[0]).toMatchObject({ batchNo: "SY-00", expiry: "2026-12-31", costPrice: 5900, qtyMilli: 2_000 });
    await o.as("post", `/transfers/${t.id}/receive`).send({});
    const arrived = (await o.as("get", `/products/${syrup}/batches?branchId=${b2}`)).body.batches;
    expect(arrived[0]).toMatchObject({ batchNo: "SY-00", expiry: "2026-12-31", costPrice: 5900, qtyMilli: 2_000 });
    // Picked batch.
    const sy01 = (await o.as("get", `/products/${syrup}/batches?branchId=${b1}`)).body.batches.find((b: { batchNo: string }) => b.batchNo === "SY-01");
    const t2 = (await send([{ productId: syrup, qtyMilli: 1_000, batches: [{ batchId: sy01.id, qtyMilli: 1_000 }] }])).body.transfer;
    expect(t2.items[0].batches).toEqual([expect.objectContaining({ batchNo: "SY-01", expiry: "2027-03-31", qtyMilli: 1_000 })]);
  });

  it("branch comparison, stock across branches with a transfer suggestion", async () => {
    const counter = (await o.as("post", "/counters").send({ branchId: b1 })).body.counter.id;
    const cash = ((await o.as("get", "/payment-methods")).body.methods as { id: string; kind: string }[]).find((m) => m.kind === "CASH")!.id;
    await o.as("post", "/orders").send({ id: randomUUID(), branchId: b1, counterId: counter, lines: [{ productId: tea, qtyMilli: 2_000 }], payments: [{ methodId: cash, amount: 29000 }] });
    const cmp = (await o.as("get", "/reports/branches?from=2026-11-01&to=2026-11-04")).body;
    expect(cmp.branches.map((b: { code: string; bills: number; sales: number }) => [b.code, b.bills, b.sales])).toEqual([["B1", 1, 29000], ["B2", 0, 0], ["B3", 0, 0]]);
    expect(cmp.branches[0]).toMatchObject({ cost: 24000, stockValue: (18_000 * 12000 + 10_000 * 6000) / 1000 });

    const across = (await o.as("get", "/reports/stock-across?q=Tea")).body;
    expect(across.products[0].stock.map((s: { status: string }) => s.status)).toEqual(["ok", "low", "out"]);
    // B3 has none; B1 has plenty.
    expect(across.products[0].suggestion).toMatchObject({ toBranchId: b3, fromBranchId: b1 });
  });

  it("audit log: owner sees all with filters; a manager only their branches", async () => {
    await o.as("post", "/staff").send({ name: "Maya", email: "maya@example.com", username: "maya", role: "MANAGER", branchIds: [b2] });
    await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink("maya@example.com")), password: "staff-pass-1" });
    await request(h.app).post("/auth/login").send({ login: "maya", password: "wrong" });
    const maya = await signIn(h, "maya", "staff-pass-1");
    await o.as("patch", `/products/${tea}`).send({ price: 15000, name: "Tea 250g" });
    await o.as("post", `/products/${tea}/stock`).send({ branchId: b1, type: "REDUCE", qtyMilli: 1000, note: "Damaged" });
    await maya.as("post", `/products/${tea}/stock`).send({ branchId: b2, type: "ADD", qtyMilli: 2000 });
    // A manager can't send from a branch that isn't theirs.
    expect((await maya.as("post", "/transfers").send({ id: randomUUID(), fromBranchId: b1, toBranchId: b2, lines: [{ productId: tea, qtyMilli: 1000 }] })).status).toBe(404);

    const all = (await o.as("get", "/audit-log")).body.entries as { action: string; userName: string; branchCode: string | null; data: Record<string, unknown>; ip: string | null }[];
    const actions = all.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.signed_in", "auth.sign_in_failed", "product.price_changed", "product.updated", "product.stock_adjusted", "staff.invited", "license.redeemed"]));
    expect(all.find((e) => e.action === "product.updated")!.data).toMatchObject({ changes: { name: ["Tea 250 g", "Tea 250g"] } });
    expect(all.find((e) => e.action === "product.price_changed")!.data).toMatchObject({ from: 14500, to: 15000 });
    expect(all.find((e) => e.action === "auth.sign_in_failed")!.userName).toBe("Maya");

    const filtered = (await o.as("get", `/audit-log?action=product.stock&branchId=${b1}`)).body.entries;
    expect(filtered.map((e: { action: string; branchCode: string }) => [e.action, e.branchCode])).toEqual([["product.stock_adjusted", "B1"]]);

    const theirs = (await maya.as("get", "/audit-log")).body.entries as { action: string; branchCode: string | null; userName: string }[];
    expect(theirs.every((e) => e.branchCode === "B2" || e.userName === "Maya")).toBe(true);
    expect(theirs.some((e) => e.action === "product.stock_adjusted" && e.branchCode === "B2")).toBe(true);
    expect(theirs.some((e) => e.action === "license.redeemed")).toBe(false);
    expect((await maya.as("get", `/audit-log?branchId=${b1}`)).status).toBe(404);

    // Paging and 2-year retention.
    const page = (await o.as("get", "/audit-log?limit=2")).body;
    expect(page.entries).toHaveLength(2);
    const next = (await o.as("get", `/audit-log?limit=2&before=${encodeURIComponent(page.next)}`)).body.entries;
    expect(next[0].createdAt <= page.entries[1].createdAt).toBe(true);
    await db().auditLog.create({ data: { accountId: o.me.account.id, action: "old.entry", entityType: "x", createdAt: new Date("2024-01-01T00:00:00Z") } });
    await o.as("get", "/audit-log");
    expect(await db().auditLog.count({ where: { action: "old.entry" } })).toBe(0);
  });
});
