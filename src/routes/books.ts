// Connected money tools: Supplier Book, Expense Tracker, Customer Ledger
// (udhaar), Supplier Ledger and Cash Book. Purchases live in purchases.ts.
//
// Roles: everyone may see udhaar balances and receive a payment; expenses,
// suppliers, payments made and the cash book are owner/manager. Managers only
// touch their own branches.
import { Router, type Request } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import type { Expense, PaymentMethod, Supplier } from "../generated/prisma/client.js";
import type { Db } from "../db/types.js";
import { isUniqueViolation } from "../db/errors.js";
import { mergeFields, offlineMeta, recordClashes, recordRemovedEdit } from "../services/conflicts.js";
import { AppError } from "../http/errors.js";
import { normalizePhone } from "../lib/normalize.js";
import { parseTaxNumber, stateFromTaxNumber, taxNumberMessage } from "../lib/taxes.js";
type TaxAcc = Parameters<typeof parseTaxNumber>[0];
import { audit } from "../services/audit.js";
import { addDays, cashBook, dayStart, customerBalances, customerStatement, requireTool, supplierBalances, supplierStatement } from "../services/books.js";
import { fromDay } from "../services/batches.js";
import { changes } from "../lib/diff.js";
import { CashEntryBody, CashOpeningBody, ExpenseBody, ExpensePatchBody, OpeningBody, PaymentBody, SupplierBody, SupplierPatchBody, VoidBody } from "../schemas4.js";
import { branchFor } from "./access.js";
import { customerDto } from "./customers.js";
import { shopToday } from "./catalogue.js";

export const DEFAULT_EXPENSE_CATEGORIES = ["Rent", "Salaries", "Electricity", "Purchases", "Transport", "Repairs", "Marketing", "Internet & phone", "Supplies", "Other"];

export const supplierDto = (s: Supplier, balance = 0) => ({
  id: s.id,
  name: s.name,
  phone: s.phone,
  email: s.email,
  gstin: s.gstin,
  stateCode: s.stateCode,
  address: s.address,
  notes: s.notes,
  balance,
  createdAt: s.createdAt.toISOString(),
});

export const expenseDto = (e: Expense, names: { supplier?: string | null; user?: string | null } = {}) => ({
  id: e.id,
  branchId: e.branchId,
  spentAt: e.spentAt.toISOString(),
  category: e.category,
  description: e.description,
  amount: e.amount,
  methodId: e.methodId,
  methodName: e.methodName,
  kind: e.kind,
  supplierId: e.supplierId,
  supplierName: names.supplier ?? null,
  userName: names.user ?? "",
  offline: e.offline,
});

/** A payment method that moves money now (not udhaar). */
export async function moneyMethod(db: Db, accountId: string, methodId: string): Promise<PaymentMethod> {
  const m = await db.paymentMethod.findFirst({ where: { id: methodId, accountId } });
  if (!m) throw new AppError(400, "bad_payment_method", "Pick how the money was paid.");
  if (m.kind === "CREDIT") throw new AppError(400, "bad_payment_method", "Udhaar can't pay this. Pick cash, UPI, card or another method.");
  return m;
}

function cleanSupplier(account: TaxAcc, body: { phone?: string; gstin?: string; stateCode?: string }) {
  const out: { phone?: string; gstin?: string | null; stateCode?: string | null } = {};
  if (body.phone !== undefined) {
    if (body.phone === "") out.phone = "";
    else {
      const p = normalizePhone(body.phone);
      if (!p) throw new AppError(400, "invalid_phone", "Enter a valid phone number.");
      out.phone = p;
    }
  }
  if (body.gstin !== undefined) {
    if (body.gstin === "") out.gstin = null;
    else {
      const g = parseTaxNumber(account, body.gstin);
      if (!g) throw new AppError(400, "invalid_gstin", taxNumberMessage(account));
      out.gstin = g;
    }
  }
  if (body.stateCode !== undefined) out.stateCode = body.stateCode || null;
  if (out.gstin && !out.stateCode && !body.stateCode) out.stateCode = stateFromTaxNumber(account, out.gstin);
  return out;
}

const at = (ctx: Ctx, v: string | undefined) => {
  const now = ctx.now();
  if (!v) return now;
  const d = new Date(v);
  // Back-dating is fine; the future isn't.
  return d > now ? now : d;
};

