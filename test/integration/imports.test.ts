import { beforeEach, describe, expect, it } from "vitest";
import { db, harness, resetDb, signIn, signUpOwner, TEST_DB, type H } from "./harness.js";

// Shaped like Setu_main/lib/pos/backup.ts (POS_BACKUP.json): rupees as numbers, stock in units.
const backup = {
  app: "setu-free-pos",
  version: 1,
  exportedAt: "2026-10-01T00:00:00.000Z",
  data: {
    settings: [{ id: "main", taxEnabled: true, defaultTaxRate: 5 }],
    categories: [{ id: "c1", name: "Staples", createdAt: "" }],
    products: [
      { id: "p1", name: "Wheat Atta 5 kg", sellingPrice: 285, sku: "ATT-5", barcode: "8901", categoryId: "c1", costPrice: 248, taxRate: null, taxInclusive: true, trackStock: true, stock: 12, unit: "pcs", imageDataUrl: "", description: "" },
      { id: "p2", name: "Cough syrup", sellingPrice: 90.5, sku: "", barcode: "", categoryId: "", costPrice: null, taxRate: 12, taxInclusive: true, trackStock: true, stock: 7.5, lowStockThreshold: 2, unit: "btl" },
      { id: "p3", name: "", sellingPrice: 10 },
    ],
    customers: [{ id: "u1", name: "Meera", phone: "+91 99000 11111", email: "", address: "", notes: "" }],
    payments: [{ id: "m1", name: "Cash", isDefault: true }, { id: "m2", name: "Paytm", isDefault: false }],
    stock_batches: [
      { id: "b1", productId: "p2", batchNo: "SY-01", expiry: "2026-12-31", costPrice: 60, quantity: 5, receivedAt: "2026-01-01" },
      { id: "b2", productId: "p2", batchNo: "SY-02", expiry: "2027-06-30", costPrice: 62, quantity: 2.5, receivedAt: "2026-02-01" },
    ],
    orders: [{ id: "o1" }],
  },
};

describe.skipIf(!TEST_DB)("imports (Postgres)", () => {
  let h: H;
  beforeEach(async () => {
    await resetDb();
    h = harness();
  });

  async function owner() {
    const o = await signUpOwner(h);
    return signIn(h, o.username);
  }

  it("CSV products: create, then re-import updates by SKU and sets stock; bad rows reported", async () => {
    const o = await owner();
    const branchId = o.me.branches[0].id;
    const rows = [
      { name: "Tea 250 g", sku: "TEA-1", hsn: "0902", gstRateBp: 500, price: 14500, stockMilli: 10_000, category: "Beverages" },
      { name: "Soap", price: 4000 },
      { name: "", price: 10 },
      { name: "Bad HSN", hsn: "12", price: 100 },
    ];
    const r = (await o.as("post", "/imports/products").send({ branchId, rows })).body;
    expect(r).toMatchObject({ created: 2, updated: 0 });
    expect(r.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);

    const again = (await o.as("post", "/imports/products").send({ branchId, rows: [{ name: "Tea (new name)", sku: "tea-1", price: 15000, stockMilli: 8_000 }] })).body;
    expect(again).toMatchObject({ created: 0, updated: 1 });
    const tea = await db().product.findFirstOrThrow({ where: { sku: { equals: "tea-1", mode: "insensitive" } } });
    expect(await db().product.count()).toBe(2);
    expect(tea).toMatchObject({ name: "Tea (new name)", price: 15000 });
    expect((await db().branchProduct.findFirstOrThrow({ where: { productId: tea.id } })).stockMilli).toBe(8_000);
    expect(await db().category.count()).toBe(1);
  });

  it("CSV customers: match on mobile, validate GSTIN", async () => {
    const o = await owner();
    const r = (await o.as("post", "/imports/customers").send({ rows: [{ name: "Meera", phone: "99000 11111" }, { name: "Pune Traders", gstin: "27ABCDE1234F1Z5" }, { name: "X", gstin: "nope" }] })).body;
    expect(r).toMatchObject({ created: 2, updated: 0 });
    expect(r.errors).toEqual([{ row: 3, message: "gstin: not a valid GSTIN" }]);
    const again = (await o.as("post", "/imports/customers").send({ rows: [{ name: "Meera Rao", phone: "+91 9900011111" }] })).body;
    expect(again).toMatchObject({ created: 0, updated: 1 });
    expect((await db().customer.findFirstOrThrow({ where: { phone: "9900011111" } })).name).toBe("Meera Rao");
    expect((await db().customer.findFirstOrThrow({ where: { name: "Pune Traders" } })).stateCode).toBe("27");
  });

  it("free POS backup: products, categories, customers, payment methods and stock", async () => {
    const o = await owner();
    const branchId = o.me.branches[0].id;
    const r = (await o.as("post", "/imports/free-pos").send({ branchId, backup })).body;
    expect(r).toMatchObject({ products: { created: 2, updated: 0 }, customers: { created: 1 }, categories: 1, paymentMethodsAdded: 1, batches: 0, skipped: { orders: 1 } });
    expect(r.products.errors).toHaveLength(1);
    const atta = await db().product.findFirstOrThrow({ where: { sku: "ATT-5" } });
    expect(atta).toMatchObject({ price: 28500, costPrice: 24800, gstRateBp: 500, taxInclusive: true, barcode: "8901" });
    const syrup = await db().product.findFirstOrThrow({ where: { name: "Cough syrup" } });
    expect(syrup).toMatchObject({ price: 9050, gstRateBp: 1200, unit: "btl", lowStockMilli: 2000 });
    expect((await db().branchProduct.findFirstOrThrow({ where: { productId: syrup.id } })).stockMilli).toBe(7500);
    expect((await db().paymentMethod.findMany({ where: { name: "Paytm" } })).length).toBe(1);

    // Importing again updates instead of duplicating.
    const again = (await o.as("post", "/imports/free-pos").send({ branchId, backup })).body;
    expect(again.products).toMatchObject({ created: 0, updated: 2 });
    expect(again.paymentMethodsAdded).toBe(0);
  });

  it("free POS backup brings batches in when batch tracking is on", async () => {
    let o = await owner();
    await o.as("patch", "/settings").send({ batchTracking: true });
    o = await signIn(h, o.me.user.username);
    const branchId = o.me.branches[0].id;
    const r = (await o.as("post", "/imports/free-pos").send({ branchId, backup })).body;
    expect(r.batches).toBe(2);
    const syrup = await db().product.findFirstOrThrow({ where: { name: "Cough syrup" } });
    const batches = await db().batch.findMany({ where: { productId: syrup.id }, orderBy: { expiry: "asc" } });
    expect(batches.map((b) => [b.batchNo, b.qtyMilli, b.costPrice])).toEqual([["SY-01", 5000, 6000], ["SY-02", 2500, 6200]]);
    const atta = await db().product.findFirstOrThrow({ where: { sku: "ATT-5" } });
    expect((await db().batch.findMany({ where: { productId: atta.id } })).map((b) => [b.opening, b.qtyMilli])).toEqual([[true, 12000]]);
  });

  it("rejects files that aren't free POS backups; cashiers can't import", async () => {
    const o = await owner();
    const r = await o.as("post", "/imports/free-pos").send({ branchId: o.me.branches[0].id, backup: { ...backup, app: "something-else" } });
    expect(r.body.error.code).toBe("not_a_backup");
  });
});
