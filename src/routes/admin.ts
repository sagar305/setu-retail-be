// Setu team (super-admin) API. Shops' business data is not exposed here:
// only counts, plan and contact details (docs/PLAN.md, Phase 7).
import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Ctx } from "../context.js";
import { adminAudit, adminOf, authenticateAdmin, revokeAdminSessions } from "../auth/admin.js";
import { Prisma, type Plan } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { issueLicenseKey, readLicenseKey } from "../lib/licenseKey.js";
import { normalizeEmail } from "../lib/normalize.js";
import { startOfMonth } from "../lib/time.js";
import { customKeyMail, resetPasswordMail, verifyEmailMail } from "../mail/templates.js";
import { AddDaysBody, AdminCreateBody, BulkRemindBody, IssueKeyBody, LockBody, UnlockBody } from "../schemasAdmin.js";
import { audit } from "../services/audit.js";
import { DAY_MS } from "../services/planTimeline.js";
import { loadSegments, planState, usage } from "../services/plans.js";
import { pruneRateLimits } from "../services/rateLimit.js";
import { pruneIdempotencyKeys } from "../http/idempotency.js";
import { sendAutomaticReminders, sendBulkReminders, sendReminderNow } from "../services/reminders.js";
import { reconcileWithinPlan } from "../services/withinPlan.js";
import { adminDto, sendAdminLink } from "./adminAuth.js";
import { issueLink } from "./auth.js";

export type AccountStatus = "trial" | "paid" | "granted" | "expired" | "unverified" | "locked";
const STATUSES: readonly AccountStatus[] = ["trial", "paid", "granted", "expired", "unverified", "locked"];

type Row = {
  id: string;
  name: string;
  phone: string;
  taxNumber: string | null;
  timezone: string;
  createdAt: Date;
  lockedBySetuAt: Date | null;
  lockReason: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerVerifiedAt: Date | null;
  source: "TRIAL" | "KEY" | "GRANT" | null;
  planCode: string | null;
  planName: string | null;
  endsAt: Date | null;
  branches: number;
  lastActiveAt: Date | null;
};

/** Every account with its current plan; filters are applied in SQL. */
function accountsQuery(now: Date, where: Prisma.Sql = Prisma.empty, tail: Prisma.Sql = Prisma.empty) {
  return Prisma.sql`
    WITH cur AS (
      SELECT DISTINCT ON (s."accountId") s."accountId", s.source::text AS source, p.code, p.name
      FROM subscriptions s JOIN plans p ON p.id = s."planId"
      WHERE s."startsAt" <= ${now} AND s."endsAt" > ${now}
      ORDER BY s."accountId", s."startsAt" DESC
    ), ends AS (
      SELECT "accountId", max("endsAt") AS "endsAt" FROM subscriptions GROUP BY 1
    ), x AS (
      SELECT a.id, a.name, a.phone, a."taxNumber", a.timezone, a."createdAt", a."lockedBySetuAt", a."lockReason",
             o.id AS "ownerId", o.name AS "ownerName", o.email AS "ownerEmail", o."emailVerifiedAt" AS "ownerVerifiedAt",
             cur.source, cur.code AS "planCode", cur.name AS "planName", ends."endsAt",
             (SELECT count(*)::int FROM branches b WHERE b."accountId" = a.id AND b."archivedAt" IS NULL) AS branches,
             (SELECT max(u."lastLoginAt") FROM users u WHERE u."accountId" = a.id) AS "lastActiveAt",
             CASE WHEN a."lockedBySetuAt" IS NOT NULL THEN 'locked'
                  WHEN ends."endsAt" IS NULL THEN 'unverified'
                  WHEN cur.source IS NULL THEN 'expired'
                  WHEN cur.source = 'TRIAL' THEN 'trial'
                  WHEN cur.source = 'GRANT' THEN 'granted'
                  ELSE 'paid' END AS status
      FROM accounts a
      LEFT JOIN LATERAL (SELECT * FROM users u WHERE u."accountId" = a.id AND u.role = 'OWNER' ORDER BY u."createdAt" LIMIT 1) o ON true
      LEFT JOIN cur ON cur."accountId" = a.id
      LEFT JOIN ends ON ends."accountId" = a.id
    )
    SELECT * FROM x ${where} ${tail}`;
}

