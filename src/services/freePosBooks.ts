// Free Browser POS backup → connected-tools history: suppliers, expenses,
// manual cash book lines, customer ledger (udhaar), supplier ledger,
// purchases and purchase returns. Imported rows keep their dates and are
// marked importedFrom = "free-pos"; purchases don't move stock (stock comes
// across with the products). Ids are derived from the backup's ids, so
// importing the same file again doesn't duplicate anything.
//
// Free POS shapes: Setu_main/lib/toolkit/types.ts. Money there is rupees.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Account, Branch, PaymentKind, PaymentMethod } from "../generated/prisma/client.js";
import type { Db } from "../db/types.js";
import { GSTIN_PATTERN, normalizePhone, normalizeTaxNumber } from "../lib/normalize.js";
import { fromDay } from "./batches.js";
import { dayStart } from "./books.js";

const num = z.coerce.number();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((s) => s.slice(0, 10));
const FreeSupplier = z.object({ id: z.string(), name: z.string().min(1), phone: z.string().optional().default(""), email: z.string().optional().default(""), gstin: z.string().optional().default(""), address: z.string().optional().default(""), notes: z.string().optional().default("") });
const FreeExpense = z.object({ id: z.string(), date: day, category: z.string().optional().default("Other"), description: z.string().optional().default(""), amount: num, paymentMode: z.string().optional().default(""), supplierId: z.string().nullable().optional() });
const FreeCash = z.object({ id: z.string(), date: day, type: z.enum(["in", "out"]), amount: num, description: z.string().optional().default("") });
const FreeLedger = z.object({ id: z.string(), customerId: z.string(), customerName: z.string().optional().default(""), type: z.enum(["credit", "payment"]), amount: num, note: z.string().optional().default(""), date: day });
const FreeSupplierLedger = z.object({ id: z.string(), supplierId: z.string().nullable().optional(), supplierName: z.string().optional().default(""), type: z.enum(["bill", "payment"]), amount: num, note: z.string().optional().default(""), date: day, paymentMode: z.string().optional().default("") });
const FreePurchaseItem = z.object({ productId: z.string().nullable().optional(), name: z.string().optional().default("Item"), quantity: num, unitCost: num, batchNo: z.string().optional(), expiry: z.string().optional() });
const FreePurchase = z.object({ id: z.string(), supplierId: z.string().nullable().optional(), supplierName: z.string().optional().default(""), billNumber: z.string().optional().default(""), date: day, items: z.array(FreePurchaseItem).optional().default([]), total: num, paymentMode: z.string().optional().default(""), expenseId: z.string().optional(), notes: z.string().optional().default("") });
const FreeReturn = z.object({ id: z.string(), purchaseId: z.string(), date: day, mode: z.enum(["replacement", "credit-note"]), items: z.array(z.object({ itemIndex: num, name: z.string().optional().default("Item"), quantity: num, unitCost: num })).optional().default([]), amount: num, status: z.enum(["settled", "pending", "received"]).optional().default("settled"), note: z.string().optional().default("") });
const FreeCustomer = z.object({ id: z.string(), name: z.string(), phone: z.string().optional().default("") });

const parseAll = <T extends z.ZodType>(schema: T, raw: unknown[] | undefined) => (raw ?? []).map((r) => schema.safeParse(r)).filter((r) => r.success).map((r) => r.data as z.infer<T>);
const paise = (v: number) => Math.round(v * 100);
const milli = (v: number) => Math.round(v * 1000);

