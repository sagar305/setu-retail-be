// Connected-tools books, read live from bills, credit notes, purchases and the
// few ledger tables, so deleting or cancelling anything can't leave a stale row.
//
//   Customer owes:  credit (udhaar) part of completed bills + opening/credit entries
//                   − payments received − credit notes refunded to their udhaar
//   You owe:        unpaid part of supplier bills + opening/bill entries
//                   − payments made − credit-note purchase returns
//   Cash book:      cash sales − cash refunds + cash payments received
//                   − cash expenses − cash paid to suppliers (incl. at purchase)
//                   ± manual entries
import type { RequestHandler } from "express";
import { Prisma } from "../generated/prisma/client.js";
import type { Account } from "../generated/prisma/client.js";
import type { Db } from "../db/types.js";
import { AppError } from "../http/errors.js";
import { auth } from "../auth/middleware.js";
import { settleOldestFirst } from "../lib/books.js";
import { startOfDay } from "../lib/time.js";

// ── Connected tools (Settings → Connected tools) ──
export const TOOLS = [
  { slug: "receipt-designer", name: "Receipt Designer" },
  { slug: "customer-ledger", name: "Customer Ledger (Udhaar)" },
  { slug: "cash-book", name: "Cash Book" },
  { slug: "invoice-aging", name: "Invoice Aging" },
  { slug: "expense-tracker", name: "Expense Tracker" },
  { slug: "purchase-register", name: "Purchase Register" },
  { slug: "supplier-book", name: "Supplier Book" },
  { slug: "supplier-ledger", name: "Supplier Ledger" },
  { slug: "payables-aging", name: "Payables Aging" },
  { slug: "profit-dashboard", name: "Profit Dashboard" },
  { slug: "stock-register", name: "Stock Register" },
  { slug: "barcode-generator", name: "Barcode Generator" },
] as const;
export type ToolSlug = (typeof TOOLS)[number]["slug"];
export const TOOL_SLUGS = TOOLS.map((t) => t.slug) as [ToolSlug, ...ToolSlug[]];

export const toolOn = (account: Pick<Account, "disabledTools">, slug: ToolSlug) => !account.disabledTools.includes(slug);
export const toolsDto = (account: Pick<Account, "disabledTools">) => Object.fromEntries(TOOLS.map((t) => [t.slug, toolOn(account, t.slug)])) as Record<ToolSlug, boolean>;

