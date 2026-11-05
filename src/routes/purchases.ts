// Purchase Register: supplier bills that add stock (as batches when batch
// tracking is on), set cost prices and record input GST. Returns to the
// supplier as a credit note (reduces what's owed) or a replacement.
import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import type { Account, Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db/types.js";
import { AppError } from "../http/errors.js";
import { computePurchase } from "../lib/books.js";
import { placeOfSupply, returnAmounts } from "../lib/gst.js";
import { audit } from "../services/audit.js";
import { requireTool } from "../services/books.js";
import { fromDay, reconcileBatches, toDay } from "../services/batches.js";
import { PurchaseBody, PurchaseCancelBody, PurchaseReturnBody, ReplacementBody } from "../schemas4.js";
import { branchFor } from "./access.js";
import { moneyMethod } from "./books.js";
import { moveStock } from "./catalogue.js";

export const purchaseInclude = { items: true, returns: { include: { items: true }, orderBy: { occurredAt: "asc" } }, supplier: { select: { name: true } } } satisfies Prisma.PurchaseInclude;
type FullPurchase = Prisma.PurchaseGetPayload<{ include: typeof purchaseInclude }>;

const creditNoteTotal = (p: FullPurchase) => p.returns.filter((r) => r.mode === "CREDIT_NOTE").reduce((s, r) => s + r.total, 0);

const purchaseSummary = (p: Omit<FullPurchase, "items" | "returns"> & { returns: { mode: string; total: number }[] }) => ({
  id: p.id,
  branchId: p.branchId,
  supplierId: p.supplierId,
  supplierName: p.supplier.name,
  billNumber: p.billNumber,
  billDate: toDay(p.billDate)!,
  dueDate: toDay(p.dueDate),
  interState: p.interState,
  taxableTotal: p.taxableTotal,
  cgstTotal: p.cgstTotal,
  sgstTotal: p.sgstTotal,
  igstTotal: p.igstTotal,
  total: p.total,
  paidAmount: p.paidAmount,
  paidMethodName: p.paidMethodName,
  returnedTotal: p.returns.filter((r) => r.mode === "CREDIT_NOTE").reduce((s, r) => s + r.total, 0),
  notes: p.notes,
  stockApplied: p.stockApplied,
  imported: Boolean(p.importedFrom),
  cancelledAt: p.cancelledAt?.toISOString() ?? null,
  cancelReason: p.cancelReason,
  createdAt: p.createdAt.toISOString(),
});

export const purchaseDto = (p: FullPurchase) => ({
  ...purchaseSummary(p),
  returnedTotal: creditNoteTotal(p),
  items: p.items.map((i) => ({
    id: i.id,
    productId: i.productId,
    name: i.name,
    hsn: i.hsn,
    unit: i.unit,
    qtyMilli: i.qtyMilli,
    unitCost: i.unitCost,
    gstRateBp: i.gstRateBp,
    taxable: i.taxable,
    cgst: i.cgst,
    sgst: i.sgst,
    igst: i.igst,
    total: i.total,
    batchNo: i.batchNo,
    expiry: toDay(i.expiry),
    returnedQtyMilli: i.returnedQtyMilli,
  })),
  returns: p.returns.map((r) => ({
    id: r.id,
    mode: r.mode,
    status: r.status,
    occurredAt: r.occurredAt.toISOString(),
    receivedAt: r.receivedAt?.toISOString() ?? null,
    note: r.note,
    taxableTotal: r.taxableTotal,
    cgstTotal: r.cgstTotal,
    sgstTotal: r.sgstTotal,
    igstTotal: r.igstTotal,
    total: r.total,
    items: r.items.map((x) => ({ id: x.id, purchaseItemId: x.purchaseItemId, name: x.name, qtyMilli: x.qtyMilli, taxable: x.taxable, cgst: x.cgst, sgst: x.sgst, igst: x.igst, total: x.total })),
  })),
});

/**
 * What a unit costs the shop. A GST-registered shop claims the input GST back,
 * so its cost is before GST; otherwise the GST paid is part of the cost.
 */
export const effectiveCost = (account: Pick<Account, "taxEnabled">, unitCost: number, gstRateBp: number) => (account.taxEnabled ? unitCost : Math.round((unitCost * (10_000 + gstRateBp)) / 10_000));

/** Take stock out, from `batchId` first when given, keeping batches equal to stock. */
async function takeOut(tx: Db, a: { accountId: string; branchId: string; productId: string; qtyMilli: number; batchId: string | null; batchTracking: boolean; type: "PURCHASE_RETURN" | "PURCHASE_CANCEL"; refId: string; note: string; userId: string; now: Date }) {
  const stock = await moveStock(tx, { at: a.now, accountId: a.accountId, branchId: a.branchId, productId: a.productId, change: -a.qtyMilli, type: a.type, refId: a.refId, note: a.note, userId: a.userId });
  if (!a.batchTracking) return;
  if (a.batchId) {
    const b = await tx.batch.findUnique({ where: { id: a.batchId } });
    const q = Math.min(Math.max(0, b?.qtyMilli ?? 0), a.qtyMilli);
    if (q > 0) await tx.batch.update({ where: { id: a.batchId }, data: { qtyMilli: { decrement: q } } });
  }
  await reconcileBatches(tx, { accountId: a.accountId, branchId: a.branchId, productId: a.productId, stockMilli: stock, now: a.now });
}

export function purchasesRouter(ctx: Ctx): Router {
  const router = Router();
  const gate = [authenticate(ctx), requireActivePlan, requireRole("OWNER", "MANAGER"), requireTool("purchase-register")];
  router.use(["/purchases", "/purchase-returns"], ...gate);

  async function find(a: AuthContext, id: unknown): Promise<FullPurchase> {
    const p = await ctx.prisma.purchase.findFirst({ where: { id: String(id), accountId: a.account.id }, include: purchaseInclude });
    if (!p) throw new AppError(404, "not_found", "Supplier bill not found.");
    branchFor(a, p.branchId);
    return p;
  }

  router.get("/purchases", async (req, res) => {
    const a = auth(req);
    const branchIds = typeof req.query.branchId === "string" && req.query.branchId ? [branchFor(a, req.query.branchId).id] : a.branches.map((b) => b.id);
    const ok = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const where: Prisma.PurchaseWhereInput = {
      accountId: a.account.id,
      branchId: { in: branchIds },
      ...(typeof req.query.supplierId === "string" && req.query.supplierId ? { supplierId: req.query.supplierId } : {}),
      ...(ok(req.query.from) || ok(req.query.to) ? { billDate: { ...(ok(req.query.from) ? { gte: fromDay(String(req.query.from)) } : {}), ...(ok(req.query.to) ? { lte: fromDay(String(req.query.to)) } : {}) } } : {}),
      ...(typeof req.query.q === "string" && req.query.q.trim() ? { OR: [{ billNumber: { contains: req.query.q.trim(), mode: "insensitive" } }, { supplier: { name: { contains: req.query.q.trim(), mode: "insensitive" } } }] } : {}),
    };
    const rows = await ctx.prisma.purchase.findMany({
      where,
      include: { supplier: { select: { name: true } }, returns: { select: { mode: true, total: true } }, _count: { select: { items: true } } },
      orderBy: [{ billDate: "desc" }, { createdAt: "desc" }],
      take: 500,
    });
    const live = rows.filter((r) => !r.cancelledAt);
    res.json({
      totals: { bills: live.length, total: live.reduce((s, r) => s + r.total, 0), inputGst: live.reduce((s, r) => s + r.cgstTotal + r.sgstTotal + r.igstTotal, 0) },
      purchases: rows.map((r) => ({ ...purchaseSummary(r), itemCount: r._count.items })),
    });
  });

  router.get("/purchases/:id", async (req, res) => {
    res.json({ purchase: purchaseDto(await find(auth(req), req.params.id)) });
  });

  router.post("/purchases", async (req, res) => {
    const a = auth(req);
    const { account } = a;
    const body = PurchaseBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const replay = await ctx.prisma.purchase.findUnique({ where: { id: body.id }, include: purchaseInclude });
    if (replay) {
      if (replay.accountId !== account.id) throw new AppError(409, "id_taken", "That id is already used.");
      return res.status(200).json({ purchase: purchaseDto(replay), replayed: true });
    }
    const supplier = await ctx.prisma.supplier.findFirst({ where: { id: body.supplierId, accountId: account.id, archivedAt: null } });
    if (!supplier) throw new AppError(400, "unknown_supplier", "Pick a supplier from the Supplier Book.");
    const dup = await ctx.prisma.purchase.findFirst({ where: { accountId: account.id, supplierId: supplier.id, billNumber: { equals: body.billNumber, mode: "insensitive" }, cancelledAt: null } });
    if (dup) throw new AppError(409, "duplicate_bill", `Bill ${body.billNumber} from ${supplier.name} is already entered.`);
    if (body.dueDate && body.dueDate < body.billDate) throw new AppError(400, "bad_due_date", "The due date can't be before the bill date.");

    const ids = [...new Set(body.lines.map((l) => l.productId).filter((x): x is string => Boolean(x)))];
    const products = await ctx.prisma.product.findMany({ where: { id: { in: ids }, accountId: account.id, archivedAt: null } });
    const byId = new Map(products.map((p) => [p.id, p]));
    if (ids.some((id) => !byId.has(id))) throw new AppError(400, "unknown_product", "Some items are no longer in the catalogue.");
    const lines = body.lines.map((l, i) => {
      const p = l.productId ? byId.get(l.productId) : undefined;
      const name = l.name || p?.name;
      if (!name) throw new AppError(400, "validation_error", `Line ${i + 1}: pick a product or type what it is.`);
      return { ...l, product: p, name, hsn: l.hsn ?? p?.hsn ?? "", unit: p?.unit ?? "pcs" };
    });

    const { interState } = placeOfSupply(branch.stateCode, supplier.stateCode);
    const bill = computePurchase(lines, interState);
    if (body.expectedTotal !== undefined && body.expectedTotal !== bill.total) throw new AppError(409, "total_mismatch", "The bill total changed. Check it and save again.", { total: bill.total });
    if (body.paidAmount > bill.total) throw new AppError(400, "overpaid", "Paid can't be more than the bill total.");
    if (body.paidAmount > 0 && !body.paidMethodId) throw new AppError(400, "bad_payment_method", "Pick how the paid part was paid.");
    const method = body.paidAmount > 0 ? await moneyMethod(ctx.prisma, account.id, body.paidMethodId!) : null;
    const now = ctx.now();

    const purchase = await ctx.prisma.$transaction(async (tx) => {
      await tx.purchase.create({
        data: {
          id: body.id,
          accountId: account.id,
          branchId: branch.id,
          supplierId: supplier.id,
          billNumber: body.billNumber,
          billDate: fromDay(body.billDate),
          dueDate: body.dueDate ? fromDay(body.dueDate) : null,
          interState,
          taxableTotal: bill.taxableTotal,
          cgstTotal: bill.cgstTotal,
          sgstTotal: bill.sgstTotal,
          igstTotal: bill.igstTotal,
          total: bill.total,
          paidAmount: body.paidAmount,
          paidMethodId: method?.id ?? null,
          paidMethodName: method?.name ?? "",
          paidKind: method?.kind ?? null,
          notes: body.notes ?? "",
          createdAt: ctx.now(),
          userId: a.user.id,
        },
      });
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        const amt = bill.lines[i]!;
        const p = l.product;
        const cost = effectiveCost(account, l.unitCost, l.gstRateBp);
        let batchId: string | null = null;
        if (p?.trackStock) {
          await moveStock(tx, { at: ctx.now(), accountId: account.id, branchId: branch.id, productId: p.id, change: l.qtyMilli, type: "PURCHASE", refId: body.id, note: `Bill ${body.billNumber} · ${supplier.name}`, userId: a.user.id });
          if (account.batchTracking) {
            const b = await tx.batch.create({
              data: { accountId: account.id, branchId: branch.id, productId: p.id, batchNo: l.batchNo ?? "", expiry: l.expiry ? fromDay(l.expiry) : null, costPrice: cost, qtyMilli: l.qtyMilli, note: `Bill ${body.billNumber}`, receivedAt: now },
            });
            batchId = b.id;
          }
        }
        if (p) await tx.product.update({ where: { id: p.id }, data: { costPrice: cost } });
        await tx.purchaseItem.create({
          data: {
            purchaseId: body.id,
            productId: p?.id ?? null,
            name: l.name,
            hsn: l.hsn,
            unit: l.unit,
            qtyMilli: l.qtyMilli,
            unitCost: l.unitCost,
            gstRateBp: l.gstRateBp,
            taxable: amt.taxable,
            cgst: amt.cgst,
            sgst: amt.sgst,
            igst: amt.igst,
            total: amt.total,
            batchId,
            batchNo: l.batchNo ?? "",
            expiry: l.expiry ? fromDay(l.expiry) : null,
          },
        });
      }
      return tx.purchase.findUniqueOrThrow({ where: { id: body.id }, include: purchaseInclude });
    });
    await audit(ctx.prisma, { accountId: account.id, userId: a.user.id, branchId: branch.id, action: "purchase.created", entityType: "purchase", entityId: purchase.id, data: { billNumber: purchase.billNumber, supplier: supplier.name, total: purchase.total, paid: purchase.paidAmount } });
    res.status(201).json({ purchase: purchaseDto(purchase) });
  });

  router.post("/purchases/:id/cancel", async (req, res) => {
    const a = auth(req);
    const p = await find(a, req.params.id);
    branchFor(a, p.branchId, true);
    const body = PurchaseCancelBody.parse(req.body);
    if (p.cancelledAt) throw new AppError(409, "already_cancelled", "This bill is already cancelled.");
    if (p.returns.length) throw new AppError(409, "has_returns", "Goods from this bill were returned. Cancel isn't possible; return the rest instead.");
    const now = ctx.now();
    const done = await ctx.prisma.$transaction(async (tx) => {
      if (p.stockApplied) {
        const tracked = await tx.product.findMany({ where: { id: { in: p.items.map((i) => i.productId).filter((x): x is string => Boolean(x)) }, trackStock: true }, select: { id: true } });
        const isTracked = new Set(tracked.map((t) => t.id));
        for (const i of p.items) {
          if (!i.productId || !isTracked.has(i.productId)) continue;
          await takeOut(tx, { accountId: a.account.id, branchId: p.branchId, productId: i.productId, qtyMilli: i.qtyMilli, batchId: i.batchId, batchTracking: a.account.batchTracking, type: "PURCHASE_CANCEL", refId: p.id, note: `Bill ${p.billNumber} cancelled`, userId: a.user.id, now });
        }
      }
      await tx.purchase.update({ where: { id: p.id }, data: { cancelledAt: now, cancelReason: body.reason } });
      return tx.purchase.findUniqueOrThrow({ where: { id: p.id }, include: purchaseInclude });
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: p.branchId, action: "purchase.cancelled", entityType: "purchase", entityId: p.id, data: { billNumber: p.billNumber, total: p.total, reason: body.reason } });
    res.json({ purchase: purchaseDto(done) });
  });

  router.post("/purchases/:id/returns", async (req, res) => {
    const a = auth(req);
    const p = await find(a, req.params.id);
    branchFor(a, p.branchId, true);
    const body = PurchaseReturnBody.parse(req.body);
    if (p.cancelledAt) throw new AppError(409, "cancelled", "This bill was cancelled.");
    if (p.returns.some((r) => r.id === body.id)) return res.status(200).json({ purchase: purchaseDto(p), replayed: true });
    const items = new Map(p.items.map((i) => [i.id, i]));
    const wanted = new Map<string, number>();
    for (const r of body.items) wanted.set(r.purchaseItemId, (wanted.get(r.purchaseItemId) ?? 0) + r.qtyMilli);
    for (const [id, q] of wanted) {
      const i = items.get(id);
      if (!i) throw new AppError(400, "unknown_item", "That item isn't on this bill.");
      if (q > i.qtyMilli - i.returnedQtyMilli) throw new AppError(400, "too_many", `Only ${(i.qtyMilli - i.returnedQtyMilli) / 1000} ${i.unit} of ${i.name} can still be returned.`);
    }
    const now = ctx.now();
    const done = await ctx.prisma.$transaction(async (tx) => {
      const tracked = new Set((await tx.product.findMany({ where: { id: { in: [...wanted.keys()].map((id) => items.get(id)!.productId).filter((x): x is string => Boolean(x)) }, trackStock: true }, select: { id: true } })).map((t) => t.id));
      const lines = [...wanted].map(([id, q]) => {
        const i = items.get(id)!;
        return { item: i, qtyMilli: q, amounts: returnAmounts(i, i.returnedQtyMilli, q) };
      });
      const sum = (k: "taxable" | "cgst" | "sgst" | "igst" | "total") => lines.reduce((s, l) => s + l.amounts[k], 0);
      await tx.purchaseReturn.create({
        data: {
          id: body.id,
          accountId: a.account.id,
          branchId: p.branchId,
          purchaseId: p.id,
          supplierId: p.supplierId,
          mode: body.mode,
          status: body.mode === "CREDIT_NOTE" ? "SETTLED" : "PENDING",
          taxableTotal: sum("taxable"),
          cgstTotal: sum("cgst"),
          sgstTotal: sum("sgst"),
          igstTotal: sum("igst"),
          total: sum("total"),
          note: body.note ?? "",
          occurredAt: now,
          userId: a.user.id,
          items: { create: lines.map((l) => ({ purchaseItemId: l.item.id, productId: l.item.productId, name: l.item.name, qtyMilli: l.qtyMilli, ...l.amounts })) },
        },
      });
      for (const l of lines) {
        await tx.purchaseItem.update({ where: { id: l.item.id }, data: { returnedQtyMilli: { increment: l.qtyMilli } } });
        if (p.stockApplied && l.item.productId && tracked.has(l.item.productId)) {
          await takeOut(tx, { accountId: a.account.id, branchId: p.branchId, productId: l.item.productId, qtyMilli: l.qtyMilli, batchId: l.item.batchId, batchTracking: a.account.batchTracking, type: "PURCHASE_RETURN", refId: body.id, note: `Returned to supplier · bill ${p.billNumber}`, userId: a.user.id, now });
        }
      }
      return tx.purchase.findUniqueOrThrow({ where: { id: p.id }, include: purchaseInclude });
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: p.branchId, action: "purchase.returned", entityType: "purchase", entityId: p.id, data: { returnId: body.id, mode: body.mode } });
    res.status(201).json({ purchase: purchaseDto(done) });
  });

  router.post("/purchase-returns/:id/receive", async (req, res) => {
    const a = auth(req);
    const body = ReplacementBody.parse(req.body ?? {});
    const r = await ctx.prisma.purchaseReturn.findFirst({ where: { id: String(req.params.id), accountId: a.account.id }, include: { items: true } });
    if (!r) throw new AppError(404, "not_found", "Return not found.");
    branchFor(a, r.branchId, true);
    if (r.mode !== "REPLACEMENT" || r.status !== "PENDING") throw new AppError(409, "not_pending", "This return isn't waiting for a replacement.");
    const p = await find(a, r.purchaseId);
    const now = ctx.now();
    const done = await ctx.prisma.$transaction(async (tx) => {
      const tracked = new Set((await tx.product.findMany({ where: { id: { in: r.items.map((i) => i.productId).filter((x): x is string => Boolean(x)) }, trackStock: true }, select: { id: true } })).map((t) => t.id));
      for (const x of r.items) {
        if (!x.productId || !tracked.has(x.productId) || !p.stockApplied) continue;
        const orig = p.items.find((i) => i.id === x.purchaseItemId);
        await moveStock(tx, { at: ctx.now(), accountId: a.account.id, branchId: r.branchId, productId: x.productId, change: x.qtyMilli, type: "REPLACEMENT", refId: r.id, note: `Replacement · bill ${p.billNumber}`, userId: a.user.id });
        if (a.account.batchTracking) {
          const expiry = body.expiry === undefined ? (orig?.expiry ?? null) : body.expiry ? fromDay(body.expiry) : null;
          await tx.batch.create({
            data: { accountId: a.account.id, branchId: r.branchId, productId: x.productId, batchNo: body.batchNo ?? orig?.batchNo ?? "", expiry, costPrice: orig ? effectiveCost(a.account, orig.unitCost, orig.gstRateBp) : null, qtyMilli: x.qtyMilli, note: `Replacement · bill ${p.billNumber}`, receivedAt: now },
          });
        }
      }
      await tx.purchaseReturn.update({ where: { id: r.id }, data: { status: "RECEIVED", receivedAt: now } });
      return tx.purchase.findUniqueOrThrow({ where: { id: p.id }, include: purchaseInclude });
    });
    res.json({ purchase: purchaseDto(done) });
  });

  return router;
}

