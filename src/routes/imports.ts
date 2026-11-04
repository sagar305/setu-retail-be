// Bring data in: products/customers from CSV (parsed in the browser, sent as
// rows) and the free Browser POS backup (POS_BACKUP.json).
//
// Re-running an import updates instead of duplicating: products match on SKU,
// then barcode, then name; customers on mobile, then name.
import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import type { Db } from "../db/types.js";
import type { Branch, Product } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { GSTIN_PATTERN, normalizePhone, normalizeTaxNumber } from "../lib/normalize.js";
import { audit } from "../services/audit.js";
import { addToOpeningBatch, fromDay, reconcileBatches } from "../services/batches.js";
import { branchFor, planLimit } from "./access.js";
import { moveStock } from "./catalogue.js";
import { importFreePosBooks } from "../services/freePosBooks.js";

const MAX_ROWS = 5000;
const Paise = z.number().int().min(0).max(1_000_000_000);

export const ProductRow = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(120).optional(),
  sku: z.string().trim().max(60).optional(),
  barcode: z.string().trim().max(60).optional(),
  hsn: z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})?$/, "HSN is 4, 6 or 8 digits.").optional(),
  gstRateBp: z.number().int().min(0).max(10_000).optional(),
  taxInclusive: z.boolean().optional(),
  unit: z.string().trim().max(20).optional(),
  price: Paise,
  costPrice: Paise.nullable().optional(),
  trackStock: z.boolean().optional(),
  lowStockMilli: z.number().int().min(0).nullable().optional(),
  /** Sets this branch's stock to this number when given. */
  stockMilli: z.number().int().optional(),
});
export const CustomerRow = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().max(200).optional(),
  gstin: z.string().trim().max(15).optional(),
  stateCode: z.string().trim().max(2).optional(),
  address: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(500).optional(),
});
export const ProductImportBody = z.object({ branchId: z.uuid(), rows: z.array(z.unknown()).min(1).max(MAX_ROWS) });
export const CustomerImportBody = z.object({ rows: z.array(z.unknown()).min(1).max(MAX_ROWS) });
export const FreePosImportBody = z.object({ branchId: z.uuid(), backup: z.object({ app: z.string(), version: z.number(), data: z.record(z.string(), z.array(z.unknown())) }) });

export type ImportResult = { created: number; updated: number; errors: { row: number; message: string }[] };

type Catalogue = { products: Product[]; categories: Map<string, string> };

async function loadCatalogue(db: Db, accountId: string): Promise<Catalogue> {
  const [products, categories] = await Promise.all([
    db.product.findMany({ where: { accountId, archivedAt: null } }),
    db.category.findMany({ where: { accountId, archivedAt: null } }),
  ]);
  return { products, categories: new Map(categories.map((c) => [c.name.toLowerCase(), c.id])) };
}

function findMatch(cat: Catalogue, row: { sku?: string; barcode?: string; name: string }): Product | undefined {
  const sku = row.sku?.toLowerCase();
  return (
    (sku ? cat.products.find((p) => p.sku.toLowerCase() === sku) : undefined) ??
    (row.barcode ? cat.products.find((p) => p.barcode === row.barcode) : undefined) ??
    cat.products.find((p) => p.name.toLowerCase() === row.name.toLowerCase())
  );
}