const OM = requireRole("OWNER", "MANAGER");

function dayRange(ctx: Ctx, a: AuthContext, req: Request) {
  const today = shopToday(ctx.now(), a.account.timezone);
  const ok = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const to = ok(req.query.to) ? String(req.query.to) : today;
  const from = ok(req.query.from) ? String(req.query.from) : to;
  if (from > to) throw new AppError(400, "bad_range", "Pick a valid date range.");
  if (fromDay(to).getTime() - fromDay(from).getTime() > 400 * 86_400_000) throw new AppError(400, "range_too_long", "Pick a range of up to 400 days.");
  return { from, to };
}

export function booksRouter(ctx: Ctx): Router {
  const router = Router();
  // /customers/... is also authenticated by the customers router; don't look the session up twice.
  const signIn = authenticate(ctx);
  const base = [(req: Request, res: Parameters<typeof signIn>[1], next: Parameters<typeof signIn>[2]) => (req.auth ? next() : signIn(req, res, next)), requireActivePlan];
  router.use(["/suppliers", "/expenses", "/expense-categories", "/ledger", "/cash-book"], ...base);
  router.use(["/customers/:id/ledger", "/customers/:id/payments", "/customers/:id/opening"], ...base);

  // ── Supplier Book ──
  const SUPPLIER_TOOLS = requireTool("supplier-book", "purchase-register", "supplier-ledger", "expense-tracker");
  router.get("/suppliers", OM, SUPPLIER_TOOLS, async (req, res) => {
    const a = auth(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rows = await ctx.prisma.supplier.findMany({
      where: { accountId: a.account.id, archivedAt: null, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q.replace(/\D/g, "") || q } }, { gstin: q.toUpperCase() }] } : {}) },
      orderBy: { name: "asc" },
      take: 500,
    });
    const balances = await supplierBalances(ctx.prisma, a.account.id, rows.map((r) => r.id));
    res.json({ suppliers: rows.map((s) => supplierDto(s, balances.get(s.id) ?? 0)) });
  });

  router.post("/suppliers", OM, SUPPLIER_TOOLS, async (req, res) => {
    const a = auth(req);
    const body = SupplierBody.parse(req.body);
    const s = await ctx.prisma.supplier.create({ data: { accountId: a.account.id, ...body, ...cleanSupplier(a.account, body) } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "supplier.created", entityType: "supplier", entityId: s.id });
    res.status(201).json({ supplier: supplierDto(s) });
  });

  async function findSupplier(a: AuthContext, id: unknown) {
    const s = await ctx.prisma.supplier.findFirst({ where: { id: String(id), accountId: a.account.id } });
    if (!s) throw new AppError(404, "not_found", "Supplier not found.");
    return s;
  }

  router.get("/suppliers/:id", OM, SUPPLIER_TOOLS, async (req, res) => {
    const a = auth(req);
    const s = await findSupplier(a, req.params.id);
    const balances = await supplierBalances(ctx.prisma, a.account.id, [s.id]);
    res.json({ supplier: supplierDto(s, balances.get(s.id) ?? 0) });
  });

  router.patch("/suppliers/:id", OM, SUPPLIER_TOOLS, async (req, res) => {
    const a = auth(req);
    const found = await findSupplier(a, req.params.id);
    const body = SupplierPatchBody.parse(req.body);
    const { base, changedAt } = offlineMeta(req);
    const subject = { entityType: "supplier" as const, entityId: found.id, label: found.name };
    if (base && found.archivedAt) {
      await recordRemovedEdit(ctx.prisma, a, subject, body, changedAt, ctx.now());
      return void res.json({ supplier: supplierDto(found), conflicts: 1 });
    }
    const { apply: data, clashes } = mergeFields(found, { ...body, ...cleanSupplier(a.account, body) }, base);
    const conflicts = await recordClashes(ctx.prisma, a, subject, clashes, changedAt, ctx.now());
    const s = Object.keys(data).length ? await ctx.prisma.supplier.update({ where: { id: found.id }, data }) : found;
    const changed = changes(found, data);
    if (Object.keys(changed).length) await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "supplier.updated", entityType: "supplier", entityId: s.id, data: { name: found.name, changes: changed } as never });
    const balances = await supplierBalances(ctx.prisma, a.account.id, [s.id]);
    res.json({ supplier: supplierDto(s, balances.get(s.id) ?? 0), conflicts });
  });

  router.delete("/suppliers/:id", OM, SUPPLIER_TOOLS, async (req, res) => {
    const a = auth(req);
    const s = await findSupplier(a, req.params.id);
    const balance = (await supplierBalances(ctx.prisma, a.account.id, [s.id])).get(s.id) ?? 0;
    if (balance !== 0) throw new AppError(409, "has_balance", "Settle this supplier's balance before removing them.");
    await ctx.prisma.supplier.update({ where: { id: s.id }, data: { archivedAt: ctx.now() } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "supplier.archived", entityType: "supplier", entityId: s.id, data: { name: s.name } });
    res.status(204).end();
  });

  // ── Expense Tracker ──
  const EXPENSES = [OM, requireTool("expense-tracker")];
  router.get("/expense-categories", ...EXPENSES, async (req, res) => {
    const used = await ctx.prisma.expense.groupBy({ by: ["category"], where: { accountId: auth(req).account.id, deletedAt: null } });
    const all = [...DEFAULT_EXPENSE_CATEGORIES];
    for (const u of used) if (!all.some((c) => c.toLowerCase() === u.category.toLowerCase())) all.push(u.category);
    res.json({ categories: all });
  });

  router.get("/expenses", ...EXPENSES, async (req, res) => {
    const a = auth(req);
    const { from, to } = dayRange(ctx, a, req);
    const branchIds = typeof req.query.branchId === "string" && req.query.branchId ? [branchFor(a, req.query.branchId).id] : a.branches.map((b) => b.id);
    const category = typeof req.query.category === "string" && req.query.category ? req.query.category : undefined;
    const where = { accountId: a.account.id, branchId: { in: branchIds }, deletedAt: null, spentAt: { gte: dayStart(from, a.account.timezone), lt: dayStart(addDays(to, 1), a.account.timezone) }, ...(category ? { category } : {}) };
    const [rows, byCategory] = await Promise.all([
      ctx.prisma.expense.findMany({ where, orderBy: { spentAt: "desc" }, take: 2000 }),
      ctx.prisma.expense.groupBy({ by: ["category"], where, _sum: { amount: true }, orderBy: { _sum: { amount: "desc" } } }),
    ]);
    const names = await namesFor(ctx.prisma, rows);
    res.json({
      from,
      to,
      total: byCategory.reduce((s, c) => s + (c._sum.amount ?? 0), 0),
      byCategory: byCategory.map((c) => ({ category: c.category, amount: c._sum.amount ?? 0 })),
      expenses: rows.map((e) => expenseDto(e, { supplier: e.supplierId ? names.suppliers.get(e.supplierId) : null, user: e.userId ? names.users.get(e.userId) : null })),
    });
  });

  router.post("/expenses", ...EXPENSES, async (req, res) => {
    const a = auth(req);
    const body = ExpenseBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const existing = await ctx.prisma.expense.findUnique({ where: { id: body.id } });
    if (existing) {
      if (existing.accountId !== a.account.id) throw new AppError(409, "id_taken", "That id is already used.");
      return res.status(200).json({ expense: expenseDto(existing), replayed: true });
    }
    const m = await moneyMethod(ctx.prisma, a.account.id, body.methodId);
    if (body.supplierId) await findSupplier(a, body.supplierId);
    const e = await ctx.prisma.expense.create({
      data: { id: body.id, accountId: a.account.id, branchId: branch.id, spentAt: at(ctx, body.spentAt), category: body.category, description: body.description ?? "", amount: body.amount, methodId: m.id, methodName: m.name, kind: m.kind, supplierId: body.supplierId ?? null, userId: a.user.id },
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "expense.created", entityType: "expense", entityId: e.id, data: { category: e.category, amount: e.amount, method: e.methodName } });
    res.status(201).json({ expense: expenseDto(e, { user: a.user.name }) });
  });

  async function findExpense(a: AuthContext, id: unknown) {
    const e = await ctx.prisma.expense.findFirst({ where: { id: String(id), accountId: a.account.id, deletedAt: null } });
    if (!e) throw new AppError(404, "not_found", "Expense not found.");
    branchFor(a, e.branchId, true);
    return e;
  }

  router.patch("/expenses/:id", ...EXPENSES, async (req, res) => {
    const a = auth(req);
    const found = await findExpense(a, req.params.id);
    const body = ExpensePatchBody.parse(req.body);
    const m = body.methodId ? await moneyMethod(ctx.prisma, a.account.id, body.methodId) : null;
    if (body.supplierId) await findSupplier(a, body.supplierId);
    const e = await ctx.prisma.expense.update({
      where: { id: found.id },
      data: {
        category: body.category,
        description: body.description,
        amount: body.amount,
        spentAt: body.spentAt ? at(ctx, body.spentAt) : undefined,
        supplierId: body.supplierId === undefined ? undefined : body.supplierId,
        ...(m ? { methodId: m.id, methodName: m.name, kind: m.kind } : {}),
      },
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: e.branchId, action: "expense.updated", entityType: "expense", entityId: e.id, data: { before: { amount: found.amount, category: found.category }, after: { amount: e.amount, category: e.category } } });
    res.json({ expense: expenseDto(e) });
  });

  router.delete("/expenses/:id", ...EXPENSES, async (req, res) => {
    const a = auth(req);
    const e = await findExpense(a, req.params.id);
    await ctx.prisma.expense.update({ where: { id: e.id }, data: { deletedAt: ctx.now() } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: e.branchId, action: "expense.deleted", entityType: "expense", entityId: e.id, data: { amount: e.amount, category: e.category } });
    res.status(204).end();
  });

  // ── Customer Ledger (udhaar) ──
  const CUSTOMER_LEDGER = requireTool("customer-ledger", "invoice-aging");
  router.get("/ledger/customers", CUSTOMER_LEDGER, async (req, res) => {
    const a = auth(req);
    const balances = await customerBalances(ctx.prisma, a.account.id);
    const customers = await ctx.prisma.customer.findMany({ where: { id: { in: [...balances.keys()] }, accountId: a.account.id } });
    const rows = customers.map((c) => ({ customer: customerDto(c), balance: balances.get(c.id)! })).sort((x, y) => y.balance - x.balance);
    res.json({ owed: rows.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0), advance: -rows.filter((r) => r.balance < 0).reduce((s, r) => s + r.balance, 0), customers: rows });
  });

  async function findCustomer(a: AuthContext, id: unknown) {
    const c = await ctx.prisma.customer.findFirst({ where: { id: String(id), accountId: a.account.id } });
    if (!c) throw new AppError(404, "not_found", "Customer not found.");
    return c;
  }

  router.get("/customers/:id/ledger", CUSTOMER_LEDGER, async (req, res) => {
    const a = auth(req);
    const c = await findCustomer(a, req.params.id);
    res.json({ customer: customerDto(c), ...(await customerStatement(ctx.prisma, a.account.id, c.id)) });
  });

  router.post("/customers/:id/payments", requireTool("customer-ledger"), async (req, res) => {
    const a = auth(req);
    const c = await findCustomer(a, req.params.id);
    const body = PaymentBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const m = await moneyMethod(ctx.prisma, a.account.id, body.methodId);
    try {
      await ctx.prisma.customerLedgerEntry.create({
        data: { id: body.id, accountId: a.account.id, customerId: c.id, branchId: branch.id, type: "PAYMENT", amount: body.amount, occurredAt: at(ctx, body.occurredAt), methodId: m.id, methodName: m.name, kind: m.kind, note: body.note ?? "", userId: a.user.id },
      });
      await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "ledger.customer_payment", entityType: "customer", entityId: c.id, data: { name: c.name, amount: body.amount, method: m.name } });
    } catch (err) {
      // Same id again: the payment is already recorded.
      if (!isUniqueViolation(err)) throw err;
    }
    res.status(201).json({ customer: customerDto(c), ...(await customerStatement(ctx.prisma, a.account.id, c.id)) });
  });

  router.post("/customers/:id/opening", OM, requireTool("customer-ledger"), async (req, res) => {
    const a = auth(req);
    const c = await findCustomer(a, req.params.id);
    const body = OpeningBody.parse(req.body);
    try {
      await ctx.prisma.customerLedgerEntry.create({ data: { id: body.id, accountId: a.account.id, customerId: c.id, type: "OPENING", amount: body.amount, occurredAt: fromDay(body.date), note: body.note || "Opening balance", userId: a.user.id } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "ledger.customer_opening", entityType: "customer", entityId: c.id, data: { amount: body.amount, date: body.date } });
    res.status(201).json({ customer: customerDto(c), ...(await customerStatement(ctx.prisma, a.account.id, c.id)) });
  });

  router.post("/ledger/customer-entries/:id/void", OM, requireTool("customer-ledger"), async (req, res) => {
    const a = auth(req);
    const body = VoidBody.parse(req.body ?? {});
    const e = await ctx.prisma.customerLedgerEntry.findFirst({ where: { id: String(req.params.id), accountId: a.account.id, voidedAt: null } });
    if (!e) throw new AppError(404, "not_found", "Entry not found.");
    if (e.branchId) branchFor(a, e.branchId, true);
    await ctx.prisma.customerLedgerEntry.update({ where: { id: e.id }, data: { voidedAt: ctx.now(), voidedById: a.user.id } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: e.branchId, action: "ledger.customer_entry_voided", entityType: "customer", entityId: e.customerId, data: { entryId: e.id, type: e.type, amount: e.amount, reason: body.reason ?? "" } });
    res.json({ ...(await customerStatement(ctx.prisma, a.account.id, e.customerId)) });
  });

  // ── Supplier Ledger ──
  const SUPPLIER_LEDGER = [OM, requireTool("supplier-ledger", "payables-aging")];
  router.get("/ledger/suppliers", ...SUPPLIER_LEDGER, async (req, res) => {
    const a = auth(req);
    const balances = await supplierBalances(ctx.prisma, a.account.id);
    const suppliers = await ctx.prisma.supplier.findMany({ where: { id: { in: [...balances.keys()] }, accountId: a.account.id } });
    const rows = suppliers.map((s) => ({ supplier: supplierDto(s, balances.get(s.id)!), balance: balances.get(s.id)! })).sort((x, y) => y.balance - x.balance);
    res.json({ owed: rows.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0), advance: -rows.filter((r) => r.balance < 0).reduce((s, r) => s + r.balance, 0), suppliers: rows });
  });

  router.get("/suppliers/:id/ledger", ...SUPPLIER_LEDGER, async (req, res) => {
    const a = auth(req);
    const s = await findSupplier(a, req.params.id);
    const st = await supplierStatement(ctx.prisma, a.account.id, s.id);
    res.json({ supplier: supplierDto(s, st.balance), ...st });
  });

  router.post("/suppliers/:id/payments", OM, requireTool("supplier-ledger"), async (req, res) => {
    const a = auth(req);
    const s = await findSupplier(a, req.params.id);
    const body = PaymentBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const m = await moneyMethod(ctx.prisma, a.account.id, body.methodId);
    try {
      await ctx.prisma.supplierLedgerEntry.create({
        data: { id: body.id, accountId: a.account.id, supplierId: s.id, branchId: branch.id, type: "PAYMENT", amount: body.amount, occurredAt: at(ctx, body.occurredAt), methodId: m.id, methodName: m.name, kind: m.kind, note: body.note ?? "", userId: a.user.id },
      });
      await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "ledger.supplier_payment", entityType: "supplier", entityId: s.id, data: { name: s.name, amount: body.amount, method: m.name } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    const st = await supplierStatement(ctx.prisma, a.account.id, s.id);
    res.status(201).json({ supplier: supplierDto(s, st.balance), ...st });
  });

  router.post("/suppliers/:id/opening", OM, requireTool("supplier-ledger"), async (req, res) => {
    const a = auth(req);
    const s = await findSupplier(a, req.params.id);
    const body = OpeningBody.parse(req.body);
    try {
      await ctx.prisma.supplierLedgerEntry.create({ data: { id: body.id, accountId: a.account.id, supplierId: s.id, type: "OPENING", amount: body.amount, occurredAt: fromDay(body.date), dueDate: body.dueDate ? fromDay(body.dueDate) : null, note: body.note || "Opening balance", userId: a.user.id } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "ledger.supplier_opening", entityType: "supplier", entityId: s.id, data: { amount: body.amount, date: body.date } });
    const st = await supplierStatement(ctx.prisma, a.account.id, s.id);
    res.status(201).json({ supplier: supplierDto(s, st.balance), ...st });
  });

  router.post("/ledger/supplier-entries/:id/void", OM, requireTool("supplier-ledger"), async (req, res) => {
    const a = auth(req);
    const body = VoidBody.parse(req.body ?? {});
    const e = await ctx.prisma.supplierLedgerEntry.findFirst({ where: { id: String(req.params.id), accountId: a.account.id, voidedAt: null } });
    if (!e) throw new AppError(404, "not_found", "Entry not found.");
    if (e.branchId) branchFor(a, e.branchId, true);
    await ctx.prisma.supplierLedgerEntry.update({ where: { id: e.id }, data: { voidedAt: ctx.now(), voidedById: a.user.id } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: e.branchId, action: "ledger.supplier_entry_voided", entityType: "supplier", entityId: e.supplierId, data: { entryId: e.id, type: e.type, amount: e.amount, reason: body.reason ?? "" } });
    res.json({ ...(await supplierStatement(ctx.prisma, a.account.id, e.supplierId)) });
  });

  // ── Cash Book (per branch) ──
  const CASH = [OM, requireTool("cash-book")];
  router.get("/cash-book", ...CASH, async (req, res) => {
    const a = auth(req);
    const branch = branchFor(a, req.query.branchId);
    const { from, to } = dayRange(ctx, a, req);
    if (fromDay(to).getTime() - fromDay(from).getTime() > 92 * 86_400_000) throw new AppError(400, "range_too_long", "Pick up to 3 months at a time.");
    res.json({ branchId: branch.id, ...(await cashBook(ctx.prisma, a.account, branch.id, from, to)) });
  });

  router.post("/cash-book/entries", ...CASH, async (req, res) => {
    const a = auth(req);
    const body = CashEntryBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    try {
      await ctx.prisma.cashEntry.create({ data: { id: body.id, accountId: a.account.id, branchId: branch.id, type: body.type, amount: body.amount, description: body.description, occurredAt: at(ctx, body.occurredAt), userId: a.user.id } });
      await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "cash_book.entry_added", entityType: "cash_entry", entityId: body.id, data: { type: body.type, amount: body.amount, description: body.description } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    res.status(201).json({ saved: true });
  });

  router.delete("/cash-book/entries/:id", ...CASH, async (req, res) => {
    const a = auth(req);
    const e = await ctx.prisma.cashEntry.findFirst({ where: { id: String(req.params.id), accountId: a.account.id, deletedAt: null } });
    if (!e) throw new AppError(404, "not_found", "Entry not found.");
    branchFor(a, e.branchId, true);
    await ctx.prisma.cashEntry.update({ where: { id: e.id }, data: { deletedAt: ctx.now() } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: e.branchId, action: "cash_book.entry_deleted", entityType: "cash_entry", entityId: e.id, data: { type: e.type, amount: e.amount, description: e.description } });
    res.status(204).end();
  });

  router.put("/cash-book/opening", requireRole("OWNER"), requireTool("cash-book"), async (req, res) => {
    const a = auth(req);
    const body = CashOpeningBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    await ctx.prisma.cashOpening.upsert({
      where: { branchId: branch.id },
      create: { branchId: branch.id, accountId: a.account.id, day: fromDay(body.day), amount: body.amount, userId: a.user.id },
      update: { day: fromDay(body.day), amount: body.amount, userId: a.user.id },
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "cash_book.opening_set", entityType: "branch", entityId: branch.id, data: body });
    res.json({ opening: { day: body.day, amount: body.amount } });
  });

  return router;
}

async function namesFor(db: Db, rows: { supplierId: string | null; userId: string | null }[]) {
  const sIds = [...new Set(rows.map((r) => r.supplierId).filter((x): x is string => Boolean(x)))];
  const uIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => Boolean(x)))];
  const [s, u] = await Promise.all([
    sIds.length ? db.supplier.findMany({ where: { id: { in: sIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    uIds.length ? db.user.findMany({ where: { id: { in: uIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  return { suppliers: new Map(s.map((x) => [x.id, x.name])), users: new Map(u.map((x) => [x.id, x.name])) };
}
