import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole } from "../auth/middleware.js";
import type { Customer, Prisma } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { GSTIN_PATTERN, normalizePhone, normalizeTaxNumber } from "../lib/normalize.js";
import { CustomerBody, CustomerPatchBody } from "../schemas2.js";
import { planLimit } from "./access.js";

export const customerDto = (c: Customer) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  address: c.address,
  gstin: c.gstin,
  stateCode: c.stateCode,
  notes: c.notes,
  createdAt: c.createdAt.toISOString(),
});

function clean(body: { phone?: string; gstin?: string; stateCode?: string }) {
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
      const g = normalizeTaxNumber(body.gstin);
      if (!g || !GSTIN_PATTERN.test(g)) throw new AppError(400, "invalid_gstin", "Enter a valid 15-character GSTIN.");
      out.gstin = g;
    }
  }
  if (body.stateCode !== undefined) out.stateCode = body.stateCode || null;
  // A GSTIN starts with the state code; use it when none was given.
  if (out.gstin && !out.stateCode && body.stateCode === undefined) out.stateCode = out.gstin.slice(0, 2);
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
    const [rows, total] = await Promise.all([ctx.prisma.customer.findMany({ where, orderBy: { name: "asc" }, take }), ctx.prisma.customer.count({ where })]);
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
      return tx.customer.create({ data: { ...body, ...clean(body), accountId: a.account.id } });
    });
    res.status(201).json({ customer: customerDto(c) });
  });

  router.patch("/customers/:id", requireRole("OWNER", "MANAGER"), async (req, res) => {
    const a = auth(req);
    const body = CustomerPatchBody.parse(req.body);
    const found = await ctx.prisma.customer.findFirst({ where: { id: String(req.params.id), accountId: a.account.id } });
    if (!found) throw new AppError(404, "not_found", "Customer not found.");
    const c = await ctx.prisma.customer.update({ where: { id: found.id }, data: { ...body, ...clean(body) } });
    res.json({ customer: customerDto(c) });
  });

  return router;
}
