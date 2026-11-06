// Field-level merge for changes made offline, and the owner's "Needs review"
// list (Phase 9b, decision v1.9).
//
// A device sends an edit with `_base`: the values it last saw for the fields
// it changed. For each field:
//   - the cloud still has the base value  → apply the device's value
//   - the cloud already has the device's  → nothing to do
//   - the cloud has something else        → a real clash: keep the cloud value
//                                           and add it to the review list
// Fields the device didn't change are never touched, so edits to different
// fields of the same record merge on their own. Requests without `_base`
// (older clients) apply as before.
import type { Request } from "express";
import type { AuthContext } from "../auth/middleware.js";
import type { Db } from "../db/types.js";
import type { Prisma } from "../generated/prisma/client.js";

export type Clash = { field: string; base: unknown; cloud: unknown; device: unknown };

const norm = (v: unknown): string => JSON.stringify(v instanceof Date ? v.toISOString() : (v ?? null));
const same = (a: unknown, b: unknown) => norm(a) === norm(b);

/** What a device sent alongside its change: the values it saw, and when it made the change. */
export function offlineMeta(req: Request): { base: Record<string, unknown> | null; changedAt: Date | null } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const base = body["_base"] && typeof body["_base"] === "object" && !Array.isArray(body["_base"]) ? (body["_base"] as Record<string, unknown>) : null;
  const t = typeof body["_changedAt"] === "string" ? new Date(body["_changedAt"]) : null;
  return { base, changedAt: t && !Number.isNaN(t.getTime()) ? t : null };
}

export function mergeFields<T extends Record<string, unknown>>(current: Record<string, unknown>, next: T, base: Record<string, unknown> | null): { apply: Partial<T>; clashes: Clash[] } {
  if (!base) return { apply: next, clashes: [] };
  const apply: Partial<T> = {};
  const clashes: Clash[] = [];
  for (const [field, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (!(field in base) || same(current[field], base[field])) (apply as Record<string, unknown>)[field] = value;
    else if (!same(current[field], value)) clashes.push({ field, base: base[field], cloud: current[field] ?? null, device: value });
  }
  return { apply, clashes };
}

type Subject = { entityType: "product" | "branch_price" | "customer" | "supplier"; entityId: string; label: string; relatedId?: string | null; branchId?: string | null };

const json = (v: unknown) => (v === undefined ? null : JSON.parse(norm(v))) as Prisma.InputJsonValue;

export async function recordClashes(db: Db, a: AuthContext, subject: Subject, clashes: Clash[], changedAt: Date | null, now: Date) {
  if (!clashes.length) return 0;
  await db.conflict.createMany({
    data: clashes.map((c) => ({
      accountId: a.account.id,
      branchId: subject.branchId ?? null,
      kind: "field",
      entityType: subject.entityType,
      entityId: subject.entityId,
      relatedId: subject.relatedId ?? null,
      label: subject.label,
      field: c.field,
      baseValue: json(c.base),
      cloudValue: json(c.cloud),
      deviceValue: json(c.device),
      userId: a.user.id,
      userName: a.user.name,
      changedAt: changedAt ?? now,
    })),
  });
  return clashes.length;
}

/** An edit (made offline) to something that was removed meanwhile. */
export async function recordRemovedEdit(db: Db, a: AuthContext, subject: Subject, patch: Record<string, unknown>, changedAt: Date | null, now: Date) {
  await db.conflict.create({
    data: { accountId: a.account.id, kind: "removed", entityType: subject.entityType, entityId: subject.entityId, label: subject.label, deviceValue: json(patch), userId: a.user.id, userName: a.user.name, changedAt: changedAt ?? now },
  });
}

/** Two customers with the same phone (one just added, possibly offline). */
export async function recordDuplicateCustomer(db: Db, a: AuthContext, newId: string, existing: { id: string; name: string }, label: string, changedAt: Date | null, now: Date) {
  await db.conflict.create({
    data: { accountId: a.account.id, kind: "duplicate_customer", entityType: "customer", entityId: newId, relatedId: existing.id, label, cloudValue: json({ id: existing.id, name: existing.name }), userId: a.user.id, userName: a.user.name, changedAt: changedAt ?? now },
  });
}