/** 403 while the owner has switched the tool off (any one of `slugs` being on is enough). */
export function requireTool(...slugs: ToolSlug[]): RequestHandler {
  return (req, _res, next) => {
    const account = auth(req).account;
    if (slugs.some((s) => toolOn(account, s))) return next();
    const name = TOOLS.find((t) => t.slug === slugs[0])!.name;
    next(new AppError(403, "tool_off", `${name} is switched off. The owner can turn it on in Settings → Connected tools.`));
  };
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

// ── Balances ──
export async function customerBalances(db: Db, accountId: string, customerIds?: string[]): Promise<Map<string, number>> {
  const only = customerIds ? Prisma.sql`AND x.id = ANY(${customerIds}::uuid[])` : Prisma.empty;
  const rows = await db.$queryRaw<{ id: string; balance: bigint }[]>`
    SELECT x.id, sum(x.amt) AS balance FROM (
      SELECT o."customerId" AS id, p."amount" AS amt
        FROM "order_payments" p JOIN "orders" o ON o."id" = p."orderId"
        WHERE o."accountId" = ${accountId}::uuid AND o."status" = 'COMPLETED' AND p."kind" = 'CREDIT' AND o."customerId" IS NOT NULL
      UNION ALL
      SELECT "customerId", CASE WHEN "type" = 'PAYMENT' THEN -"amount" ELSE "amount" END
        FROM "customer_ledger_entries" WHERE "accountId" = ${accountId}::uuid AND "voidedAt" IS NULL
      UNION ALL
      SELECT o."customerId", -cn."total"
        FROM "credit_notes" cn JOIN "orders" o ON o."id" = cn."orderId"
        WHERE cn."accountId" = ${accountId}::uuid AND cn."refundKind" = 'CREDIT' AND o."customerId" IS NOT NULL
    ) x WHERE TRUE ${only}
    GROUP BY x.id HAVING sum(x.amt) <> 0`;
  return new Map(rows.map((r) => [r.id, n(r.balance)]));
}

export async function supplierBalances(db: Db, accountId: string, supplierIds?: string[]): Promise<Map<string, number>> {
  const only = supplierIds ? Prisma.sql`AND x.id = ANY(${supplierIds}::uuid[])` : Prisma.empty;
  const rows = await db.$queryRaw<{ id: string; balance: bigint }[]>`
    SELECT x.id, sum(x.amt) AS balance FROM (
      SELECT "supplierId" AS id, "total" - "paidAmount" AS amt FROM "purchases" WHERE "accountId" = ${accountId}::uuid AND "cancelledAt" IS NULL
      UNION ALL
      SELECT "supplierId", CASE WHEN "type" = 'PAYMENT' THEN -"amount" ELSE "amount" END
        FROM "supplier_ledger_entries" WHERE "accountId" = ${accountId}::uuid AND "voidedAt" IS NULL
      UNION ALL
      SELECT r."supplierId", -r."total" FROM "purchase_returns" r JOIN "purchases" pu ON pu."id" = r."purchaseId"
        WHERE r."accountId" = ${accountId}::uuid AND r."mode" = 'CREDIT_NOTE' AND pu."cancelledAt" IS NULL
    ) x WHERE TRUE ${only}
    GROUP BY x.id HAVING sum(x.amt) <> 0`;
  return new Map(rows.map((r) => [r.id, n(r.balance)]));
}

// ── Statements: every movement, a running balance, and dues cleared oldest first ──
export type StatementRow = {
  id: string;
  at: string;
  /** bill | opening | credit | payment | credit_note (customer); purchase | opening | bill | payment | return (supplier) */
  type: string;
  ref: string;
  note: string;
  /** Adds to what's owed. */
  debit: number;
  /** Reduces what's owed. */
  credit: number;
  balance: number;
  methodName: string;
  branchId: string | null;
  voidable: boolean;
  dueDate: string | null;
};
export type OpenItem = { id: string; type: string; ref: string; at: string; dueDate: string | null; amount: number; paid: number; open: number; branchId: string | null };
export type Statement = { balance: number; open: number; advance: number; rows: StatementRow[]; openItems: OpenItem[] };

function buildStatement(rows: Omit<StatementRow, "balance">[]): Statement {
  // Same moment: what was owed comes before what paid it.
  const sorted = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : b.debit - a.debit || (a.id < b.id ? -1 : 1)));
  let bal = 0;
  const withBal = sorted.map((r) => ({ ...r, balance: (bal += r.debit - r.credit) }));
  const credits = sorted.reduce((s, r) => s + r.credit, 0);
  const dues = sorted.filter((r) => r.debit > 0);
  const settled = settleOldestFirst(dues.map((r) => ({ id: r.id, at: r.at, amount: r.debit })), credits);
  const byId = new Map(dues.map((r) => [r.id, r]));
  return {
    balance: bal,
    open: settled.open,
    advance: settled.advance,
    rows: withBal.reverse(),
    openItems: settled.dues.filter((d) => d.open > 0).map((d) => ({ id: d.id, type: byId.get(d.id)!.type, ref: byId.get(d.id)!.ref, at: d.at, dueDate: byId.get(d.id)!.dueDate, amount: d.amount, paid: d.paid, open: d.open, branchId: byId.get(d.id)!.branchId })),
  };
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

