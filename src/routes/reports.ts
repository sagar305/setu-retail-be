import { Router, type Request } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { startOfDay } from "../lib/time.js";
import { fromDay, toDay } from "../services/batches.js";
import { branchFor } from "./access.js";
import { DEFAULT_LOW_STOCK_MILLI, shopToday } from "./catalogue.js";

// Owner and managers only; managers see only their branches.
// Ranges are [from, to) instants; the app sends them computed in the shop's day.

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function scope(a: AuthContext, req: Request) {
  const branchIds = typeof req.query.branchId === "string" && req.query.branchId ? [branchFor(a, req.query.branchId).id] : a.branches.map((b) => b.id);
  return branchIds;
}

function range(ctx: Ctx, a: AuthContext, req: Request) {
  const parse = (v: unknown) => (typeof v === "string" && v ? new Date(v) : null);
  const from = parse(req.query.from) ?? startOfDay(ctx.now(), a.account.timezone);
  const to = parse(req.query.to) ?? ctx.now();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new AppError(400, "bad_range", "Pick a valid date range.");
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new AppError(400, "range_too_long", "Pick a range of up to 400 days.");
  return { from, to };
}

export function reportsRouter(ctx: Ctx): Router {
  const router = Router();
  router.use("/reports", authenticate(ctx), requireActivePlan, requireRole("OWNER", "MANAGER"));

  async function sales(a: AuthContext, branchIds: string[], from: Date, to: Date) {
    const tz = a.account.timezone;
    const done: Prisma.OrderWhereInput = { accountId: a.account.id, branchId: { in: branchIds }, status: "COMPLETED", createdAt: { gte: from, lt: to } };
    const [completed, cancelled, returns, byPayment, refunds, top, byBranch, byDay] = await Promise.all([
      ctx.prisma.order.aggregate({ where: done, _count: true, _sum: { subtotal: true, discountTotal: true, total: true } }),
      ctx.prisma.order.aggregate({ where: { ...done, status: "CANCELLED" }, _count: true, _sum: { total: true } }),
      ctx.prisma.creditNote.aggregate({ where: { accountId: a.account.id, branchId: { in: branchIds }, createdAt: { gte: from, lt: to } }, _count: true, _sum: { total: true } }),
      ctx.prisma.orderPayment.groupBy({ by: ["methodName", "kind"], where: { order: done }, _sum: { amount: true } }),
      ctx.prisma.creditNote.groupBy({ by: ["refundMethodName"], where: { accountId: a.account.id, branchId: { in: branchIds }, createdAt: { gte: from, lt: to } }, _sum: { total: true } }),
      ctx.prisma.orderItem.groupBy({ by: ["productId", "name", "unit"], where: { order: done }, _sum: { qtyMilli: true, total: true }, orderBy: { _sum: { total: "desc" } }, take: 10 }),
      ctx.prisma.order.groupBy({ by: ["branchId"], where: done, _count: true, _sum: { total: true } }),
      ctx.prisma.$queryRaw<{ day: string; bills: bigint; sales: bigint }[]>`
        SELECT to_char("createdAt" AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*) AS bills, sum("total") AS sales
        FROM "orders"
        WHERE "accountId" = ${a.account.id}::uuid AND "branchId" = ANY(${branchIds}::uuid[]) AND "status" = 'COMPLETED'
          AND "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY 1 ORDER BY 1`,
    ]);
    const salesTotal = n(completed._sum.total);
    const returnsTotal = n(returns._sum.total);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bills: completed._count,
      gross: n(completed._sum.subtotal),
      discounts: n(completed._sum.discountTotal),
      sales: salesTotal,
      returns: returnsTotal,
      returnCount: returns._count,
      net: salesTotal - returnsTotal,
      averageBill: completed._count ? Math.round(salesTotal / completed._count) : 0,
      cancelled: { count: cancelled._count, total: n(cancelled._sum.total) },
      byPayment: byPayment.map((p) => ({ method: p.methodName, kind: p.kind, amount: n(p._sum.amount) })).sort((x, y) => y.amount - x.amount),
      refundsByMethod: refunds.map((r) => ({ method: r.refundMethodName, amount: n(r._sum.total) })),
      topProducts: top.map((t) => ({ productId: t.productId, name: t.name, unit: t.unit, qtyMilli: n(t._sum.qtyMilli), amount: n(t._sum.total) })),
      byBranch: byBranch.map((b) => ({ branchId: b.branchId, bills: b._count, sales: n(b._sum.total) })),
      byDay: byDay.map((d) => ({ day: d.day, bills: n(d.bills), sales: n(d.sales) })),
    };
  }

  router.get("/reports/sales", async (req, res) => {
    const a = auth(req);
    const { from, to } = range(ctx, a, req);
    res.json(await sales(a, scope(a, req), from, to));
  });

  router.get("/reports/gst", async (req, res) => {
    const a = auth(req);
    const branchIds = scope(a, req);
    const { from, to } = range(ctx, a, req);
    const done: Prisma.OrderWhereInput = { accountId: a.account.id, branchId: { in: branchIds }, status: "COMPLETED", taxEnabled: true, createdAt: { gte: from, lt: to } };
    const amounts = { taxable: true, cgst: true, sgst: true, igst: true, total: true } as const;
    const [byRate, byHsn, b2b, b2c, cnByRate, creditNotes] = await Promise.all([
      ctx.prisma.orderItem.groupBy({ by: ["gstRateBp"], where: { order: done }, _sum: amounts, orderBy: { gstRateBp: "asc" } }),
      ctx.prisma.orderItem.groupBy({ by: ["hsn", "gstRateBp", "unit"], where: { order: done }, _sum: { ...amounts, qtyMilli: true }, orderBy: [{ hsn: "asc" }, { gstRateBp: "asc" }] }),
      ctx.prisma.order.findMany({
        where: { ...done, customerGstin: { not: null } },
        orderBy: { createdAt: "asc" },
        take: 5000,
        select: { invoiceNumber: true, createdAt: true, customerName: true, customerGstin: true, placeOfSupply: true, interState: true, taxableTotal: true, cgstTotal: true, sgstTotal: true, igstTotal: true, total: true },
      }),
      ctx.prisma.order.groupBy({ by: ["interState", "placeOfSupply"], where: { ...done, customerGstin: null }, _count: true, _sum: { taxableTotal: true, cgstTotal: true, sgstTotal: true, igstTotal: true, total: true } }),
      ctx.prisma.$queryRaw<{ rate: number; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; total: bigint }[]>`
        SELECT oi."gstRateBp" AS rate, sum(ci."taxable") AS taxable, sum(ci."cgst") AS cgst, sum(ci."sgst") AS sgst, sum(ci."igst") AS igst, sum(ci."total") AS total
        FROM "credit_note_items" ci
        JOIN "credit_notes" cn ON cn."id" = ci."creditNoteId"
        JOIN "order_items" oi ON oi."id" = ci."orderItemId"
        JOIN "orders" o ON o."id" = cn."orderId"
        WHERE cn."accountId" = ${a.account.id}::uuid AND cn."branchId" = ANY(${branchIds}::uuid[]) AND o."taxEnabled" = true
          AND cn."createdAt" >= ${from} AND cn."createdAt" < ${to}
        GROUP BY 1 ORDER BY 1`,
      ctx.prisma.creditNote.findMany({
        where: { accountId: a.account.id, branchId: { in: branchIds }, createdAt: { gte: from, lt: to }, order: { taxEnabled: true } },
        orderBy: { createdAt: "asc" },
        take: 5000,
        select: { number: true, createdAt: true, taxableTotal: true, cgstTotal: true, sgstTotal: true, igstTotal: true, total: true, order: { select: { invoiceNumber: true, customerGstin: true, customerName: true } } },
      }),
    ]);
    const sum = (r: { _sum: Record<string, number | null> }, k: string) => n(r._sum[k]);
    const salesRates = byRate.map((r) => ({ rateBp: r.gstRateBp, taxable: sum(r, "taxable"), cgst: sum(r, "cgst"), sgst: sum(r, "sgst"), igst: sum(r, "igst"), total: sum(r, "total") }));
    const cnRates = cnByRate.map((r) => ({ rateBp: Number(r.rate), taxable: n(r.taxable), cgst: n(r.cgst), sgst: n(r.sgst), igst: n(r.igst), total: n(r.total) }));
    const rates = [...new Set([...salesRates, ...cnRates].map((r) => r.rateBp))].sort((x, y) => x - y);
    const keys = ["taxable", "cgst", "sgst", "igst", "total"] as const;
    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      byRate: rates.map((rateBp) => {
        const s = salesRates.find((r) => r.rateBp === rateBp);
        const c = cnRates.find((r) => r.rateBp === rateBp);
        const row = { rateBp } as Record<string, number>;
        for (const k of keys) {
          row[`sales_${k}`] = s?.[k] ?? 0;
          row[`returns_${k}`] = c?.[k] ?? 0;
          row[`net_${k}`] = (s?.[k] ?? 0) - (c?.[k] ?? 0);
        }
        return row;
      }),
      byHsn: byHsn.map((r) => ({ hsn: r.hsn, rateBp: r.gstRateBp, unit: r.unit, qtyMilli: n(r._sum.qtyMilli), taxable: sum(r, "taxable"), cgst: sum(r, "cgst"), sgst: sum(r, "sgst"), igst: sum(r, "igst"), total: sum(r, "total") })),
      b2b: b2b.map((o) => ({
        invoiceNumber: o.invoiceNumber,
        date: o.createdAt.toISOString(),
        customerName: o.customerName,
        customerGstin: o.customerGstin,
        placeOfSupply: o.placeOfSupply,
        interState: o.interState,
        taxable: o.taxableTotal,
        cgst: o.cgstTotal,
        sgst: o.sgstTotal,
        igst: o.igstTotal,
        total: o.total,
      })),
      b2c: b2c.map((r) => ({
        interState: r.interState,
        placeOfSupply: r.placeOfSupply,
        bills: r._count,
        taxable: n(r._sum.taxableTotal),
        cgst: n(r._sum.cgstTotal),
        sgst: n(r._sum.sgstTotal),
        igst: n(r._sum.igstTotal),
        total: n(r._sum.total),
      })),
      creditNotes: creditNotes.map((c) => ({
        number: c.number,
        date: c.createdAt.toISOString(),
        invoiceNumber: c.order.invoiceNumber,
        customerName: c.order.customerName,
        customerGstin: c.order.customerGstin,
        taxable: c.taxableTotal,
        cgst: c.cgstTotal,
        sgst: c.sgstTotal,
        igst: c.igstTotal,
        total: c.total,
      })),
    });
  });

  router.get("/reports/stock", async (req, res) => {
    const a = auth(req);
    const branch = branchFor(a, req.query.branchId);
    const products = await ctx.prisma.product.findMany({
      where: { accountId: a.account.id, archivedAt: null, trackStock: true },
      include: { branches: { where: { branchId: branch.id } } },
      orderBy: { name: "asc" },
    });
    let value = 0;
    let missingCost = 0;
    const items = products.map((p) => {
      const stock = p.branches[0]?.stockMilli ?? 0;
      const low = p.lowStockMilli ?? DEFAULT_LOW_STOCK_MILLI;
      if (stock > 0) {
        if (p.costPrice === null) missingCost += 1;
        else value += Math.round((stock * p.costPrice) / 1000);
      }
      const status = stock < 0 ? "negative" : stock === 0 ? "out" : stock <= low ? "low" : "ok";
      return { productId: p.id, name: p.name, unit: p.unit, stockMilli: stock, costPrice: p.costPrice, value: stock > 0 && p.costPrice !== null ? Math.round((stock * p.costPrice) / 1000) : 0, status };
    });
    const today = shopToday(ctx.now(), a.account.timezone);
    const t = fromDay(today).getTime();
    const batches = a.account.batchTracking
      ? await ctx.prisma.batch.findMany({ where: { branchId: branch.id, qtyMilli: { gt: 0 }, expiry: { not: null, lte: new Date(t + 90 * 86_400_000) } }, orderBy: { expiry: "asc" } })
      : [];
    const byId = new Map(products.map((p) => [p.id, p]));
    const bucket = (e: Date) => (e.getTime() < t ? "expired" : e.getTime() <= t + 30 * 86_400_000 ? "30" : e.getTime() <= t + 60 * 86_400_000 ? "60" : "90");
    const expiring = batches.map((b) => {
      const p = byId.get(b.productId);
      const cost = b.costPrice ?? p?.costPrice ?? null;
      return { batchId: b.id, productName: p?.name ?? "", unit: p?.unit ?? "", batchNo: b.batchNo, expiry: toDay(b.expiry), qtyMilli: b.qtyMilli, value: cost === null ? null : Math.round((b.qtyMilli * cost) / 1000), bucket: bucket(b.expiry!) };
    });
    res.json({
      branchId: branch.id,
      value,
      missingCost,
      counts: {
        tracked: items.length,
        low: items.filter((i) => i.status === "low").length,
        out: items.filter((i) => i.status === "out").length,
        negative: items.filter((i) => i.status === "negative").length,
      },
      items,
      batchTracking: a.account.batchTracking,
      expiring,
    });
  });

  router.get("/reports/staff", async (req, res) => {
    const a = auth(req);
    const branchIds = scope(a, req);
    const { from, to } = range(ctx, a, req);
    const done: Prisma.OrderWhereInput = { accountId: a.account.id, branchId: { in: branchIds }, status: "COMPLETED", createdAt: { gte: from, lt: to } };
    const [byCashier, byCounter, margin] = await Promise.all([
      ctx.prisma.order.groupBy({ by: ["cashierId"], where: done, _count: true, _sum: { total: true, discountTotal: true, returnedTotal: true } }),
      ctx.prisma.order.groupBy({ by: ["counterId"], where: done, _count: true, _sum: { total: true } }),
      ctx.prisma.$queryRaw<{ productId: string | null; name: string; unit: string; qty: bigint; revenue: number; cost: number | null; unknown: bigint }[]>`
        SELECT oi."productId" AS "productId", oi."name" AS name, oi."unit" AS unit,
          sum(oi."qtyMilli" - oi."returnedQtyMilli") AS qty,
          round(sum(oi."taxable"::numeric * (oi."qtyMilli" - oi."returnedQtyMilli") / oi."qtyMilli"))::float8 AS revenue,
          round(sum(oi."unitCost"::numeric * (oi."qtyMilli" - oi."returnedQtyMilli") / 1000))::float8 AS cost,
          count(*) FILTER (WHERE oi."unitCost" IS NULL) AS unknown
        FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
        WHERE o."accountId" = ${a.account.id}::uuid AND o."branchId" = ANY(${branchIds}::uuid[]) AND o."status" = 'COMPLETED'
          AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
        GROUP BY 1, 2, 3 ORDER BY revenue DESC LIMIT 500`,
    ]);
    const [users, counters] = await Promise.all([
      ctx.prisma.user.findMany({ where: { id: { in: byCashier.map((c) => c.cashierId) } }, select: { id: true, name: true, role: true } }),
      ctx.prisma.counter.findMany({ where: { id: { in: byCounter.map((c) => c.counterId) } }, select: { id: true, code: true, name: true, branch: { select: { code: true } } } }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const counterById = new Map(counters.map((c) => [c.id, c]));
    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      byCashier: byCashier
        .map((c) => ({ userId: c.cashierId, name: userById.get(c.cashierId)?.name ?? "—", role: userById.get(c.cashierId)?.role ?? null, bills: c._count, sales: n(c._sum.total), discounts: n(c._sum.discountTotal), returns: n(c._sum.returnedTotal) }))
        .sort((x, y) => y.sales - x.sales),
      byCounter: byCounter
        .map((c) => {
          const ct = counterById.get(c.counterId);
          return { counterId: c.counterId, code: ct ? `${ct.branch.code}-${ct.code}` : "—", name: ct?.name ?? "", bills: c._count, sales: n(c._sum.total) };
        })
        .sort((x, y) => y.sales - x.sales),
      margin: margin.map((m) => {
        const revenue = n(m.revenue);
        const known = n(m.unknown) === 0 && m.cost !== null;
        const cost = known ? n(m.cost) : null;
        return { productId: m.productId, name: m.name, unit: m.unit, qtyMilli: n(m.qty), revenue, cost, margin: cost === null ? null : revenue - cost, marginBp: cost === null || revenue === 0 ? null : Math.round(((revenue - cost) * 10_000) / revenue) };
      }),
    });
  });

  router.get("/reports/stock-log", async (req, res) => {
    const a = auth(req);
    const branch = branchFor(a, req.query.branchId);
    const { from, to } = range(ctx, a, req);
    const productId = typeof req.query.productId === "string" && req.query.productId ? req.query.productId : undefined;
    const logs = await ctx.prisma.inventoryLog.findMany({ where: { branchId: branch.id, createdAt: { gte: from, lt: to }, ...(productId ? { productId } : {}) }, orderBy: { createdAt: "desc" }, take: 1000 });
    const [products, users] = await Promise.all([
      ctx.prisma.product.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.productId))] } }, select: { id: true, name: true, unit: true } }),
      ctx.prisma.user.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.userId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } }),
    ]);
    const pById = new Map(products.map((p) => [p.id, p]));
    const uById = new Map(users.map((u) => [u.id, u.name]));
    res.json({
      log: logs.map((l) => ({ id: l.id, createdAt: l.createdAt.toISOString(), productName: pById.get(l.productId)?.name ?? "", unit: pById.get(l.productId)?.unit ?? "", type: l.type, changeMilli: l.changeMilli, stockAfterMilli: l.stockAfterMilli, note: l.note, userName: l.userId ? (uById.get(l.userId) ?? "") : "" })),
    });
  });

  router.get("/reports/dashboard", async (req, res) => {
    const a = auth(req);
    const branchIds = scope(a, req);
    const now = ctx.now();
    const tz = a.account.timezone;
    const today = startOfDay(now, tz);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const weekStart = new Date(today.getTime() - 6 * 86_400_000);
    const [todayR, yestR, week, low, expiringSoon, credit] = await Promise.all([
      // "Today" is the whole shop day, so a bill made this very second counts.
      sales(a, branchIds, today, new Date(today.getTime() + 86_400_000)),
      ctx.prisma.order.aggregate({ where: { accountId: a.account.id, branchId: { in: branchIds }, status: "COMPLETED", createdAt: { gte: yesterday, lt: today } }, _sum: { total: true }, _count: true }),
      ctx.prisma.$queryRaw<{ day: string; sales: bigint; bills: bigint }[]>`
        SELECT to_char("createdAt" AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, sum("total") AS sales, count(*) AS bills FROM "orders"
        WHERE "accountId" = ${a.account.id}::uuid AND "branchId" = ANY(${branchIds}::uuid[]) AND "status" = 'COMPLETED' AND "createdAt" >= ${weekStart}
        GROUP BY 1 ORDER BY 1`,
      ctx.prisma.$queryRaw<{ productId: string; name: string; unit: string; branchId: string; stock: number; low: number }[]>`
        SELECT p."id" AS "productId", p."name" AS name, p."unit" AS unit, bp."branchId" AS "branchId", bp."stockMilli" AS stock, coalesce(p."lowStockMilli", ${DEFAULT_LOW_STOCK_MILLI}) AS low
        FROM "branch_products" bp JOIN "products" p ON p."id" = bp."productId"
        WHERE p."accountId" = ${a.account.id}::uuid AND bp."branchId" = ANY(${branchIds}::uuid[]) AND p."trackStock" AND p."archivedAt" IS NULL
          AND bp."stockMilli" <= coalesce(p."lowStockMilli", ${DEFAULT_LOW_STOCK_MILLI})
        ORDER BY bp."stockMilli" ASC LIMIT 50`,
      a.account.batchTracking
        ? ctx.prisma.batch.count({ where: { accountId: a.account.id, branchId: { in: branchIds }, qtyMilli: { gt: 0 }, expiry: { not: null, lte: new Date(fromDay(shopToday(now, tz)).getTime() + 30 * 86_400_000) } } })
        : Promise.resolve(0),
      ctx.prisma.orderPayment.aggregate({ where: { kind: "CREDIT", order: { accountId: a.account.id, branchId: { in: branchIds }, status: "COMPLETED", createdAt: { gte: today } } }, _sum: { amount: true } }),
    ]);
    const days = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(weekStart.getTime() + i * 86_400_000 + 12 * 3600_000)));
    res.json({
      today: { sales: todayR.sales, net: todayR.net, bills: todayR.bills, averageBill: todayR.averageBill, returns: todayR.returns, byPayment: todayR.byPayment, byBranch: todayR.byBranch, topProducts: todayR.topProducts.slice(0, 5), creditGiven: n(credit._sum.amount) },
      yesterday: { sales: n(yestR._sum.total), bills: yestR._count },
      week: days.map((day) => {
        const r = week.find((w) => w.day === day);
        return { day, sales: n(r?.sales), bills: n(r?.bills) };
      }),
      lowStock: low.map((l) => ({ productId: l.productId, name: l.name, unit: l.unit, branchId: l.branchId, stockMilli: Number(l.stock), status: Number(l.stock) < 0 ? "negative" : Number(l.stock) === 0 ? "out" : "low" })),
      expiringSoon,
    });
  });

  return router;
}
