// The owner's "Needs review" list (Phase 9b, decision v1.9).
import "../zodOpenApi.js";
import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole } from "../auth/middleware.js";
import type { Conflict } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { CustomerPatchBody, ProductPatchBody } from "../schemas2.js";
import { SupplierPatchBody } from "../schemas4.js";
import { audit } from "../services/audit.js";

export const ResolveBody = z.object({
  /**
   * field:   "cloud" (keep) | "device" (use the device's value)
   * removed: "discard" | "restore" (bring it back and apply the edit)
   * duplicate_customer: "keep_both" | "merge" (move bills and udhaar to the older customer)
   */
  choice: z.enum(["cloud", "device", "discard", "restore", "keep_both", "merge"]),
});

export const ConflictDto = z.object({
  id: z.string(),
  kind: z.enum(["field", "removed", "duplicate_customer"]),
  entityType: z.string(),
  entityId: z.string(),
  relatedId: z.string().nullable(),
  label: z.string(),
  field: z.string().nullable(),
  baseValue: z.unknown(),
  cloudValue: z.unknown(),
  deviceValue: z.unknown(),
  userName: z.string(),
  changedAt: z.string(),
  status: z.enum(["OPEN", "RESOLVED"]),
  resolution: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

const dto = (c: Conflict): z.infer<typeof ConflictDto> => ({
  id: c.id,
  kind: c.kind as "field",
  entityType: c.entityType,
  entityId: c.entityId,
  relatedId: c.relatedId,
  label: c.label,
  field: c.field,
  baseValue: c.baseValue,
  cloudValue: c.cloudValue,
  deviceValue: c.deviceValue,
  userName: c.userName,
  changedAt: c.changedAt.toISOString(),
  status: c.status,
  resolution: c.resolution,
  resolvedAt: c.resolvedAt?.toISOString() ?? null,
});

const ALLOWED: Record<string, readonly string[]> = {
  field: ["cloud", "device"],
  removed: ["discard", "restore"],
  duplicate_customer: ["keep_both", "merge"],
};

export function conflictsRouter(ctx: Ctx): Router {
  const router = Router();
  router.use("/conflicts", authenticate(ctx), requireActivePlan);

  // Everyone may see how many are waiting (a badge); only the owner opens the list.
  router.get("/conflicts/count", async (req, res) => {
    const a = auth(req);
    res.json({ open: await ctx.prisma.conflict.count({ where: { accountId: a.account.id, status: "OPEN" } }) });
  });

  router.get("/conflicts", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const status = req.query["status"] === "resolved" ? "RESOLVED" : "OPEN";
    const rows = await ctx.prisma.conflict.findMany({ where: { accountId: a.account.id, status }, orderBy: { createdAt: status === "OPEN" ? "asc" : "desc" }, take: 200 });
    res.json({ conflicts: rows.map(dto) });
  });

  router.post("/conflicts/:id/resolve", requireRole("OWNER"), async (req, res) => {
    const a = auth(req);
    const { choice } = ResolveBody.parse(req.body);
    const c = await ctx.prisma.conflict.findFirst({ where: { id: String(req.params.id), accountId: a.account.id } });
    if (!c) throw new AppError(404, "not_found", "Not found.");
    if (c.status !== "OPEN") throw new AppError(409, "already_resolved", "Someone already sorted this out.");
    if (!ALLOWED[c.kind]?.includes(choice)) throw new AppError(400, "bad_choice", "That choice doesn't fit this item.");
    const now = ctx.now();

    await ctx.prisma.$transaction(async (tx) => {
      const device = c.deviceValue as unknown;
      if (c.kind === "field" && choice === "device") {
        const patch = { [c.field!]: device };
        if (c.entityType === "product") await tx.product.update({ where: { id: c.entityId }, data: ProductPatchBody.parse(patch) });
        else if (c.entityType === "customer") await tx.customer.update({ where: { id: c.entityId }, data: CustomerPatchBody.parse(patch) });
        else if (c.entityType === "supplier") await tx.supplier.update({ where: { id: c.entityId }, data: SupplierPatchBody.parse(patch) });
        else if (c.entityType === "branch_price") {
          await tx.branchProduct.upsert({
            where: { branchId_productId: { branchId: c.relatedId!, productId: c.entityId } },
            create: { branchId: c.relatedId!, productId: c.entityId, price: device as number | null },
            update: { price: device as number | null },
          });
        }
      }
      if (c.kind === "removed" && choice === "restore") {
        const patch = (device ?? {}) as Record<string, unknown>;
        if (c.entityType === "product") await tx.product.update({ where: { id: c.entityId }, data: { ...ProductPatchBody.parse(patch), archivedAt: null } });
        else if (c.entityType === "customer") await tx.customer.update({ where: { id: c.entityId }, data: { ...CustomerPatchBody.parse(patch), archivedAt: null } });
        else if (c.entityType === "supplier") await tx.supplier.update({ where: { id: c.entityId }, data: { ...SupplierPatchBody.parse(patch), archivedAt: null } });
      }
      if (c.kind === "duplicate_customer" && choice === "merge") {
        // The newer customer's bills and udhaar move to the older one, which stays.
        const keep = c.relatedId!;
        await tx.order.updateMany({ where: { accountId: a.account.id, customerId: c.entityId }, data: { customerId: keep } });
        await tx.customerLedgerEntry.updateMany({ where: { accountId: a.account.id, customerId: c.entityId }, data: { customerId: keep } });
        await tx.customer.update({ where: { id: c.entityId }, data: { archivedAt: now } });
      }
      await tx.conflict.update({ where: { id: c.id }, data: { status: "RESOLVED", resolution: choice, resolvedBy: a.user.id, resolvedAt: now } });
      await audit(tx, { accountId: a.account.id, userId: a.user.id, action: "review.resolved", entityType: c.entityType, entityId: c.entityId, data: { label: c.label, field: c.field, kind: c.kind, choice } });
    });
    const fresh = await ctx.prisma.conflict.findUniqueOrThrow({ where: { id: c.id } });
    res.json({ conflict: dto(fresh) });
  });

  return router;
}