type Row = Omit<StatementRow, "balance">;
const group = (rows: (Row & { party: string })[]) => {
  const m = new Map<string, Row[]>();
  for (const { party, ...r } of rows) m.set(party, [...(m.get(party) ?? []), r]);
  return m;
};
const emptyStatement = (): Statement => ({ balance: 0, open: 0, advance: 0, rows: [], openItems: [] });

/** Udhaar statements for some customers (or all), in three queries. */
export async function customerStatements(db: Db, accountId: string, customerIds?: string[]): Promise<Map<string, Statement>> {
  const only = customerIds ? { in: customerIds } : { not: null };
  const [bills, entries, notes] = await Promise.all([
    db.order.findMany({
      where: { accountId, customerId: only, status: "COMPLETED", payments: { some: { kind: "CREDIT" } } },
      select: { id: true, customerId: true, invoiceNumber: true, createdAt: true, branchId: true, payments: { where: { kind: "CREDIT" }, select: { amount: true } } },
    }),
    db.customerLedgerEntry.findMany({ where: { accountId, voidedAt: null, ...(customerIds ? { customerId: { in: customerIds } } : {}) } }),
    db.creditNote.findMany({ where: { accountId, refundKind: "CREDIT", order: { customerId: only } }, select: { id: true, number: true, createdAt: true, branchId: true, total: true, order: { select: { invoiceNumber: true, customerId: true } } } }),
  ]);
  const byParty = group([
    ...bills.map((o) => ({ party: o.customerId!, id: o.id, at: o.createdAt.toISOString(), type: "bill", ref: o.invoiceNumber, note: "Udhaar on bill", debit: o.payments.reduce((s, p) => s + p.amount, 0), credit: 0, methodName: "", branchId: o.branchId, voidable: false, dueDate: null })),
    ...entries.map((e) => ({
      party: e.customerId,
      id: e.id,
      at: e.occurredAt.toISOString(),
      type: e.type.toLowerCase(),
      ref: "",
      note: e.note,
      debit: e.type === "PAYMENT" ? 0 : e.amount,
      credit: e.type === "PAYMENT" ? e.amount : 0,
      methodName: e.methodName,
      branchId: e.branchId,
      voidable: true,
      dueDate: null,
    })),
    ...notes.map((c) => ({ party: c.order.customerId!, id: c.id, at: c.createdAt.toISOString(), type: "credit_note", ref: c.number, note: `Return on ${c.order.invoiceNumber}`, debit: 0, credit: c.total, methodName: "", branchId: c.branchId, voidable: false, dueDate: null })),
  ]);
  return new Map([...byParty].map(([id, rows]) => [id, buildStatement(rows)]));
}

export async function customerStatement(db: Db, accountId: string, customerId: string): Promise<Statement> {
  return (await customerStatements(db, accountId, [customerId])).get(customerId) ?? emptyStatement();
}

