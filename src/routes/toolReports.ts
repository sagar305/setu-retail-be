// Phase 4b report tools: Invoice Aging, Payables Aging, Profit Dashboard and
// Stock Register. Owner and managers; each needs its tool switched on.
import { Router, type Request } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import { AppError } from "../http/errors.js";
import { AGING_BUCKETS, addDaysTo, agingBucket, type AgingBucket } from "../lib/books.js";
import { customerStatements, dayStart, requireTool, supplierStatements, type OpenItem } from "../services/books.js";
import { branchFor } from "./access.js";
import { shopToday } from "./catalogue.js";

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const emptyBuckets = (): Record<AgingBucket, number> => ({ current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 });

function days(ctx: Ctx, a: AuthContext, req: Request, maxDays = 400) {
  const today = shopToday(ctx.now(), a.account.timezone);
  const ok = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const to = ok(req.query.to) ? String(req.query.to) : today;
  const from = ok(req.query.from) ? String(req.query.from) : `${to.slice(0, 8)}01`;
  if (from > to) throw new AppError(400, "bad_range", "Pick a valid date range.");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > maxDays) throw new AppError(400, "range_too_long", `Pick a range of up to ${maxDays} days.`);
  return { from, to, start: dayStart(from, a.account.timezone), end: dayStart(addDaysTo(to, 1), a.account.timezone) };
}

type AgedItem = OpenItem & { dueDay: string; bucket: AgingBucket; daysOverdue: number };

function age(items: OpenItem[], today: string, dueOf: (i: OpenItem) => string) {
  const buckets = emptyBuckets();
  const aged: AgedItem[] = items.map((i) => {
    const dueDay = dueOf(i);
    const b = agingBucket(dueDay, today);
    buckets[b.bucket] += i.open;
    return { ...i, dueDay, ...b };
  });
  return { buckets, items: aged, maxDaysOverdue: aged.reduce((m, i) => Math.max(m, i.daysOverdue), 0) };
}

