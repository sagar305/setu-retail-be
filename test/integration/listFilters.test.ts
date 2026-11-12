import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { harness, resetDb, signIn, signUpOwner, TEST_DB, type H } from "./harness.js";

type Agent = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!TEST_DB)("list pages: paging and filters (Postgres)", () => {
  let h: H;
  let o: Agent;
  let branchId: string;
  let m: Record<"CASH" | "UPI" | "CARD", string>;

  beforeEach(async () => {
    await resetDb();
    h = harness();
    const owner = await signUpOwner(h);
    o = await signIn(h, owner.username);
    branchId = o.me.branches[0].id;
    const methods = (await o.as("get", "/payment-methods")).body.methods as { id: string; kind: "CASH" | "UPI" | "CARD" }[];
    m = Object.fromEntries(methods.map((x) => [x.kind, x.id])) as typeof m;
  });

  it("products: stock and category filters, with a total for paging", async () => {
    const dairy = (await o.as("post", "/categories").send({ name: "Dairy" })).body.category.id as string;
    const add = (name: string, qty: number, extra: Record<string, unknown> = {}) =>
      o.as("post", "/products").send({ name, price: 1000, openingStock: [{ branchId, qtyMilli: qty * 1000 }], ...extra });
    await add("Milk", 0, { categoryId: dairy });
    await add("Curd", 3, { categoryId: dairy }); // under the default alert of 5
    await add("Paneer", 8, { categoryId: dairy, lowStockMilli: 10_000 }); // under its own alert of 10
    await add("Rice", 50);
    await add("Bags", 0, { trackStock: false });

    const list = async (query: string) => (await o.as("get", `/products?branchId=${branchId}&${query}`)).body as { products: { name: string }[]; total: number };
    const names = async (query: string) => (await list(query)).products.map((p) => p.name);

    expect(await names("stock=out")).toEqual(["Milk"]);
    expect(await names("stock=low")).toEqual(["Curd", "Paneer"]);
    expect(await names("stock=ok")).toEqual(["Rice"]);
    expect(await names(`categoryId=${dairy}&stock=low`)).toEqual(["Curd", "Paneer"]);
    expect(await names("categoryId=none")).toEqual(["Bags", "Rice"]);

    const page = await list("limit=2&offset=2");
    expect(page.total).toBe(5);
    expect(page.products.map((p) => p.name)).toEqual(["Milk", "Paneer"]);
  });

  it("orders: payment method, status, date and branch filters, with a total for paging", async () => {
    const tea = (await o.as("post", "/products").send({ name: "Tea", price: 10000, openingStock: [{ branchId, qtyMilli: 100_000 }] })).body.product.id as string;
    const counterId = (await o.as("post", "/counters").send({ branchId })).body.counter.id as string;
    const sell = (methodId: string) =>
      o.as("post", "/orders").send({ id: randomUUID(), branchId, counterId, lines: [{ productId: tea, qtyMilli: 1000 }], payments: [{ methodId, amount: 10000 }] });
    for (const method of [m.CASH, m.CASH, m.UPI, m.CARD, m.UPI]) expect((await sell(method)).status).toBe(201);
    h.clock.now = new Date("2026-11-04T10:10:00Z");
    const late = await sell(m.CASH);
    await o.as("post", `/orders/${late.body.order.id}/cancel`).send({ reason: "Wrong items" });

    const list = async (query: string) => (await o.as("get", `/orders?${query}`)).body as { orders: { paymentMethods: string[]; status: string }[]; total: number };

    expect((await list("")).total).toBe(6);
    const upi = await list(`methodId=${m.UPI}`);
    expect(upi.total).toBe(2);
    expect(upi.orders.every((x) => x.paymentMethods.includes("UPI"))).toBe(true);
    expect((await list(`methodId=${m.CASH}&status=COMPLETED`)).total).toBe(2);
    expect((await list("status=CANCELLED")).total).toBe(1);
    expect((await list(`branchId=${branchId}&from=2026-11-04T00:00:00Z&to=2026-11-04T10:05:00Z`)).total).toBe(5);

    const second = await list("limit=4&offset=4");
    expect(second.total).toBe(6);
    expect(second.orders).toHaveLength(2);
  });

  it("customers: pages with a total", async () => {
    for (const name of ["Asha", "Bina", "Chitra", "Divya", "Esha"]) await o.as("post", "/customers").send({ name });
    const page = (await o.as("get", "/customers?limit=2&offset=2")).body as { customers: { name: string }[]; total: number };
    expect(page.total).toBe(5);
    expect(page.customers.map((c) => c.name)).toEqual(["Chitra", "Divya"]);
  });
});
