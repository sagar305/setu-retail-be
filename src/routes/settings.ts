import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole } from "../auth/middleware.js";
import type { Account } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { CounterBody, CounterPatchBody, PaymentMethodBody, SettingsPatchBody } from "../schemas2.js";
import { audit } from "../services/audit.js";
import { startBatchTracking } from "../services/batches.js";
import { branchFor } from "./access.js";
import { newDeviceKey } from "../auth/device.js";

export const settingsDto = (a: Account) => ({
  business: { name: a.name, phone: a.phone, taxNumber: a.taxNumber, currency: a.currency, timezone: a.timezone },
  taxEnabled: a.taxEnabled,
  allowNegativeStock: a.allowNegativeStock,
  cashierMaxDiscountBp: a.cashierMaxDiscountBp,
  receiptFooter: a.receiptFooter,
  receiptPaperSize: a.receiptPaperSize as "80mm" | "58mm" | "a4",
  batchTracking: a.batchTracking,
});

export const DEFAULT_PAYMENT_METHODS = [
  { name: "Cash", kind: "CASH", sort: 1 },
  { name: "UPI", kind: "UPI", sort: 2 },
  { name: "Card", kind: "CARD", sort: 3 },
  { name: "Credit (Udhaar)", kind: "CREDIT", sort: 4 },
] as const;

export function settingsRouter(ctx: Ctx): Router {
  const router = Router();
  router.use(["/settings", "/payment-methods", "/counters"], authenticate(ctx), requireActivePlan);

  router.get("/settings", (req, res) => {
    res.json(settingsDto(auth(req).account));
  });

  router.patch("/settings", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const body = SettingsPatchBody.parse(req.body);
    const account = await ctx.prisma.$transaction(async (tx) => {
      const updated = await tx.account.update({ where: { id: a.account.id }, data: body });
      // Turning batches on: current stock becomes an opening batch per product.
      if (body.batchTracking && !a.account.batchTracking) await startBatchTracking(tx, a.account.id, ctx.now());
      return updated;
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "settings.updated", entityType: "account", entityId: a.account.id, data: body });
    res.json(settingsDto(account));
  });

  router.get("/payment-methods", async (req, res) => {
    const methods = await ctx.prisma.paymentMethod.findMany({ where: { accountId: auth(req).account.id }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
    res.json({ methods: methods.map(({ id, name, kind, active, sort }) => ({ id, name, kind, active, sort })) });
  });

  router.post("/payment-methods", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const body = PaymentMethodBody.parse(req.body);
    const m = await ctx.prisma.paymentMethod.create({ data: { accountId: a.account.id, ...body } });
    res.status(201).json({ method: { id: m.id, name: m.name, kind: m.kind, active: m.active, sort: m.sort } });
  });

  router.patch("/payment-methods/:id", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const body = PaymentMethodBody.partial().parse(req.body);
    const found = await ctx.prisma.paymentMethod.findFirst({ where: { id: String(req.params.id), accountId: a.account.id } });
    if (!found) throw new AppError(404, "not_found", "Payment method not found.");
    const m = await ctx.prisma.paymentMethod.update({ where: { id: found.id }, data: body });
    res.json({ method: { id: m.id, name: m.name, kind: m.kind, active: m.active, sort: m.sort } });
  });

  // ── Counters: each device that bills registers once per branch ──
  const counterDto = (c: { id: string; branchId: string; code: string; name: string; lastSeenAt: Date | null }) => ({
    id: c.id,
    branchId: c.branchId,
    code: c.code,
    name: c.name,
    lastSeenAt: c.lastSeenAt?.toISOString() ?? null,
  });

  router.get("/counters", async (req, res) => {
    const branch = branchFor(auth(req), req.query.branchId);
    const counters = await ctx.prisma.counter.findMany({ where: { branchId: branch.id }, orderBy: { number: "asc" } });
    res.json({ counters: counters.map(counterDto) });
  });

  router.post("/counters", async (req, res) => {
    const a = auth(req);
    const body = CounterBody.parse(req.body);
    const branch = branchFor(a, body.branchId, true);
    const counter = await ctx.prisma.$transaction(async (tx) => {
      await tx.branch.update({ where: { id: branch.id }, data: { updatedAt: ctx.now() } }); // row lock
      const last = await tx.counter.findFirst({ where: { branchId: branch.id }, orderBy: { number: "desc" } });
      const number = (last?.number ?? 0) + 1;
      const created = await tx.counter.create({ data: { branchId: branch.id, number, code: `C${number}`, name: body.name || `Counter ${number}`, lastSeenAt: ctx.now() } });
      const key = newDeviceKey(created.id);
      await tx.counter.update({ where: { id: created.id }, data: { deviceKeyHash: key.hash } });
      return { ...created, deviceKey: key.key };
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "counter.created", entityType: "counter", entityId: counter.id, data: { branch: branch.code, code: counter.code } });
    // The device key is shown once; the device keeps it to sync offline bills.
    res.status(201).json({ counter: counterDto(counter), deviceKey: counter.deviceKey });
  });

  router.patch("/counters/:id", requireRole("OWNER", "MANAGER"), async (req, res) => {
    const a = auth(req);
    const { name } = CounterPatchBody.parse(req.body);
    const found = await ctx.prisma.counter.findUnique({ where: { id: String(req.params.id) } });
    if (!found) throw new AppError(404, "not_found", "Counter not found.");
    branchFor(a, found.branchId, true);
    const c = await ctx.prisma.counter.update({ where: { id: found.id }, data: { name } });
    res.json({ counter: counterDto(c) });
  });

  return router;
}