async function upsertProducts(ctx: Ctx, a: AuthContext, branch: Branch, rows: z.infer<typeof ProductRow>[], indexes: number[], note: string): Promise<ImportResult & { idMap: Map<number, string> }> {
  const result: ImportResult & { idMap: Map<number, string> } = { created: 0, updated: 0, errors: [], idMap: new Map() };
  const max = planLimit(a, "maxProducts");
  await ctx.prisma.$transaction(
    async (tx) => {
      await tx.account.update({ where: { id: a.account.id }, data: { updatedAt: ctx.now() } });
      const cat = await loadCatalogue(tx, a.account.id);
      let count = cat.products.length;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        let categoryId: string | null | undefined;
        if (row.category) {
          categoryId = cat.categories.get(row.category.toLowerCase());
          if (!categoryId) {
            categoryId = (await tx.category.create({ data: { accountId: a.account.id, name: row.category } })).id;
            cat.categories.set(row.category.toLowerCase(), categoryId);
          }
        }
        const fields = {
          name: row.name,
          categoryId,
          sku: row.sku,
          barcode: row.barcode,
          hsn: row.hsn,
          gstRateBp: row.gstRateBp,
          taxInclusive: row.taxInclusive,
          unit: row.unit,
          price: row.price,
          costPrice: row.costPrice,
          trackStock: row.trackStock,
          lowStockMilli: row.lowStockMilli,
        };
        const existing = findMatch(cat, row);
        let product: Product;
        if (existing) {
          product = await tx.product.update({ where: { id: existing.id }, data: fields });
          cat.products[cat.products.indexOf(existing)] = product;
          result.updated += 1;
        } else {
          if (max !== null && count >= max) {
            result.errors.push({ row: indexes[i]!, message: `Plan limit of ${max.toLocaleString("en-IN")} products reached.` });
            continue;
          }
          product = await tx.product.create({ data: { ...fields, accountId: a.account.id } });
          cat.products.push(product);
          count += 1;
          result.created += 1;
        }
        result.idMap.set(indexes[i]!, product.id);
        if (row.stockMilli !== undefined && product.trackStock) {
          const current = (await tx.branchProduct.findUnique({ where: { branchId_productId: { branchId: branch.id, productId: product.id } } }))?.stockMilli ?? 0;
          if (current !== row.stockMilli) {
            await moveStock(tx, { accountId: a.account.id, branchId: branch.id, productId: product.id, change: row.stockMilli - current, type: "SET", set: row.stockMilli, note, userId: a.user.id });
          }
          if (a.account.batchTracking) await reconcileBatches(tx, { accountId: a.account.id, branchId: branch.id, productId: product.id, stockMilli: row.stockMilli, now: ctx.now() });
        }
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return result;
}

function validRows<T extends z.ZodType>(schema: T, raw: unknown[], errors: ImportResult["errors"]) {
  const rows: z.infer<T>[] = [];
  const indexes: number[] = [];
  raw.forEach((r, i) => {
    const parsed = schema.safeParse(r);
    if (parsed.success) {
      rows.push(parsed.data);
      indexes.push(i + 1);
    } else {
      errors.push({ row: i + 1, message: parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
    }
  });
  return { rows, indexes };
}

async function upsertCustomers(ctx: Ctx, a: AuthContext, raw: z.infer<typeof CustomerRow>[], indexes: number[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, errors: [] };
  const max = planLimit(a, "maxCustomers");
  await ctx.prisma.$transaction(
    async (tx) => {
      await tx.account.update({ where: { id: a.account.id }, data: { updatedAt: ctx.now() } });
      const existing = await tx.customer.findMany({ where: { accountId: a.account.id, archivedAt: null } });
      let count = existing.length;
      for (let i = 0; i < raw.length; i++) {
        const row = raw[i]!;
        const phone = row.phone ? normalizePhone(row.phone) : "";
        if (row.phone && !phone) {
          result.errors.push({ row: indexes[i]!, message: "phone: not a valid number" });
          continue;
        }
        const gstin = row.gstin ? normalizeTaxNumber(row.gstin) : null;
        if (row.gstin && (!gstin || !GSTIN_PATTERN.test(gstin))) {
          result.errors.push({ row: indexes[i]!, message: "gstin: not a valid GSTIN" });
          continue;
        }
        const data = { name: row.name, phone: phone ?? "", email: row.email ?? "", gstin, stateCode: row.stateCode || gstin?.slice(0, 2) || null, address: row.address ?? "", notes: row.notes ?? "" };
        const match = (phone ? existing.find((c) => c.phone === phone) : undefined) ?? existing.find((c) => c.name.toLowerCase() === row.name.toLowerCase() && (!c.phone || !phone));
        if (match) {
          Object.assign(match, await tx.customer.update({ where: { id: match.id }, data }));
          result.updated += 1;
        } else {
          if (max !== null && count >= max) {
            result.errors.push({ row: indexes[i]!, message: `Plan limit of ${max.toLocaleString("en-IN")} customers reached.` });
            continue;
          }
          existing.push(await tx.customer.create({ data: { ...data, accountId: a.account.id } }));
          count += 1;
          result.created += 1;
        }
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return result;
}

// ── Free Browser POS backup (Setu_main/lib/pos/types.ts) ──
const num = z.coerce.number();
const FreeProduct = z.object({
  id: z.string(),
  name: z.string().min(1),
  sellingPrice: num,
  sku: z.string().optional().default(""),
  barcode: z.string().optional().default(""),
  categoryId: z.string().optional().default(""),
  costPrice: num.nullable().optional(),
  taxRate: num.nullable().optional(),
  taxInclusive: z.boolean().optional().default(false),
  trackStock: z.boolean().optional().default(true),
  stock: num.optional().default(0),
  lowStockThreshold: num.nullable().optional(),
  unit: z.string().optional().default(""),
});
const FreeCategory = z.object({ id: z.string(), name: z.string() });
const FreeCustomer = z.object({ name: z.string(), phone: z.string().optional().default(""), email: z.string().optional().default(""), address: z.string().optional().default(""), notes: z.string().optional().default("") });
const FreeMethod = z.object({ name: z.string() });
const FreeSettings = z.object({ taxEnabled: z.boolean().optional(), defaultTaxRate: num.optional() });
const FreeBatch = z.object({ productId: z.string(), batchNo: z.string().optional().default(""), expiry: z.string().optional().default(""), costPrice: num.nullable().optional(), quantity: num, opening: z.boolean().optional() });

const rupees = (v: number) => Math.round(v * 100);
const milli = (v: number) => Math.round(v * 1000);
const parseAll = <T extends z.ZodType>(schema: T, raw: unknown[] | undefined) => (raw ?? []).map((r) => schema.safeParse(r)).filter((r) => r.success).map((r) => r.data as z.infer<T>);

export function importsRouter(ctx: Ctx): Router {
  const router = Router();
  router.use("/imports", authenticate(ctx), requireActivePlan, requireRole("OWNER", "MANAGER"));

  router.post("/imports/products", async (req, res) => {
    const a = auth(req);
    const body = ProductImportBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const errors: ImportResult["errors"] = [];
    const { rows, indexes } = validRows(ProductRow, body.rows, errors);
    const r = await upsertProducts(ctx, a, branch, rows, indexes, "CSV import");
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "import.products", entityType: "import", data: { created: r.created, updated: r.updated, errors: errors.length + r.errors.length } });
    res.json({ created: r.created, updated: r.updated, errors: [...errors, ...r.errors].sort((x, y) => x.row - y.row) });
  });

  router.post("/imports/customers", async (req, res) => {
    const a = auth(req);
    const body = CustomerImportBody.parse(req.body);
    const errors: ImportResult["errors"] = [];
    const { rows, indexes } = validRows(CustomerRow, body.rows, errors);
    const r = await upsertCustomers(ctx, a, rows, indexes);
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "import.customers", entityType: "import", data: { created: r.created, updated: r.updated } });
    res.json({ created: r.created, updated: r.updated, errors: [...errors, ...r.errors].sort((x, y) => x.row - y.row) });
  });

  router.post("/imports/free-pos", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const { branchId, backup } = FreePosImportBody.parse(req.body);
    if (backup.app !== "setu-free-pos") throw new AppError(400, "not_a_backup", "This isn't a Setu Browser POS backup (POS_BACKUP.json).");
    const branch = branchFor(a, branchId, true);
    const d = backup.data;
    const settings = parseAll(FreeSettings, d.settings)[0];
    const defaultRate = settings?.taxEnabled ? (settings.defaultTaxRate ?? 0) : 0;
    const categories = new Map(parseAll(FreeCategory, d.categories).map((c) => [c.id, c.name]));
    // Keep the backup's row numbers so skipped products are reported, not lost.
    const parsedProducts = (d.products ?? []).map((r) => FreeProduct.safeParse(r));
    const unreadable = parsedProducts.flatMap((r, i) => (r.success ? [] : [{ row: i + 1, message: "Skipped: no name or price" }]));
    const products = parsedProducts.flatMap((r) => (r.success ? [r.data] : []));
    const productRows = products.map((p) => ({
      name: p.name.slice(0, 120),
      category: p.categoryId ? categories.get(p.categoryId) : undefined,
      sku: p.sku,
      barcode: p.barcode,
      gstRateBp: Math.round((p.taxRate ?? defaultRate) * 100),
      taxInclusive: p.taxInclusive,
      unit: p.unit || "pcs",
      price: rupees(p.sellingPrice),
      costPrice: p.costPrice === null || p.costPrice === undefined ? null : rupees(p.costPrice),
      trackStock: p.trackStock,
      lowStockMilli: p.lowStockThreshold === null || p.lowStockThreshold === undefined ? null : milli(p.lowStockThreshold),
      stockMilli: p.trackStock ? milli(p.stock) : undefined,
    }));
    const valid = productRows.map((r) => ProductRow.safeParse(r));
    const okRows = valid.flatMap((v) => (v.success ? [v.data] : []));
    const okIdx = valid.flatMap((v, i) => (v.success ? [i + 1] : []));
    const productErrors = valid.flatMap((v, i) => (v.success ? [] : [{ row: i + 1, message: `${products[i]!.name}: ${v.error.issues[0]?.message ?? "invalid"}` }]));

    // Batch details: only when batch tracking is on here; otherwise stock stays one number.
    const freeBatches = a.account.batchTracking ? parseAll(FreeBatch, d.stock_batches).filter((b) => b.quantity > 0 && !b.opening) : [];
    const p = await upsertProducts(ctx, a, branch, okRows, okIdx, "Imported from free POS");
    if (freeBatches.length) {
      const freeIdToRow = new Map(products.map((fp, i) => [fp.id, i + 1]));
      await ctx.prisma.$transaction(async (tx) => {
        for (const b of freeBatches) {
          const productId = p.idMap.get(freeIdToRow.get(b.productId) ?? -1);
          if (!productId) continue;
          await tx.batch.create({
            data: { accountId: a.account.id, branchId: branch.id, productId, batchNo: b.batchNo, expiry: /^\d{4}-\d{2}-\d{2}$/.test(b.expiry) ? fromDay(b.expiry) : null, costPrice: b.costPrice === null || b.costPrice === undefined ? null : rupees(b.costPrice), qtyMilli: milli(b.quantity), receivedAt: ctx.now() },
          });
        }
        // Batches now say which units the stock is; trim the catch-all batch to match.
        for (const productId of new Set(p.idMap.values())) {
          const bp = await tx.branchProduct.findUnique({ where: { branchId_productId: { branchId: branch.id, productId } } });
          await tx.batch.deleteMany({ where: { branchId: branch.id, productId, opening: true } });
          const sum = (await tx.batch.aggregate({ where: { branchId: branch.id, productId }, _sum: { qtyMilli: true } }))._sum.qtyMilli ?? 0;
          const stock = Math.max(0, bp?.stockMilli ?? 0);
          if (stock > sum) await addToOpeningBatch(tx, { accountId: a.account.id, branchId: branch.id, productId, qtyMilli: stock - sum, now: ctx.now() });
          else if (stock < sum) await reconcileBatches(tx, { accountId: a.account.id, branchId: branch.id, productId, stockMilli: stock, now: ctx.now() });
        }
      });
    }

    const customers = parseAll(FreeCustomer, d.customers);
    const cust = customers.length ? await upsertCustomers(ctx, a, customers.map((c) => ({ ...c, name: c.name.slice(0, 120) || "Customer" })), customers.map((_, i) => i + 1)) : { created: 0, updated: 0, errors: [] };

    const methods = parseAll(FreeMethod, d.payments);
    const have = new Set((await ctx.prisma.paymentMethod.findMany({ where: { accountId: a.account.id } })).map((m) => m.name.toLowerCase()));
    let methodsAdded = 0;
    for (const m of methods) {
      if (have.has(m.name.toLowerCase())) continue;
      await ctx.prisma.paymentMethod.create({ data: { accountId: a.account.id, name: m.name.slice(0, 60), kind: "OTHER", sort: 10 + methodsAdded } });
      have.add(m.name.toLowerCase());
      methodsAdded += 1;
    }

    // Connected-tools history (suppliers, expenses, cash book, ledgers, purchases).
    const productIds = new Map(products.flatMap((fp, i) => { const pid = p.idMap.get(i + 1); return pid ? [[fp.id, pid] as const] : []; }));
    const books = await ctx.prisma.$transaction((tx) => importFreePosBooks(tx, { account: a.account, branch, userId: a.user.id, data: d, productIds }), { timeout: 120_000, maxWait: 10_000 });

    const summary = {
      books,
      products: { created: p.created, updated: p.updated, errors: [...unreadable, ...productErrors, ...p.errors] },
      customers: { created: cust.created, updated: cust.updated, errors: cust.errors },
      categories: categories.size,
      paymentMethodsAdded: methodsAdded,
      batches: freeBatches.length,
      skipped: { orders: (d.orders ?? []).length },
    };
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "import.free_pos", entityType: "import", data: { branch: branch.code, products: p.created + p.updated, customers: cust.created + cust.updated, books } });
    res.json(summary);
  });

  return router;
}
