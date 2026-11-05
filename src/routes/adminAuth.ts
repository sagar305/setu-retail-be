// Setu team sign-in: email + password, then an authenticator-app code.
// First sign-in after an invite (or reset) links the authenticator app.
import { Router } from "express";
import type { Ctx } from "../context.js";
import {
  adminAudit,
  adminOf,
  authenticateAdmin,
  clearAdminCookie,
  endAdminSession,
  refreshAdminSession,
  revokeAdminSessions,
  startAdminSession,
} from "../auth/admin.js";
import { requireAllowedOrigin } from "../auth/middleware.js";
import type { SuperAdmin } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { signAdminToken, verifyAdminToken } from "../lib/jwt.js";
import { normalizeEmail } from "../lib/normalize.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { decryptTotpSecret, encryptTotpSecret, newTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp.js";
import { hashToken, newToken } from "../lib/tokens.js";
import { adminInviteMail } from "../mail/templates.js";
import { rateLimit, RULES } from "../services/rateLimit.js";
import { AdminAcceptBody, AdminCodeBody, AdminLoginBody } from "../schemasAdmin.js";

const MAX_FAILED = 5;
const LOCKOUT_MS = 15 * 60_000;
export const ADMIN_LINK_HOURS = 48;

export const adminDto = (a: SuperAdmin) => ({
  id: a.id,
  email: a.email,
  name: a.name,
  status: a.status,
  twoFactor: Boolean(a.totpSecretEnc),
  lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
  createdAt: a.createdAt.toISOString(),
});

/** Invite or reset: a one-time link to set a password (2FA is set up at the next sign-in). */
export async function sendAdminLink(ctx: Ctx, admin: SuperAdmin, reset: boolean): Promise<string> {
  const token = newToken();
  const now = ctx.now();
  await ctx.prisma.$transaction([
    ctx.prisma.adminToken.updateMany({ where: { adminId: admin.id, usedAt: null }, data: { usedAt: now } }),
    ctx.prisma.adminToken.create({ data: { adminId: admin.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + ADMIN_LINK_HOURS * 3600_000) } }),
  ]);
  const url = new URL("/super-admin/accept", ctx.env.APP_URL);
  url.searchParams.set("token", token);
  await ctx.mailer.send(adminInviteMail(admin.email, admin.name, url.toString(), reset));
  return url.toString();
}

