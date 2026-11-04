import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import { revokeAllSessions } from "../auth/session.js";
import { isUniqueViolation } from "../db/errors.js";
import { staffDto } from "../dto.js";
import type { Role } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { normalizeEmail, normalizeUsername } from "../lib/normalize.js";
import { InviteStaffBody, StaffPatchBody } from "../schemas.js";
import { audit } from "../services/audit.js";
import { sendInvite } from "./auth.js";

const include = { branches: { select: { branchId: true } } } as const;

/** Branches the acting user may assign: owner → any usable branch; manager → their own. */
function assignable(a: AuthContext, branchIds: string[], role: Role) {
  const usable = new Map(a.branches.filter((b) => b.withinPlan).map((b) => [b.id, b]));
  if (branchIds.some((id) => !usable.has(id))) {
    throw new AppError(400, "bad_branch", "Pick branches you manage that are active on the plan.");
  }
  if (role === "CASHIER" && branchIds.length !== 1) throw new AppError(400, "one_branch", "A cashier works in exactly one branch.");
}

function assertCanManage(a: AuthContext, target: { role: Role; branches: { branchId: string }[] }) {
  if (target.role === "OWNER") throw new AppError(403, "forbidden", "The owner can't be changed here.");
  if (a.user.role === "OWNER") return;
  const mine = new Set(a.branches.map((b) => b.id));
  if (target.role !== "CASHIER" || !target.branches.every((b) => mine.has(b.branchId))) {
    throw new AppError(403, "forbidden", "Managers can only manage cashiers in their own branches.");
  }
}

export function staffRouter(ctx: Ctx): Router {
  const router = Router();
  router.use("/staff", authenticate(ctx), requireActivePlan, requireRole("OWNER", "MANAGER"));

  router.get("/staff", async (req, res) => {
    const a = auth(req);
    const where =
      a.user.role === "OWNER"
        ? { accountId: a.account.id }
        : {
            accountId: a.account.id,
            OR: [{ id: a.user.id }, { role: "CASHIER" as const, branches: { some: { branchId: { in: a.branches.map((b) => b.id) } } } }],
          };
    const users = await ctx.prisma.user.findMany({ where, include, orderBy: { createdAt: "asc" } });
    res.json({ staff: users.map(staffDto) });
  });

  router.post("/staff", async (req, res) => {
    const a = auth(req);
    const body = InviteStaffBody.parse(req.body);
    if (a.user.role === "MANAGER" && body.role !== "CASHIER") throw new AppError(403, "forbidden", "Managers can add cashiers only.");
    assignable(a, body.branchIds, body.role);
    const max = a.plan.plan!.maxStaff;
    const email = normalizeEmail(body.email);
    const username = normalizeUsername(body.username);

    let user;
    try {
      user = await ctx.prisma.$transaction(async (tx) => {
        await tx.account.update({ where: { id: a.account.id }, data: { updatedAt: ctx.now() } }); // row lock for the limit check
        const count = await tx.user.count({ where: { accountId: a.account.id, role: { not: "OWNER" }, status: { not: "DISABLED" } } });
        if (max !== null && count >= max) {
          throw new AppError(403, "plan_limit", `Your plan allows ${max} staff. Upgrade to add more.`, { limit: "staff", max });
        }
        const created = await tx.user.create({
          data: {
            accountId: a.account.id,
            email,
            username,
            name: body.name,
            role: body.role,
            status: "INVITED",
            branches: { create: body.branchIds.map((branchId) => ({ branchId })) },
          },
          include,
        });
        await audit(tx, { accountId: a.account.id, userId: a.user.id, action: "staff.invited", entityType: "user", entityId: created.id, data: { role: body.role, branchIds: body.branchIds } });
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err, "email")) throw new AppError(409, "email_taken", "Someone on Setu Retail already uses this email.");
      if (isUniqueViolation(err, "username")) throw new AppError(409, "username_taken", "That username is taken. Try another.");
      throw err;
    }
    await sendInvite(ctx, user, a.user.name, a.account.name);
    res.status(201).json({ staff: staffDto(user) });
  });

  router.post("/staff/:id/resend-invite", async (req, res) => {
    const a = auth(req);
    const target = await ctx.prisma.user.findFirst({ where: { id: String(req.params.id), accountId: a.account.id }, include });
    if (!target) throw new AppError(404, "not_found", "Staff member not found.");
    assertCanManage(a, target);
    if (target.status !== "INVITED") throw new AppError(400, "not_invited", "This person has already set their password.");
    await sendInvite(ctx, target, a.user.name, a.account.name);
    res.json({ sent: true });
  });

  router.patch("/staff/:id", async (req, res) => {
    const a = auth(req);
    const body = StaffPatchBody.parse(req.body);
    const target = await ctx.prisma.user.findFirst({ where: { id: String(req.params.id), accountId: a.account.id }, include });
    if (!target) throw new AppError(404, "not_found", "Staff member not found.");
    assertCanManage(a, target);
    if (a.user.role === "MANAGER" && body.role && body.role !== "CASHIER") throw new AppError(403, "forbidden", "Managers can't promote staff.");

    const role = body.role ?? target.role;
    const branchIds = body.branchIds ?? target.branches.map((b) => b.branchId);
    if (body.branchIds || body.role) assignable(a, branchIds, role);

    const reEnable = body.disabled === false && target.status === "DISABLED";
    const max = a.plan.plan!.maxStaff;

    const updated = await ctx.prisma.$transaction(async (tx) => {
      if (reEnable && max !== null) {
        const count = await tx.user.count({ where: { accountId: a.account.id, role: { not: "OWNER" }, status: { not: "DISABLED" } } });
        if (count >= max) throw new AppError(403, "plan_limit", `Your plan allows ${max} staff. Upgrade to add more.`, { limit: "staff", max });
      }
      const status = body.disabled === true ? "DISABLED" : reEnable ? (target.passwordHash ? "ACTIVE" : "INVITED") : target.status;
      if (body.branchIds || body.role) {
        await tx.userBranch.deleteMany({ where: { userId: target.id } });
        await tx.userBranch.createMany({ data: branchIds.map((branchId) => ({ userId: target.id, branchId })) });
      }
      const u = await tx.user.update({ where: { id: target.id }, data: { name: body.name, role, status }, include });
      await audit(tx, { accountId: a.account.id, userId: a.user.id, action: "staff.updated", entityType: "user", entityId: target.id, data: body });
      return u;
    });
    if (body.disabled === true || body.role || body.branchIds) await revokeAllSessions(ctx, target.id);
    res.json({ staff: staffDto(updated) });
  });

  return router;
}
