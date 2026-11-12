import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole } from "../auth/middleware.js";
import type { Account, Customer, Prisma } from "../generated/prisma/client.js";
import { mergeFields, offlineMeta, recordClashes, recordDuplicateCustomer, recordRemovedEdit } from "../services/conflicts.js";
import { AppError } from "../http/errors.js";
import { normalizePhone } from "../lib/normalize.js";
import { parseTaxNumber, stateFromTaxNumber, taxNumberMessage } from "../lib/taxes.js";
import { CustomerBody, CustomerPatchBody } from "../schemas2.js";
import { planLimit } from "./access.js";
import { audit } from "../services/audit.js";
import { changes } from "../lib/diff.js";

export const customerDto = (c: Customer) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  address: c.address,
  gstin: c.gstin,
  stateCode: c.stateCode,
  notes: c.notes,
  creditDays: c.creditDays,
  createdAt: c.createdAt.toISOString(),
});

function clean(account: Account, body: { phone?: string; gstin?: string; stateCode?: string }) {
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
  // A GSTIN starts with the state code; use it when none was given.
  if (out.gstin && !out.stateCode && body.stateCode === undefined) out.stateCode = stateFromTaxNumber(account, out.gstin);
  return out;
}

export function customersRouter(ctx: Ctx): Router {
  const router = Router();
  router.use("/customers", authenticate(ctx), requireActivePlan);

  router.get("/customers", async (req, res) => {
    const a = auth(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const digits = q.replace(/\D/g, "");
    const where: Prisma.CustomerWhereInput = {
      accountId: a.account.id,
      archivedAt: null,
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []), { gstin: { equals: q.toUpperCase() } }] } : {}),
    };
    const take = Math.min(Number(req.query.limit) || 100, 500);
    const skip = Math.max(Number(req.query.offset) || 0, 0);
    const [rows, total] = await Promise.all([ctx.prisma.customer.findMany({ where, orderBy: { name: "asc" }, take, skip }), ctx.prisma.customer.count({ where })]);
    res.json({ customers: rows.map(customerDto), total });
  });

  router.get("/customers/:id", async (req, res) => {
    const c = await ctx.prisma.customer.findFirst({ where: { id: String(req.params.id), accountId: auth(req).account.id } });
    if (!c) throw new AppError(404, "not_found", "Customer not found.");
    res.json({ customer: customerDto(c) });
  });

  // Any role can add a customer at the counter.
  router.post("/customers", async (req, res) => {
    const a = auth(req);
    const body = CustomerBody.parse(req.body);
    const max = planLimit(a, "maxCustomers");
    const c = await ctx.prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: a.account.id }, data: { updatedAt: ctx.now() } });
      if (max !== null && (await tx.customer.count({ where: { accountId: a.account.id, archivedAt: null } })) >= max) {
        throw new AppError(403, "plan_limit", `Your plan allows ${max.toLocaleString("en-IN")} customers.`, { limit: "customers", max });
      }
      return tx.customer.create({ data: { ...body, ...clean(a.account, body), accountId: a.account.id } });
    });
    // Same phone as another customer (often both added on different counters offline): ask the owner.
    if (c.phone) {
      const other = await ctx.prisma.customer.findFirst({ where: { accountId: a.account.id, phone: c.phone, archivedAt: null, id: { not: c.id } }, orderBy: { createdAt: "asc" } });
      if (other) await recordDuplicateCustomer(ctx.prisma, a, c.id, other, `${c.name} and ${other.name} (${c.phone})`, offlineMeta(req).changedAt, ctx.now());
    }
    res.status(201).json({ customer: customerDto(c) });
  });

  router.patch("/customers/:id", requireRole("OWNER", "MANAGER"), async (req, res) => {
    const a = auth(req);
    const body = CustomerPatchBody.parse(req.body);
    const found = await ctx.prisma.customer.findFirst({ where: { id: String(req.params.id), accountId: a.account.id } });
    if (!found) throw new AppError(404, "not_found", "Customer not found.");
    const { base, changedAt } = offlineMeta(req);
    const subject = { entityType: "customer" as const, entityId: found.id, label: found.name };
    if (base && found.archivedAt) {
      await recordRemovedEdit(ctx.prisma, a, subject, body, changedAt, ctx.now());
      return void res.json({ customer: customerDto(found), conflicts: 1 });
    }
    const { apply, clashes } = mergeFields(found, { ...body, ...clean(a.account, body) }, base);
    const conflicts = await recordClashes(ctx.prisma, a, subject, clashes, changedAt, ctx.now());
    const data = apply;
    const c = Object.keys(data).length ? await ctx.prisma.customer.update({ where: { id: found.id }, data }) : found;
    const changed = changes(found, data);
    if (Object.keys(changed).length) await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "customer.updated", entityType: "customer", entityId: c.id, data: { name: found.name, changes: changed } as never });
    res.json({ customer: customerDto(c), conflicts });
  });

  return router;
}
