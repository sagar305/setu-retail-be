// Stock transfers between branches: send (stock leaves, in transit) →
// receive (checked; short or damaged quantity goes back to the sender or is
// written off) or cancel before it arrives. With batch tracking the same
// batch number, expiry and cost move with the stock.
import "../zodOpenApi.js";
import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { auth, authenticate, requireActivePlan, requireRole, type AuthContext } from "../auth/middleware.js";
import type { Db } from "../db/types.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { audit } from "../services/audit.js";
import { sortFefo, takeFromBatches, toDay } from "../services/batches.js";
import { branchFor } from "./access.js";
import { moveStock } from "./catalogue.js";

const Milli = z.number().int().min(1).max(1_000_000_000);
export const TransferBody = z.object({
  id: z.uuid(),
  fromBranchId: z.uuid(),
  toBranchId: z.uuid(),
  note: z.string().trim().max(300).optional(),
  lines: z
    .array(z.object({ productId: z.uuid(), qtyMilli: Milli, batches: z.array(z.object({ batchId: z.uuid(), qtyMilli: Milli })).max(50).optional() }))
    .min(1)
    .max(300),
});
export const ReceiveBody = z.object({
  note: z.string().trim().max(300).optional(),
  /** Leave out to accept everything as sent. */
  lines: z.array(z.object({ itemId: z.uuid(), receivedMilli: z.number().int().min(0), short: z.enum(["RETURN", "WRITE_OFF"]).optional() })).max(300).optional(),
});

const include = { items: { include: { batches: true }, orderBy: { name: "asc" } } } satisfies Prisma.StockTransferInclude;
type Full = Prisma.StockTransferGetPayload<{ include: typeof include }>;

export const TransferBatchDto = z.object({ batchNo: z.string(), expiry: z.string().nullable(), costPrice: z.number().int().nullable(), qtyMilli: z.number().int() });
export const TransferDto = z.object({
  id: z.string(),
  number: z.string(),
  fromBranchId: z.string(),
  toBranchId: z.string(),
  status: z.enum(["SENT", "RECEIVED", "CANCELLED"]),
  note: z.string(),
  receiveNote: z.string(),
  sentAt: z.string(),
  sentByName: z.string(),
  receivedAt: z.string().nullable(),
  receivedByName: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  value: z.number().int(),
  shortMilli: z.number().int(),
  items: z.array(z.object({ id: z.string(), productId: z.string(), name: z.string(), unit: z.string(), qtyMilli: z.number().int(), receivedMilli: z.number().int().nullable(), returnedMilli: z.number().int(), writtenOffMilli: z.number().int(), unitCost: z.number().int().nullable(), batches: z.array(TransferBatchDto) })),
});

const valueOf = (t: { items: { qtyMilli: number; unitCost: number | null }[] }) => t.items.reduce((s, i) => s + (i.unitCost === null ? 0 : Math.round((i.unitCost * i.qtyMilli) / 1000)), 0);

