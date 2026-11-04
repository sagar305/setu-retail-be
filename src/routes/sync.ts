// Offline support.
//  - PUT/DELETE /me/pin: a user's counter PIN for offline sign-in.
//  - POST /counters/:id/device-key: give this device its counter key (online, signed in).
//  - GET  /sync/pack: what a counter needs to bill with no internet (device key).
//  - POST /sync/customers, /sync/orders: push what was made offline (device key).
// Offline bills are saved as charged; sync is refused while the plan has ended
// and the bills simply wait on the device until it's renewed.
import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan } from "../auth/middleware.js";
import { device, deviceAuth, newDeviceKey } from "../auth/device.js";
import { customerDto } from "./customers.js";
import { isUniqueViolation } from "../db/errors.js";
import { AppError } from "../http/errors.js";
import { computeBill, placeOfSupply } from "../lib/gst.js";
import { GSTIN_PATTERN, normalizePhone, normalizeTaxNumber } from "../lib/normalize.js";
import { verifyPassword } from "../lib/password.js";
import { makePinVerifier, PIN_PATTERN } from "../lib/pin.js";
import { settingsDto } from "./settings.js";
import { audit } from "../services/audit.js";
import { invoiceSeq, persistOrder } from "../services/orderWriter.js";
import { DiscountBody } from "../schemas2.js";
import { branchFor } from "./access.js";
import { batchDto, productDto, shopToday } from "./catalogue.js";
import { sortFefo, toDay } from "../services/batches.js";