const rowStatus = (r: Row): AccountStatus => {
  if (r.lockedBySetuAt) return "locked";
  if (!r.endsAt) return "unverified";
  if (!r.source) return "expired";
  return r.source === "TRIAL" ? "trial" : r.source === "GRANT" ? "granted" : "paid";
};

function rowDto(r: Row, now: Date) {
  const active = r.source !== null;
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    ownerName: r.ownerName ?? "",
    ownerEmail: r.ownerEmail ?? "",
    status: rowStatus(r),
    planCode: r.planCode,
    planName: r.planName,
    endsAt: r.endsAt?.toISOString() ?? null,
    daysLeft: active && r.endsAt ? Math.max(0, Math.ceil((r.endsAt.getTime() - now.getTime()) / DAY_MS)) : 0,
    branches: r.branches,
    lastActiveAt: r.lastActiveAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

const limitsOf = (p: Pick<Plan, "maxBranches" | "maxStaff" | "maxProducts" | "maxCustomers" | "maxOrdersPerMonth">) => ({
  maxBranches: p.maxBranches,
  maxStaff: p.maxStaff,
  maxProducts: p.maxProducts,
  maxCustomers: p.maxCustomers,
  maxOrdersPerMonth: p.maxOrdersPerMonth,
});

const fmt = (n: number | null) => (n === null ? "unlimited" : n.toLocaleString("en-IN"));

export function adminRouter(ctx: Ctx): Router {
  const router = Router();

  // ── Daily job (Vercel Cron sends "Authorization: Bearer $CRON_SECRET") ──
  router.get("/internal/cron/reminders", async (req, res) => {
    const expected = ctx.env.CRON_SECRET;
    if (!expected || req.get("authorization") !== `Bearer ${expected}`) throw new AppError(401, "unauthorized", "Not allowed.");
    const reminders = await sendAutomaticReminders(ctx);
    // Daily housekeeping rides on the same job.
    await pruneRateLimits(ctx);
    await pruneIdempotencyKeys(ctx);
    res.json(reminders);
  });

  router.use("/admin", authenticateAdmin(ctx));

  async function findRow(id: string): Promise<Row> {
    const now = ctx.now();
    const [row] = await ctx.prisma.$queryRaw<Row[]>(accountsQuery(now, Prisma.sql`WHERE x.id = ${id}::uuid`));
    if (!row) throw new AppError(404, "account_not_found", "Account not found.");
    return row;
  }
  const accountId = (raw: unknown) => {
    const id = String(raw);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, "account_not_found", "Account not found.");
    return id;
  };

  router.get("/admin/dashboard", async (_req, res) => {
    const now = ctx.now();
    const rows = await ctx.prisma.$queryRaw<Row[]>(accountsQuery(now));
    const monthStart = startOfMonth(now, "Asia/Kolkata");
    const byPlan = new Map<string, { code: string; name: string; accounts: number }>();
    const count = (s: AccountStatus) => rows.filter((r) => rowStatus(r) === s).length;
    for (const r of rows) {
      if (rowStatus(r) !== "paid") continue;
      const k = r.planCode!.startsWith("custom-") ? "custom" : r.planCode!;
      const e = byPlan.get(k) ?? { code: k, name: k === "custom" ? "Custom (Contact sales)" : r.planName!, accounts: 0 };
      e.accounts += 1;
      byPlan.set(k, e);
    }
    const order = ["basic", "gold", "platinum", "custom"];
    res.json({
      accounts: rows.length,
      trial: count("trial"),
      paidByPlan: [...byPlan.values()].sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code)),
      granted: count("granted"),
      expired: count("expired"),
      unverified: count("unverified"),
      locked: count("locked"),
      expiringIn14Days: rows.filter((r) => r.source && !r.lockedBySetuAt && r.endsAt && r.endsAt.getTime() - now.getTime() <= 14 * DAY_MS).length,
      signupsThisMonth: rows.filter((r) => r.createdAt >= monthStart).length,
      remindersLast7Days: await ctx.prisma.expiryReminder.count({ where: { sentAt: { gt: new Date(now.getTime() - 7 * DAY_MS) } } }),
    });
  });

  router.get("/admin/accounts", async (req, res) => {
    const now = ctx.now();
    const q = String(req.query["q"] ?? "").trim().slice(0, 100);
    const status = String(req.query["status"] ?? "");
    const expiring = req.query["expiring"] ? Number(req.query["expiring"]) : null;
    const limit = Math.min(100, Math.max(1, Number(req.query["limit"] ?? 50) || 50));
    const offset = Math.max(0, Number(req.query["offset"] ?? 0) || 0);
    const conds: Prisma.Sql[] = [];
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const digits = q.replace(/\D/g, "");
      conds.push(Prisma.sql`(x.name ILIKE ${like} OR x."ownerEmail" ILIKE ${like} OR x."ownerName" ILIKE ${like}${digits.length >= 4 ? Prisma.sql` OR x.phone LIKE ${`%${digits}%`}` : Prisma.empty})`);
    }
    if ((STATUSES as readonly string[]).includes(status)) conds.push(Prisma.sql`x.status = ${status}`);
    if (expiring !== null && Number.isFinite(expiring)) {
      conds.push(Prisma.sql`x.source IS NOT NULL AND x."lockedBySetuAt" IS NULL AND x."endsAt" <= ${new Date(now.getTime() + Math.min(365, Math.max(1, expiring)) * DAY_MS)}`);
    }
    const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
    const sort = expiring !== null ? Prisma.sql`ORDER BY x."endsAt" ASC` : Prisma.sql`ORDER BY x."createdAt" DESC`;
    const [rows, total] = await Promise.all([
      ctx.prisma.$queryRaw<Row[]>(accountsQuery(now, where, Prisma.sql`${sort} LIMIT ${limit} OFFSET ${offset}`)),
      ctx.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM (${accountsQuery(now, where)}) t`),
    ]);
    res.json({ accounts: rows.map((r) => rowDto(r, now)), total: total[0]?.n ?? 0 });
  });

  router.get("/admin/accounts/:id", async (req, res) => {
    const id = accountId(req.params.id);
    const now = ctx.now();
    const row = await findRow(id);
    const [state, use, segments, redemptions, issued, reminders, activity] = await Promise.all([
      planState(ctx.prisma, id, now),
      usage(ctx.prisma, id, now),
      loadSegments(ctx.prisma, id),
      ctx.prisma.licenseRedemption.findMany({ where: { accountId: id }, orderBy: { redeemedAt: "desc" } }),
      ctx.prisma.issuedKey.findMany({ where: { accountId: id }, orderBy: { issuedAt: "desc" } }),
      ctx.prisma.expiryReminder.findMany({ where: { accountId: id }, orderBy: { sentAt: "desc" }, take: 20 }),
      ctx.prisma.adminAuditLog.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    const plans = new Map((await ctx.prisma.plan.findMany({ where: { id: { in: issued.map((k) => k.planId) } } })).map((p) => [p.id, p]));
    const admins = new Map((await ctx.prisma.superAdmin.findMany({ where: { id: { in: issued.map((k) => k.issuedById) } } })).map((a) => [a.id, a.name]));
    const redeemedAt = new Map(redemptions.map((r) => [r.keyId, r.redeemedAt]));
    res.json({
      account: { ...rowDto(row, now), taxNumber: row.taxNumber, timezone: row.timezone, lockedAt: row.lockedBySetuAt?.toISOString() ?? null, lockReason: row.lockReason, ownerVerified: Boolean(row.ownerVerifiedAt), ownerId: row.ownerId },
      plan: { expired: state.expired, daysLeft: state.daysLeft, code: state.plan?.code ?? null, name: state.plan?.name ?? null, source: state.current?.source ?? null, limits: state.plan ? limitsOf(state.plan) : null },
      usage: use,
      timeline: segments.map((s) => ({ planCode: s.planCode, planName: s.plan.name, source: s.source, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })),
      redemptions: redemptions.map((r) => ({ id: r.id, planCode: r.planCode, days: r.days, mode: r.mode, convertedDays: r.convertedDays, redeemedAt: r.redeemedAt.toISOString(), custom: r.planCode.startsWith("custom-") })),
      issuedKeys: issued.map((k) => ({ id: k.id, days: k.days, limits: limitsOf(plans.get(k.planId)!), note: k.note, issuedBy: admins.get(k.issuedById) ?? "", issuedAt: k.issuedAt.toISOString(), redeemedAt: redeemedAt.get(k.keyId)?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null })),
      reminders: reminders.map((r) => ({ endsAt: r.endsAt.toISOString(), step: r.step, sentAt: r.sentAt.toISOString(), manual: r.step === 0 })),
      activity: activity.map((e) => ({ id: e.id, adminName: e.adminName, action: e.action, data: e.data, createdAt: e.createdAt.toISOString() })),
    });
  });

  router.post("/admin/accounts/:id/lock", async (req, res) => {
    const admin = adminOf(req);
    const id = accountId(req.params.id);
    const { reason } = LockBody.parse(req.body);
    const row = await findRow(id);
    if (row.lockedBySetuAt) throw new AppError(409, "already_locked", "This account is already locked.");
    const now = ctx.now();
    await ctx.prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id }, data: { lockedBySetuAt: now, lockReason: reason } });
      // Every request, refresh and counter sync checks the lock, so signed-in
      // users and devices are stopped at once with the "locked" message.
      await adminAudit(tx, admin, "account.locked", { accountId: id, data: { reason } });
      await audit(tx, { accountId: id, userId: null, action: "account.locked_by_setu", entityType: "account", entityId: id });
    });
    res.json({ locked: true });
  });

  router.post("/admin/accounts/:id/unlock", async (req, res) => {
    const admin = adminOf(req);
    const id = accountId(req.params.id);
    const { note } = UnlockBody.parse(req.body ?? {});
    const row = await findRow(id);
    if (!row.lockedBySetuAt) throw new AppError(409, "not_locked", "This account isn't locked.");
    await ctx.prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id }, data: { lockedBySetuAt: null, lockReason: null } });
      await adminAudit(tx, admin, "account.unlocked", { accountId: id, data: { note: note ?? "", wasLockedFor: row.lockReason } });
      await audit(tx, { accountId: id, userId: null, action: "account.unlocked_by_setu", entityType: "account", entityId: id });
    });
    res.json({ locked: false });
  });

  /** Free days of the current plan (or, if it has ended, of the last one), added after everything already on the timeline. */
  router.post("/admin/accounts/:id/add-days", async (req, res) => {
    const admin = adminOf(req);
    const id = accountId(req.params.id);
    const { days, reason } = AddDaysBody.parse(req.body);
    await findRow(id);
    const now = ctx.now();
    const added = await ctx.prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id }, data: { updatedAt: now } }); // row lock: one timeline change at a time
      const segments = await loadSegments(tx, id);
      if (!segments.length) throw new AppError(409, "not_started", "This account hasn't started its trial yet (the owner must verify their email).");
      const state = await planState(tx, id, now);
      const last = segments[segments.length - 1]!;
      const plan = state.current ? segments.find((s) => s.id === state.current!.id)!.plan : last.plan;
      const lastEnd = Math.max(now.getTime(), ...segments.map((s) => s.endsAt.getTime()));
      const startsAt = new Date(lastEnd);
      const endsAt = new Date(lastEnd + days * DAY_MS);
      await tx.subscription.create({ data: { accountId: id, planId: plan.id, source: "GRANT", startsAt, endsAt } });
      await adminAudit(tx, admin, "account.days_added", { accountId: id, data: { days, plan: plan.code, reason, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } });
      await audit(tx, { accountId: id, userId: null, action: "license.days_added", entityType: "subscription", data: { days, plan: plan.code, by: "Setu" } });
      return { plan, startsAt, endsAt };
    });
    const state = await planState(ctx.prisma, id, now);
    if (state.plan) await reconcileWithinPlan(ctx.prisma, id, state.plan);
    res.json({ planCode: added.plan.code, startsAt: added.startsAt.toISOString(), endsAt: added.endsAt.toISOString() });
  });

  async function owner(id: string) {
    const o = await ctx.prisma.user.findFirst({ where: { accountId: id, role: "OWNER" }, orderBy: { createdAt: "asc" } });
    if (!o) throw new AppError(404, "owner_not_found", "This account has no owner.");
    return o;
  }

  router.post("/admin/accounts/:id/resend-verification", async (req, res) => {
    const admin = adminOf(req);
    const id = accountId(req.params.id);
    const o = await owner(id);
    if (o.emailVerifiedAt) throw new AppError(409, "already_verified", "The owner's email is already verified.");
    const link = await issueLink(ctx, o.id, "VERIFY_EMAIL");
    await ctx.mailer.send(verifyEmailMail(o.email, o.name, link));
    await adminAudit(ctx.prisma, admin, "account.verification_resent", { accountId: id, data: { to: o.email } });
    res.json({ sent: true, to: o.email });
  });

  router.post("/admin/accounts/:id/send-reset", async (req, res) => {
    const admin = adminOf(req);
    const id = accountId(req.params.id);
    const o = await owner(id);
    if (o.status !== "ACTIVE") throw new AppError(409, "owner_inactive", "The owner can't sign in yet.");
    const link = await issueLink(ctx, o.id, "RESET_PASSWORD");
    await ctx.mailer.send(resetPasswordMail(o.email, o.name, link));
    await adminAudit(ctx.prisma, admin, "account.reset_sent", { accountId: id, data: { to: o.email } });
    res.json({ sent: true, to: o.email });
  });

  router.post("/admin/accounts/:id/remind", async (req, res) => {
    const id = accountId(req.params.id);
    await findRow(id);
    const sent = await sendReminderNow(ctx, id, adminOf(req));
    if (!sent) throw new AppError(409, "no_owner_email", "The owner hasn't verified their email, so there is nowhere to send it.");
    res.json({ sent: true });
  });

  router.post("/admin/reminders", async (req, res) => {
    const { withinDays } = BulkRemindBody.parse(req.body);
    res.json(await sendBulkReminders(ctx, withinDays, adminOf(req)));
  });

  // ── Contact-sales keys ──
  router.post("/admin/keys", async (req, res) => {
    const admin = adminOf(req);
    const body = IssueKeyBody.parse(req.body);
    const row = await findRow(body.accountId);
    const o = await owner(body.accountId);
    const key = issueLicenseKey(`custom-${randomUUID()}`, "custom", body.days, ctx.env.RETAIL_LICENSE_SECRET);
    const { keyId } = readLicenseKey(key, ctx.env.RETAIL_LICENSE_SECRET)!;
    const limits = { maxBranches: body.maxBranches, maxStaff: body.maxStaff, maxProducts: body.maxProducts, maxCustomers: body.maxCustomers, maxOrdersPerMonth: body.maxOrdersPerMonth };
    const issued = await ctx.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.create({ data: { code: `custom-${keyId}`, name: `Custom · ${body.maxBranches.toLocaleString("en-IN")} branches`, isPublic: false, monthlyPriceInr: null, ...limits } });
      const k = await tx.issuedKey.create({ data: { keyId, accountId: row.id, planId: plan.id, days: body.days, note: body.note, issuedById: admin.id } });
      await adminAudit(tx, admin, "key.issued", { accountId: row.id, data: { issuedKeyId: k.id, days: body.days, ...limits, note: body.note } });
      return k;
    });
    const summary = `${body.days} days · ${fmt(body.maxBranches)} branches, ${fmt(body.maxStaff)} staff, ${fmt(body.maxProducts)} products, ${fmt(body.maxCustomers)} customers, ${fmt(body.maxOrdersPerMonth)} bills a month`;
    const url = `${new URL("/settings/plan", ctx.env.APP_URL).toString()}#key=${encodeURIComponent(key)}`;
    let emailed = true;
    try {
      await ctx.mailer.send(customKeyMail(o.email, o.name, row.name, key, summary, url));
    } catch (err) {
      emailed = false;
      req.log?.error({ err }, "custom key email failed");
    }
    res.status(201).json({ id: issued.id, key, emailedTo: emailed ? o.email : null, redeemUrl: url });
  });

  router.post("/admin/keys/:id/revoke", async (req, res) => {
    const admin = adminOf(req);
    const k = await ctx.prisma.issuedKey.findUnique({ where: { id: String(req.params.id) } }).catch(() => null);
    if (!k) throw new AppError(404, "key_not_found", "Key not found.");
    if (k.revokedAt) throw new AppError(409, "already_revoked", "This key is already cancelled.");
    if (await ctx.prisma.licenseRedemption.findUnique({ where: { keyId: k.keyId } })) throw new AppError(409, "key_used", "This key was already redeemed, so it can't be cancelled.");
    await ctx.prisma.issuedKey.update({ where: { id: k.id }, data: { revokedAt: ctx.now() } });
    await adminAudit(ctx.prisma, admin, "key.revoked", { accountId: k.accountId, data: { issuedKeyId: k.id } });
    res.json({ revoked: true });
  });

  router.get("/admin/keys", async (_req, res) => {
    const keys = await ctx.prisma.issuedKey.findMany({ orderBy: { issuedAt: "desc" }, take: 200, include: { account: { select: { name: true } } } });
    const [plans, admins, redemptions] = await Promise.all([
      ctx.prisma.plan.findMany({ where: { id: { in: keys.map((k) => k.planId) } } }),
      ctx.prisma.superAdmin.findMany({ where: { id: { in: keys.map((k) => k.issuedById) } }, select: { id: true, name: true } }),
      ctx.prisma.licenseRedemption.findMany({ where: { keyId: { in: keys.map((k) => k.keyId) } }, select: { keyId: true, redeemedAt: true } }),
    ]);
    const plan = new Map(plans.map((p) => [p.id, p]));
    const who = new Map(admins.map((a) => [a.id, a.name]));
    const used = new Map(redemptions.map((r) => [r.keyId, r.redeemedAt]));
    res.json({
      keys: keys.map((k) => ({ id: k.id, accountId: k.accountId, accountName: k.account.name, days: k.days, limits: limitsOf(plan.get(k.planId)!), note: k.note, issuedBy: who.get(k.issuedById) ?? "", issuedAt: k.issuedAt.toISOString(), redeemedAt: used.get(k.keyId)?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null })),
    });
  });

  router.get("/admin/redemptions", async (req, res) => {
    const before = req.query["before"] ? new Date(String(req.query["before"])) : null;
    const rows = await ctx.prisma.licenseRedemption.findMany({
      where: before && !Number.isNaN(before.getTime()) ? { redeemedAt: { lt: before } } : {},
      orderBy: { redeemedAt: "desc" },
      take: 100,
      include: { account: { select: { name: true } } },
    });
    res.json({
      redemptions: rows.map((r) => ({ id: r.id, accountId: r.accountId, accountName: r.account.name, planCode: r.planCode, days: r.days, mode: r.mode, redeemedAt: r.redeemedAt.toISOString(), custom: r.planCode.startsWith("custom-") })),
      next: rows.length === 100 ? rows[rows.length - 1]!.redeemedAt.toISOString() : null,
    });
  });

  // ── What the Setu team did ──
  router.get("/admin/activity", async (req, res) => {
    const where: Prisma.AdminAuditLogWhereInput = {};
    const adminId = String(req.query["adminId"] ?? "");
    const account = String(req.query["accountId"] ?? "");
    const action = String(req.query["action"] ?? "");
    const before = req.query["before"] ? new Date(String(req.query["before"])) : null;
    if (/^[0-9a-f-]{36}$/i.test(adminId)) where.adminId = adminId;
    if (/^[0-9a-f-]{36}$/i.test(account)) where.accountId = account;
    if (action) where.action = { startsWith: action.slice(0, 60) };
    if (before && !Number.isNaN(before.getTime())) where.createdAt = { lt: before };
    const rows = await ctx.prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 });
    const ids = [...new Set(rows.map((r) => r.accountId).filter((x): x is string => Boolean(x)))];
    const names = new Map((await ctx.prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
    res.json({
      entries: rows.map((e) => ({ id: e.id, adminId: e.adminId, adminName: e.adminName, action: e.action, accountId: e.accountId, accountName: e.accountId ? (names.get(e.accountId) ?? "(removed)") : null, data: e.data, ip: e.ip, createdAt: e.createdAt.toISOString() })),
      next: rows.length === 100 ? rows[rows.length - 1]!.createdAt.toISOString() : null,
    });
  });

  // ── The Setu team ──
  router.get("/admin/admins", async (_req, res) => {
    const admins = await ctx.prisma.superAdmin.findMany({ orderBy: { createdAt: "asc" } });
    res.json({ admins: admins.map(adminDto) });
  });

  router.post("/admin/admins", async (req, res) => {
    const me = adminOf(req);
    const { email, name } = AdminCreateBody.parse(req.body);
    const normalized = normalizeEmail(email);
    if (await ctx.prisma.superAdmin.findUnique({ where: { email: normalized } })) throw new AppError(409, "email_taken", "There is already an admin with this email.");
    const admin = await ctx.prisma.superAdmin.create({ data: { email: normalized, name, status: "INVITED", createdById: me.id } });
    await sendAdminLink(ctx, admin, false);
    await adminAudit(ctx.prisma, me, "admin.invited", { data: { adminId: admin.id, email: normalized } });
    res.status(201).json({ admin: adminDto(admin) });
  });

  async function otherAdmin(meId: string, id: string) {
    if (id === meId) throw new AppError(400, "not_yourself", "Ask another admin to do this for you.");
    const a = await ctx.prisma.superAdmin.findUnique({ where: { id } }).catch(() => null);
    if (!a) throw new AppError(404, "admin_not_found", "Admin not found.");
    return a;
  }

  /** New password and authenticator app: for a lost phone or a forgotten password. */
  router.post("/admin/admins/:id/reset", async (req, res) => {
    const me = adminOf(req);
    const a = await otherAdmin(me.id, String(req.params.id));
    if (a.status === "DISABLED") throw new AppError(409, "admin_disabled", "Turn this admin back on first.");
    const now = ctx.now();
    const updated = await ctx.prisma.$transaction(async (tx) => {
      const u = await tx.superAdmin.update({ where: { id: a.id }, data: { status: "INVITED", passwordHash: null, totpSecretEnc: null, totpLastStep: null, failedLogins: 0, lockedUntil: null } });
      await revokeAdminSessions(tx, a.id, now);
      return u;
    });
    await sendAdminLink(ctx, updated, true);
    await adminAudit(ctx.prisma, me, "admin.reset", { data: { adminId: a.id, email: a.email } });
    res.json({ admin: adminDto(updated) });
  });

  router.post("/admin/admins/:id/disable", async (req, res) => {
    const me = adminOf(req);
    const a = await otherAdmin(me.id, String(req.params.id));
    const now = ctx.now();
    const updated = await ctx.prisma.$transaction(async (tx) => {
      const u = await tx.superAdmin.update({ where: { id: a.id }, data: { status: "DISABLED" } });
      await revokeAdminSessions(tx, a.id, now);
      await tx.adminToken.updateMany({ where: { adminId: a.id, usedAt: null }, data: { usedAt: now } });
      return u;
    });
    await adminAudit(ctx.prisma, me, "admin.disabled", { data: { adminId: a.id, email: a.email } });
    res.json({ admin: adminDto(updated) });
  });

  router.post("/admin/admins/:id/enable", async (req, res) => {
    const me = adminOf(req);
    const a = await otherAdmin(me.id, String(req.params.id));
    if (a.status !== "DISABLED") throw new AppError(409, "not_disabled", "This admin isn't turned off.");
    // Back on means a fresh password and authenticator app.
    const updated = await ctx.prisma.superAdmin.update({ where: { id: a.id }, data: { status: "INVITED", passwordHash: null, totpSecretEnc: null, totpLastStep: null } });
    await sendAdminLink(ctx, updated, true);
    await adminAudit(ctx.prisma, me, "admin.enabled", { data: { adminId: a.id, email: a.email } });
    res.json({ admin: adminDto(updated) });
  });

  return router;
}
