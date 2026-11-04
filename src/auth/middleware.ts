import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Ctx } from "../context.js";
import type { Account, Branch, Role, User } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { planState, type PlanState } from "../services/plans.js";

export type AuthContext = {
  user: User;
  account: Account;
  sessionId: string;
  /** Branches this user may work in: all usable branches for the owner, assigned ones otherwise. */
  branches: Branch[];
  plan: PlanState;
};

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Bearer access token → user, account, branches and plan, checked against the
 * database on every request so a disabled user or revoked session stops at once.
 */
export function authenticate(ctx: Ctx): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const now = ctx.now();
    const claims = token ? await verifyAccessToken(token, ctx.env.JWT_SECRET, now) : null;
    if (!claims) return next(new AppError(401, "not_signed_in", "Please sign in."));

    const session = await ctx.prisma.session.findUnique({
      where: { id: claims.sid },
      include: { user: { include: { account: true, branches: { include: { branch: true } } } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= now || session.userId !== claims.sub) {
      return next(new AppError(401, "session_ended", "Please sign in again."));
    }
    const { user } = session;
    if (user.status !== "ACTIVE" || !user.withinPlan) return next(new AppError(403, "user_disabled", "Your access has been removed."));
    if (user.account.lockedBySetuAt) return next(new AppError(403, "account_locked", "This account is locked. Contact Setu support."));

    const plan = await planState(ctx.prisma, user.accountId, now);
    if (plan.expired && user.role !== "OWNER") {
      return next(new AppError(402, "plan_expired", "The shop's plan has ended. Ask the owner to renew."));
    }

    const branches =
      user.role === "OWNER"
        ? await ctx.prisma.branch.findMany({ where: { accountId: user.accountId, archivedAt: null }, orderBy: { number: "asc" } })
        : user.branches.map((ub) => ub.branch).filter((b) => !b.archivedAt).sort((a, b) => a.number - b.number);

    const { account, branches: _assigned, ...plainUser } = user;
    req.auth = { user: plainUser, account, sessionId: session.id, branches, plan };
    next();
  };
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw new AppError(401, "not_signed_in", "Please sign in.");
  return req.auth;
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!roles.includes(auth(req).user.role)) return next(new AppError(403, "forbidden", "You don't have permission to do that."));
    next();
  };
}

/** Everything except the owner's plan/renewal screens needs an active plan. */
export const requireActivePlan: RequestHandler = (req, _res, next) => {
  if (auth(req).plan.expired) return next(new AppError(402, "plan_expired", "Your plan has ended. Redeem a key to continue."));
  next();
};

/** Origin check for cookie-authenticated endpoints (refresh, logout). */
export function requireAllowedOrigin(allowed: Set<string>): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get("origin");
    if (origin && !allowed.has(origin)) return next(new AppError(403, "bad_origin", "Request origin not allowed."));
    next();
  };
}