/** Supplier statements for some suppliers (or all), in three queries. */
export async function supplierStatements(db: Db, accountId: string, supplierIds?: string[]): Promise<Map<string, Statement>> {
  const only = supplierIds ? { supplierId: { in: supplierIds } } : {};
  const [purchases, entries, returns] = await Promise.all([
    db.purchase.findMany({ where: { accountId, cancelledAt: null, ...only } }),
    db.supplierLedgerEntry.findMany({ where: { accountId, voidedAt: null, ...only } }),
    db.purchaseReturn.findMany({ where: { accountId, mode: "CREDIT_NOTE", purchase: { cancelledAt: null }, ...only }, include: { purchase: { select: { billNumber: true } } } }),
  ]);
  // A bill is dated by its bill date; what was paid at entry is a payment on that bill.
  const billAt = (p: { billDate: Date; createdAt: Date }) => `${day(p.billDate)}T00:00:00.000Z` < p.createdAt.toISOString() ? `${day(p.billDate)}T00:00:00.000Z` : p.createdAt.toISOString();
  const byParty = group([
    ...purchases.map((p) => ({ party: p.supplierId, id: p.id, at: billAt(p), type: "purchase", ref: p.billNumber, note: p.notes, debit: p.total, credit: 0, methodName: "", branchId: p.branchId, voidable: false, dueDate: day(p.dueDate) ?? day(p.billDate) })),
    ...purchases
      .filter((p) => p.paidAmount > 0)
      .map((p) => ({ party: p.supplierId, id: `${p.id}:paid`, at: billAt(p), type: "paid_on_bill", ref: p.billNumber, note: "Paid with the bill", debit: 0, credit: p.paidAmount, methodName: p.paidMethodName, branchId: p.branchId, voidable: false, dueDate: null })),
    ...entries.map((e) => ({
      party: e.supplierId,
      id: e.id,
      at: e.occurredAt.toISOString(),
      type: e.type.toLowerCase(),
      ref: "",
      note: e.note,
      debit: e.type === "PAYMENT" ? 0 : e.amount,
      credit: e.type === "PAYMENT" ? e.amount : 0,
      methodName: e.methodName,
      branchId: e.branchId,
      voidable: true,
      dueDate: e.type === "PAYMENT" ? null : (day(e.dueDate) ?? e.occurredAt.toISOString().slice(0, 10)),
    })),
    ...returns.map((r) => ({ party: r.supplierId, id: r.id, at: r.occurredAt.toISOString(), type: "return", ref: r.purchase.billNumber, note: r.note || "Goods returned (credit note)", debit: 0, credit: r.total, methodName: "", branchId: r.branchId, voidable: false, dueDate: null })),
  ]);
  return new Map([...byParty].map(([id, rows]) => [id, buildStatement(rows)]));
}

export async function supplierStatement(db: Db, accountId: string, supplierId: string): Promise<Statement> {
  return (await supplierStatements(db, accountId, [supplierId])).get(supplierId) ?? emptyStatement();
}

// ── Cash book (per branch) ──
export type CashLine = { id: string; at: string; day: string; direction: "IN" | "OUT"; amount: number; source: string; label: string; deletable: boolean };
export type CashDay = { day: string; opening: number; in: number; out: number; closing: number; lines: CashLine[] };

/** Start of a shop day ("yyyy-mm-dd") as an instant. */
export const dayStart = (d: string, timeZone: string) => startOfDay(new Date(`${d}T12:00:00.000Z`), timeZone);

function cashMoves(branchId: string) {
  return Prisma.sql`
    SELECT o."id"::text || ':' || p."id"::text AS id, o."createdAt" AS at, 'IN' AS dir, p."amount" AS amount, 'sale' AS source, o."invoiceNumber" AS label
      FROM "order_payments" p JOIN "orders" o ON o."id" = p."orderId"
      WHERE o."branchId" = ${branchId}::uuid AND o."status" = 'COMPLETED' AND p."kind" = 'CASH'
    UNION ALL
    SELECT "id"::text, "createdAt", 'OUT', "total", 'refund', "number" FROM "credit_notes" WHERE "branchId" = ${branchId}::uuid AND "refundKind" = 'CASH'
    UNION ALL
    SELECT e."id"::text, e."occurredAt", 'IN', e."amount", 'customer_payment', 'From ' || c."name"
      FROM "customer_ledger_entries" e JOIN "customers" c ON c."id" = e."customerId"
      WHERE e."branchId" = ${branchId}::uuid AND e."type" = 'PAYMENT' AND e."kind" = 'CASH' AND e."voidedAt" IS NULL
    UNION ALL
    SELECT "id"::text, "spentAt", 'OUT', "amount", 'expense', "category" || CASE WHEN "description" <> '' THEN ': ' || "description" ELSE '' END
      FROM "expenses" WHERE "branchId" = ${branchId}::uuid AND "kind" = 'CASH' AND "deletedAt" IS NULL
    UNION ALL
    SELECT e."id"::text, e."occurredAt", 'OUT', e."amount", 'supplier_payment', 'To ' || s."name"
      FROM "supplier_ledger_entries" e JOIN "suppliers" s ON s."id" = e."supplierId"
      WHERE e."branchId" = ${branchId}::uuid AND e."type" = 'PAYMENT' AND e."kind" = 'CASH' AND e."voidedAt" IS NULL
    UNION ALL
    SELECT pu."id"::text, pu."createdAt", 'OUT', pu."paidAmount", 'purchase', s."name" || ' bill ' || pu."billNumber"
      FROM "purchases" pu JOIN "suppliers" s ON s."id" = pu."supplierId"
      WHERE pu."branchId" = ${branchId}::uuid AND pu."paidKind" = 'CASH' AND pu."paidAmount" > 0 AND pu."cancelledAt" IS NULL
    UNION ALL
    SELECT "id"::text, "occurredAt", "type"::text, "amount", 'manual', "description" FROM "cash_entries" WHERE "branchId" = ${branchId}::uuid AND "deletedAt" IS NULL`;
}

