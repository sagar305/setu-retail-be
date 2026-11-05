// "Your plan ends soon" emails.
//
// - Automatic: a daily job (GET /internal/cron/reminders) emails the owner at
//   14, 7 and 1 days before the account's plan timeline ends, each step once
//   per end date. A missed day still sends: 6 days left sends the 7-day one.
// - By hand: the Setu team can send one now to an account, or to everyone
//   ending within N days.
// Accounts with a plan queued after the current one have a later end date,
// so they are reminded about that one instead.

import type { Ctx } from "../context.js";
import { Prisma, type SuperAdmin } from "../generated/prisma/client.js";
import { planEndedMail, planEndingMail } from "../mail/templates.js";
import { adminAudit } from "../auth/admin.js";
import { DAY_MS } from "./planTimeline.js";

export const REMINDER_STEPS = [14, 7, 1] as const;

/** Which automatic step is due with this many days left (null: not yet). */
export function reminderStep(daysLeft: number): number | null {
  if (daysLeft < 1 || daysLeft > REMINDER_STEPS[0]) return null;
  return [...REMINDER_STEPS].reverse().find((s) => daysLeft <= s)!;
}

type Due = { accountId: string; endsAt: Date };

/** Unlocked accounts on a plan now, whose timeline ends within `days`. */
async function endingWithin(ctx: Ctx, now: Date, days: number): Promise<Due[]> {
  const until = new Date(now.getTime() + days * DAY_MS);
  return ctx.prisma.$queryRaw<Due[]>(Prisma.sql`
    SELECT a.id AS "accountId", max(s."endsAt") AS "endsAt"
    FROM accounts a JOIN subscriptions s ON s."accountId" = a.id
    WHERE a."lockedBySetuAt" IS NULL
    GROUP BY a.id
    HAVING max(s."endsAt") > ${now} AND max(s."endsAt") <= ${until}
       AND bool_or(s."startsAt" <= ${now} AND s."endsAt" > ${now})`);
}

const appPlanUrl = (ctx: Ctx) => new URL("/settings/plan", ctx.env.APP_URL).toString();

/** Email the owner. Returns false when there is no verified, active owner to write to. */
async function mailOwner(ctx: Ctx, accountId: string, endsAt: Date | null, now: Date): Promise<boolean> {
  const account = await ctx.prisma.account.findUnique({ where: { id: accountId }, include: { users: { where: { role: "OWNER" } } } });
  const owner = account?.users[0];
  if (!account || !owner || owner.status !== "ACTIVE" || !owner.emailVerifiedAt) return false;
  if (!endsAt || endsAt <= now) {
    await ctx.mailer.send(planEndedMail(owner.email, owner.name, account.name, appPlanUrl(ctx)));
    return true;
  }
  const last = await ctx.prisma.subscription.findFirst({ where: { accountId, endsAt }, include: { plan: true } });
  const daysLeft = Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS);
  const endsOn = endsAt.toLocaleDateString("en-IN", { timeZone: account.timezone, day: "numeric", month: "long", year: "numeric" });
  await ctx.mailer.send(planEndingMail(owner.email, owner.name, account.name, last?.plan.name ?? "current", daysLeft, endsOn, appPlanUrl(ctx)));
  return true;
}

/** The daily job. Returns how many were sent. */
export async function sendAutomaticReminders(ctx: Ctx): Promise<{ sent: number; checked: number }> {
  const now = ctx.now();
  const due = await endingWithin(ctx, now, REMINDER_STEPS[0]);
  let sent = 0;
  for (const d of due) {
    const step = reminderStep(Math.ceil((d.endsAt.getTime() - now.getTime()) / DAY_MS));
    if (step === null) continue;
    // Claim the (account, end date, step) first: the partial unique index
    // makes a second run (or a parallel one) skip it.
    const claimed = await ctx.prisma.expiryReminder.createMany({ data: [{ accountId: d.accountId, endsAt: d.endsAt, step, sentAt: now }], skipDuplicates: true });
    if (claimed.count === 0) continue;
    try {
      if (await mailOwner(ctx, d.accountId, d.endsAt, now)) sent += 1;
    } catch (err) {
      // Let tomorrow's run try again.
      await ctx.prisma.expiryReminder.deleteMany({ where: { accountId: d.accountId, endsAt: d.endsAt, step } });
      throw err;
    }
  }
  if (sent) await adminAudit(ctx.prisma, null, "reminders.sent_automatic", { data: { sent } });
  return { sent, checked: due.length };
}

async function timelineEnd(ctx: Ctx, accountId: string): Promise<Date | null> {
  const r = await ctx.prisma.subscription.aggregate({ where: { accountId }, _max: { endsAt: true } });
  return r._max.endsAt;
}

/** By hand, one account: "ends in N days", or "has ended" if it already has. */
export async function sendReminderNow(ctx: Ctx, accountId: string, admin: SuperAdmin): Promise<boolean> {
  const now = ctx.now();
  const endsAt = await timelineEnd(ctx, accountId);
  const sent = await mailOwner(ctx, accountId, endsAt, now);
  if (sent) {
    await ctx.prisma.expiryReminder.create({ data: { accountId, endsAt: endsAt ?? now, step: 0, adminId: admin.id, sentAt: now } });
    await adminAudit(ctx.prisma, admin, "account.reminder_sent", { accountId, data: { endsAt: endsAt?.toISOString() ?? null } });
  }
  return sent;
}

/** By hand, everyone whose plan ends within `withinDays` (skipping anyone reminded in the last 24 hours). */
export async function sendBulkReminders(ctx: Ctx, withinDays: number, admin: SuperAdmin): Promise<{ sent: number; skipped: number }> {
  const now = ctx.now();
  const due = await endingWithin(ctx, now, withinDays);
  let sent = 0;
  let skipped = 0;
  for (const d of due) {
    const recent = await ctx.prisma.expiryReminder.findFirst({ where: { accountId: d.accountId, sentAt: { gt: new Date(now.getTime() - DAY_MS) } } });
    if (recent || !(await mailOwner(ctx, d.accountId, d.endsAt, now))) {
      skipped += 1;
      continue;
    }
    await ctx.prisma.expiryReminder.create({ data: { accountId: d.accountId, endsAt: d.endsAt, step: 0, adminId: admin.id, sentAt: now } });
    sent += 1;
  }
  await adminAudit(ctx.prisma, admin, "reminders.sent_bulk", { data: { withinDays, sent, skipped } });
  return { sent, skipped };
}
