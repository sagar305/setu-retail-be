import type { z } from "zod";
import type { Account, Branch, User } from "./generated/prisma/client.js";
import type { BranchDto, MeDto, PlanDto, StaffDto, UserDto } from "./schemas.js";
import type { PlanState } from "./services/plans.js";
import type { Segment } from "./services/planTimeline.js";

export const userDto = (u: User): z.infer<typeof UserDto> => ({
  id: u.id,
  name: u.name,
  email: u.email,
  username: u.username,
  role: u.role,
});

export const branchDto = (b: Branch): z.infer<typeof BranchDto> => ({
  id: b.id,
  code: b.code,
  name: b.name,
  address: b.address,
  phone: b.phone,
  gstin: b.gstin,
  stateCode: b.stateCode,
  withinPlan: b.withinPlan,
  createdAt: b.createdAt.toISOString(),
});

export const planDto = (s: PlanState): z.infer<typeof PlanDto> => ({
  expired: s.expired,
  daysLeft: s.daysLeft,
  current:
    s.current && s.plan
      ? {
          code: s.plan.code,
          name: s.plan.name,
          source: (s.current as Segment).source,
          startsAt: s.current.startsAt.toISOString(),
          endsAt: s.current.endsAt.toISOString(),
          limits: {
            maxBranches: s.plan.maxBranches,
            maxStaff: s.plan.maxStaff,
            maxProducts: s.plan.maxProducts,
            maxCustomers: s.plan.maxCustomers,
            maxOrdersPerMonth: s.plan.maxOrdersPerMonth,
          },
        }
      : null,
  queued: s.queuedPlans.map((q) => ({ code: q.code, name: q.name, startsAt: q.startsAt.toISOString(), endsAt: q.endsAt.toISOString() })),
});

export const meDto = (user: User, account: Account, branches: Branch[], plan: PlanState): z.infer<typeof MeDto> => ({
  user: userDto(user),
  account: {
    id: account.id,
    name: account.name,
    currency: account.currency,
    timezone: account.timezone,
    keepActiveReviewPending: account.keepActiveReviewPending,
  },
  branches: branches.map(branchDto),
  plan: planDto(plan),
});

export const staffDto = (u: User & { branches: { branchId: string }[] }): z.infer<typeof StaffDto> => ({
  ...userDto(u),
  status: u.status,
  withinPlan: u.withinPlan,
  branchIds: u.branches.map((b) => b.branchId),
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});
