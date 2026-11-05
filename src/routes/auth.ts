import { Router, type Request } from "express";
import type { Ctx } from "../context.js";
import { authenticate, auth, requireAllowedOrigin } from "../auth/middleware.js";
import {
  assertCanHoldSession,
  clearRefreshCookie,
  refreshSession,
  revokeAllSessions,
  revokeSessionByCookie,
  startSession,
} from "../auth/session.js";
import { TRIAL_MONTHS, TRIAL_PLAN } from "../config/plans.js";
import { isUniqueViolation } from "../db/errors.js";
import { meDto } from "../dto.js";
import type { TokenPurpose, User } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { GSTIN_PATTERN, normalizeEmail, normalizePhone, normalizeTaxNumber, normalizeUsername } from "../lib/normalize.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { hashToken, newToken } from "../lib/tokens.js";
import { inviteMail, resetPasswordMail, verifyEmailMail } from "../mail/templates.js";
import {
  AcceptInviteBody,
  EmailOnlyBody,
  LoginBody,
  ResetPasswordBody,
  SignupBody,
  VerifyEmailBody,
} from "../schemas.js";
import { audit } from "../services/audit.js";
import { DEFAULT_PAYMENT_METHODS } from "./settings.js";
import { addMonths, planState } from "../services/plans.js";

const HOUR = 3600_000;
export const TOKEN_TTL: Record<TokenPurpose, number> = {
  VERIFY_EMAIL: 24 * HOUR,
  RESET_PASSWORD: 1 * HOUR,
  INVITE: 7 * 24 * HOUR,
};
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60_000;

const LINK_PATH: Record<TokenPurpose, string> = {
  VERIFY_EMAIL: "/verify-email",
  RESET_PASSWORD: "/reset-password",
  INVITE: "/accept-invite",
};

/** Issue a one-time token (replacing any unused one of the same purpose) and return the emailed link. */
export async function issueLink(ctx: Ctx, userId: string, purpose: TokenPurpose): Promise<string> {
  const token = newToken();
  const now = ctx.now();
  await ctx.prisma.$transaction([
    ctx.prisma.oneTimeToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: now } }),
    ctx.prisma.oneTimeToken.create({
      data: { userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + TOKEN_TTL[purpose]) },
    }),
  ]);
  const url = new URL(LINK_PATH[purpose], ctx.env.APP_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

async function consumeToken(ctx: Ctx, token: string, purpose: TokenPurpose) {
  const now = ctx.now();
  const row = await ctx.prisma.oneTimeToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { include: { account: true } } } });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt <= now) {
    throw new AppError(400, "link_invalid", "This link has expired or was already used. Ask for a new one.");
  }
  return row;
}

export async function sendInvite(ctx: Ctx, user: User, inviterName: string, businessName: string) {
  const link = await issueLink(ctx, user.id, "INVITE");
  const role = user.role === "MANAGER" ? "a manager" : "a cashier";
  await ctx.mailer.send(inviteMail(user.email, user.name, inviterName, businessName, role, link));
}

function sendSessionResponse(ctx: Ctx) {
  return async (user: User, issued: { accessToken: string; expiresIn: number }) => {
    const full = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { account: true, branches: { include: { branch: true } } } });
    const now = ctx.now();
    const plan = await planState(ctx.prisma, full.accountId, now);
    const branches =
      full.role === "OWNER"
        ? await ctx.prisma.branch.findMany({ where: { accountId: full.accountId, archivedAt: null }, orderBy: { number: "asc" } })
        : full.branches.map((b) => b.branch).filter((b) => !b.archivedAt);
    return { ...issued, me: meDto(full, full.account, branches, plan) };
  };
}

