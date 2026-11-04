// Placeholder limits for the public plans. The database row is the source of
// truth once seeded; edit limits there, not here. Null = unlimited.

export type PlanCode = "basic" | "gold" | "platinum";

export type PlanLimits = {
  maxBranches: number | null;
  maxStaff: number | null;
  maxProducts: number | null;
  maxCustomers: number | null;
  maxOrdersPerMonth: number | null;
};

export type PlanSeed = PlanLimits & { code: PlanCode; name: string };

export const PUBLIC_PLANS: readonly PlanSeed[] = [
  {
    code: "basic",
    name: "Basic",
    maxBranches: 1,
    maxStaff: 3,
    maxProducts: 1_000,
    maxCustomers: 2_000,
    maxOrdersPerMonth: 3_000,
  },
  {
    code: "gold",
    name: "Gold",
    maxBranches: 10,
    maxStaff: 30,
    maxProducts: 10_000,
    maxCustomers: 20_000,
    maxOrdersPerMonth: 30_000,
  },
  {
    code: "platinum",
    name: "Platinum",
    maxBranches: 100,
    maxStaff: 300,
    maxProducts: 100_000,
    maxCustomers: null,
    maxOrdersPerMonth: null,
  },
];

/** New owners get this plan free for TRIAL_MONTHS after verifying their email. */
export const TRIAL_PLAN: PlanCode = "basic";
export const TRIAL_MONTHS = 3;