async function names(db: Db, ids: (string | null)[]) {
  const u = await db.user.findMany({ where: { id: { in: [...new Set(ids.filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } });
  return new Map(u.map((x) => [x.id, x.name]));
}

export const transferDto = (t: Full, who: Map<string, string>): z.infer<typeof TransferDto> => ({
  id: t.id,
  number: t.number,
  fromBranchId: t.fromBranchId,
  toBranchId: t.toBranchId,
  status: t.status,
  note: t.note,
  receiveNote: t.receiveNote,
  sentAt: t.sentAt.toISOString(),
  sentByName: who.get(t.sentById) ?? "",
  receivedAt: t.receivedAt?.toISOString() ?? null,
  receivedByName: t.receivedById ? (who.get(t.receivedById) ?? "") : null,
  cancelledAt: t.cancelledAt?.toISOString() ?? null,
  value: valueOf(t),
  shortMilli: t.items.reduce((s, i) => s + i.returnedMilli + i.writtenOffMilli, 0),
  items: t.items.map((i) => ({ id: i.id, productId: i.productId, name: i.name, unit: i.unit, qtyMilli: i.qtyMilli, receivedMilli: i.receivedMilli, returnedMilli: i.returnedMilli, writtenOffMilli: i.writtenOffMilli, unitCost: i.unitCost, batches: i.batches.map((b) => ({ batchNo: b.batchNo, expiry: toDay(b.expiry), costPrice: b.costPrice, qtyMilli: b.qtyMilli })) })),
});

/** Split `qty` across the transfer's batches in order (earliest expiry first). */
function splitBatches<T extends { qtyMilli: number }>(batches: T[], qty: number): { batch: T; qtyMilli: number }[] {
  const out: { batch: T; qtyMilli: number }[] = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const q = Math.min(b.qtyMilli, left);
    if (q > 0) out.push({ batch: b, qtyMilli: q });
    left -= q;
  }
  return out;
}

export function transfersRouter(ctx: Ctx): Router {
  const router = Router();
  router.use("/transfers", authenticate(ctx), requireActivePlan, requireRole("OWNER", "MANAGER"));

  async function find(a: AuthContext, id: unknown): Promise<Full> {
    const t = await ctx.prisma.stockTransfer.findFirst({ where: { id: String(id), accountId: a.account.id }, include });
    // Managers see transfers that touch one of their branches.
    if (!t || !a.branches.some((b) => b.id === t.fromBranchId || b.id === t.toBranchId)) throw new AppError(404, "not_found", "Transfer not found.");
    return t;
  }
  const respond = async (t: Full) => ({ transfer: transferDto(t, await names(ctx.prisma, [t.sentById, t.receivedById])) });

  router.get("/transfers", async (req, res) => {
    const a = auth(req);
    const mine = a.branches.map((b) => b.id);
    const branchId = typeof req.query.branchId === "string" && req.query.branchId ? branchFor(a, req.query.branchId).id : null;
    const status = typeof req.query.status === "string" && ["SENT", "RECEIVED", "CANCELLED"].includes(req.query.status) ? (req.query.status as "SENT") : undefined;
    const rows = await ctx.prisma.stockTransfer.findMany({
      where: { accountId: a.account.id, ...(status ? { status } : {}), OR: branchId ? [{ fromBranchId: branchId }, { toBranchId: branchId }] : [{ fromBranchId: { in: mine } }, { toBranchId: { in: mine } }] },
      include,
      orderBy: { sentAt: "desc" },
      take: 300,
    });
    const who = await names(ctx.prisma, rows.flatMap((t) => [t.sentById, t.receivedById]));
    res.json({ transfers: rows.map((t) => transferDto(t, who)) });
  });

  router.get("/transfers/:id", async (req, res) => {
    res.json(await respond(await find(auth(req), req.params.id)));
  });

  router.post("/transfers", async (req, res) => {
    const a = auth(req);
    const body = TransferBody.parse(req.body);
    const from = branchFor(a, body.fromBranchId, true);
    const to = branchFor(a, body.toBranchId, true);
    if (from.id === to.id) throw new AppError(400, "same_branch", "Pick two different branches.");
    const existing = await ctx.prisma.stockTransfer.findUnique({ where: { id: body.id }, include });
    if (existing) {
      if (existing.accountId !== a.account.id) throw new AppError(409, "id_taken", "That id is already used.");
      return res.status(200).json({ ...(await respond(existing)), replayed: true });
    }
    const qty = new Map<string, number>();
    for (const l of body.lines) qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.qtyMilli);
    const products = await ctx.prisma.product.findMany({ where: { id: { in: [...qty.keys()] }, accountId: a.account.id, archivedAt: null }, include: { branches: { where: { branchId: from.id } } } });
    if (products.length !== qty.size) throw new AppError(400, "unknown_product", "Some products are no longer in the catalogue.");
    const short = products.filter((p) => !p.trackStock || (p.branches[0]?.stockMilli ?? 0) < qty.get(p.id)!);
    if (short.length) throw new AppError(409, "not_enough_stock", `Not enough stock in ${from.name}: ${short.map((p) => p.name).join(", ")}.`, { productIds: short.map((p) => p.id) });
    const now = ctx.now();

    const t = await ctx.prisma.$transaction(async (tx) => {
      const acc = await tx.account.update({ where: { id: a.account.id }, data: { nextTransferNumber: { increment: 1 } } });
      const number = `T-${String(acc.nextTransferNumber - 1).padStart(5, "0")}`;
      await tx.stockTransfer.create({ data: { id: body.id, accountId: a.account.id, number, fromBranchId: from.id, toBranchId: to.id, note: body.note ?? "", sentById: a.user.id, sentAt: now } });
      for (const p of products) {
        const q = qty.get(p.id)!;
        await moveStock(tx, { at: ctx.now(), accountId: a.account.id, branchId: from.id, productId: p.id, change: -q, type: "TRANSFER_OUT", refId: body.id, note: `${number} to ${to.code}`, userId: a.user.id });
        const item = await tx.stockTransferItem.create({ data: { transferId: body.id, productId: p.id, name: p.name, unit: p.unit, qtyMilli: q, unitCost: p.costPrice } });
        if (!a.account.batchTracking) continue;
        // The batches it leaves from: the ones picked, else earliest expiry first.
        const picked = body.lines.filter((l) => l.productId === p.id).flatMap((l) => l.batches ?? []);
        let left = q;
        const moved: { batchId: string | null; qtyMilli: number }[] = [];
        for (const pb of picked) {
          const b = await tx.batch.findFirst({ where: { id: pb.batchId, branchId: from.id, productId: p.id } });
          const take = Math.min(pb.qtyMilli, Math.max(0, b?.qtyMilli ?? 0), left);
          if (!b || take <= 0) continue;
          await tx.batch.update({ where: { id: b.id }, data: { qtyMilli: { decrement: take } } });
          moved.push({ batchId: b.id, qtyMilli: take });
          left -= take;
        }
        if (left > 0) {
          const r = await takeFromBatches(tx, { branchId: from.id, productId: p.id, qtyMilli: left, fallbackCost: p.costPrice });
          moved.push(...r.allocations.map((x) => ({ batchId: x.batchId, qtyMilli: x.qtyMilli })));
          if (r.shortfall > 0) moved.push({ batchId: null, qtyMilli: r.shortfall });
        }
        const src = await tx.batch.findMany({ where: { id: { in: moved.map((m) => m.batchId).filter((x): x is string => Boolean(x)) } } });
        const byId = new Map(src.map((b) => [b.id, b]));
        for (const m of moved) {
          const b = m.batchId ? byId.get(m.batchId) : undefined;
          await tx.stockTransferBatch.create({ data: { itemId: item.id, sourceBatchId: m.batchId, batchNo: b && !b.opening ? b.batchNo : "", expiry: b?.expiry ?? null, costPrice: b?.costPrice ?? p.costPrice, qtyMilli: m.qtyMilli } });
        }
      }
      return tx.stockTransfer.findUniqueOrThrow({ where: { id: body.id }, include });
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: from.id, action: "transfer.sent", entityType: "transfer", entityId: t.id, data: { number: t.number, from: from.code, to: to.code, items: t.items.length, value: valueOf(t) } });
    res.status(201).json(await respond(t));
  });

  /** Put stock back into the sending branch (and its batches). */
  async function backToSender(tx: Db, a: AuthContext, t: Full, item: Full["items"][number], qtyMilli: number, note: string) {
    if (qtyMilli <= 0) return;
    await moveStock(tx, { at: ctx.now(), accountId: a.account.id, branchId: t.fromBranchId, productId: item.productId, change: qtyMilli, type: "TRANSFER_RETURN", refId: t.id, note, userId: a.user.id });
    if (!a.account.batchTracking) return;
    // Back into the batches it came from; anything without a batch goes to the catch-all.
    for (const { batch, qtyMilli: q } of splitBatches(sortFefo(item.batches.map((b) => ({ ...b, receivedAt: new Date(0) }))).reverse(), qtyMilli)) {
      const src = batch.sourceBatchId ? await tx.batch.findUnique({ where: { id: batch.sourceBatchId } }) : null;
      if (src) await tx.batch.update({ where: { id: src.id }, data: { qtyMilli: { increment: q } } });
      else {
        const opening = await tx.batch.findFirst({ where: { branchId: t.fromBranchId, productId: item.productId, opening: true } });
        if (opening) await tx.batch.update({ where: { id: opening.id }, data: { qtyMilli: { increment: q } } });
        else await tx.batch.create({ data: { accountId: a.account.id, branchId: t.fromBranchId, productId: item.productId, qtyMilli: q, opening: true, note: "Stock without batch details", receivedAt: ctx.now() } });
      }
    }
  }

  router.post("/transfers/:id/receive", async (req, res) => {
    const a = auth(req);
    const t = await find(a, req.params.id);
    const to = branchFor(a, t.toBranchId, true);
    const body = ReceiveBody.parse(req.body ?? {});
    if (t.status !== "SENT") throw new AppError(409, "not_in_transit", t.status === "RECEIVED" ? "This transfer was already received." : "This transfer was cancelled.");
    const given = new Map((body.lines ?? []).map((l) => [l.itemId, l]));
    for (const id of given.keys()) if (!t.items.some((i) => i.id === id)) throw new AppError(400, "unknown_item", "That item isn't on this transfer.");
    for (const i of t.items) {
      const g = given.get(i.id);
      if (g && g.receivedMilli > i.qtyMilli) throw new AppError(400, "too_many", `More ${i.name} received than was sent.`);
      if (g && g.receivedMilli < i.qtyMilli && !g.short) throw new AppError(400, "short_needs_action", `Say what happens to the missing ${i.name}: back to the sender or written off.`);
    }
    const now = ctx.now();
    const done = await ctx.prisma.$transaction(async (tx) => {
      const r = await tx.stockTransfer.updateMany({ where: { id: t.id, status: "SENT" }, data: { status: "RECEIVED", receivedAt: now, receivedById: a.user.id, receiveNote: body.note ?? "" } });
      if (r.count === 0) throw new AppError(409, "not_in_transit", "This transfer was already received or cancelled.");
      const fromCode = a.branches.find((b) => b.id === t.fromBranchId)?.code ?? (await tx.branch.findUnique({ where: { id: t.fromBranchId } }))?.code ?? "";
      for (const i of t.items) {
        const g = given.get(i.id);
        const got = g?.receivedMilli ?? i.qtyMilli;
        const missing = i.qtyMilli - got;
        await tx.stockTransferItem.update({ where: { id: i.id }, data: { receivedMilli: got, returnedMilli: g?.short === "RETURN" ? missing : 0, writtenOffMilli: g?.short === "WRITE_OFF" ? missing : 0 } });
        if (got > 0) {
          await moveStock(tx, { at: ctx.now(), accountId: a.account.id, branchId: to.id, productId: i.productId, change: got, type: "TRANSFER_IN", refId: t.id, note: `${t.number} from ${fromCode}`, userId: a.user.id });
          if (a.account.batchTracking) {
            // Same batch number, expiry and cost arrive, earliest expiry first.
            for (const { batch, qtyMilli } of splitBatches(sortFefo(i.batches.map((b) => ({ ...b, receivedAt: new Date(0) }))), got)) {
              if (!batch.batchNo && !batch.expiry) {
                const opening = await tx.batch.findFirst({ where: { branchId: to.id, productId: i.productId, opening: true } });
                if (opening) await tx.batch.update({ where: { id: opening.id }, data: { qtyMilli: { increment: qtyMilli } } });
                else await tx.batch.create({ data: { accountId: a.account.id, branchId: to.id, productId: i.productId, qtyMilli, opening: true, note: "Stock without batch details", receivedAt: now } });
              } else {
                await tx.batch.create({ data: { accountId: a.account.id, branchId: to.id, productId: i.productId, batchNo: batch.batchNo, expiry: batch.expiry, costPrice: batch.costPrice, qtyMilli, note: `${t.number} from ${fromCode}`, receivedAt: now } });
              }
            }
          }
        }
        if (missing > 0 && g?.short === "RETURN") await backToSender(tx, a, t, { ...i, batches: [...i.batches] }, missing, `${t.number}: short/damaged, back from ${to.code}`);
      }
      return tx.stockTransfer.findUniqueOrThrow({ where: { id: t.id }, include });
    });
    const shortLines = done.items.filter((i) => i.returnedMilli || i.writtenOffMilli);
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: to.id, action: "transfer.received", entityType: "transfer", entityId: t.id, data: { number: t.number, short: shortLines.map((i) => ({ name: i.name, returnedMilli: i.returnedMilli, writtenOffMilli: i.writtenOffMilli })) } });
    res.json(await respond(done));
  });

  router.post("/transfers/:id/cancel", async (req, res) => {
    const a = auth(req);
    const t = await find(a, req.params.id);
    branchFor(a, t.fromBranchId, true);
    if (t.status !== "SENT") throw new AppError(409, "not_in_transit", "Only a transfer still in transit can be cancelled.");
    const done = await ctx.prisma.$transaction(async (tx) => {
      const r = await tx.stockTransfer.updateMany({ where: { id: t.id, status: "SENT" }, data: { status: "CANCELLED", cancelledAt: ctx.now(), cancelledById: a.user.id } });
      if (r.count === 0) throw new AppError(409, "not_in_transit", "This transfer was already received or cancelled.");
      for (const i of t.items) await backToSender(tx, a, t, i, i.qtyMilli, `${t.number} cancelled`);
      return tx.stockTransfer.findUniqueOrThrow({ where: { id: t.id }, include });
    });
    await audit(ctx.prisma, { accountId: a.account.id, userId: a.user.id, branchId: t.fromBranchId, action: "transfer.cancelled", entityType: "transfer", entityId: t.id, data: { number: t.number } });
    res.json(await respond(done));
  });

  return router;
}