export function adminAuthRouter(ctx: Ctx, allowedOrigins: Set<string>): Router {
  const router = Router();
  const sameOrigin = requireAllowedOrigin(allowedOrigins);
  const secret = ctx.env.JWT_SECRET;

  async function failed(admin: SuperAdmin, what: "password" | "code") {
    const n = admin.failedLogins + 1;
    const locked = n >= MAX_FAILED;
    await ctx.prisma.superAdmin.update({
      where: { id: admin.id },
      data: locked ? { failedLogins: 0, lockedUntil: new Date(ctx.now().getTime() + LOCKOUT_MS) } : { failedLogins: n },
    });
    await adminAudit(ctx.prisma, admin, "admin.sign_in_failed", { data: { what, attempt: n, locked } });
  }

  function assertNotLocked(admin: SuperAdmin) {
    if (admin.lockedUntil && admin.lockedUntil > ctx.now()) {
      throw new AppError(429, "too_many_attempts", "Too many wrong attempts. Try again in 15 minutes.");
    }
  }

  async function signedIn(req: Parameters<typeof startAdminSession>[1], res: Parameters<typeof startAdminSession>[2], admin: SuperAdmin) {
    const now = ctx.now();
    const fresh = await ctx.prisma.superAdmin.update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
    const issued = await startAdminSession(ctx, req, res, fresh);
    await adminAudit(ctx.prisma, fresh, "admin.signed_in", { data: { userAgent: String(req.get("user-agent") ?? "").slice(0, 200) } });
    return { ...issued, admin: adminDto(fresh) };
  }

  router.post("/admin/auth/login", rateLimit(ctx, RULES.adminLogin), async (req, res) => {
    const { email, password } = AdminLoginBody.parse(req.body);
    const admin = await ctx.prisma.superAdmin.findUnique({ where: { email: normalizeEmail(email) } });
    if (admin) assertNotLocked(admin);
    const ok = await verifyPassword(password, admin?.passwordHash ?? null);
    if (!admin || !ok || admin.status !== "ACTIVE") {
      if (admin && !ok) await failed(admin, "password");
      throw new AppError(401, "invalid_credentials", "Email or password is wrong.");
    }
    const now = ctx.now();
    if (!admin.totpSecretEnc) {
      const totp = newTotpSecret();
      const token = await signAdminToken({ sub: admin.id, purpose: "setup", tse: encryptTotpSecret(totp, secret) }, secret, now, 10 * 60);
      res.json({ step: "setup", token, secret: totp, otpauthUrl: otpauthUrl(totp, admin.email) });
      return;
    }
    res.json({ step: "code", token: await signAdminToken({ sub: admin.id, purpose: "mfa" }, secret, now, 5 * 60) });
  });

  /** First sign-in: prove the authenticator app has the secret, then it is saved. */
  router.post("/admin/auth/setup-2fa", rateLimit(ctx, RULES.adminCode), async (req, res) => {
    const { token, code } = AdminCodeBody.parse(req.body);
    const claims = await verifyAdminToken(token, secret, ctx.now(), "setup");
    const totp = claims?.tse ? decryptTotpSecret(claims.tse, secret) : null;
    const admin = claims ? await ctx.prisma.superAdmin.findUnique({ where: { id: claims.sub } }) : null;
    if (!claims || !totp || !admin || admin.status !== "ACTIVE") throw new AppError(401, "step_expired", "That took too long. Sign in again.");
    if (admin.totpSecretEnc) throw new AppError(409, "already_set_up", "Two-step sign-in is already set up. Sign in again.");
    assertNotLocked(admin);
    const step = verifyTotp(totp, code, ctx.now(), null);
    if (step === null) {
      await failed(admin, "code");
      throw new AppError(401, "invalid_code", "That code didn't match. Check the time on your phone and try the newest code.");
    }
    const saved = await ctx.prisma.superAdmin.update({ where: { id: admin.id }, data: { totpSecretEnc: encryptTotpSecret(totp, secret), totpLastStep: step } });
    await adminAudit(ctx.prisma, saved, "admin.two_factor_set_up");
    res.json(await signedIn(req, res, saved));
  });

  router.post("/admin/auth/verify", rateLimit(ctx, RULES.adminCode), async (req, res) => {
    const { token, code } = AdminCodeBody.parse(req.body);
    const now = ctx.now();
    const claims = await verifyAdminToken(token, secret, now, "mfa");
    const admin = claims ? await ctx.prisma.superAdmin.findUnique({ where: { id: claims.sub } }) : null;
    if (!admin || admin.status !== "ACTIVE" || !admin.totpSecretEnc) throw new AppError(401, "step_expired", "That took too long. Sign in again.");
    assertNotLocked(admin);
    const totp = decryptTotpSecret(admin.totpSecretEnc, secret);
    const step = totp ? verifyTotp(totp, code, now, admin.totpLastStep) : null;
    if (step === null) {
      await failed(admin, "code");
      throw new AppError(401, "invalid_code", "That code didn't match. Try the newest code in your authenticator app.");
    }
    // Claim the step atomically so the same code can't sign in twice.
    const claimed = await ctx.prisma.superAdmin.updateMany({
      where: { id: admin.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    if (claimed.count === 0) throw new AppError(401, "invalid_code", "That code was already used. Wait for the next one.");
    res.json(await signedIn(req, res, admin));
  });

  router.post("/admin/auth/refresh", sameOrigin, async (req, res) => {
    const { accessToken, expiresIn, admin } = await refreshAdminSession(ctx, req, res);
    res.json({ accessToken, expiresIn, admin: adminDto(admin) });
  });

  router.post("/admin/auth/logout", sameOrigin, async (req, res) => {
    await endAdminSession(ctx, req);
    clearAdminCookie(ctx, res);
    res.status(204).end();
  });

  async function adminToken(token: string) {
    const row = await ctx.prisma.adminToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { admin: true } });
    if (!row || row.usedAt || row.expiresAt <= ctx.now() || row.admin.status === "DISABLED") {
      throw new AppError(400, "link_invalid", "This link has expired or was already used. Ask another admin for a new one.");
    }
    return row;
  }

  router.get("/admin/auth/invite/:token", rateLimit(ctx, RULES.token), async (req, res) => {
    const row = await adminToken(String(req.params.token));
    res.json({ email: row.admin.email, name: row.admin.name });
  });

  router.post("/admin/auth/accept", rateLimit(ctx, RULES.token), async (req, res) => {
    const { token, password } = AdminAcceptBody.parse(req.body);
    const row = await adminToken(token);
    const now = ctx.now();
    const passwordHash = await hashPassword(password);
    await ctx.prisma.$transaction(async (tx) => {
      await tx.adminToken.update({ where: { id: row.id }, data: { usedAt: now } });
      // A new password always means linking the authenticator app again.
      await tx.superAdmin.update({ where: { id: row.adminId }, data: { passwordHash, status: "ACTIVE", totpSecretEnc: null, totpLastStep: null, failedLogins: 0, lockedUntil: null } });
      await revokeAdminSessions(tx, row.adminId, now);
      await adminAudit(tx, row.admin, "admin.password_set");
    });
    res.json({ accepted: true, email: row.admin.email });
  });

  router.get("/admin/me", authenticateAdmin(ctx), (req, res) => {
    res.json({ admin: adminDto(adminOf(req)) });
  });

  return router;
}
