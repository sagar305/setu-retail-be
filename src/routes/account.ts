import { Router } from "express";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireRole } from "../auth/middleware.js";
import { isUniqueViolation } from "../db/errors.js";
import { branchDto, planDto } from "../dto.js";
import type { Plan } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { readLicenseKey, type License } from "../lib/licenseKey.js";
import { KeepActiveBody, LicenseKeyBody, RedeemBody } from "../schemas.js";
import { audit } from "../services/audit.js";
import { loadSegments, planState, usage } from "../services/plans.js";
import { planRedemption } from "../services/planTimeline.js";
import { reconcileWithinPlan } from "../services/withinPlan.js";

/** Owner-only plan screens. Reachable when the plan has expired, so the owner can renew. */
export function accountRouter(ctx: Ctx): Router {
  const router = Router();
  router.use("/account", authenticate(ctx), requireRole("OWNER"));

  router.get("/account/plan", async (req, res) => {
    const a = auth(req);
    res.json({
      plan: planDto(a.plan),
      usage: await usage(ctx.prisma, a.account.id, ctx.now()),
      keepActiveReviewPending: a.account.keepActiveReviewPending,
    });
  });

  async function resolveKey(key: string, accountId: string): Promise<{ license: License; plan: Plan }> {
    const license = readLicenseKey(key, ctx.env.RETAIL_LICENSE_SECRET);
    if (!license) throw new AppError(400, "invalid_key", "That isn't a valid Setu Retail key. Check it against your receipt.");
    if (await ctx.prisma.licenseRedemption.findUnique({ where: { keyId: license.keyId } })) {
      throw new AppError(409, "key_used", "This key has already been redeemed.");
    }
    // Contact-sales keys carry the "custom" plan byte. The Setu team issues
    // them for one account, with their own plan row (Phase 7).
    if (license.plan === "custom") {
      const issued = await ctx.prisma.issuedKey.findUnique({ where: { keyId: license.keyId } });
      if (!issued || issued.revokedAt) throw new AppError(400, "invalid_key", "That isn't a valid Setu Retail key. Check it against your receipt.");
      if (issued.accountId !== accountId) throw new AppError(403, "key_other_account", "This key was issued for a different Setu Retail account. Sign in to that account to redeem it.");
    }
    const code = license.plan === "custom" ? `custom-${license.keyId}` : license.plan;
    const plan = await ctx.prisma.plan.findUnique({ where: { code } });
    if (!plan) throw new AppError(400, "invalid_key", "That isn't a valid Setu Retail key. Check it against your receipt.");
    return { license, plan };
  }

  router.post("/account/license/check", async (req, res) => {
    const a = auth(req);
    const { key } = LicenseKeyBody.parse(req.body);
    const { license, plan } = await resolveKey(key, a.account.id);
    const segments = await loadSegments(ctx.prisma, a.account.id);
    const now = ctx.now();
    const input = { planCode: plan.code, monthlyPriceInr: plan.monthlyPriceInr, days: license.days };
    const base = planRedemption(segments, now, input);
    const iso = (d: Date) => d.toISOString();
    res.json({
      plan: { code: plan.code, name: plan.name },
      days: license.days,
      needsChoice: base.needsChoice,
      options: base.needsChoice
        ? (["now", "later"] as const).map((choice) => {
            const p = planRedemption(segments, now, { ...input, choice });
            return { choice, convertedDays: p.convertedDays, startsAt: iso(p.newSegment.startsAt), endsAt: iso(p.newSegment.endsAt) };
          })
        : [{ choice: null, convertedDays: 0, startsAt: iso(base.newSegment.startsAt), endsAt: iso(base.newSegment.endsAt) }],
    });
  });

  router.post("/account/license/redeem", async (req, res) => {
    const a = auth(req);
    const { key, choice } = RedeemBody.parse(req.body);
    const { license, plan } = await resolveKey(key, a.account.id);
    const now = ctx.now();

    try {
      await ctx.prisma.$transaction(async (tx) => {
        const segments = await loadSegments(tx, a.account.id);
        const p = planRedemption(segments, now, { planCode: plan.code, monthlyPriceInr: plan.monthlyPriceInr, days: license.days, choice });
        if (p.needsChoice) throw new AppError(400, "choice_required", "Choose whether the new plan starts now or after your current plan.");

        const redemption = await tx.licenseRedemption.create({
          data: { keyId: license.keyId, accountId: a.account.id, userId: a.user.id, planCode: plan.code, days: license.days, mode: p.mode, convertedDays: p.convertedDays, redeemedAt: now },
        });
        if (p.endCurrent) await tx.subscription.update({ where: { id: p.endCurrent.id }, data: { endsAt: p.endCurrent.endsAt } });
        for (const s of p.shifted) await tx.subscription.update({ where: { id: s.id }, data: { startsAt: s.startsAt, endsAt: s.endsAt } });
        await tx.subscription.create({
          data: { accountId: a.account.id, planId: plan.id, source: "KEY", startsAt: p.newSegment.startsAt, endsAt: p.newSegment.endsAt, redemptionId: redemption.id },
        });
        await audit(tx, {
          accountId: a.account.id,
          userId: a.user.id,
          action: "license.redeemed",
          entityType: "license",
          entityId: redemption.id,
          data: { plan: plan.code, days: license.days, mode: p.mode, convertedDays: p.convertedDays },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, "keyId")) throw new AppError(409, "key_used", "This key has already been redeemed.");
      throw err;
    }

    const state = await planState(ctx.prisma, a.account.id, now);
    if (state.plan) await reconcileWithinPlan(ctx.prisma, a.account.id, state.plan);
    const account = await ctx.prisma.account.findUniqueOrThrow({ where: { id: a.account.id } });
    res.json({ plan: planDto(state), keepActiveReviewPending: account.keepActiveReviewPending });
  });

  router.get("/account/keep-active", async (req, res) => {
    const a = auth(req);
    if (!a.plan.plan) throw new AppError(402, "plan_expired", "Your plan has ended. Redeem a key to continue.");
    const [branches, staff] = await Promise.all([
      ctx.prisma.branch.findMany({ where: { accountId: a.account.id, archivedAt: null }, orderBy: [{ createdAt: "asc" }, { number: "asc" }] }),
      ctx.prisma.user.findMany({
        where: { accountId: a.account.id, role: { not: "OWNER" }, status: { not: "DISABLED" } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    res.json({
      limits: { maxBranches: a.plan.plan.maxBranches, maxStaff: a.plan.plan.maxStaff },
      branches: branches.map(branchDto),
      staff: staff.map((u) => ({ id: u.id, name: u.name, role: u.role, withinPlan: u.withinPlan, createdAt: u.createdAt.toISOString() })),
    });
  });

  router.post("/account/keep-active", async (req, res) => {
    const a = auth(req);
    const plan = a.plan.plan;
    if (!plan) throw new AppError(402, "plan_expired", "Your plan has ended. Redeem a key to continue.");
    const { branchIds, staffIds } = KeepActiveBody.parse(req.body);

    const [branches, staff] = await Promise.all([
      ctx.prisma.branch.findMany({ where: { accountId: a.account.id, archivedAt: null }, select: { id: true } }),
      ctx.prisma.user.findMany({ where: { accountId: a.account.id, role: { not: "OWNER" }, status: { not: "DISABLED" } }, select: { id: true } }),
    ]);
    const keepB = new Set(branchIds);
    const keepS = new Set(staffIds);
    const bIds = new Set(branches.map((b) => b.id));
    const sIds = new Set(staff.map((s) => s.id));
    if ([...keepB].some((id) => !bIds.has(id)) || [...keepS].some((id) => !sIds.has(id))) {
      throw new AppError(400, "unknown_ids", "Some of the picked branches or staff don't belong to this account.");
    }
    if (keepB.size === 0) throw new AppError(400, "need_a_branch", "Keep at least one branch.");
    if (plan.maxBranches !== null && keepB.size > plan.maxBranches) {
      throw new AppError(400, "over_limit", `Your plan allows ${plan.maxBranches} branch(es).`);
    }
    if (plan.maxStaff !== null && keepS.size > plan.maxStaff) throw new AppError(400, "over_limit", `Your plan allows ${plan.maxStaff} staff.`);

    await ctx.prisma.$transaction(async (tx) => {
      await tx.branch.updateMany({ where: { accountId: a.account.id, id: { in: [...keepB] } }, data: { withinPlan: true } });
      await tx.branch.updateMany({ where: { accountId: a.account.id, id: { notIn: [...keepB] } }, data: { withinPlan: false } });
      await tx.user.updateMany({ where: { accountId: a.account.id, role: { not: "OWNER" }, id: { in: [...keepS] } }, data: { withinPlan: true } });
      await tx.user.updateMany({ where: { accountId: a.account.id, role: { not: "OWNER" }, id: { notIn: [...keepS] } }, data: { withinPlan: false } });
      await tx.account.update({ where: { id: a.account.id }, data: { keepActiveReviewPending: false } });
      // Staff who can no longer sign in are signed out now.
      await tx.session.updateMany({
        where: { revokedAt: null, user: { accountId: a.account.id, withinPlan: false } },
        data: { revokedAt: ctx.now() },
      });
      await audit(tx, { accountId: a.account.id, userId: a.user.id, action: "plan.keep_active_chosen", entityType: "account", entityId: a.account.id, data: { branchIds: [...keepB], staffIds: [...keepS] } });
    });
    res.json({ saved: true });
  });

  return router;
}
