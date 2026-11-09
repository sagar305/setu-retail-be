// Setu team (super-admin) sessions. Separate from shop sessions: own table,
// own refresh cookie (path /admin/auth) and own token issuer. A sign-in lasts
// 8 hours; access tokens last 10 minutes and are refreshed from the cookie.

import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from "express";
import type { Ctx } from "../context.js";
import type { Db } from "../db/types.js";
import type { Prisma, SuperAdmin } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { signAdminToken, verifyAdminToken } from "../lib/jwt.js";
import { hashToken, newToken } from "../lib/tokens.js";
import { requestIp } from "../services/audit.js";

export const ADMIN_SESSION_HOURS = 8;
export const ADMIN_ACCESS_SECONDS = 10 * 60;
export const ADMIN_REFRESH_COOKIE = "setu_admin_rt";

declare module "express-serve-static-core" {
  interface Request {
    admin?: SuperAdmin;
  }
}

/** Whole-site path, like the shop sign-in cookie (see auth/session.ts). */
function cookieOptions(ctx: Ctx, expires: Date, path = "/"): CookieOptions {
  return { httpOnly: true, secure: ctx.env.NODE_ENV === "production", sameSite: "strict", path, expires };
}
const LEGACY_PATHS = ["/admin/auth", "/api/admin/auth"];
const clearPaths = (ctx: Ctx, res: Response, paths: string[]) => {
  for (const path of paths) res.clearCookie(ADMIN_REFRESH_COOKIE, { ...cookieOptions(ctx, new Date(0), path), expires: undefined });
};

const readCookie = (req: Request): string | null => {
  const v = (req.cookies as Record<string, unknown> | undefined)?.[ADMIN_REFRESH_COOKIE];
  return typeof v === "string" && v ? v : null;
};

export function clearAdminCookie(ctx: Ctx, res: Response) {
  clearPaths(ctx, res, ["/", ...LEGACY_PATHS]);
}

export async function startAdminSession(ctx: Ctx, req: Request, res: Response, admin: SuperAdmin) {
  const now = ctx.now();
  const refresh = newToken();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_HOURS * 3600_000);
  const session = await ctx.prisma.adminSession.create({
    data: { adminId: admin.id, refreshTokenHash: hashToken(refresh), expiresAt, userAgent: (req.get("user-agent") ?? "").slice(0, 300), createdAt: now, lastUsedAt: now },
  });
  res.cookie(ADMIN_REFRESH_COOKIE, refresh, cookieOptions(ctx, expiresAt));
  clearPaths(ctx, res, LEGACY_PATHS);
  const accessToken = await signAdminToken({ sub: admin.id, purpose: "access", sid: session.id }, ctx.env.JWT_SECRET, now, ADMIN_ACCESS_SECONDS);
  return { accessToken, expiresIn: ADMIN_ACCESS_SECONDS };
}

/** Rotate the refresh token; a replayed old one ends the session. */
export async function refreshAdminSession(ctx: Ctx, req: Request, res: Response) {
  const token = readCookie(req);
  if (!token) throw new AppError(401, "not_signed_in", "Please sign in.");
  const now = ctx.now();
  const hash = hashToken(token);
  const session = await ctx.prisma.adminSession.findUnique({ where: { refreshTokenHash: hash }, include: { admin: true } });
  if (!session) {
    const replayed = await ctx.prisma.adminSession.findUnique({ where: { previousHash: hash } });
    if (replayed && !replayed.revokedAt) await ctx.prisma.adminSession.update({ where: { id: replayed.id }, data: { revokedAt: now } });
    clearAdminCookie(ctx, res);
    throw new AppError(401, "not_signed_in", "Please sign in.");
  }
  if (session.revokedAt || session.expiresAt <= now || session.admin.status !== "ACTIVE") {
    clearAdminCookie(ctx, res);
    throw new AppError(401, "session_ended", "Please sign in again.");
  }
  const next = newToken();
  await ctx.prisma.adminSession.update({ where: { id: session.id }, data: { refreshTokenHash: hashToken(next), previousHash: hash, lastUsedAt: now } });
  res.cookie(ADMIN_REFRESH_COOKIE, next, cookieOptions(ctx, session.expiresAt));
  clearPaths(ctx, res, LEGACY_PATHS);
  const accessToken = await signAdminToken({ sub: session.adminId, purpose: "access", sid: session.id }, ctx.env.JWT_SECRET, now, ADMIN_ACCESS_SECONDS);
  return { accessToken, expiresIn: ADMIN_ACCESS_SECONDS, admin: session.admin };
}

export async function endAdminSession(ctx: Ctx, req: Request) {
  const token = readCookie(req);
  if (token) await ctx.prisma.adminSession.updateMany({ where: { refreshTokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: ctx.now() } });
}

export async function revokeAdminSessions(db: Db, adminId: string, now: Date) {
  await db.adminSession.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: now } });
}

/** Bearer admin access token → req.admin, checked against the database on every request. */
export function authenticateAdmin(ctx: Ctx): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const now = ctx.now();
    const claims = token ? await verifyAdminToken(token, ctx.env.JWT_SECRET, now, "access") : null;
    if (!claims?.sid) return next(new AppError(401, "not_signed_in", "Please sign in."));
    const session = await ctx.prisma.adminSession.findUnique({ where: { id: claims.sid }, include: { admin: true } });
    if (!session || session.revokedAt || session.expiresAt <= now || session.adminId !== claims.sub || session.admin.status !== "ACTIVE" || !session.admin.totpSecretEnc) {
      return next(new AppError(401, "session_ended", "Please sign in again."));
    }
    req.admin = session.admin;
    next();
  };
}

export function adminOf(req: Request): SuperAdmin {
  if (!req.admin) throw new AppError(401, "not_signed_in", "Please sign in.");
  return req.admin;
}

/** Every Setu team action is logged. */
export async function adminAudit(
  db: Db,
  admin: Pick<SuperAdmin, "id" | "name"> | null,
  action: string,
  opts: { accountId?: string | null; data?: Prisma.InputJsonValue } = {},
) {
  await db.adminAuditLog.create({
    data: { adminId: admin?.id ?? null, adminName: admin?.name ?? "", action, accountId: opts.accountId ?? null, data: opts.data ?? undefined, ip: requestIp() },
  });
}
