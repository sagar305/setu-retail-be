import type { CookieOptions, Request, Response } from "express";
import type { Ctx } from "../context.js";
import type { Account, User } from "../generated/prisma/client.js";
import { ACCESS_TOKEN_SECONDS, signAccessToken } from "../lib/jwt.js";
import { hashToken, newToken } from "../lib/tokens.js";
import { AppError } from "../http/errors.js";
import { planState } from "../services/plans.js";
import { reconcileWithinPlan } from "../services/withinPlan.js";

/** One shift: a sign-in lasts 12 hours, however often the token is refreshed. */
export const SESSION_HOURS = 12;
export const REFRESH_COOKIE = "setu_rt";

function cookieOptions(ctx: Ctx, expires: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: ctx.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `${ctx.env.COOKIE_PATH_PREFIX}/auth`,
    expires,
  };
}

export function setRefreshCookie(ctx: Ctx, res: Response, token: string, expires: Date) {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(ctx, expires));
}

export function clearRefreshCookie(ctx: Ctx, res: Response) {
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(ctx, new Date(0)), expires: undefined });
}

export function readRefreshCookie(req: Request): string | null {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === "string" && value ? value : null;
}

/**
 * Checks that must pass for a user to hold a session — at sign-in and at every
 * refresh. Also keeps branches/staff within the current plan first, so a
 * plan that just shrank takes effect.
 */
export async function assertCanHoldSession(ctx: Ctx, user: User & { account: Account }) {
  if (!user.emailVerifiedAt) throw new AppError(403, "email_not_verified", "Verify your email first. We can send the link again.");
  if (user.status === "DISABLED") throw new AppError(403, "user_disabled", "Your access has been removed. Ask the shop owner.");
  if (user.status === "INVITED") throw new AppError(403, "invite_pending", "Set your password from the invite email first.");
  if (user.account.lockedBySetuAt) throw new AppError(403, "account_locked", "This account is locked. Contact Setu support.");

  const now = ctx.now();
  const state = await planState(ctx.prisma, user.accountId, now);
  if (state.expired) {
    if (user.role !== "OWNER") {
      throw new AppError(402, "plan_expired", "The shop's plan has ended. Ask the owner to renew.");
    }
    return { state, user };
  }

  await reconcileWithinPlan(ctx.prisma, user.accountId, state.plan!);
  const fresh = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { branches: { include: { branch: true } } } });
  if (!fresh.withinPlan) {
    throw new AppError(403, "over_plan_limit", "The shop's plan has fewer staff logins now. Ask the owner.");
  }
  if (fresh.role !== "OWNER") {
    const usable = fresh.branches.some((ub) => ub.branch.withinPlan && !ub.branch.archivedAt);
    if (!usable) throw new AppError(403, "branch_unavailable", "Your branch is not active on the shop's plan. Ask the owner.");
  }
  return { state, user: fresh };
}

export type IssuedSession = { accessToken: string; expiresIn: number };

export async function startSession(ctx: Ctx, req: Request, res: Response, user: User): Promise<IssuedSession> {
  const now = ctx.now();
  const refresh = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);
  const session = await ctx.prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refresh),
      expiresAt,
      userAgent: (req.get("user-agent") ?? "").slice(0, 300),
      createdAt: now,
      lastUsedAt: now,
    },
  });
  setRefreshCookie(ctx, res, refresh, expiresAt);
  const accessToken = await signAccessToken({ sub: user.id, acc: user.accountId, role: user.role, sid: session.id }, ctx.env.JWT_SECRET, now);
  return { accessToken, expiresIn: ACCESS_TOKEN_SECONDS };
}

/** Rotate the refresh token. A replayed old token revokes the whole session. */
export async function refreshSession(ctx: Ctx, req: Request, res: Response) {
  const token = readRefreshCookie(req);
  if (!token) throw new AppError(401, "not_signed_in", "Please sign in.");
  const now = ctx.now();
  const hash = hashToken(token);

  const session = await ctx.prisma.session.findUnique({ where: { refreshTokenHash: hash }, include: { user: { include: { account: true } } } });
  if (!session) {
    const replayed = await ctx.prisma.session.findUnique({ where: { previousHash: hash } });
    if (replayed && !replayed.revokedAt) {
      await ctx.prisma.session.update({ where: { id: replayed.id }, data: { revokedAt: now } });
      req.log?.warn({ sessionId: replayed.id }, "refresh token replayed; session revoked");
    }
    clearRefreshCookie(ctx, res);
    throw new AppError(401, "not_signed_in", "Please sign in.");
  }
  if (session.revokedAt || session.expiresAt <= now) {
    clearRefreshCookie(ctx, res);
    throw new AppError(401, "session_ended", "Your shift session has ended. Please sign in again.");
  }

  await assertCanHoldSession(ctx, session.user);

  const next = newToken();
  await ctx.prisma.session.update({
    where: { id: session.id },
    data: { refreshTokenHash: hashToken(next), previousHash: hash, lastUsedAt: now },
  });
  setRefreshCookie(ctx, res, next, session.expiresAt);
  const accessToken = await signAccessToken(
    { sub: session.user.id, acc: session.user.accountId, role: session.user.role, sid: session.id },
    ctx.env.JWT_SECRET,
    now,
  );
  return { accessToken, expiresIn: ACCESS_TOKEN_SECONDS, user: session.user };
}

export async function revokeSessionByCookie(ctx: Ctx, req: Request) {
  const token = readRefreshCookie(req);
  if (!token) return;
  await ctx.prisma.session.updateMany({ where: { refreshTokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: ctx.now() } });
}

export async function revokeAllSessions(ctx: Ctx, userId: string) {
  await ctx.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: ctx.now() } });
}