/** A stable UUID for a backup row, so re-importing finds the same record. */
export function importedId(accountId: string, store: string, freeId: string): string {
  const h = createHash("sha256").update(`${accountId}:${store}:${freeId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const isCredit = (mode: string) => mode.trim().toLowerCase() === "credit";

export type BooksImportResult = { suppliers: number; expenses: number; cashEntries: number; customerLedger: number; supplierLedger: number; purchases: number; purchaseReturns: number };

export async function importFreePosBooks(
  db: Db,
  args: { account: Account; branch: Branch; userId: string; data: Record<string, unknown[]>; productIds: Map<string, string> },
): Promise<BooksImportResult> {
  const { account, branch, data: d } = args;
  const tz = account.timezone;
  const id = (store: string, freeId: string) => importedId(account.id, store, freeId);
  // Rows dated by day are placed at noon in the shop's time zone.
  const atDay = (s: string) => new Date(dayStart(s, tz).getTime() + 12 * 3600_000);
  const methods = await db.paymentMethod.findMany({ where: { accountId: account.id } });
  // The free POS counts a payment with no mode as cash, so do we.
  const method = (mode: string): { m: PaymentMethod | null; name: string; kind: PaymentKind } => {
    const t = mode.trim().toLowerCase();
    const byName = t ? methods.find((m) => m.name.toLowerCase() === t) : undefined;
    const kind: PaymentKind = byName?.kind ?? (!t || t === "cash" ? "CASH" : t === "upi" ? "UPI" : t === "card" ? "CARD" : "OTHER");
    const m = byName ?? methods.find((x) => x.kind === kind && x.active) ?? null;
    return { m, name: m?.name ?? (mode.trim() || "Cash"), kind: kind === "CREDIT" ? "OTHER" : kind };
  };
  const result: BooksImportResult = { suppliers: 0, expenses: 0, cashEntries: 0, customerLedger: 0, supplierLedger: 0, purchases: 0, purchaseReturns: 0 };

  // ── Suppliers: match GSTIN, phone, then name ──
  const existing = await db.supplier.findMany({ where: { accountId: account.id, archivedAt: null } });
  const supplierIds = new Map<string, string>();
  const byName = new Map<string, string>();
  const ensureSupplier = async (s: { id?: string; name: string; phone?: string; email?: string; gstin?: string; address?: string; notes?: string }) => {
    const phone = s.phone ? (normalizePhone(s.phone) ?? "") : "";
    const g = s.gstin ? normalizeTaxNumber(s.gstin) : null;
    const gstin = g && GSTIN_PATTERN.test(g) ? g : null;
    const name = s.name.trim().slice(0, 120) || "Supplier";
    const found = (gstin && existing.find((x) => x.gstin === gstin)) || (phone && existing.find((x) => x.phone === phone)) || existing.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const created = await db.supplier.create({ data: { accountId: account.id, name, phone, email: s.email ?? "", gstin, stateCode: gstin?.slice(0, 2) ?? null, address: s.address ?? "", notes: s.notes ?? "" } });
    existing.push(created);
    result.suppliers += 1;
    return created.id;
  };
  for (const s of parseAll(FreeSupplier, d.suppliers)) {
    const sid = await ensureSupplier(s);
    supplierIds.set(s.id, sid);
    byName.set(s.name.trim().toLowerCase(), sid);
  }
  const supplierFor = async (freeId: string | null | undefined, name: string) => (freeId && supplierIds.get(freeId)) || byName.get(name.trim().toLowerCase()) || (name.trim() ? await ensureSupplier({ name }).then((x) => (byName.set(name.trim().toLowerCase(), x), x)) : null);

  // ── Purchases (history: no stock change) ──
  const purchases = parseAll(FreePurchase, d.purchases);
  const mirroredExpenses = new Set(purchases.map((p) => p.expenseId).filter((x): x is string => Boolean(x)));
  const purchaseItems = new Map<string, string[]>();
  for (const p of purchases) {
    const supplierId = await supplierFor(p.supplierId, p.supplierName || "Supplier");
    if (!supplierId) continue;
    const pid = id("purchases", p.id);
    const items = p.items.map((it, i) => ({ id: id("purchase_items", `${p.id}:${i}`), it, taxable: Math.round((paise(it.unitCost) * milli(it.quantity)) / 1000) }));
    purchaseItems.set(p.id, items.map((x) => x.id));
    if (await db.purchase.findUnique({ where: { id: pid }, select: { id: true } })) continue;
    const total = paise(p.total);
    const credit = isCredit(p.paymentMode);
    const pay = method(p.paymentMode);
    await db.purchase.create({
      data: {
        id: pid,
        accountId: account.id,
        branchId: branch.id,
        supplierId,
        billNumber: (p.billNumber || p.id).slice(0, 60),
        billDate: fromDay(p.date),
        taxableTotal: total,
        cgstTotal: 0,
        sgstTotal: 0,
        igstTotal: 0,
        total,
        paidAmount: credit ? 0 : total,
        paidMethodId: credit ? null : (pay.m?.id ?? null),
        paidMethodName: credit ? "" : pay.name,
        paidKind: credit ? null : pay.kind,
        notes: p.notes.slice(0, 500),
        stockApplied: false,
        importedFrom: "free-pos",
        userId: args.userId,
        createdAt: atDay(p.date),
        items: {
          create: items.map(({ id: itemId, it, taxable }) => ({
            id: itemId,
            productId: (it.productId && args.productIds.get(it.productId)) || null,
            name: it.name.slice(0, 200),
            qtyMilli: Math.max(1, milli(it.quantity)),
            unitCost: paise(it.unitCost),
            taxable,
            cgst: 0,
            sgst: 0,
            igst: 0,
            total: taxable,
            batchNo: it.batchNo ?? "",
            expiry: it.expiry && /^\d{4}-\d{2}-\d{2}$/.test(it.expiry) ? fromDay(it.expiry) : null,
          })),
        },
      },
    });
    result.purchases += 1;
  }

  for (const r of parseAll(FreeReturn, d.purchase_returns)) {
    const pid = id("purchases", r.purchaseId);
    const p = await db.purchase.findUnique({ where: { id: pid }, select: { id: true, supplierId: true } });
    const rid = id("purchase_returns", r.id);
    if (!p || (await db.purchaseReturn.findUnique({ where: { id: rid }, select: { id: true } }))) continue;
    const itemIds = purchaseItems.get(r.purchaseId) ?? [];
    const total = paise(r.amount);
    await db.purchaseReturn.create({
      data: {
        id: rid,
        accountId: account.id,
        branchId: branch.id,
        purchaseId: p.id,
        supplierId: p.supplierId,
        mode: r.mode === "credit-note" ? "CREDIT_NOTE" : "REPLACEMENT",
        status: r.mode === "credit-note" ? "SETTLED" : r.status === "pending" ? "PENDING" : "RECEIVED",
        taxableTotal: total,
        cgstTotal: 0,
        sgstTotal: 0,
        igstTotal: 0,
        total,
        note: r.note.slice(0, 300),
        occurredAt: atDay(r.date),
        importedFrom: "free-pos",
        userId: args.userId,
        items: { create: r.items.map((x) => { const t = Math.round((paise(x.unitCost) * milli(x.quantity)) / 1000); return { purchaseItemId: itemIds[x.itemIndex] ?? null, name: x.name.slice(0, 200), qtyMilli: Math.max(1, milli(x.quantity)), taxable: t, cgst: 0, sgst: 0, igst: 0, total: t }; }) },
      },
    });
    result.purchaseReturns += 1;
  }

  // ── Expenses (not the old copies of purchases) ──
  const expenses = parseAll(FreeExpense, d.expenses).filter((e) => !mirroredExpenses.has(e.id) && !isCredit(e.paymentMode) && e.amount > 0);
  const expenseRows = await Promise.all(
    expenses.map(async (e) => {
      const pay = method(e.paymentMode);
      return {
        id: id("expenses", e.id),
        accountId: account.id,
        branchId: branch.id,
        spentAt: atDay(e.date),
        category: e.category.slice(0, 120) || "Other",
        description: e.description.slice(0, 300),
        amount: paise(e.amount),
        methodId: pay.m?.id ?? null,
        methodName: pay.name,
        kind: pay.kind,
        supplierId: e.supplierId ? (supplierIds.get(e.supplierId) ?? null) : null,
        userId: args.userId,
        importedFrom: "free-pos",
      };
    }),
  );
  if (expenseRows.length) result.expenses = (await db.expense.createMany({ data: expenseRows, skipDuplicates: true })).count;

  // ── Manual cash book lines ──
  const cash = parseAll(FreeCash, d.cashbook).filter((c) => c.amount > 0);
  if (cash.length) {
    result.cashEntries = (
      await db.cashEntry.createMany({
        data: cash.map((c) => ({ id: id("cashbook", c.id), accountId: account.id, branchId: branch.id, type: c.type === "in" ? ("IN" as const) : ("OUT" as const), amount: paise(c.amount), occurredAt: atDay(c.date), description: (c.description || (c.type === "in" ? "Cash in" : "Cash out")).slice(0, 120), userId: args.userId, importedFrom: "free-pos" })),
        skipDuplicates: true,
      })
    ).count;
  }

  // ── Customer ledger: the backup's udhaar given and payments received ──
  const freeCustomers = new Map(parseAll(FreeCustomer, d.customers).map((c) => [c.id, c]));
  const ours = await db.customer.findMany({ where: { accountId: account.id, archivedAt: null }, select: { id: true, name: true, phone: true } });
  const customerFor = (freeId: string, name: string) => {
    const fc = freeCustomers.get(freeId);
    const phone = fc?.phone ? normalizePhone(fc.phone) : null;
    const n = (fc?.name || name).trim().toLowerCase();
    return (phone && ours.find((c) => c.phone === phone)) || ours.find((c) => c.name.toLowerCase() === n) || null;
  };
  const cashMethod = method("");
  const ledgerRows = parseAll(FreeLedger, d.ledger)
    .filter((l) => l.amount > 0)
    .flatMap((l) => {
      const c = customerFor(l.customerId, l.customerName);
      if (!c) return [];
      const payment = l.type === "payment";
      return [{ id: id("ledger", l.id), accountId: account.id, customerId: c.id, branchId: payment ? branch.id : null, type: payment ? ("PAYMENT" as const) : ("CREDIT" as const), amount: paise(l.amount), occurredAt: atDay(l.date), methodId: payment ? (cashMethod.m?.id ?? null) : null, methodName: payment ? cashMethod.name : "", kind: payment ? cashMethod.kind : null, note: l.note.slice(0, 300) || (payment ? "Payment" : "Udhaar"), userId: args.userId, importedFrom: "free-pos" }];
    });
  if (ledgerRows.length) result.customerLedger = (await db.customerLedgerEntry.createMany({ data: ledgerRows, skipDuplicates: true })).count;

  // ── Supplier ledger: bills kept only in the ledger, and payments made ──
  const supplierRows = [];
  for (const s of parseAll(FreeSupplierLedger, d.supplier_ledger).filter((x) => x.amount > 0)) {
    const supplierId = await supplierFor(s.supplierId, s.supplierName || "Supplier");
    if (!supplierId) continue;
    const payment = s.type === "payment";
    const pay = method(s.paymentMode);
    supplierRows.push({ id: id("supplier_ledger", s.id), accountId: account.id, supplierId, branchId: payment ? branch.id : null, type: payment ? ("PAYMENT" as const) : ("BILL" as const), amount: paise(s.amount), occurredAt: atDay(s.date), methodId: payment ? (pay.m?.id ?? null) : null, methodName: payment ? pay.name : "", kind: payment ? pay.kind : null, note: s.note.slice(0, 300), userId: args.userId, importedFrom: "free-pos" });
  }
  if (supplierRows.length) result.supplierLedger = (await db.supplierLedgerEntry.createMany({ data: supplierRows, skipDuplicates: true })).count;

  return result;
}
