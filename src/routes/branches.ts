import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole } from "../auth/middleware.js";
import { branchDto } from "../dto.js";
import { AppError } from "../http/errors.js";
import { GSTIN_PATTERN, normalizeTaxNumber } from "../lib/normalize.js";
import { BranchBody, BranchPatchBody } from "../schemas.js";
import { audit } from "../services/audit.js";

function cleanGstin(gstin: string | undefined): string | null | undefined {
  if (gstin === undefined) return undefined;
  if (gstin === "") return null;
  const g = normalizeTaxNumber(gstin);
  if (!g || !GSTIN_PATTERN.test(g)) throw new AppError(400, "invalid_gstin", "Enter a valid 15-character GSTIN.");
  return g;
}

export function branchesRouter(ctx: Ctx): Router {
  const router = Router();
  router.use("/branches", authenticate(ctx), requireActivePlan);

  router.get("/branches", (req, res) => {
    res.json({ branches: auth(req).branches.map(branchDto) });
  });

  router.post("/branches", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const body = BranchBody.parse(req.body);
    const gstin = cleanGstin(body.gstin);
    const max = a.plan.plan!.maxBranches;

    const branch = await ctx.prisma.$transaction(async (tx) => {
      // Locks the account row, so two owners adding at once can't both slip under the limit.
      const account = await tx.account.update({ where: { id: a.account.id }, data: { nextBranchNumber: { increment: 1 } } });
      const count = await tx.branch.count({ where: { accountId: a.account.id, archivedAt: null } });
      if (max !== null && count >= max) {
        throw new AppError(403, "plan_limit", `Your plan allows ${max} branch${max === 1 ? "" : "es"}. Upgrade to add more.`, { limit: "branches", max });
      }
      const number = account.nextBranchNumber - 1;
      const created = await tx.branch.create({
        data: {
          accountId: a.account.id,
          number,
          code: `B${number}`,
          name: body.name,
          address: body.address ?? "",
          phone: body.phone ?? "",
          gstin: gstin ?? null,
          stateCode: body.stateCode || gstin?.slice(0, 2) || null,
        },
      });
      await audit(tx, { accountId: a.account.id, userId: a.user.id, action: "branch.created", entityType: "branch", entityId: created.id, data: { code: created.code, name: created.name } });
      return created;
    });
    res.status(201).json({ branch: branchDto(branch) });
  });

  router.patch("/branches/:id", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const body = BranchPatchBody.parse(req.body);
    const branch = await ctx.prisma.branch.findFirst({ where: { id: String(req.params.id), accountId: a.account.id, archivedAt: null } });
    if (!branch) throw new AppError(404, "not_found", "Branch not found.");
    if (!branch.withinPlan) throw new AppError(403, "branch_read_only", "This branch is read-only on your current plan.");
    const gstin = cleanGstin(body.gstin);
    const updated = await ctx.prisma.branch.update({
      where: { id: branch.id },
      data: {
        name: body.name,
        address: body.address,
        phone: body.phone,
        gstin,
        stateCode: body.stateCode === "" ? null : body.stateCode,
      },
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, action: "branch.updated", entityType: "branch", entityId: branch.id, data: body });
    res.json({ branch: branchDto(updated) });
  });

  return router;
}
