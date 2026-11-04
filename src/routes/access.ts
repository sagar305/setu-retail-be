import type { AuthContext } from "../auth/middleware.js";
import type { Branch } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";

/** A branch the user may work in; `write` also requires it to be active on the plan. */
export function branchFor(a: AuthContext, branchId: unknown, write = false): Branch {
  const branch = typeof branchId === "string" ? a.branches.find((b) => b.id === branchId) : undefined;
  if (!branch) throw new AppError(404, "branch_not_found", "Branch not found.");
  if (write && !branch.withinPlan) throw new AppError(403, "branch_read_only", "This branch is read-only on your current plan.");
  return branch;
}

export const isStaffManager = (a: AuthContext) => a.user.role === "OWNER" || a.user.role === "MANAGER";

export function planLimit(a: AuthContext, key: "maxProducts" | "maxCustomers" | "maxOrdersPerMonth"): number | null {
  return a.plan.plan?.[key] ?? null;
}
