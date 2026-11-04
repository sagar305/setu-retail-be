import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import type { Db } from "../db/types.js";
import type { BranchProduct, InventoryChange, Prisma, Product } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { changes } from "../lib/diff.js";
import { BatchBody, BatchPatchBody, BranchPriceBody, CategoryBody, ProductBody, ProductPatchBody, StockAdjustBody } from "../schemas2.js";
import { addToOpeningBatch, expiryStatus, fromDay, reconcileBatches, sortFefo, takeFromBatches, toDay } from "../services/batches.js";
import { audit } from "../services/audit.js";
import { branchFor, isStaffManager, planLimit } from "./access.js";

export const DEFAULT_LOW_STOCK_MILLI = 5000;

export function productDto(p: Product, bp: BranchProduct | undefined, showCost: boolean, nextExpiry?: string | null) {
  const lowAt = p.lowStockMilli ?? DEFAULT_LOW_STOCK_MILLI;
  const stockMilli = bp?.stockMilli ?? 0;
  return {
    id: p.id,
    name: p.name,
    categoryId: p.categoryId,
    sku: p.sku,
    barcode: p.barcode,
    hsn: p.hsn,
    gstRateBp: p.gstRateBp,
    taxInclusive: p.taxInclusive,
    unit: p.unit,
    defaultPrice: p.price,
    branchPrice: bp?.price ?? null,
    /** What the branch sells it for. */
    price: bp?.price ?? p.price,
    costPrice: showCost ? p.costPrice : undefined,
    trackStock: p.trackStock,
    stockMilli,
    lowStockMilli: p.lowStockMilli,
    stockStatus: !p.trackStock ? "untracked" : stockMilli <= 0 ? "out" : stockMilli <= lowAt ? "low" : "ok",
    archived: p.archivedAt !== null,
    nextExpiry: nextExpiry ?? null,
  } as const;
}

/** Change a branch's stock and log why. Returns the new stock (milli). */
export async function moveStock(
  db: Db,
  args: { accountId: string; branchId: string; productId: string; change: number; type: InventoryChange; note?: string; refId?: string | null; userId: string | null; set?: number },
): Promise<number> {
  const row = await db.branchProduct.upsert({
    where: { branchId_productId: { branchId: args.branchId, productId: args.productId } },
    create: { branchId: args.branchId, productId: args.productId, stockMilli: args.set ?? args.change },
    update: args.set !== undefined ? { stockMilli: args.set } : { stockMilli: { increment: args.change } },
  });
  await db.inventoryLog.create({
    data: {
      accountId: args.accountId,
      branchId: args.branchId,
      productId: args.productId,
      type: args.type,
      changeMilli: args.change,
      stockAfterMilli: row.stockMilli,
      note: args.note ?? "",
      refId: args.refId ?? null,
      userId: args.userId,
    },
  });
  return row.stockMilli;
}

async function nextExpiries(db: Db, branchId: string, productIds: string[]): Promise<Map<string, string>> {
  if (!productIds.length) return new Map();
  const rows = await db.batch.groupBy({ by: ["productId"], where: { branchId, productId: { in: productIds }, qtyMilli: { gt: 0 }, expiry: { not: null } }, _min: { expiry: true } });
  return new Map(rows.filter((r) => r._min.expiry).map((r) => [r.productId, toDay(r._min.expiry)!]));
}

/** Today in the shop's time zone, as yyyy-mm-dd. */
export function shopToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function batchDto(b: { id: string; productId: string; batchNo: string; expiry: Date | null; costPrice: number | null; qtyMilli: number; opening: boolean; receivedAt: Date }, today: string, showCost = true) {
  return {
    id: b.id,
    productId: b.productId,
    batchNo: b.batchNo,
    expiry: toDay(b.expiry),
    costPrice: showCost ? b.costPrice : null,
    qtyMilli: b.qtyMilli,
    opening: b.opening,
    receivedAt: b.receivedAt.toISOString(),
    status: expiryStatus(b.expiry, today),
  };
}

async function findProduct(ctx: Ctx, a: AuthContext, id: unknown) {
  const p = await ctx.prisma.product.findFirst({ where: { id: String(id), accountId: a.account.id } });
  if (!p) throw new AppError(404, "not_found", "Product not found.");
  return p;
}

