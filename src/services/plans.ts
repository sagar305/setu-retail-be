import type { Db } from "../db/types.js";
import type { Plan } from "../generated/prisma/client.js";
import { startOfMonth } from "../lib/time.js";
import { timelineState, type Segment, type TimelineState } from "./planTimeline.js";

export type Limits = Pick<Plan, "maxBranches" | "maxStaff" | "maxProducts" | "maxCustomers" | "maxOrdersPerMonth">;

export type PlanState = TimelineState & {
  /** Limits of the active plan; null when expired. */
  plan: (Limits & { code: string; name: string }) | null;
  queuedPlans: { code: string; name: string; startsAt: Date; endsAt: Date }[];
};

export async function loadSegments(db: Db, accountId: string): Promise<(Segment & { plan: Plan })[]> {
  const subs = await db.subscription.findMany({ where: { accountId }, include: { plan: true }, orderBy: { startsAt: "asc" } });
  return subs.map((s) => ({
    id: s.id,
    planCode: s.plan.code,
    monthlyPriceInr: s.plan.monthlyPriceInr,
    source: s.source,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    plan: s.plan,
  }));
}

export async function planState(db: Db, accountId: string, now: Date): Promise<PlanState> {
  const segments = await loadSegments(db, accountId);
  const state = timelineState(segments, now);
  const current = state.current ? segments.find((s) => s.id === state.current!.id)! : null;
  return {
    ...state,
    plan: current
      ? {
          code: current.plan.code,
          name: current.plan.name,
          maxBranches: current.plan.maxBranches,
          maxStaff: current.plan.maxStaff,
          maxProducts: current.plan.maxProducts,
          maxCustomers: current.plan.maxCustomers,
          maxOrdersPerMonth: current.plan.maxOrdersPerMonth,
        }
      : null,
    queuedPlans: state.queued.map((q) => {
      const s = segments.find((x) => x.id === q.id)!;
      return { code: s.plan.code, name: s.plan.name, startsAt: s.startsAt, endsAt: s.endsAt };
    }),
  };
}

export const addMonths = (date: Date, months: number): Date => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

/** Counts that plan limits apply to. */
export async function usage(db: Db, accountId: string, now: Date = new Date()) {
  const account = await db.account.findUnique({ where: { id: accountId }, select: { timezone: true } });
  const monthStart = startOfMonth(now, account?.timezone ?? "Asia/Kolkata");
  const [branches, staff, products, customers, ordersThisMonth] = await Promise.all([
    db.branch.count({ where: { accountId, archivedAt: null } }),
    db.user.count({ where: { accountId, role: { not: "OWNER" }, status: { not: "DISABLED" } } }),
    db.product.count({ where: { accountId, archivedAt: null } }),
    db.customer.count({ where: { accountId, archivedAt: null } }),
    db.order.count({ where: { accountId, createdAt: { gte: monthStart } } }),
  ]);
  return { branches, staff, products, customers, ordersThisMonth };
}