export function toolReportsRouter(ctx: Ctx): Router {
  const router = Router();
  // The reports router already signed the user in for /reports/*.
  const signIn = authenticate(ctx);
  router.use(["/reports/aging", "/reports/profit", "/reports/stock-register"], (req, res, next) => (req.auth ? next() : signIn(req, res, next)), requireActivePlan, requireRole("OWNER", "MANAGER"));

  // ── Invoice Aging: who owes udhaar, and how overdue ──
  router.get("/reports/aging/customers", requireTool("invoice-aging"), async (req, res) => {
    const a = auth(req);
    const tz = a.account.timezone;
    const today = shopToday(ctx.now(), tz);
    const statements = await customerStatements(ctx.prisma, a.account.id);
    const ids = [...statements].filter(([, st]) => st.open > 0).map(([id]) => id);
    const customers = await ctx.prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true, creditDays: true } });
    const totals = emptyBuckets();
    const rows = customers
      .map((c) => {
        const st = statements.get(c.id)!;
        const creditDays = c.creditDays ?? a.account.creditDays;
        // Due creditDays after the bill's shop day.
        const r = age(st.openItems, today, (i) => addDaysTo(shopToday(new Date(i.at), tz), creditDays));
        for (const k of Object.keys(totals) as AgingBucket[]) totals[k] += r.buckets[k];
        return { customerId: c.id, name: c.name, phone: c.phone, creditDays, open: st.open, ...r };
      })
      .sort((x, y) => y.maxDaysOverdue - x.maxDaysOverdue || y.open - x.open);
    res.json({ asOf: today, creditDays: a.account.creditDays, buckets: AGING_BUCKETS, totals, total: rows.reduce((s, r) => s + r.open, 0), parties: rows });
  });

  // ── Payables Aging: unpaid supplier bills by due date ──
  router.get("/reports/aging/suppliers", requireTool("payables-aging"), async (req, res) => {
    const a = auth(req);
    const today = shopToday(ctx.now(), a.account.timezone);
    const statements = await supplierStatements(ctx.prisma, a.account.id);
    const ids = [...statements].filter(([, st]) => st.open > 0).map(([id]) => id);
    const suppliers = await ctx.prisma.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } });
    const totals = emptyBuckets();
    const rows = suppliers
      .map((s) => {
        const st = statements.get(s.id)!;
        const r = age(st.openItems, today, (i) => i.dueDate ?? i.at.slice(0, 10));
        for (const k of Object.keys(totals) as AgingBucket[]) totals[k] += r.buckets[k];
        return { supplierId: s.id, name: s.name, phone: s.phone, open: st.open, ...r };
      })
      .sort((x, y) => y.maxDaysOverdue - x.maxDaysOverdue || y.open - x.open);
    // Due in the next 7 days, to plan payments.
    const soon = rows.flatMap((r) => r.items.filter((i) => i.bucket === "current" && i.dueDay <= addDaysTo(today, 7)).map((i) => ({ ...i, supplierId: r.supplierId, name: r.name }))).sort((x, y) => x.dueDay.localeCompare(y.dueDay));
    res.json({ asOf: today, buckets: AGING_BUCKETS, totals, total: rows.reduce((s, r) => s + r.open, 0), parties: rows, dueThisWeek: soon });
  });

  // ── Profit Dashboard: net sales before GST − cost of goods sold − expenses ──
  router.get("/reports/profit", requireTool("profit-dashboard"), async (req, res) => {
    const a = auth(req);
    const tz = a.account.timezone;
    const { from, to, start, end } = days(ctx, a, req);
    const branchIds = typeof req.query.branchId === "string" && req.query.branchId ? [branchFor(a, req.query.branchId).id] : a.branches.map((b) => b.id);
    const monthly = (Date.parse(to) - Date.parse(from)) / 86_400_000 > 62;
    const fmt = monthly ? "YYYY-MM" : "YYYY-MM-DD";
    const acc = a.account.id;
    const [sales, returns, expenses, byCategory] = await Promise.all([
      ctx.prisma.$queryRaw<{ period: string; branchId: string; revenue: bigint; cost: bigint; uncosted: bigint; uncostedRevenue: bigint }[]>`
        SELECT to_char(o."createdAt" AT TIME ZONE ${tz}, ${fmt}) AS period, o."branchId",
          sum(i."taxable") AS revenue,
          sum(CASE WHEN i."unitCost" IS NULL THEN 0 ELSE round(i."unitCost"::numeric * i."qtyMilli" / 1000) END) AS cost,
          count(*) FILTER (WHERE i."unitCost" IS NULL) AS uncosted,
          coalesce(sum(i."taxable") FILTER (WHERE i."unitCost" IS NULL), 0) AS "uncostedRevenue"
        FROM "order_items" i JOIN "orders" o ON o."id" = i."orderId"
        WHERE o."accountId" = ${acc}::uuid AND o."branchId" = ANY(${branchIds}::uuid[]) AND o."status" = 'COMPLETED'
          AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
        GROUP BY 1, 2`,
      ctx.prisma.$queryRaw<{ period: string; branchId: string; revenue: bigint; cost: bigint }[]>`
        SELECT to_char(cn."createdAt" AT TIME ZONE ${tz}, ${fmt}) AS period, cn."branchId",
          sum(ci."taxable") AS revenue,
          sum(CASE WHEN oi."unitCost" IS NULL THEN 0 ELSE round(oi."unitCost"::numeric * ci."qtyMilli" / 1000) END) AS cost
        FROM "credit_note_items" ci JOIN "credit_notes" cn ON cn."id" = ci."creditNoteId" JOIN "order_items" oi ON oi."id" = ci."orderItemId"
        WHERE cn."accountId" = ${acc}::uuid AND cn."branchId" = ANY(${branchIds}::uuid[]) AND cn."createdAt" >= ${start} AND cn."createdAt" < ${end}
        GROUP BY 1, 2`,
      ctx.prisma.$queryRaw<{ period: string; branchId: string; amount: bigint }[]>`
        SELECT to_char("spentAt" AT TIME ZONE ${tz}, ${fmt}) AS period, "branchId", sum("amount") AS amount
        FROM "expenses" WHERE "accountId" = ${acc}::uuid AND "branchId" = ANY(${branchIds}::uuid[]) AND "deletedAt" IS NULL
          AND "spentAt" >= ${start} AND "spentAt" < ${end}
        GROUP BY 1, 2`,
      ctx.prisma.expense.groupBy({ by: ["category"], where: { accountId: acc, branchId: { in: branchIds }, deletedAt: null, spentAt: { gte: start, lt: end } }, _sum: { amount: true }, orderBy: { _sum: { amount: "desc" } } }),
    ]);
    type Line = { revenue: number; cost: number; expenses: number };
    const blank = (): Line => ({ revenue: 0, cost: 0, expenses: 0 });
    const periods = new Map<string, Line>();
    const branches = new Map<string, Line>();
    const add = (period: string, branchId: string, k: keyof Line, v: number) => {
      periods.set(period, { ...(periods.get(period) ?? blank()), [k]: (periods.get(period)?.[k] ?? 0) + v });
      branches.set(branchId, { ...(branches.get(branchId) ?? blank()), [k]: (branches.get(branchId)?.[k] ?? 0) + v });
    };
    for (const r of sales) {
      add(r.period, r.branchId, "revenue", n(r.revenue));
      add(r.period, r.branchId, "cost", n(r.cost));
    }
    for (const r of returns) {
      add(r.period, r.branchId, "revenue", -n(r.revenue));
      add(r.period, r.branchId, "cost", -n(r.cost));
    }
    for (const r of expenses) add(r.period, r.branchId, "expenses", n(r.amount));
    const shape = (l: Line) => ({ ...l, grossProfit: l.revenue - l.cost, netProfit: l.revenue - l.cost - l.expenses });
    const total = [...periods.values()].reduce((t, l) => ({ revenue: t.revenue + l.revenue, cost: t.cost + l.cost, expenses: t.expenses + l.expenses }), blank());
    res.json({
      from,
      to,
      period: monthly ? "month" : "day",
      ...shape(total),
      grossMarginBp: total.revenue > 0 ? Math.round(((total.revenue - total.cost) * 10_000) / total.revenue) : null,
      uncosted: { lines: sales.reduce((s, r) => s + n(r.uncosted), 0), revenue: sales.reduce((s, r) => s + n(r.uncostedRevenue), 0) },
      byPeriod: [...periods].sort((x, y) => x[0].localeCompare(y[0])).map(([period, l]) => ({ period, ...shape(l) })),
      byBranch: [...branches].map(([branchId, l]) => ({ branchId, ...shape(l) })),
      expensesByCategory: byCategory.map((c) => ({ category: c.category, amount: c._sum.amount ?? 0 })),
    });
  });

  // ── Stock Register: opening, in, out and closing per product, per branch ──
  router.get("/reports/stock-register", requireTool("stock-register"), async (req, res) => {
    const a = auth(req);
    const branch = branchFor(a, req.query.branchId);
    const { from, to, start, end } = days(ctx, a, req);
    const [products, before, upTo, moves] = await Promise.all([
      ctx.prisma.product.findMany({ where: { accountId: a.account.id, trackStock: true, archivedAt: null }, select: { id: true, name: true, sku: true, unit: true, costPrice: true }, orderBy: { name: "asc" } }),
      ctx.prisma.$queryRaw<{ productId: string; stock: number }[]>`
        SELECT DISTINCT ON ("productId") "productId", "stockAfterMilli" AS stock FROM "inventory_logs"
        WHERE "branchId" = ${branch.id}::uuid AND "createdAt" < ${start} ORDER BY "productId", "createdAt" DESC, "seq" DESC`,
      ctx.prisma.$queryRaw<{ productId: string; stock: number }[]>`
        SELECT DISTINCT ON ("productId") "productId", "stockAfterMilli" AS stock FROM "inventory_logs"
        WHERE "branchId" = ${branch.id}::uuid AND "createdAt" < ${end} ORDER BY "productId", "createdAt" DESC, "seq" DESC`,
      ctx.prisma.inventoryLog.groupBy({ by: ["productId", "type"], where: { branchId: branch.id, createdAt: { gte: start, lt: end } }, _sum: { changeMilli: true } }),
    ]);
    const open = new Map(before.map((r) => [r.productId, n(r.stock)]));
    const close = new Map(upTo.map((r) => [r.productId, n(r.stock)]));
    // Movement kinds people recognise on a register.
    const KIND: Record<string, "purchases" | "sales" | "returns" | "adjustments" | "supplierReturns"> = {
      PURCHASE: "purchases",
      REPLACEMENT: "purchases",
      SALE: "sales",
      CANCEL: "returns",
      RETURN: "returns",
      PURCHASE_RETURN: "supplierReturns",
      PURCHASE_CANCEL: "supplierReturns",
      OPENING: "adjustments",
      ADD: "adjustments",
      REDUCE: "adjustments",
      SET: "adjustments",
    };
    const flows = new Map<string, Record<"purchases" | "sales" | "returns" | "adjustments" | "supplierReturns", number>>();
    for (const m of moves) {
      const f = flows.get(m.productId) ?? { purchases: 0, sales: 0, returns: 0, adjustments: 0, supplierReturns: 0 };
      f[KIND[m.type] ?? "adjustments"] += m._sum.changeMilli ?? 0;
      flows.set(m.productId, f);
    }
    const items = products
      .map((p) => {
        const f = flows.get(p.id) ?? { purchases: 0, sales: 0, returns: 0, adjustments: 0, supplierReturns: 0 };
        const closing = close.get(p.id) ?? 0;
        return { productId: p.id, name: p.name, sku: p.sku, unit: p.unit, opening: open.get(p.id) ?? 0, ...f, closing, value: p.costPrice === null ? null : Math.round((Math.max(0, closing) * p.costPrice) / 1000) };
      })
      .filter((i) => i.opening || i.closing || i.purchases || i.sales || i.returns || i.adjustments || i.supplierReturns);
    res.json({ branchId: branch.id, from, to, items, value: items.reduce((s, i) => s + (i.value ?? 0), 0), missingCost: items.filter((i) => i.value === null && i.closing > 0).length });
  });

  return router;
}
