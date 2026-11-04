import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import { isUniqueViolation } from "../db/errors.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { toolOn } from "../services/books.js";
import { computeBill, placeOfSupply, returnAmounts, type Discount } from "../lib/gst.js";
import { startOfDay, startOfMonth } from "../lib/time.js";
import { CancelBody, HeldCartBody, OrderBody, ReturnBody } from "../schemas2.js";
import { audit } from "../services/audit.js";
import { branchFor, planLimit } from "./access.js";
import { moveStock } from "./catalogue.js";
import { restoreToBatches } from "../services/batches.js";
import { invoiceNumberFor, invoiceSeq, orderInclude, persistOrder, type FullOrder } from "../services/orderWriter.js";

const pad = (n: number) => String(n).padStart(5, "0");

export function orderDto(o: FullOrder, cashierName?: string) {
  return {
    id: o.id,
    invoiceNumber: o.invoiceNumber,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    branch: o.branch,
    counter: o.counter,
    cashierId: o.cashierId,
    cashierName: cashierName ?? null,
    customer: o.customerId ? { id: o.customerId, name: o.customerName, phone: o.customerPhone, gstin: o.customerGstin } : null,
    placeOfSupply: o.placeOfSupply,
    interState: o.interState,
    taxEnabled: o.taxEnabled,
    discount: { type: o.discountType as "flat" | "percent", value: o.discountValue },
    subtotal: o.subtotal,
    discountTotal: o.discountTotal,
    taxableTotal: o.taxableTotal,
    cgstTotal: o.cgstTotal,
    sgstTotal: o.sgstTotal,
    igstTotal: o.igstTotal,
    total: o.total,
    returnedTotal: o.returnedTotal,
    note: o.note,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    offline: o.offline,
    priceDiffers: o.priceDiffers,
    items: o.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      name: i.name,
      hsn: i.hsn,
      unit: i.unit,
      qtyMilli: i.qtyMilli,
      unitPrice: i.unitPrice,
      gstRateBp: i.gstRateBp,
      taxInclusive: i.taxInclusive,
      gross: i.gross,
      discount: i.discount,
      taxable: i.taxable,
      cgst: i.cgst,
      sgst: i.sgst,
      igst: i.igst,
      total: i.total,
      returnedQtyMilli: i.returnedQtyMilli,
      batches: i.batches.map((b) => ({ batchNo: b.batch.batchNo, expiry: b.batch.expiry ? b.batch.expiry.toISOString().slice(0, 10) : null, qtyMilli: b.qtyMilli })),
    })),
    payments: o.payments.map((p) => ({ methodId: p.methodId, methodName: p.methodName, kind: p.kind, amount: p.amount })),
    creditNotes: o.creditNotes.map((c) => ({
      id: c.id,
      number: c.number,
      reason: c.reason,
      refundMethodName: c.refundMethodName,
      taxableTotal: c.taxableTotal,
      cgstTotal: c.cgstTotal,
      sgstTotal: c.sgstTotal,
      igstTotal: c.igstTotal,
      total: c.total,
      createdAt: c.createdAt.toISOString(),
      items: c.items.map((i) => ({ orderItemId: i.orderItemId, qtyMilli: i.qtyMilli, total: i.total })),
    })),
  };
}

async function loadOrder(ctx: Ctx, a: AuthContext, id: string): Promise<FullOrder> {
  const o = await ctx.prisma.order.findFirst({ where: { id, accountId: a.account.id }, include: orderInclude });
  if (!o || !a.branches.some((b) => b.id === o.branchId)) throw new AppError(404, "not_found", "Bill not found.");
  if (a.user.role === "CASHIER" && o.cashierId !== a.user.id) throw new AppError(404, "not_found", "Bill not found.");
  return o;
}

export async function withCashier(ctx: Ctx, o: FullOrder) {
  const u = await ctx.prisma.user.findUnique({ where: { id: o.cashierId }, select: { name: true } });
  return orderDto(o, u?.name);
}

