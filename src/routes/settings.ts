import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole } from "../auth/middleware.js";
import type { Account } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { CounterBody, CounterPatchBody, PaymentMethodBody, SettingsPatchBody, TaxGroupBody } from "../schemas2.js";
import type { Db } from "../db/types.js";
import { taxesRate } from "../lib/gst.js";
import { asTaxParts } from "../lib/taxes.js";
import { audit } from "../services/audit.js";
import { startBatchTracking } from "../services/batches.js";
import { branchFor } from "./access.js";
import { newDeviceKey } from "../auth/device.js";
import { TOOL_SLUGS, toolsDto } from "../services/books.js";

export const settingsDto = (a: Account) => ({
  business: { name: a.name, phone: a.phone, taxNumber: a.taxNumber, currency: a.currency, timezone: a.timezone },
  taxEnabled: a.taxEnabled,
  allowNegativeStock: a.allowNegativeStock,
  cashierMaxDiscountBp: a.cashierMaxDiscountBp,
  receiptFooter: a.receiptFooter,
  receiptPaperSize: a.receiptPaperSize as "80mm" | "58mm" | "a4",
  batchTracking: a.batchTracking,
  tools: toolsDto(a),
  creditDays: a.creditDays,
  logoDataUrl: a.logoDataUrl,
  upiId: a.upiId,
  printUpiQrOnReceipt: a.printUpiQrOnReceipt,
  taxMode: a.taxMode,
  taxLabel: a.taxLabel,
  taxNumberLabel: a.taxNumberLabel,
  itemCodeLabel: a.itemCodeLabel,
  invoiceTitle: a.invoiceTitle,
});

type GroupRow = { id: string; name: string; taxes: unknown; isDefault: boolean };
export const taxGroupDto = (g: GroupRow, products = 0) => {
  const taxes = asTaxParts(g.taxes);
  return { id: g.id, name: g.name, taxes, isDefault: g.isDefault, rateBp: taxesRate(taxes), products };
};

export const DEFAULT_PAYMENT_METHODS = [
  { name: "Cash", kind: "CASH", sort: 1 },
  { name: "UPI", kind: "UPI", sort: 2 },
  { name: "Card", kind: "CARD", sort: 3 },
  { name: "Credit (Udhaar)", kind: "CREDIT", sort: 4 },
] as const;

