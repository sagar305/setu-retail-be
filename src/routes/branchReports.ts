// Phase 5 reports: branches side by side, stock across branches, transfers,
// and the audit log viewer. Owner sees every branch; managers their own.
import "../zodOpenApi.js";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { addDaysTo } from "../lib/books.js";
import { pruneAudit } from "../services/audit.js";
import { customerStatements, dayStart } from "../services/books.js";
import { branchFor } from "./access.js";
import { DEFAULT_LOW_STOCK_MILLI, shopToday } from "./catalogue.js";

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function days(ctx: Ctx, a: AuthContext, req: Request) {
  const today = shopToday(ctx.now(), a.account.timezone);
  const ok = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const to = ok(req.query.to) ? String(req.query.to) : today;
  const from = ok(req.query.from) ? String(req.query.from) : `${to.slice(0, 8)}01`;
  if (from > to) throw new AppError(400, "bad_range", "Pick a valid date range.");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) throw new AppError(400, "range_too_long", "Pick a range of up to 400 days.");
  return { from, to, start: dayStart(from, a.account.timezone), end: dayStart(addDaysTo(to, 1), a.account.timezone) };
}

const M = z.number().int();
export const BranchComparisonDto = z.object({
  from: z.string(),
  to: z.string(),
  branches: z.array(
    z.object({
      branchId: z.string(),
      code: z.string(),
      name: z.string(),
      bills: z.number().int(),
      sales: M,
      returns: M,
      netSales: M,
      averageBill: M,
      revenue: M,
      cost: M,
      grossProfit: M,
      expenses: M,
      netProfit: M,
      stockValue: M,
      udhaar: M,
      inTransitIn: M,
    }),
  ),
  udhaarUnassigned: M,
});
export const StockAcrossDto = z.object({
  branches: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  products: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      sku: z.string(),
      unit: z.string(),
      total: z.number().int(),
      stock: z.array(z.object({ branchId: z.string(), stockMilli: z.number().int(), lowMilli: z.number().int(), status: z.enum(["ok", "low", "out"]) })),
      /** A branch that's low, and one with stock to spare. */
      suggestion: z.object({ toBranchId: z.string(), fromBranchId: z.string(), qtyMilli: z.number().int() }).nullable(),
    }),
  ),
});
export const TransferReportDto = z.object({
  from: z.string(),
  to: z.string(),
  totals: z.object({ sent: z.number().int(), sentValue: M, inTransit: z.number().int(), inTransitValue: M, returnedValue: M, writtenOffValue: M }),
  rows: z.array(z.object({ id: z.string(), number: z.string(), sentAt: z.string(), fromBranchId: z.string(), toBranchId: z.string(), status: z.string(), lines: z.number().int(), value: M, returnedValue: M, writtenOffValue: M })),
});
export const AuditEntryDto = z.object({ id: z.string(), createdAt: z.string(), action: z.string(), entityType: z.string(), entityId: z.string().nullable(), userId: z.string().nullable(), userName: z.string(), role: z.string().nullable(), branchId: z.string().nullable(), branchCode: z.string().nullable(), ip: z.string().nullable(), data: z.unknown() });