/** Days `from`..`to` (inclusive, shop days). A day opens with the previous day's closing. */
export async function cashBook(db: Db, account: Pick<Account, "id" | "timezone">, branchId: string, from: string, to: string) {
  const tz = account.timezone;
  const opening = await db.cashOpening.findUnique({ where: { branchId } });
  const since = opening ? dayStart(day(opening.day)!, tz) : new Date(0);
  const start = dayStart(from, tz);
  const end = dayStart(addDays(to, 1), tz);
  const moves = cashMoves(branchId);
  const [before, rows] = await Promise.all([
    start > since
      ? db.$queryRaw<{ net: bigint | null }[]>`SELECT sum(CASE WHEN m.dir = 'IN' THEN m.amount ELSE -m.amount END) AS net FROM (${moves}) m WHERE m.at >= ${since} AND m.at < ${start}`
      : Promise.resolve([{ net: 0n }]),
    db.$queryRaw<{ id: string; at: Date; day: string; dir: "IN" | "OUT"; amount: number; source: string; label: string }[]>`
      SELECT m.*, to_char(m.at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day FROM (${moves}) m
      WHERE m.at >= ${start > since ? start : since} AND m.at < ${end} ORDER BY m.at, m.id`,
  ]);
  const openingDay = opening ? day(opening.day)! : null;
  // Before the owner's opening day the book is empty; on it, the balance starts at their amount.
  let balance = openingDay && from < openingDay ? 0 : (opening?.amount ?? 0) + n(before[0]?.net);
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const days: CashDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (openingDay && d === openingDay && from < openingDay) balance = opening!.amount;
    const list = openingDay && d < openingDay ? [] : (byDay.get(d) ?? []);
    // Cash sales are one line a day; everything else line by line.
    const sales = list.filter((r) => r.source === "sale");
    const lines: CashLine[] = [
      ...(sales.length ? [{ id: `sales-${d}`, at: sales[0]!.at.toISOString(), day: d, direction: "IN" as const, amount: sales.reduce((s, r) => s + n(r.amount), 0), source: "sale", label: `Cash sales (${new Set(sales.map((r) => r.label)).size} bills)`, deletable: false }] : []),
      ...list.filter((r) => r.source !== "sale").map((r) => ({ id: r.id, at: r.at.toISOString(), day: d, direction: r.dir, amount: n(r.amount), source: r.source, label: r.label, deletable: r.source === "manual" })),
    ];
    const inn = lines.filter((l) => l.direction === "IN").reduce((s, l) => s + l.amount, 0);
    const out = lines.filter((l) => l.direction === "OUT").reduce((s, l) => s + l.amount, 0);
    const open = balance;
    balance += inn - out;
    days.push({ day: d, opening: open, in: inn, out, closing: balance, lines });
  }
  return { opening: opening ? { day: day(opening.day)!, amount: opening.amount } : null, days };
}

export function addDays(d: string, k: number): string {
  const t = new Date(`${d}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
}