export function catalogueRouter(ctx: Ctx): Router {
  const router = Router();
  router.use(["/categories", "/products", "/batches"], authenticate(ctx), requireActivePlan);
  const OM = requireRole("OWNER", "MANAGER");

  // ── Categories ──
  router.get("/categories", async (req, res) => {
    const rows = await ctx.prisma.category.findMany({ where: { accountId: auth(req).account.id, archivedAt: null }, orderBy: { name: "asc" } });
    res.json({ categories: rows.map((c) => ({ id: c.id, name: c.name })) });
  });
  router.post("/categories", OM, async (req, res) => {
    const { name } = CategoryBody.parse(req.body);
    const c = await ctx.prisma.category.create({ data: { accountId: auth(req).account.id, name } });
    res.status(201).json({ category: { id: c.id, name: c.name } });
  });
  router.patch("/categories/:id", OM, async (req, res) => {
    const { name } = CategoryBody.parse(req.body);
    const r = await ctx.prisma.category.updateMany({ where: { id: String(req.params.id), accountId: auth(req).account.id }, data: { name } });
    if (!r.count) throw new AppError(404, "not_found", "Category not found.");
    res.json({ category: { id: String(req.params.id), name } });
  });
  router.delete("/categories/:id", OM, async (req, res) => {
    const a = auth(req);
    const id = String(req.params.id);
    const r = await ctx.prisma.category.updateMany({ where: { id, accountId: a.account.id }, data: { archivedAt: ctx.now() } });
    if (!r.count) throw new AppError(404, "not_found", "Category not found.");
    await ctx.prisma.product.updateMany({ where: { accountId: a.account.id, categoryId: id }, data: { categoryId: null } });
    res.status(204).end();
  });

  // ── Products ──
  router.get("/products", async (req, res) => {
    const a = auth(req);
    const branch = branchFor(a, req.query.branchId);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const take = Math.min(Number(req.query.limit) || 500, 2000);
    const skip = Math.max(Number(req.query.offset) || 0, 0);
    const where: Prisma.ProductWhereInput = {
      accountId: a.account.id,
      ...(req.query.archived === "true" ? {} : { archivedAt: null }),
      ...(typeof req.query.categoryId === "string" ? { categoryId: req.query.categoryId } : {}),
      ...(q
        ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { equals: q, mode: "insensitive" } }, { barcode: q }, { hsn: { startsWith: q } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      ctx.prisma.product.findMany({ where, include: { branches: { where: { branchId: branch.id } } }, orderBy: { name: "asc" }, take, skip }),
      ctx.prisma.product.count({ where }),
    ]);
    const showCost = isStaffManager(a);
    const expiries = a.account.batchTracking ? await nextExpiries(ctx.prisma, branch.id, rows.map((r) => r.id)) : new Map<string, string>();
    res.json({ products: rows.map((p) => productDto(p, p.branches[0], showCost, expiries.get(p.id))), total });
  });

  router.get("/products/:id", async (req, res) => {
    const a = auth(req);
    const p = await findProduct(ctx, a, req.params.id);
    const rows = await ctx.prisma.branchProduct.findMany({ where: { productId: p.id, branchId: { in: a.branches.map((b) => b.id) } } });
    const showCost = isStaffManager(a);
    res.json({
      product: productDto(p, undefined, showCost),
      branches: a.branches.map((b) => {
        const bp = rows.find((r) => r.branchId === b.id);
        return { branchId: b.id, code: b.code, name: b.name, price: bp?.price ?? null, stockMilli: bp?.stockMilli ?? 0, withinPlan: b.withinPlan };
      }),
    });
  });

  router.post("/products", OM, async (req, res) => {
    const a = auth(req);
    const { openingStock, ...body } = ProductBody.parse(req.body);
    for (const o of openingStock ?? []) branchFor(a, o.branchId, true);
    if (body.categoryId && !(await ctx.prisma.category.findFirst({ where: { id: body.categoryId, accountId: a.account.id } }))) {
      throw new AppError(400, "bad_category", "Category not found.");
    }
    const max = planLimit(a, "maxProducts");
    const product = await ctx.prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: a.account.id }, data: { updatedAt: ctx.now() } }); // row lock for the limit
      if (max !== null && (await tx.product.count({ where: { accountId: a.account.id, archivedAt: null } })) >= max) {
        throw new AppError(403, "plan_limit", `Your plan allows ${max.toLocaleString("en-IN")} products. Upgrade to add more.`, { limit: "products", max });
      }
      const p = await tx.product.create({ data: { ...body, accountId: a.account.id } });
      for (const o of openingStock ?? []) {
        if (o.qtyMilli <= 0) continue;
        await moveStock(tx, { accountId: a.account.id, branchId: o.branchId, productId: p.id, change: o.qtyMilli, type: "OPENING", userId: a.user.id });
        if (a.account.batchTracking && p.trackStock) await addToOpeningBatch(tx, { accountId: a.account.id, branchId: o.branchId, productId: p.id, qtyMilli: o.qtyMilli, now: ctx.now() });
      }
      return p;
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "product.created", entityType: "product", entityId: product.id, data: { name: product.name, price: product.price, openingStock: (openingStock ?? []).filter((o) => o.qtyMilli > 0).map((o) => ({ branchId: o.branchId, qtyMilli: o.qtyMilli })) } });
    res.status(201).json({ product: productDto(product, undefined, true) });
  });

  router.patch("/products/:id", OM, async (req, res) => {
    const a = auth(req);
    const p = await findProduct(ctx, a, req.params.id);
    const body = ProductPatchBody.parse(req.body);
    const updated = await ctx.prisma.product.update({ where: { id: p.id }, data: body });
    const changed = changes(p, body);
    if ("price" in changed) {
      await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "product.price_changed", entityType: "product", entityId: p.id, data: { name: p.name, from: p.price, to: body.price! } });
      delete changed.price;
    }
    if (Object.keys(changed).length) await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "product.updated", entityType: "product", entityId: p.id, data: { name: p.name, changes: changed } as never });
    res.json({ product: productDto(updated, undefined, true) });
  });

  router.delete("/products/:id", OM, async (req, res) => {
    const a = auth(req);
    const p = await findProduct(ctx, a, req.params.id);
    await ctx.prisma.product.update({ where: { id: p.id }, data: { archivedAt: ctx.now() } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "product.archived", entityType: "product", entityId: p.id });
    res.status(204).end();
  });

  router.put("/products/:id/branches/:branchId", OM, async (req, res) => {
    const a = auth(req);
    const p = await findProduct(ctx, a, req.params.id);
    const branch = branchFor(a, req.params.branchId, true);
    const { price } = BranchPriceBody.parse(req.body);
    const bp = await ctx.prisma.branchProduct.upsert({
      where: { branchId_productId: { branchId: branch.id, productId: p.id } },
      create: { branchId: branch.id, productId: p.id, price },
      update: { price },
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "product.branch_price", entityType: "product", entityId: p.id, data: { branch: branch.code, price } });
    res.json({ product: productDto(p, bp, true) });
  });

  router.post("/products/:id/stock", OM, async (req, res) => {
    const a = auth(req);
    const p = await findProduct(ctx, a, req.params.id);
    const body = StockAdjustBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const stock = await ctx.prisma.$transaction(async (tx) => {
      const current = (await tx.branchProduct.findUnique({ where: { branchId_productId: { branchId: branch.id, productId: p.id } } }))?.stockMilli ?? 0;
      const change = body.type === "ADD" ? body.qtyMilli : body.type === "REDUCE" ? -body.qtyMilli : body.qtyMilli - current;
      const after = await moveStock(tx, {
        accountId: a.account.id,
        branchId: branch.id,
        productId: p.id,
        change,
        type: body.type,
        note: body.note,
        userId: a.user.id,
        set: body.type === "SET" ? body.qtyMilli : undefined,
      });
      if (a.account.batchTracking && p.trackStock) {
        if (body.type === "ADD") await addToOpeningBatch(tx, { accountId: a.account.id, branchId: branch.id, productId: p.id, qtyMilli: body.qtyMilli, now: ctx.now() });
        else if (body.type === "REDUCE") await takeFromBatches(tx, { branchId: branch.id, productId: p.id, qtyMilli: body.qtyMilli, fallbackCost: p.costPrice });
        else await reconcileBatches(tx, { accountId: a.account.id, branchId: branch.id, productId: p.id, stockMilli: after, now: ctx.now() });
      }
      return after;
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "product.stock_adjusted", entityType: "product", entityId: p.id, data: { name: p.name, type: body.type, qtyMilli: body.qtyMilli, stockAfterMilli: stock, note: body.note ?? "" } });
    res.json({ stockMilli: stock });
  });

  router.get("/products/:id/stock-history", OM, async (req, res) => {
    const a = auth(req);
    const p = await findProduct(ctx, a, req.params.id);
    const branch = branchFor(a, req.query.branchId);
    const logs = await ctx.prisma.inventoryLog.findMany({ where: { productId: p.id, branchId: branch.id }, orderBy: { createdAt: "desc" }, take: 200 });
    res.json({
      history: logs.map((l) => ({ id: l.id, type: l.type, changeMilli: l.changeMilli, stockAfterMilli: l.stockAfterMilli, note: l.note, refId: l.refId, createdAt: l.createdAt.toISOString() })),
    });
  });

  // ── Batches ──
  router.get("/products/:id/batches", async (req, res) => {
    const a = auth(req);
    const p = await findProduct(ctx, a, req.params.id);
    const branch = branchFor(a, req.query.branchId);
    const rows = await ctx.prisma.batch.findMany({ where: { branchId: branch.id, productId: p.id, qtyMilli: { gt: 0 } } });
    const today = shopToday(ctx.now(), a.account.timezone);
    res.json({ batches: sortFefo(rows).map((b) => batchDto(b, today, isStaffManager(a))) });
  });

  router.post("/products/:id/batches", OM, async (req, res) => {
    const a = auth(req);
    if (!a.account.batchTracking) throw new AppError(400, "batches_off", "Turn on batch & expiry tracking in Settings first.");
    const p = await findProduct(ctx, a, req.params.id);
    if (!p.trackStock) throw new AppError(400, "not_tracked", "Stock isn't tracked for this product.");
    const body = BatchBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const batch = await ctx.prisma.$transaction(async (tx) => {
      await moveStock(tx, { accountId: a.account.id, branchId: branch.id, productId: p.id, change: body.qtyMilli, type: "ADD", note: body.note || `Batch ${body.batchNo || "—"}`, userId: a.user.id });
      return tx.batch.create({
        data: {
          accountId: a.account.id,
          branchId: branch.id,
          productId: p.id,
          batchNo: body.batchNo ?? "",
          expiry: body.expiry ? fromDay(body.expiry) : null,
          costPrice: body.costPrice ?? null,
          qtyMilli: body.qtyMilli,
          note: body.note ?? "",
          receivedAt: ctx.now(),
        },
      });
    });
    res.status(201).json({ batch: batchDto(batch, shopToday(ctx.now(), a.account.timezone)) });
  });

  router.patch("/batches/:id", OM, async (req, res) => {
    const a = auth(req);
    const body = BatchPatchBody.parse(req.body);
    const found = await ctx.prisma.batch.findFirst({ where: { id: String(req.params.id), accountId: a.account.id } });
    if (!found) throw new AppError(404, "not_found", "Batch not found.");
    branchFor(a, found.branchId, true);
    const b = await ctx.prisma.batch.update({
      where: { id: found.id },
      data: { batchNo: body.batchNo, costPrice: body.costPrice, expiry: body.expiry === undefined ? undefined : body.expiry ? fromDay(body.expiry) : null },
    });
    res.json({ batch: batchDto(b, shopToday(ctx.now(), a.account.timezone)) });
  });

  router.get("/batches/expiring", OM, async (req, res) => {
    const a = auth(req);
    const branchIds = typeof req.query.branchId === "string" ? [branchFor(a, req.query.branchId).id] : a.branches.map((b) => b.id);
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
    const today = shopToday(ctx.now(), a.account.timezone);
    const until = new Date(fromDay(today).getTime() + days * 86_400_000);
    const rows = await ctx.prisma.batch.findMany({
      where: { accountId: a.account.id, branchId: { in: branchIds }, qtyMilli: { gt: 0 }, expiry: { not: null, lte: until } },
      orderBy: { expiry: "asc" },
      take: 1000,
    });
    const products = new Map((await ctx.prisma.product.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.productId))] } }, select: { id: true, name: true, unit: true } })).map((p) => [p.id, p]));
    res.json({
      batches: rows.map((b) => ({ ...batchDto(b, today), branchId: b.branchId, productName: products.get(b.productId)?.name ?? "", unit: products.get(b.productId)?.unit ?? "" })),
    });
  });

  return router;
}