export function settingsRouter(ctx: Ctx): Router {
  const router = Router();
  router.use(["/settings", "/payment-methods", "/counters", "/tax-groups"], authenticate(ctx), requireActivePlan);

  router.get("/settings", (req, res) => {
    res.json(settingsDto(auth(req).account));
  });

  router.patch("/settings", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const { tools, ...body } = SettingsPatchBody.parse(req.body);
    const disabledTools = tools ? TOOL_SLUGS.filter((t) => (tools[t] === undefined ? a.account.disabledTools.includes(t) : !tools[t])) : undefined;
    const account = await ctx.prisma.$transaction(async (tx) => {
      const updated = await tx.account.update({ where: { id: a.account.id }, data: { ...body, disabledTools } });
      // First switch to custom taxes: start from the GST rates in use, one group per rate.
      if (body.taxMode === "CUSTOM" && a.account.taxMode !== "CUSTOM") await seedTaxGroups(tx, updated);
      // Turning batches on: current stock becomes an opening batch per product.
      if (body.batchTracking && !a.account.batchTracking) await startBatchTracking(tx, a.account.id, ctx.now());
      return updated;
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "settings.updated", entityType: "account", entityId: a.account.id, data: { ...body, logoDataUrl: body.logoDataUrl === undefined ? undefined : body.logoDataUrl ? "(image)" : null, ...(tools ? { tools } : {}) } });
    res.json(settingsDto(account));
  });

  // ── Tax groups (custom tax mode) ──
  router.get("/tax-groups", async (req, res) => {
    const a = auth(req);
    const [groups, counts] = await Promise.all([
      ctx.prisma.taxGroup.findMany({ where: { accountId: a.account.id, archivedAt: null }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
      ctx.prisma.product.groupBy({ by: ["taxGroupId"], where: { accountId: a.account.id, archivedAt: null }, _count: true }),
    ]);
    const n = new Map(counts.map((c) => [c.taxGroupId, c._count]));
    const dflt = groups.find((g) => g.isDefault);
    res.json({ groups: groups.map((g) => taxGroupDto(g, (n.get(g.id) ?? 0) + (g.id === dflt?.id ? (n.get(null) ?? 0) : 0))) });
  });

  router.post("/tax-groups", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const body = TaxGroupBody.parse(req.body);
    const g = await ctx.prisma.$transaction(async (tx) => {
      const first = (await tx.taxGroup.count({ where: { accountId: a.account.id, archivedAt: null } })) === 0;
      const isDefault = body.isDefault || first;
      if (isDefault) await tx.taxGroup.updateMany({ where: { accountId: a.account.id }, data: { isDefault: false } });
      return tx.taxGroup.create({ data: { accountId: a.account.id, name: body.name, taxes: body.taxes, isDefault } });
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "tax_group.created", entityType: "tax_group", entityId: g.id, data: { name: g.name, taxes: body.taxes, isDefault: g.isDefault } });
    res.status(201).json({ group: taxGroupDto(g) });
  });

  router.patch("/tax-groups/:id", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const body = TaxGroupBody.partial().parse(req.body);
    const found = await ctx.prisma.taxGroup.findFirst({ where: { id: String(req.params.id), accountId: a.account.id, archivedAt: null } });
    if (!found) throw new AppError(404, "not_found", "Tax group not found.");
    if (body.isDefault === false && found.isDefault) throw new AppError(400, "needs_default", "Make another group the default instead.");
    const g = await ctx.prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.taxGroup.updateMany({ where: { accountId: a.account.id }, data: { isDefault: false } });
      return tx.taxGroup.update({ where: { id: found.id }, data: body });
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "tax_group.updated", entityType: "tax_group", entityId: g.id, data: { name: g.name, ...body } });
    res.json({ group: taxGroupDto(g) });
  });

  router.delete("/tax-groups/:id", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const found = await ctx.prisma.taxGroup.findFirst({ where: { id: String(req.params.id), accountId: a.account.id, archivedAt: null } });
    if (!found) throw new AppError(404, "not_found", "Tax group not found.");
    if (found.isDefault) throw new AppError(400, "is_default", "This is the default group. Make another group the default first.");
    // Its products fall back to the default group. Bills keep the taxes they were made with.
    await ctx.prisma.$transaction([
      ctx.prisma.product.updateMany({ where: { taxGroupId: found.id }, data: { taxGroupId: null } }),
      ctx.prisma.taxGroup.update({ where: { id: found.id }, data: { archivedAt: ctx.now(), isDefault: false } }),
    ]);
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "tax_group.removed", entityType: "tax_group", entityId: found.id, data: { name: found.name } });
    res.status(204).end();
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
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: branch.id, action: "counter.created", entityType: "counter", entityId: counter.id, data: { branch: branch.code, code: counter.code } });
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

/**
 * Switching to custom taxes for the first time: one group per GST rate the
 * catalogue uses ("<tax label> 5%", "No tax" for 0%), products moved into
 * them, and the most used one made the default.
 */
async function seedTaxGroups(tx: Db, account: Account) {
  if ((await tx.taxGroup.count({ where: { accountId: account.id } })) > 0) return;
  const rates = await tx.product.groupBy({ by: ["gstRateBp"], where: { accountId: account.id, archivedAt: null }, _count: true });
  // No products yet: the owner makes the groups; the first becomes the default.
  if (!rates.length) return;
  const used = rates.sort((x, y) => y._count - x._count);
  const label = account.taxLabel || "Tax";
  for (const [i, r] of used.entries()) {
    const g = await tx.taxGroup.create({
      data: { accountId: account.id, name: r.gstRateBp ? `${label} ${r.gstRateBp / 100}%` : "No tax", taxes: r.gstRateBp ? [{ name: label, rateBp: r.gstRateBp }] : [], isDefault: i === 0 },
    });
    await tx.product.updateMany({ where: { accountId: account.id, gstRateBp: r.gstRateBp, taxGroupId: null }, data: { taxGroupId: g.id } });
  }
}