export function branchReportsRouter(ctx: Ctx): Router {
  const router = Router();
  const signIn = authenticate(ctx);
  router.use(["/reports/branches", "/reports/stock-across", "/reports/transfers", "/audit-log"], (req, res, next) => (req.auth ? next() : signIn(req, res, next)), requireActivePlan, requireRole("OWNER", "MANAGER"));

  // ── Branches side by side ──
  router.get("/reports/branches", async (req, res) => {
    const a = auth(req);
    const { from, to, start, end } = days(ctx, a, req);
    const ids = a.branches.map((b) => b.id);
    const acc = a.account.id;
    const [sales, returns, cost, returnCost, expenses, stock, transit, statements] = await Promise.all([
      ctx.prisma.order.groupBy({ by: ["branchId"], where: { accountId: acc, branchId: { in: ids }, status: "COMPLETED", createdAt: { gte: start, lt: end } }, _count: true, _sum: { total: true, taxableTotal: true } }),
      ctx.prisma.creditNote.groupBy({ by: ["branchId"], where: { accountId: acc, branchId: { in: ids }, createdAt: { gte: start, lt: end } }, _sum: { total: true, taxableTotal: true } }),
      ctx.prisma.$queryRaw<{ branchId: string; cost: bigint }[]>`
        SELECT o."branchId", sum(CASE WHEN i."unitCost" IS NULL THEN 0 ELSE round(i."unitCost"::numeric * i."qtyMilli" / 1000) END) AS cost
        FROM "order_items" i JOIN "orders" o ON o."id" = i."orderId"
        WHERE o."accountId" = ${acc}::uuid AND o."branchId" = ANY(${ids}::uuid[]) AND o."status" = 'COMPLETED' AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
        GROUP BY 1`,
      ctx.prisma.$queryRaw<{ branchId: string; cost: bigint }[]>`
        SELECT cn."branchId", sum(CASE WHEN oi."unitCost" IS NULL THEN 0 ELSE round(oi."unitCost"::numeric * ci."qtyMilli" / 1000) END) AS cost
        FROM "credit_note_items" ci JOIN "credit_notes" cn ON cn."id" = ci."creditNoteId" JOIN "order_items" oi ON oi."id" = ci."orderItemId"
        WHERE cn."accountId" = ${acc}::uuid AND cn."branchId" = ANY(${ids}::uuid[]) AND cn."createdAt" >= ${start} AND cn."createdAt" < ${end}
        GROUP BY 1`,
      ctx.prisma.expense.groupBy({ by: ["branchId"], where: { accountId: acc, branchId: { in: ids }, deletedAt: null, spentAt: { gte: start, lt: end } }, _sum: { amount: true } }),
      ctx.prisma.$queryRaw<{ branchId: string; value: bigint }[]>`
        SELECT bp."branchId", sum(round(greatest(bp."stockMilli", 0)::numeric * p."costPrice" / 1000)) AS value
        FROM "branch_products" bp JOIN "products" p ON p."id" = bp."productId"
        WHERE bp."branchId" = ANY(${ids}::uuid[]) AND p."trackStock" AND p."archivedAt" IS NULL AND p."costPrice" IS NOT NULL
        GROUP BY 1`,
      ctx.prisma.stockTransfer.findMany({ where: { accountId: acc, status: "SENT", toBranchId: { in: ids } }, include: { items: true } }),
      customerStatements(ctx.prisma, acc),
    ]);
    const by = <T extends { branchId: string }>(rows: T[]) => new Map(rows.map((r) => [r.branchId, r]));
    const s = by(sales);
    const r = by(returns);
    const c = by(cost);
    const rc = by(returnCost);
    const e = by(expenses);
    const st = by(stock);
    const udhaar = new Map<string, number>();
    let unassigned = 0;
    for (const statement of statements.values())
      for (const i of statement.openItems) {
        if (i.branchId && ids.includes(i.branchId)) udhaar.set(i.branchId, (udhaar.get(i.branchId) ?? 0) + i.open);
        else if (!i.branchId) unassigned += i.open;
      }
    const transitIn = new Map<string, number>();
    for (const t of transit) transitIn.set(t.toBranchId, (transitIn.get(t.toBranchId) ?? 0) + t.items.reduce((x, i) => x + (i.unitCost === null ? 0 : Math.round((i.unitCost * i.qtyMilli) / 1000)), 0));
    res.json({
      from,
      to,
      branches: a.branches.map((b) => {
        const bills = s.get(b.id)?._count ?? 0;
        const gross = n(s.get(b.id)?._sum.total);
        const ret = n(r.get(b.id)?._sum.total);
        const revenue = n(s.get(b.id)?._sum.taxableTotal) - n(r.get(b.id)?._sum.taxableTotal);
        const costOf = n(c.get(b.id)?.cost) - n(rc.get(b.id)?.cost);
        const spent = n(e.get(b.id)?._sum.amount);
        return { branchId: b.id, code: b.code, name: b.name, bills, sales: gross, returns: ret, netSales: gross - ret, averageBill: bills ? Math.round(gross / bills) : 0, revenue, cost: costOf, grossProfit: revenue - costOf, expenses: spent, netProfit: revenue - costOf - spent, stockValue: n(st.get(b.id)?.value), udhaar: udhaar.get(b.id) ?? 0, inTransitIn: transitIn.get(b.id) ?? 0 };
      }),
      // Opening balances and imported udhaar don't belong to a branch.
      udhaarUnassigned: a.user.role === "OWNER" ? unassigned : 0,
    });
  });

  // ── One product's stock in every branch ──
  router.get("/reports/stock-across", async (req, res) => {
    const a = auth(req);
    const branches = a.branches;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const only = req.query.only === "suggestions";
    const products = await ctx.prisma.product.findMany({
      where: { accountId: a.account.id, trackStock: true, archivedAt: null, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { equals: q, mode: "insensitive" } }, { barcode: q }] } : {}) },
      include: { branches: { where: { branchId: { in: branches.map((b) => b.id) } } } },
      orderBy: { name: "asc" },
      take: 1000,
    });
    const rows = products.map((p) => {
      const stock = branches.map((b) => {
        const bp = p.branches.find((x) => x.branchId === b.id);
        const s = bp?.stockMilli ?? 0;
        const low = p.lowStockMilli ?? DEFAULT_LOW_STOCK_MILLI;
        return { branchId: b.id, stockMilli: s, lowMilli: low, status: (s <= 0 ? "out" : s <= low ? "low" : "ok") as "ok" | "low" | "out" };
      });
      // Low somewhere, and another branch has more than twice its own low mark: suggest moving enough to lift the low one above its mark.
      const needy = stock.filter((x) => x.status !== "ok").sort((x, y) => x.stockMilli - y.stockMilli)[0];
      const donor = stock.filter((x) => x.stockMilli > 2 * x.lowMilli).sort((x, y) => y.stockMilli - y.lowMilli - (x.stockMilli - x.lowMilli))[0];
      const suggestion = needy && donor && donor.branchId !== needy.branchId ? { toBranchId: needy.branchId, fromBranchId: donor.branchId, qtyMilli: Math.max(1000, Math.min(donor.stockMilli - donor.lowMilli, needy.lowMilli * 2 - needy.stockMilli)) } : null;
      return { productId: p.id, name: p.name, sku: p.sku, unit: p.unit, total: stock.reduce((x, s) => x + s.stockMilli, 0), stock, suggestion };
    });
    res.json({ branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name })), products: only ? rows.filter((r) => r.suggestion) : rows });
  });

  // ── Transfers in a period ──
  router.get("/reports/transfers", async (req, res) => {
    const a = auth(req);
    const { from, to, start, end } = days(ctx, a, req);
    const ids = a.branches.map((b) => b.id);
    const [rows, transit] = await Promise.all([
      ctx.prisma.stockTransfer.findMany({ where: { accountId: a.account.id, sentAt: { gte: start, lt: end }, OR: [{ fromBranchId: { in: ids } }, { toBranchId: { in: ids } }] }, include: { items: true }, orderBy: { sentAt: "desc" } }),
      // In transit right now, whenever it was sent.
      ctx.prisma.stockTransfer.findMany({ where: { accountId: a.account.id, status: "SENT", OR: [{ fromBranchId: { in: ids } }, { toBranchId: { in: ids } }] }, include: { items: true } }),
    ]);
    const v = (cost: number | null, q: number) => (cost === null ? 0 : Math.round((cost * q) / 1000));
    const shaped = rows.map((t) => ({
      id: t.id,
      number: t.number,
      sentAt: t.sentAt.toISOString(),
      fromBranchId: t.fromBranchId,
      toBranchId: t.toBranchId,
      status: t.status,
      lines: t.items.length,
      value: t.items.reduce((s, i) => s + v(i.unitCost, i.qtyMilli), 0),
      returnedValue: t.items.reduce((s, i) => s + v(i.unitCost, i.returnedMilli), 0),
      writtenOffValue: t.items.reduce((s, i) => s + v(i.unitCost, i.writtenOffMilli), 0),
    }));
    const live = shaped.filter((t) => t.status !== "CANCELLED");
    res.json({
      from,
      to,
      totals: {
        sent: live.length,
        sentValue: live.reduce((s, t) => s + t.value, 0),
        inTransit: transit.length,
        inTransitValue: transit.reduce((s, t) => s + t.items.reduce((x, i) => x + v(i.unitCost, i.qtyMilli), 0), 0),
        returnedValue: live.reduce((s, t) => s + t.returnedValue, 0),
        writtenOffValue: live.reduce((s, t) => s + t.writtenOffValue, 0),
      },
      rows: shaped,
    });
  });

  // ── Audit log ──
  router.get("/audit-log", async (req, res) => {
    const a = auth(req);
    await pruneAudit(ctx.prisma, a.account.id, ctx.now());
    const str = (k: string) => (typeof req.query[k] === "string" && req.query[k] ? String(req.query[k]) : undefined);
    const branchId = str("branchId") ? branchFor(a, str("branchId")).id : undefined;
    const tz = a.account.timezone;
    const range = {
      ...(str("from") ? { gte: dayStart(str("from")!, tz) } : {}),
      ...(str("to") ? { lt: dayStart(addDaysTo(str("to")!, 1), tz) } : {}),
      ...(str("before") ? { lt: new Date(str("before")!) } : {}),
    };
    // Managers: what happened in their branches, plus what they did themselves.
    const scope: Prisma.AuditLogWhereInput = a.user.role === "OWNER" ? {} : { OR: [{ branchId: { in: a.branches.map((b) => b.id) } }, { userId: a.user.id }] };
    const where: Prisma.AuditLogWhereInput = {
      accountId: a.account.id,
      AND: [scope, ...(branchId ? [{ branchId }] : []), ...(str("userId") ? [{ userId: str("userId") }] : []), ...(str("action") ? [{ action: { startsWith: str("action") } }] : []), ...(Object.keys(range).length ? [{ createdAt: range }] : [])],
    };
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await ctx.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
    const page = rows.slice(0, limit);
    const users = await ctx.prisma.user.findMany({ where: { id: { in: [...new Set(page.map((r) => r.userId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true, role: true } });
    const uById = new Map(users.map((u) => [u.id, u]));
    const bById = new Map((await ctx.prisma.branch.findMany({ where: { accountId: a.account.id }, select: { id: true, code: true } })).map((b) => [b.id, b.code]));
    res.json({
      entries: page.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        userName: r.userId ? (uById.get(r.userId)?.name ?? "Removed user") : r.action.startsWith("sync.") ? "Counter (offline sync)" : "System",
        role: r.userId ? (uById.get(r.userId)?.role ?? null) : null,
        branchId: r.branchId,
        branchCode: r.branchId ? (bById.get(r.branchId) ?? null) : null,
        ip: a.user.role === "OWNER" ? r.ip : null,
        data: r.data,
      })),
      next: rows.length > limit ? page[page.length - 1]!.createdAt.toISOString() : null,
    });
  });

  router.get("/audit-log/filters", async (req, res) => {
    const a = auth(req);
    const [actions, users] = await Promise.all([
      ctx.prisma.auditLog.groupBy({ by: ["action"], where: { accountId: a.account.id }, orderBy: { action: "asc" } }),
      ctx.prisma.user.findMany({ where: { accountId: a.account.id }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
    ]);
    res.json({ actions: actions.map((x) => x.action), users });
  });

  return router;
}
