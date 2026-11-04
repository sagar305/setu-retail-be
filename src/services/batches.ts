// Batch & expiry tracking. BranchProduct.stockMilli stays the single stock
// number; batches only say WHICH units those are, and are kept in step with it:
//  - stock that arrives without batch details goes into an "opening" batch;
//  - stock that leaves without naming a batch comes out of the batch that
//    expires first (FEFO).
// Batch quantities never go below zero; a sale beyond them (when selling below
// zero is allowed) is simply not allocated to a batch.
import type { Db } from "../db/types.js";

export type BatchRow = { id: string; expiry: Date | null; receivedAt: Date; qtyMilli: number; costPrice: number | null };
export type Allocation = { batchId: string; qtyMilli: number; unitCost: number | null };

/** Earliest expiry first; batches without expiry last; then oldest received. */
export function sortFefo<T extends Pick<BatchRow, "expiry" | "receivedAt">>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.expiry && b.expiry && a.expiry.getTime() !== b.expiry.getTime()) return a.expiry.getTime() - b.expiry.getTime();
    if (a.expiry && !b.expiry) return -1;
    if (!a.expiry && b.expiry) return 1;
    return a.receivedAt.getTime() - b.receivedAt.getTime();
  });
}

/** Take `qty` from batches: the preferred one first, then FEFO. Pure. */
export function planTake(rows: BatchRow[], qty: number, preferredId?: string | null): { take: { batch: BatchRow; qtyMilli: number }[]; shortfall: number } {
  const order = sortFefo(rows.filter((r) => r.qtyMilli > 0));
  const pref = preferredId ? order.findIndex((r) => r.id === preferredId) : -1;
  if (pref > 0) order.unshift(...order.splice(pref, 1));
  let left = qty;
  const take: { batch: BatchRow; qtyMilli: number }[] = [];
  for (const b of order) {
    if (left <= 0) break;
    const q = Math.min(b.qtyMilli, left);
    take.push({ batch: b, qtyMilli: q });
    left -= q;
  }
  return { take, shortfall: Math.max(0, left) };
}

/** Lock a product's batches in a branch for this transaction. */
async function lockBatches(db: Db, branchId: string, productId: string): Promise<BatchRow[]> {
  return db.$queryRaw<BatchRow[]>`
    SELECT "id", "expiry", "receivedAt", "qtyMilli", "costPrice" FROM "batches"
    WHERE "branchId" = ${branchId}::uuid AND "productId" = ${productId}::uuid
    FOR UPDATE`;
}

export async function takeFromBatches(
  db: Db,
  args: { branchId: string; productId: string; qtyMilli: number; preferredBatchId?: string | null; fallbackCost: number | null },
): Promise<{ allocations: Allocation[]; shortfall: number }> {
  const rows = await lockBatches(db, args.branchId, args.productId);
  const { take, shortfall } = planTake(rows, args.qtyMilli, args.preferredBatchId);
  for (const t of take) await db.batch.update({ where: { id: t.batch.id }, data: { qtyMilli: { decrement: t.qtyMilli } } });
  return { allocations: take.map((t) => ({ batchId: t.batch.id, qtyMilli: t.qtyMilli, unitCost: t.batch.costPrice ?? args.fallbackCost })), shortfall };
}

/** Weighted cost per unit of what was sold (allocated units at batch cost, the rest at the product cost). */
export function blendedUnitCost(allocations: Allocation[], shortfall: number, fallbackCost: number | null): number | null {
  const parts = [...allocations.map((a) => ({ q: a.qtyMilli, c: a.unitCost ?? fallbackCost })), { q: shortfall, c: fallbackCost }].filter((p) => p.q > 0);
  // Any unit with no known cost makes the line's cost unknown (margin reports skip it).
  if (!parts.length || parts.some((p) => p.c === null)) return parts.length ? null : fallbackCost;
  const q = parts.reduce((s, p) => s + p.q, 0);
  return Math.round(parts.reduce((s, p) => s + p.q * p.c!, 0) / q);
}

export async function addToOpeningBatch(db: Db, args: { accountId: string; branchId: string; productId: string; qtyMilli: number; now: Date }) {
  if (args.qtyMilli <= 0) return;
  const opening = await db.batch.findFirst({ where: { branchId: args.branchId, productId: args.productId, opening: true } });
  if (opening) await db.batch.update({ where: { id: opening.id }, data: { qtyMilli: { increment: args.qtyMilli } } });
  else await db.batch.create({ data: { accountId: args.accountId, branchId: args.branchId, productId: args.productId, qtyMilli: args.qtyMilli, opening: true, note: "Stock without batch details", receivedAt: args.now } });
}

/** Make batch quantities add up to the stock number again (after SET, imports, or turning tracking on). */
export async function reconcileBatches(db: Db, args: { accountId: string; branchId: string; productId: string; stockMilli: number; now: Date }) {
  const rows = await lockBatches(db, args.branchId, args.productId);
  const sum = rows.reduce((s, r) => s + Math.max(0, r.qtyMilli), 0);
  const target = Math.max(0, args.stockMilli);
  if (target > sum) await addToOpeningBatch(db, { ...args, qtyMilli: target - sum });
  else if (target < sum) {
    const { take } = planTake(rows, sum - target);
    for (const t of take) await db.batch.update({ where: { id: t.batch.id }, data: { qtyMilli: { decrement: t.qtyMilli } } });
  }
}

/** Put `qtyMilli` of a bill line back into the batches it came from. Returns what couldn't be placed. */
export async function restoreToBatches(db: Db, orderItemId: string, qtyMilli: number): Promise<number> {
  // Back into the batches in the order the sale took them: earliest expiry first.
  const rows = await db.orderItemBatch.findMany({ where: { orderItemId }, include: { batch: { select: { expiry: true, receivedAt: true } } } });
  const allocations = sortFefo(rows.map((r) => ({ ...r, expiry: r.batch.expiry, receivedAt: r.batch.receivedAt })));
  let left = qtyMilli;
  for (const a of allocations) {
    if (left <= 0) break;
    const q = Math.min(a.qtyMilli - a.restoredMilli, left);
    if (q <= 0) continue;
    await db.orderItemBatch.update({ where: { id: a.id }, data: { restoredMilli: { increment: q } } });
    await db.batch.update({ where: { id: a.batchId }, data: { qtyMilli: { increment: q } } });
    left -= q;
  }
  return left;
}

/** Turning tracking on: every stocked product gets an opening batch for its current stock. */
export async function startBatchTracking(db: Db, accountId: string, now: Date) {
  const rows = await db.branchProduct.findMany({ where: { stockMilli: { gt: 0 }, product: { accountId, trackStock: true } } });
  for (const r of rows) await reconcileBatches(db, { accountId, branchId: r.branchId, productId: r.productId, stockMilli: r.stockMilli, now });
}

/** "yyyy-mm-dd" ↔ Date at UTC midnight (the column is a DATE). */
export const toDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
export const fromDay = (s: string) => new Date(`${s}T00:00:00.000Z`);

export type ExpiryStatus = "expired" | "soon" | "ok" | "none";
export function expiryStatus(expiry: Date | null, today: string, soonDays = 30): ExpiryStatus {
  if (!expiry) return "none";
  const t = fromDay(today).getTime();
  if (expiry.getTime() < t) return "expired";
  return expiry.getTime() <= t + soonDays * 86_400_000 ? "soon" : "ok";
}