const Paise = z.number().int().min(0).max(1_000_000_000);
export const PinBody = z.object({ pin: z.string().regex(PIN_PATTERN, "4 to 6 digits."), password: z.string().min(1) });
export const SyncCustomer = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(20).optional(),
  gstin: z.string().trim().max(15).optional(),
  stateCode: z.string().trim().max(2).optional(),
});
export const SyncOrder = z.object({
  id: z.uuid(),
  cashierId: z.uuid(),
  invoiceNumber: z.string(),
  createdAt: z.iso.datetime(),
  customerId: z.uuid().nullable().optional(),
  taxEnabled: z.boolean(),
  discount: DiscountBody,
  lines: z
    .array(
      z.object({
        productId: z.uuid().nullable(),
        name: z.string().min(1).max(200),
        hsn: z.string().max(8),
        unit: z.string().max(20),
        unitPrice: Paise,
        gstRateBp: z.number().int().min(0).max(10_000),
        taxInclusive: z.boolean(),
        qtyMilli: z.number().int().min(1),
        batchId: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
  payments: z.array(z.object({ methodId: z.uuid(), amount: Paise })).min(1).max(5),
  /** What the device charged; must match the bill worked out from the lines. */
  total: Paise,
  note: z.string().max(300).optional(),
});
export const SyncCustomersBody = z.object({ customers: z.array(SyncCustomer).max(1000) });
export const SyncOrdersBody = z.object({ orders: z.array(z.unknown()).min(1).max(200) });

export type SyncResult = { id: string; status: "saved" | "duplicate" | "rejected" | "retry"; invoiceNumber?: string; message?: string };

const PACK_CUSTOMERS = 5000;

export function syncRouter(ctx: Ctx): Router {
  const router = Router();

  // ── Counter PIN (any signed-in user) ──
  router.put("/me/pin", authenticate(ctx), async (req, res) => {
    const a = auth(req);
    const { pin, password } = PinBody.parse(req.body);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.user.id } });
    if (!(await verifyPassword(password, user.passwordHash))) throw new AppError(403, "wrong_password", "That password isn't right.");
    await ctx.prisma.user.update({ where: { id: user.id }, data: await makePinVerifier(pin) });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "user.pin_set", entityType: "user", entityId: a.user.id });
    res.json({ pinSet: true });
  });
  router.delete("/me/pin", authenticate(ctx), async (req, res) => {
    const a = auth(req);
    await ctx.prisma.user.update({ where: { id: a.user.id }, data: { pinHash: null, pinSalt: null, pinIterations: null } });
    res.status(204).end();
  });
  router.get("/me/pin", authenticate(ctx), async (req, res) => {
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth(req).user.id }, select: { pinHash: true } });
    res.json({ pinSet: Boolean(u.pinHash) });
  });

  // ── Device key for a counter (signed in, online) ──
  router.post("/counters/:id/device-key", authenticate(ctx), requireActivePlan, async (req, res) => {
    const a = auth(req);
    const counter = await ctx.prisma.counter.findUnique({ where: { id: String(req.params.id) } });
    if (!counter) throw new AppError(404, "not_found", "Counter not found.");
    branchFor(a, counter.branchId, true);
    const { key, hash } = newDeviceKey(counter.id);
    await ctx.prisma.counter.update({ where: { id: counter.id }, data: { deviceKeyHash: hash, lastSeenAt: ctx.now() } });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "counter.device_key", entityType: "counter", entityId: counter.id });
    res.json({ deviceKey: key });
  });

  // ── Offline pack ──
  router.get("/sync/pack", deviceAuth(ctx), async (req, res) => {
    const { counter, branch, account, plan } = device(req);
    const [methods, categories, products, customers, users, batches] = await Promise.all([
      ctx.prisma.paymentMethod.findMany({ where: { accountId: account.id, active: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] }),
      ctx.prisma.category.findMany({ where: { accountId: account.id, archivedAt: null }, orderBy: { name: "asc" } }),
      ctx.prisma.product.findMany({ where: { accountId: account.id, archivedAt: null }, include: { branches: { where: { branchId: branch.id } } }, orderBy: { name: "asc" } }),
      ctx.prisma.customer.findMany({ where: { accountId: account.id, archivedAt: null }, orderBy: { updatedAt: "desc" }, take: PACK_CUSTOMERS }),
      ctx.prisma.user.findMany({
        where: {
          accountId: account.id,
          status: "ACTIVE",
          withinPlan: true,
          pinHash: { not: null },
          OR: [{ role: "OWNER" }, { branches: { some: { branchId: branch.id } } }],
        },
        select: { id: true, name: true, username: true, role: true, pinHash: true, pinSalt: true, pinIterations: true },
      }),
      account.batchTracking ? ctx.prisma.batch.findMany({ where: { branchId: branch.id, qtyMilli: { gt: 0 } } }) : Promise.resolve([]),
    ]);
    const today = shopToday(ctx.now(), account.timezone);
    const nextExpiry = new Map<string, string>();
    for (const b of sortFefo(batches)) if (b.expiry && !nextExpiry.has(b.productId)) nextExpiry.set(b.productId, toDay(b.expiry)!);
    await ctx.prisma.counter.update({ where: { id: counter.id }, data: { lastSeenAt: ctx.now() } });
    res.json({
      at: ctx.now().toISOString(),
      settings: settingsDto(account),
      account: { id: account.id, name: account.name, timezone: account.timezone, currency: account.currency },
      branch: { id: branch.id, code: branch.code, name: branch.name, address: branch.address, phone: branch.phone, gstin: branch.gstin, stateCode: branch.stateCode },
      counter: { id: counter.id, code: counter.code, name: counter.name, nextInvoiceNumber: counter.nextInvoiceNumber },
      plan: { expired: plan.expired },
      methods: methods.map(({ id, name, kind, active, sort }) => ({ id, name, kind, active, sort })),
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      // Cost stays on the server: the pack is readable by anyone at the counter.
      products: products.map((p) => productDto(p, p.branches[0], false, nextExpiry.get(p.id))),
      batches: sortFefo(batches).map((b) => batchDto(b, today, false)),
      customers: customers.map(customerDto),
      users: users.map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, pin: { hash: u.pinHash!, salt: u.pinSalt!, iterations: u.pinIterations! } })),
    });
  });

  router.post("/sync/customers", deviceAuth(ctx), async (req, res) => {
    const { account, plan } = device(req);
    if (plan.expired) throw new AppError(402, "plan_expired", "The plan has ended. Offline work waits on this counter until it's renewed.");
    const { customers } = SyncCustomersBody.parse(req.body);
    const results: { id: string; status: "saved" | "duplicate" | "rejected"; message?: string }[] = [];
    for (const c of customers) {
      const existing = await ctx.prisma.customer.findUnique({ where: { id: c.id } });
      if (existing) {
        results.push({ id: c.id, status: existing.accountId === account.id ? "duplicate" : "rejected" });
        continue;
      }
      const phone = c.phone ? (normalizePhone(c.phone) ?? "") : "";
      const g = c.gstin ? normalizeTaxNumber(c.gstin) : null;
      const gstin = g && GSTIN_PATTERN.test(g) ? g : null;
      // Created offline already: plan limits aren't applied after the fact.
      await ctx.prisma.customer.create({ data: { id: c.id, accountId: account.id, name: c.name, phone, gstin, stateCode: c.stateCode || gstin?.slice(0, 2) || null } });
      results.push({ id: c.id, status: "saved" });
    }
    res.json({ results });
  });

  router.post("/sync/orders", deviceAuth(ctx), async (req, res) => {
    const { counter, branch, account, plan } = device(req);
    if (plan.expired) throw new AppError(402, "plan_expired", "The plan has ended. Bills wait on this counter and sync once it's renewed.");
    const { orders } = SyncOrdersBody.parse(req.body);
    const now = ctx.now();
    const results: SyncResult[] = [];

    for (const raw of orders) {
      const parsed = SyncOrder.safeParse(raw);
      const id = (raw as { id?: unknown })?.id;
      if (!parsed.success) {
        results.push({ id: typeof id === "string" ? id : "", status: "rejected", message: parsed.error.issues[0]?.message ?? "Invalid bill" });
        continue;
      }
      const o = parsed.data;
      try {
        const existing = await ctx.prisma.order.findUnique({ where: { id: o.id }, select: { accountId: true, invoiceNumber: true } });
        if (existing) {
          results.push(existing.accountId === account.id ? { id: o.id, status: "duplicate", invoiceNumber: existing.invoiceNumber } : { id: o.id, status: "rejected", message: "Bill id already used." });
          continue;
        }
        const seq = invoiceSeq(o.invoiceNumber, branch.code, counter.code);
        if (seq === null) throw new AppError(400, "bad_invoice_number", "Bill number doesn't belong to this counter.");
        const cashier = await ctx.prisma.user.findFirst({ where: { id: o.cashierId, accountId: account.id }, include: { branches: true } });
        if (!cashier || (cashier.role !== "OWNER" && !cashier.branches.some((b) => b.branchId === branch.id))) throw new AppError(400, "unknown_cashier", "The person on this bill doesn't work in this branch.");
        const customer = o.customerId ? await ctx.prisma.customer.findFirst({ where: { id: o.customerId, accountId: account.id } }) : null;
        if (o.customerId && !customer) {
          results.push({ id: o.id, status: "retry", message: "Customer not synced yet." });
          continue;
        }
        const methods = await ctx.prisma.paymentMethod.findMany({ where: { accountId: account.id, id: { in: o.payments.map((p) => p.methodId) } } });
        const byId = new Map(methods.map((m) => [m.id, m]));
        if (o.payments.some((p) => !byId.has(p.methodId))) throw new AppError(400, "bad_payment_method", "Unknown payment method.");

        const pos = placeOfSupply(o.taxEnabled ? branch.stateCode : null, o.taxEnabled ? (customer?.stateCode ?? null) : null);
        const bill = computeBill(o.lines, o.discount, { taxEnabled: o.taxEnabled, interState: pos.interState });
        const paid = o.payments.reduce((s, p) => s + p.amount, 0);
        if (bill.total !== o.total || paid !== o.total) throw new AppError(400, "total_mismatch", `Bill adds up to ${bill.total}, payments ${paid}, device said ${o.total}.`);

        const productIds = [...new Set(o.lines.map((l) => l.productId).filter((x): x is string => Boolean(x)))];
        const products = await ctx.prisma.product.findMany({ where: { id: { in: productIds }, accountId: account.id }, include: { branches: { where: { branchId: branch.id } } } });
        const pById = new Map(products.map((p) => [p.id, p]));
        const priceDiffers = o.lines.some((l) => {
          const p = l.productId ? pById.get(l.productId) : undefined;
          return !p || (p.branches[0]?.price ?? p.price) !== l.unitPrice;
        });
        const createdAt = new Date(Math.min(new Date(o.createdAt).getTime(), now.getTime()));

        const saved = await ctx.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "counters" SET "nextInvoiceNumber" = GREATEST("nextInvoiceNumber", ${seq + 1}), "lastSeenAt" = ${now} WHERE "id" = ${counter.id}::uuid`;
          return persistOrder(tx, {
            id: o.id,
            account,
            branch,
            counterId: counter.id,
            cashierId: cashier.id,
            invoiceNumber: o.invoiceNumber,
            customer,
            placeOfSupply: pos.placeOfSupply,
            interState: pos.interState,
            taxEnabled: o.taxEnabled,
            discount: o.discount,
            bill,
            lines: o.lines.map((l) => {
              const p = l.productId ? pById.get(l.productId) : undefined;
              return { productId: p?.id ?? null, name: l.name, hsn: l.hsn, unit: l.unit, costPrice: p?.costPrice ?? null, trackStock: p?.trackStock ?? false, batchId: l.batchId };
            }),
            payments: o.payments.map((p) => {
              const m = byId.get(p.methodId)!;
              return { methodId: m.id, methodName: m.name, kind: m.kind, amount: p.amount };
            }),
            note: o.note ?? "",
            createdAt,
            // The sale already happened: stock may go below zero; it's flagged in reports.
            blockBelowZero: false,
            offline: true,
            priceDiffers,
            syncedAt: now,
          });
        });
        results.push({ id: o.id, status: "saved", invoiceNumber: saved.invoiceNumber });
      } catch (err) {
        if (isUniqueViolation(err, "invoiceNumber")) results.push({ id: o.id, status: "rejected", message: "Bill number already used by another bill." });
        else if (err instanceof AppError) results.push({ id: o.id, status: "rejected", message: err.message });
        else {
          req.log?.error({ err, orderId: o.id }, "offline bill failed to sync");
          results.push({ id: o.id, status: "retry", message: "Couldn't save this bill right now." });
        }
      }
    }
    const saved = results.filter((r) => r.status === "saved").length;
    if (saved) await audit(ctx.prisma, { accountId: account.id, userId: null, action: "sync.orders", entityType: "counter", entityId: counter.id, data: { saved, rejected: results.filter((r) => r.status === "rejected").length } });
    res.json({ results });
  });

  return router;
}