export function ordersRouter(ctx: Ctx): Router {
  const router = Router();
  router.use(["/orders", "/held-carts"], authenticate(ctx), requireActivePlan);
  const OM = requireRole("OWNER", "MANAGER");

  router.post("/orders", async (req, res) => {
    const a = auth(req);
    const body = OrderBody.parse(req.body);

    // Retried request (e.g. the network dropped after the server saved it).
    const existing = await ctx.prisma.order.findUnique({ where: { id: body.id }, include: orderInclude });
    if (existing) {
      if (existing.accountId !== a.account.id) throw new AppError(409, "id_conflict", "Bill id already used.");
      return res.status(200).json({ order: await withCashier(ctx, existing), replayed: true });
    }

    const branch = branchFor(a, body.branchId, true);
    const counter = await ctx.prisma.counter.findFirst({ where: { id: body.counterId, branchId: branch.id } });
    if (!counter) throw new AppError(400, "bad_counter", "This device isn't a counter of this branch. Reload billing.");
    const account = a.account;

    const customer = body.customerId ? await ctx.prisma.customer.findFirst({ where: { id: body.customerId, accountId: account.id } }) : null;
    if (body.customerId && !customer) throw new AppError(400, "bad_customer", "Customer not found.");

    const ids = [...new Set(body.lines.map((l) => l.productId))];
    const products = await ctx.prisma.product.findMany({
      where: { id: { in: ids }, accountId: account.id, archivedAt: null },
      include: { branches: { where: { branchId: branch.id } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new AppError(400, "unknown_product", "Some items are no longer sold. Remove them and try again.", { productIds: missing });

    const pos = placeOfSupply(account.taxEnabled ? branch.stateCode : null, account.taxEnabled ? (customer?.stateCode ?? null) : null);
    const discount: Discount = body.discount ?? { type: "flat", value: 0 };
    const lines = body.lines.map((l) => {
      const p = byId.get(l.productId)!;
      return { unitPrice: p.branches[0]?.price ?? p.price, qtyMilli: l.qtyMilli, gstRateBp: p.gstRateBp, taxInclusive: p.taxInclusive };
    });
    const bill = computeBill(lines, discount, { taxEnabled: account.taxEnabled, interState: pos.interState });

    if (a.user.role === "CASHIER" && bill.subtotal > 0 && bill.discountTotal * 10_000 > account.cashierMaxDiscountBp * bill.subtotal) {
      throw new AppError(403, "discount_too_high", `Cashiers can give up to ${account.cashierMaxDiscountBp / 100}% discount. Ask a manager.`);
    }

    const methods = await ctx.prisma.paymentMethod.findMany({ where: { accountId: account.id, id: { in: body.payments.map((p) => p.methodId) }, active: true } });
    const methodById = new Map(methods.map((m) => [m.id, m]));
    if (body.payments.some((p) => !methodById.has(p.methodId))) throw new AppError(400, "bad_payment_method", "Pick a payment method.");
    const paid = body.payments.reduce((s, p) => s + p.amount, 0);
    if (paid !== bill.total) {
      throw new AppError(400, "payment_mismatch", `Payments (${(paid / 100).toFixed(2)}) must equal the bill total (${(bill.total / 100).toFixed(2)}).`, { total: bill.total, paid });
    }
    if (body.payments.some((p) => methodById.get(p.methodId)!.kind === "CREDIT") && !toolOn(account, "customer-ledger")) {
      throw new AppError(400, "udhaar_off", "Udhaar is off: the owner can turn on Customer Ledger in Settings → Connected tools.");
    }
    if (body.payments.some((p) => methodById.get(p.methodId)!.kind === "CREDIT") && !customer) {
      throw new AppError(400, "credit_needs_customer", "Pick a saved customer to sell on credit (udhaar).");
    }

    const maxOrders = planLimit(a, "maxOrdersPerMonth");
    if (maxOrders !== null) {
      const count = await ctx.prisma.order.count({ where: { accountId: account.id, createdAt: { gte: startOfMonth(ctx.now(), account.timezone) } } });
      if (count >= maxOrders) {
        throw new AppError(403, "plan_limit", `Your plan allows ${maxOrders.toLocaleString("en-IN")} bills a month. Upgrade to keep billing.`, { limit: "orders", max: maxOrders });
      }
    }

    let order: FullOrder;
    try {
      order = await ctx.prisma.$transaction(async (tx) => {
        // The device numbers its own bills (so an offline bill keeps its number);
        // older clients leave it out and the counter's next number is used.
        let invoiceNumber: string;
        if (body.invoiceNumber) {
          const seq = invoiceSeq(body.invoiceNumber, branch.code, counter.code);
          if (seq === null) throw new AppError(400, "bad_invoice_number", `Bill numbers on this counter look like ${invoiceNumberFor(branch.code, counter.code, 1)}.`);
          invoiceNumber = body.invoiceNumber;
          await tx.counter.update({ where: { id: counter.id }, data: { lastSeenAt: ctx.now() } });
          await tx.$executeRaw`UPDATE "counters" SET "nextInvoiceNumber" = GREATEST("nextInvoiceNumber", ${seq + 1}) WHERE "id" = ${counter.id}::uuid`;
        } else {
          const c = await tx.counter.update({ where: { id: counter.id }, data: { nextInvoiceNumber: { increment: 1 }, lastSeenAt: ctx.now() } });
          invoiceNumber = invoiceNumberFor(branch.code, c.code, c.nextInvoiceNumber - 1);
        }
        return persistOrder(tx, {
          id: body.id,
          account,
          branch,
          counterId: counter.id,
          cashierId: a.user.id,
          invoiceNumber,
          customer,
          placeOfSupply: pos.placeOfSupply,
          interState: pos.interState,
          taxEnabled: account.taxEnabled,
          discount,
          bill,
          lines: body.lines.map((l) => {
            const p = byId.get(l.productId)!;
            return { productId: p.id, name: p.name, hsn: p.hsn, unit: p.unit, costPrice: p.costPrice, trackStock: p.trackStock, batchId: l.batchId };
          }),
          payments: body.payments.map((p) => {
            const m = methodById.get(p.methodId)!;
            return { methodId: m.id, methodName: m.name, kind: m.kind, amount: p.amount };
          }),
          note: body.note ?? "",
          createdAt: ctx.now(),
          blockBelowZero: !account.allowNegativeStock,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, "invoiceNumber")) throw new AppError(409, "invoice_number_used", "That bill number is already used. Reload billing.");
      if (isUniqueViolation(err, "id") || isUniqueViolation(err, "PRIMARY") || isUniqueViolation(err, "orders_pkey")) {
        const again = await ctx.prisma.order.findUnique({ where: { id: body.id }, include: orderInclude });
        if (again && again.accountId === account.id) return res.status(200).json({ order: await withCashier(ctx, again), replayed: true });
      }
      throw err;
    }
    res.status(201).json({ order: orderDto(order, a.user.name) });
  });

  router.get("/orders", async (req, res) => {
    const a = auth(req);
    const branchIds = typeof req.query.branchId === "string" ? [branchFor(a, req.query.branchId).id] : a.branches.map((b) => b.id);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const take = Math.min(Number(req.query.limit) || 50, 200);
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;
    const cashierOnly = a.user.role === "CASHIER";
    const valid = (d?: Date) => (d && !Number.isNaN(d.getTime()) ? d : undefined);
    const before = typeof req.query.before === "string" ? valid(new Date(req.query.before)) : undefined;
    // Cashiers see their own bills from today only, whatever they ask for.
    const gte = cashierOnly ? startOfDay(ctx.now(), a.account.timezone) : valid(from);
    const ends = [valid(to), before].filter((d): d is Date => Boolean(d));
    const lt = ends.length ? new Date(Math.min(...ends.map((d) => d.getTime()))) : undefined;
    const where: Prisma.OrderWhereInput = {
      accountId: a.account.id,
      branchId: { in: branchIds },
      ...(cashierOnly ? { cashierId: a.user.id } : {}),
      createdAt: { gte, lt },
      ...(req.query.status === "CANCELLED" || req.query.status === "COMPLETED" ? { status: req.query.status } : {}),
      ...(q ? { OR: [{ invoiceNumber: { contains: q.toUpperCase() } }, { customerName: { contains: q, mode: "insensitive" } }, { customerPhone: { contains: q.replace(/\D/g, "") || q } }] } : {}),
    };
    const rows = await ctx.prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, invoiceNumber: true, status: true, createdAt: true, branchId: true, customerName: true, total: true, returnedTotal: true, cashierId: true, offline: true, priceDiffers: true, payments: { select: { methodName: true } } },
    });
    res.json({
      orders: rows.map((o) => ({
        id: o.id,
        invoiceNumber: o.invoiceNumber,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
        branchId: o.branchId,
        customerName: o.customerName,
        total: o.total,
        returnedTotal: o.returnedTotal,
        cashierId: o.cashierId,
        offline: o.offline,
        priceDiffers: o.priceDiffers,
        paymentMethods: [...new Set(o.payments.map((p) => p.methodName))],
      })),
    });
  });

  router.get("/orders/:id", async (req, res) => {
    const o = await loadOrder(ctx, auth(req), String(req.params.id));
    res.json({ order: await withCashier(ctx, o) });
  });

  router.post("/orders/:id/cancel", OM, async (req, res) => {
    const a = auth(req);
    const { reason } = CancelBody.parse(req.body);
    const o = await loadOrder(ctx, a, String(req.params.id));
    branchFor(a, o.branchId, true);
    if (o.status === "CANCELLED") throw new AppError(409, "already_cancelled", "This bill is already cancelled.");
    if (o.returnedTotal > 0) throw new AppError(409, "has_returns", "Items on this bill were returned. Return the rest instead of cancelling.");

    const tracked = new Set((await ctx.prisma.product.findMany({ where: { id: { in: o.items.map((i) => i.productId!).filter(Boolean) }, trackStock: true }, select: { id: true } })).map((p) => p.id));
    const updated = await ctx.prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({ where: { id: o.id, status: "COMPLETED" }, data: { status: "CANCELLED", cancelledAt: ctx.now(), cancelledById: a.user.id, cancelReason: reason } });
      if (r.count === 0) throw new AppError(409, "already_cancelled", "This bill is already cancelled.");
      for (const i of o.items) {
        if (i.productId && tracked.has(i.productId)) {
          await moveStock(tx, { accountId: a.account.id, branchId: o.branchId, productId: i.productId, change: i.qtyMilli, type: "CANCEL", refId: o.id, userId: a.user.id, note: `Cancelled ${o.invoiceNumber}` });
          await restoreToBatches(tx, i.id, i.qtyMilli);
        }
      }
      await audit(tx, { accountId: a.account.id, userId: a.user.id, action: "order.cancelled", entityType: "order", entityId: o.id, data: { invoiceNumber: o.invoiceNumber, total: o.total, reason } });
      return tx.order.findUniqueOrThrow({ where: { id: o.id }, include: orderInclude });
    });
    res.json({ order: await withCashier(ctx, updated) });
  });

  router.post("/orders/:id/returns", OM, async (req, res) => {
    const a = auth(req);
    const body = ReturnBody.parse(req.body);
    const o = await loadOrder(ctx, a, String(req.params.id));
    const branch = branchFor(a, o.branchId, true);
    if (o.status === "CANCELLED") throw new AppError(409, "already_cancelled", "This bill is cancelled.");
    const counter = await ctx.prisma.counter.findFirst({ where: { id: body.counterId, branchId: branch.id } });
    if (!counter) throw new AppError(400, "bad_counter", "Returns are recorded at a counter of the bill's branch.");
    const method = await ctx.prisma.paymentMethod.findFirst({ where: { id: body.refundMethodId, accountId: a.account.id } });
    if (!method) throw new AppError(400, "bad_payment_method", "Pick how the money goes back.");
    if (method.kind === "CREDIT" && !o.customerId) throw new AppError(400, "credit_needs_customer", "Only a bill with a saved customer can be refunded to their credit.");

    const itemById = new Map(o.items.map((i) => [i.id, i]));
    const merged = new Map<string, number>();
    for (const r of body.items) merged.set(r.orderItemId, (merged.get(r.orderItemId) ?? 0) + r.qtyMilli);
    const lines = [...merged].map(([orderItemId, qtyMilli]) => {
      const item = itemById.get(orderItemId);
      if (!item) throw new AppError(400, "bad_item", "That item isn't on this bill.");
      if (qtyMilli > item.qtyMilli - item.returnedQtyMilli) throw new AppError(400, "too_many", `Only ${(item.qtyMilli - item.returnedQtyMilli) / 1000} of ${item.name} can still be returned.`);
      return { item, qtyMilli, amounts: returnAmounts(item, item.returnedQtyMilli, qtyMilli) };
    });
    const sum = (k: "taxable" | "cgst" | "sgst" | "igst" | "total") => lines.reduce((s, l) => s + l.amounts[k], 0);
    const tracked = new Set((await ctx.prisma.product.findMany({ where: { id: { in: lines.map((l) => l.item.productId!).filter(Boolean) }, trackStock: true }, select: { id: true } })).map((p) => p.id));

    const updated = await ctx.prisma.$transaction(async (tx) => {
      // Lock the bill so two returns can't over-return the same item.
      await tx.order.update({ where: { id: o.id }, data: { returnedTotal: { increment: sum("total") } } });
      for (const l of lines) {
        const r = await tx.orderItem.updateMany({
          where: { id: l.item.id, returnedQtyMilli: l.item.returnedQtyMilli },
          data: { returnedQtyMilli: { increment: l.qtyMilli } },
        });
        if (r.count === 0) throw new AppError(409, "changed", "This bill changed while you were working. Reload and try again.");
      }
      const c = await tx.counter.update({ where: { id: counter.id }, data: { nextCreditNoteNumber: { increment: 1 } } });
      const cn = await tx.creditNote.create({
        data: {
          accountId: a.account.id,
          orderId: o.id,
          branchId: branch.id,
          counterId: counter.id,
          userId: a.user.id,
          number: `CN-${branch.code}-${c.code}-${pad(c.nextCreditNoteNumber - 1)}`,
          reason: body.reason,
          refundMethodId: method.id,
          refundMethodName: method.name,
          refundKind: method.kind,
          taxableTotal: sum("taxable"),
          cgstTotal: sum("cgst"),
          sgstTotal: sum("sgst"),
          igstTotal: sum("igst"),
          total: sum("total"),
          createdAt: ctx.now(),
          items: { create: lines.map((l) => ({ orderItemId: l.item.id, qtyMilli: l.qtyMilli, ...l.amounts })) },
        },
      });
      for (const l of lines) {
        if (l.item.productId && tracked.has(l.item.productId)) {
          await moveStock(tx, { accountId: a.account.id, branchId: branch.id, productId: l.item.productId, change: l.qtyMilli, type: "RETURN", refId: cn.id, userId: a.user.id, note: cn.number });
          await restoreToBatches(tx, l.item.id, l.qtyMilli);
        }
      }
      await audit(tx, { accountId: a.account.id, userId: a.user.id, action: "order.returned", entityType: "order", entityId: o.id, data: { invoiceNumber: o.invoiceNumber, creditNote: cn.number, total: cn.total, reason: body.reason } });
      return tx.order.findUniqueOrThrow({ where: { id: o.id }, include: orderInclude });
    });
    res.status(201).json({ order: await withCashier(ctx, updated) });
  });

  // ── Held bills ──
  router.get("/held-carts", async (req, res) => {
    const a = auth(req);
    const branch = branchFor(a, req.query.branchId);
    const rows = await ctx.prisma.heldCart.findMany({ where: { accountId: a.account.id, branchId: branch.id }, orderBy: { createdAt: "desc" } });
    res.json({ carts: rows.map((c) => ({ id: c.id, label: c.label, payload: c.payload, userId: c.userId, createdAt: c.createdAt.toISOString() })) });
  });
  router.post("/held-carts", async (req, res) => {
    const a = auth(req);
    const body = HeldCartBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const c = await ctx.prisma.heldCart.create({ data: { accountId: a.account.id, branchId: branch.id, userId: a.user.id, label: body.label, payload: body.payload } });
    res.status(201).json({ cart: { id: c.id, label: c.label, payload: c.payload, userId: c.userId, createdAt: c.createdAt.toISOString() } });
  });
  router.delete("/held-carts/:id", async (req, res) => {
    const a = auth(req);
    const c = await ctx.prisma.heldCart.findFirst({ where: { id: String(req.params.id), accountId: a.account.id } });
    if (!c) throw new AppError(404, "not_found", "Held bill not found.");
    branchFor(a, c.branchId);
    await ctx.prisma.heldCart.delete({ where: { id: c.id } });
    res.status(204).end();
  });

  return router;
}
