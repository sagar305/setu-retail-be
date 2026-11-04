import type { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db/types.js";

export type AuditEntry = {
  accountId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Prisma.InputJsonValue;
};

export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      accountId: entry.accountId,
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      data: entry.data ?? undefined,
    },
  });
}