export function authRouter(ctx: Ctx, allowedOrigins: Set<string>): Router {
  const router = Router();
  const respond = sendSessionResponse(ctx);
  const sameOrigin = requireAllowedOrigin(allowedOrigins);

  router.post("/auth/signup", async (req, res) => {
    const body = SignupBody.parse(req.body);
    const email = normalizeEmail(body.email);
    const username = normalizeUsername(body.username);
    const phone = normalizePhone(body.phone);
    if (!phone) throw new AppError(400, "invalid_phone", "Enter a valid phone number.");
    const taxNumber = body.taxNumber ? normalizeTaxNumber(body.taxNumber) : null;
    if (body.taxNumber && !taxNumber) throw new AppError(400, "invalid_tax_number", "Enter a valid GSTIN or tax number.");

    const [emailTaken, usernameTaken, claim] = await Promise.all([
      ctx.prisma.user.findUnique({ where: { email } }),
      ctx.prisma.user.findUnique({ where: { username } }),
      ctx.prisma.trialClaim.findFirst({
        where: { OR: [{ email }, { phone }, ...(taxNumber ? [{ taxNumber }] : [])] },
      }),
    ]);
    if (emailTaken || claim?.email === email) throw new AppError(409, "email_taken", "This email already has an account. Sign in instead.");
    if (usernameTaken) throw new AppError(409, "username_taken", "That username is taken. Try another.");
    if (claim?.phone === phone) throw new AppError(409, "phone_used", "This phone number is already used by another shop's account.");
    if (taxNumber && claim?.taxNumber === taxNumber) {
      throw new AppError(409, "tax_number_used", "This GSTIN / tax number is already used by another shop's account.");
    }

    const isGstin = taxNumber !== null && GSTIN_PATTERN.test(taxNumber);
    const passwordHash = await hashPassword(body.password);
    let owner: User;
    try {
      owner = await ctx.prisma.$transaction(async (tx) => {
        const account = await tx.account.create({
          data: { name: body.businessName, phone, taxNumber, nextBranchNumber: 2, taxEnabled: isGstin },
        });
        await tx.paymentMethod.createMany({ data: DEFAULT_PAYMENT_METHODS.map((m) => ({ ...m, accountId: account.id })) });
        await tx.branch.create({
          data: { accountId: account.id, number: 1, code: "B1", name: "Main branch", phone: body.phone, gstin: isGstin ? taxNumber : null, stateCode: isGstin ? taxNumber!.slice(0, 2) : null },
        });
        const user = await tx.user.create({
          data: { accountId: account.id, email, username, name: body.ownerName, role: "OWNER", status: "ACTIVE", passwordHash },
        });
        await tx.trialClaim.create({ data: { email, phone, taxNumber, accountId: account.id } });
        await audit(tx, { accountId: account.id, userId: user.id, action: "account.created", entityType: "account", entityId: account.id });
        return user;
      });
    } catch (err) {
      if (isUniqueViolation(err, "username")) throw new AppError(409, "username_taken", "That username is taken. Try another.");
      if (isUniqueViolation(err, "phone")) throw new AppError(409, "phone_used", "This phone number is already used by another shop's account.");
      if (isUniqueViolation(err, "taxNumber")) throw new AppError(409, "tax_number_used", "This GSTIN / tax number is already used by another shop's account.");
      if (isUniqueViolation(err)) throw new AppError(409, "email_taken", "This email already has an account. Sign in instead.");
      throw err;
    }

    const link = await issueLink(ctx, owner.id, "VERIFY_EMAIL");
    await ctx.mailer.send(verifyEmailMail(email, owner.name, link));
    res.status(201).json({ status: "verification_sent", email });
  });

  router.post("/auth/verify-email", async (req, res) => {
    const { token } = VerifyEmailBody.parse(req.body);
    const row = await consumeToken(ctx, token, "VERIFY_EMAIL");
    const now = ctx.now();
    await ctx.prisma.$transaction(async (tx) => {
      await tx.oneTimeToken.update({ where: { id: row.id }, data: { usedAt: now } });
      await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: row.user.emailVerifiedAt ?? now } });
      // The trial starts when the owner proves their email, once per account.
      if (row.user.role === "OWNER" && (await tx.subscription.count({ where: { accountId: row.user.accountId } })) === 0) {
        const plan = await tx.plan.findUniqueOrThrow({ where: { code: TRIAL_PLAN } });
        await tx.subscription.create({
          data: { accountId: row.user.accountId, planId: plan.id, source: "TRIAL", startsAt: now, endsAt: addMonths(now, TRIAL_MONTHS) },
        });
        await audit(tx, { accountId: row.user.accountId, userId: row.userId, action: "trial.started", entityType: "subscription", data: { plan: TRIAL_PLAN, months: TRIAL_MONTHS } });
      }
    });
    res.json({ verified: true });
  });

  router.post("/auth/resend-verification", async (req, res) => {
    const { email } = EmailOnlyBody.parse(req.body);
    const user = await ctx.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    if (user && !user.emailVerifiedAt && user.status === "ACTIVE") {
      const link = await issueLink(ctx, user.id, "VERIFY_EMAIL");
      await ctx.mailer.send(verifyEmailMail(user.email, user.name, link));
    }
    // Same answer either way, so this can't be used to find accounts.
    res.status(202).json({ status: "sent_if_account_exists" });
  });

  router.post("/auth/login", async (req, res) => {
    const { login, password } = LoginBody.parse(req.body);
    const key = login.toLowerCase();
    const user = await ctx.prisma.user.findFirst({
      where: key.includes("@") ? { email: key } : { username: key },
      include: { account: true },
    });
    const now = ctx.now();
    if (user?.lockedUntil && user.lockedUntil > now) {
      throw new AppError(429, "too_many_attempts", "Too many wrong passwords. Try again in 15 minutes or reset your password.");
    }
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) {
      if (user) {
        const failed = user.failedLogins + 1;
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: failed >= MAX_FAILED_LOGINS ? { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) } : { failedLogins: failed },
        });
        await audit(ctx.prisma, { accountId: user.accountId, userId: user.id, action: "auth.sign_in_failed", entityType: "user", entityId: user.id, data: { attempt: failed, locked: failed >= MAX_FAILED_LOGINS } });
      }
      throw new AppError(401, "invalid_credentials", "Email/username or password is wrong.");
    }
    await ctx.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });

    const { user: checked } = await assertCanHoldSession(ctx, user);
    const issued = await startSession(ctx, req, res, checked);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    await audit(ctx.prisma, { accountId: user.accountId, userId: user.id, action: "auth.signed_in", entityType: "user", entityId: user.id, data: { userAgent: String(req.get("user-agent") ?? "").slice(0, 200) } });
    res.json(await respond(checked, issued));
  });

  router.post("/auth/refresh", sameOrigin, async (req, res) => {
    const { accessToken, expiresIn, user } = await refreshSession(ctx, req, res);
    res.json(await respond(user, { accessToken, expiresIn }));
  });

  router.post("/auth/logout", sameOrigin, async (req: Request, res) => {
    await revokeSessionByCookie(ctx, req);
    clearRefreshCookie(ctx, res);
    res.status(204).end();
  });

  router.post("/auth/forgot-password", async (req, res) => {
    const { email } = EmailOnlyBody.parse(req.body);
    const user = await ctx.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    if (user && user.status === "ACTIVE" && user.passwordHash) {
      const link = await issueLink(ctx, user.id, "RESET_PASSWORD");
      await ctx.mailer.send(resetPasswordMail(user.email, user.name, link));
    }
    res.status(202).json({ status: "sent_if_account_exists" });
  });

  router.post("/auth/reset-password", async (req, res) => {
    const { token, password } = ResetPasswordBody.parse(req.body);
    const row = await consumeToken(ctx, token, "RESET_PASSWORD");
    const now = ctx.now();
    const passwordHash = await hashPassword(password);
    await ctx.prisma.$transaction([
      ctx.prisma.oneTimeToken.update({ where: { id: row.id }, data: { usedAt: now } }),
      ctx.prisma.user.update({
        where: { id: row.userId },
        // Opening the emailed link proves the email too.
        data: { passwordHash, failedLogins: 0, lockedUntil: null, emailVerifiedAt: row.user.emailVerifiedAt ?? now },
      }),
    ]);
    await revokeAllSessions(ctx, row.userId);
    await audit(ctx.prisma, { accountId: row.user.accountId, userId: row.userId, action: "user.password_reset", entityType: "user", entityId: row.userId });
    res.json({ reset: true });
  });

  router.get("/auth/invite/:token", async (req, res) => {
    const row = await consumeToken(ctx, String(req.params.token), "INVITE");
    res.json({
      name: row.user.name,
      email: row.user.email,
      username: row.user.username,
      role: row.user.role,
      businessName: row.user.account.name,
    });
  });

  router.post("/auth/accept-invite", async (req, res) => {
    const { token, password } = AcceptInviteBody.parse(req.body);
    const row = await consumeToken(ctx, token, "INVITE");
    if (row.user.status === "DISABLED") throw new AppError(403, "user_disabled", "Your access has been removed. Ask the shop owner.");
    const now = ctx.now();
    const passwordHash = await hashPassword(password);
    await ctx.prisma.$transaction([
      ctx.prisma.oneTimeToken.update({ where: { id: row.id }, data: { usedAt: now } }),
      ctx.prisma.user.update({ where: { id: row.userId }, data: { passwordHash, status: "ACTIVE", emailVerifiedAt: now } }),
    ]);
    await audit(ctx.prisma, { accountId: row.user.accountId, userId: row.userId, action: "user.invite_accepted", entityType: "user", entityId: row.userId });
    res.json({ accepted: true, username: row.user.username });
  });

  router.get("/me", authenticate(ctx), (req, res) => {
    const a = auth(req);
    res.json(meDto(a.user, a.account, a.branches, a.plan));
  });

  return router;
}
