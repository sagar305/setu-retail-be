// Keeps branches and staff within the active plan's limits.
//
// - Over the limit (a smaller plan started): the oldest stay active, the rest
//   become read-only (branches) or can't sign in (staff), and the owner is
//   asked to review the choice (keepActiveReviewPending).
// - Room to spare (an upgrade): read-only ones come back, oldest first.
// Nothing is ever deleted.
import type { Db } from "../db/types.js";
import type { Limits } from "./plans.js";

type Row = { id: string; withinPlan: boolean };

/** Which ids should be within plan, keeping existing choices where possible. Rows are oldest first. */
export function chooseWithinPlan(rows: readonly Row[], limit: number | null): { keep: Set<string>; trimmed: boolean } {
  if (limit === null || rows.length <= limit) return { keep: new Set(rows.map((r) => r.id)), trimmed: false };
  const kept = rows.filter((r) => r.withinPlan);
  if (kept.length > limit) return { keep: new Set(kept.slice(0, limit).map((r) => r.id)), trimmed: true };
  const keep = new Set(kept.map((r) => r.id));
  for (const r of rows) {
    if (keep.size >= limit) break;
    keep.add(r.id);
  }
  return { keep, trimmed: false };
}

export async function reconcileWithinPlan(db: Db, accountId: string, limits: Limits): Promise<{ trimmed: boolean }> {
  const [branches, staff] = await Promise.all([
    db.branch.findMany({ where: { accountId, archivedAt: null }, orderBy: [{ createdAt: "asc" }, { number: "asc" }], select: { id: true, withinPlan: true } }),
    db.user.findMany({
      where: { accountId, role: { not: "OWNER" }, status: { not: "DISABLED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, withinPlan: true },
    }),
  ]);

  const b = chooseWithinPlan(branches, limits.maxBranches);
  const s = chooseWithinPlan(staff, limits.maxStaff);

  const apply = async (rows: Row[], keep: Set<string>, update: (ids: string[], value: boolean) => Promise<unknown>) => {
    const on = rows.filter((r) => keep.has(r.id) && !r.withinPlan).map((r) => r.id);
    const off = rows.filter((r) => !keep.has(r.id) && r.withinPlan).map((r) => r.id);
    if (on.length) await update(on, true);
    if (off.length) await update(off, false);
  };
  await apply(branches, b.keep, (ids, withinPlan) => db.branch.updateMany({ where: { id: { in: ids } }, data: { withinPlan } }));
  await apply(staff, s.keep, (ids, withinPlan) => db.user.updateMany({ where: { id: { in: ids } }, data: { withinPlan } }));

  const trimmed = b.trimmed || s.trimmed;
  if (trimmed) await db.account.update({ where: { id: accountId }, data: { keepActiveReviewPending: true } });
  return { trimmed };
}
