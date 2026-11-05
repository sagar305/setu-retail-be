import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import type { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db/types.js";

export type AuditEntry = {
  accountId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Prisma.InputJsonValue;
  /** The branch it happened in; managers see their branches' entries. */
  branchId?: string | null;
};

// The request's IP, so every audit entry records where it came from.
const requestInfo = new AsyncLocalStorage<{ ip: string | null }>();
export const auditContext: RequestHandler = (req, _res, next) => requestInfo.run({ ip: req.ip ?? null }, next);

/** The current request's IP (null outside a request). */
export const requestIp = (): string | null => requestInfo.getStore()?.ip ?? null;

export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      accountId: entry.accountId,
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      data: entry.data ?? undefined,
      branchId: entry.branchId ?? null,
      ip: requestInfo.getStore()?.ip ?? null,
    },
  });
}

/** Entries older than this are deleted (kept 2 years). */
export const AUDIT_RETENTION_DAYS = 730;

export async function pruneAudit(db: Db, accountId: string, now: Date): Promise<number> {
  const r = await db.auditLog.deleteMany({ where: { accountId, createdAt: { lt: new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000) } } });
  return r.count;
}
