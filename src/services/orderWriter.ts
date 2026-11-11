// Writes a bill: order, items, payments, stock and batch allocations.
// Used by online billing (POST /orders) and by offline sync (POST /sync/orders),
// so both save exactly the same way.
import type { Db } from "../db/types.js";
import type { Account, Branch, Customer, PaymentKind, Prisma, TaxMode } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import type { Bill, Discount } from "../lib/gst.js";
import { moveStock } from "../routes/catalogue.js";
import { blendedUnitCost, takeFromBatches } from "./batches.js";

export const orderInclude = {
  items: { orderBy: { position: "asc" }, include: { batches: { include: { batch: { select: { batchNo: true, expiry: true } } } } } },
  payments: true,
  creditNotes: { include: { items: true }, orderBy: { createdAt: "asc" } },
  counter: { select: { code: true, name: true } },
  branch: { select: { id: true, code: true, name: true, address: true, phone: true, gstin: true, stateCode: true } },
} satisfies Prisma.OrderInclude;
export type FullOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export type LineMeta = { productId: string | null; name: string; hsn: string; unit: string; costPrice: number | null; trackStock: boolean; batchId?: string | null };

export type PersistArgs = {
  id: string;
  account: Account;
  branch: Branch;
  counterId: string;
  cashierId: string;
  invoiceNumber: string;
  customer: Customer | null;
  placeOfSupply: string | null;
  interState: boolean;
  taxEnabled: boolean;
  taxMode: TaxMode;
  discount: Discount;
  bill: Bill;
  lines: LineMeta[];
  payments: { methodId: string; methodName: string; kind: PaymentKind; amount: number }[];
  note: string;
  createdAt: Date;
  /** Block the bill when stock would go below zero (online, owner setting off). */
  blockBelowZero: boolean;
  offline?: boolean;
  priceDiffers?: boolean;
  syncedAt?: Date | null;
};

const pad = (n: number) => String(n).padStart(5, "0");
export const invoiceNumberFor = (branchCode: string, counterCode: string, n: number) => `${branchCode}-${counterCode}-${pad(n)}`;

/** "B1-C2-00045" → 45 when it belongs to that counter; null otherwise. */
export function invoiceSeq(invoiceNumber: string, branchCode: string, counterCode: string): number | null {
  const m = new RegExp(`^${branchCode}-${counterCode}-(\\d{5,9})$`).exec(invoiceNumber);
  return m ? Number(m[1]) : null;
}

export async function persistOrder(tx: Db, a: PersistArgs): Promise<FullOrder> {
  const { account, branch, bill } = a;
  // Quantity per stocked product (the same product can appear on two lines).
  const need = new Map<string, number>();
  a.lines.forEach((l, i) => {
    if (l.productId && l.trackStock) need.set(l.productId, (need.get(l.productId) ?? 0) + bill.lines[i]!.qtyMilli);
  });

  if (a.blockBelowZero) {
    const short: string[] = [];
    for (const [productId, qty] of need) {
      const r = await tx.branchProduct.updateMany({ where: { branchId: branch.id, productId, stockMilli: { gte: qty } }, data: { stockMilli: { decrement: qty } } });
      if (r.count === 0) short.push(productId);
    }
    if (short.length) {
      const names = short.map((id) => a.lines.find((l) => l.productId === id)!.name);
      throw new AppError(409, "out_of_stock", `Not enough stock: ${names.join(", ")}.`, { productIds: short });
    }
  }

  const created = await tx.order.create({
    data: {
      id: a.id,
      accountId: account.id,
      branchId: branch.id,
      counterId: a.counterId,
      cashierId: a.cashierId,
      invoiceNumber: a.invoiceNumber,
      customerId: a.customer?.id ?? null,
      customerName: a.customer?.name ?? "",
      customerPhone: a.customer?.phone ?? "",
      customerGstin: a.customer?.gstin ?? null,
      placeOfSupply: a.placeOfSupply,
      interState: a.interState,
      taxEnabled: a.taxEnabled,
      taxMode: a.taxMode,
      discountType: a.discount.type,
      discountValue: a.discount.value,
      subtotal: bill.subtotal,
      discountTotal: bill.discountTotal,
      taxableTotal: bill.taxableTotal,
      cgstTotal: bill.cgstTotal,
      sgstTotal: bill.sgstTotal,
      igstTotal: bill.igstTotal,
      total: bill.total,
      note: a.note,
      createdAt: a.createdAt,
      offline: a.offline ?? false,
      priceDiffers: a.priceDiffers ?? false,
      syncedAt: a.syncedAt ?? null,
      items: {
        create: bill.lines.map((l, i) => {
          const m = a.lines[i]!;
          return {
            productId: m.productId,
            position: i,
            name: m.name,
            hsn: m.hsn,
            unit: m.unit,
            qtyMilli: l.qtyMilli,
            unitPrice: l.unitPrice,
            gstRateBp: l.gstRateBp,
            taxInclusive: l.taxInclusive,
            gross: l.gross,
            discount: l.discount,
            taxable: l.taxable,
            cgst: l.cgst,
            sgst: l.sgst,
            igst: l.igst,
            taxes: l.taxes,
            total: l.total,
            unitCost: m.costPrice,
          };
        }),
      },
      payments: { create: a.payments },
    },
    include: orderInclude,
  });

  // Stock moves when the server takes the bill (a synced offline bill: at sync).
  const movedAt = a.syncedAt ?? a.createdAt;
  for (const [productId, qty] of need) {
    if (!a.blockBelowZero) {
      await moveStock(tx, { at: movedAt, accountId: account.id, branchId: branch.id, productId, change: -qty, type: "SALE", refId: created.id, userId: a.cashierId, note: a.offline ? "Offline bill" : "" });
    } else {
      // Stock was already taken above; just log it.
      const after = (await tx.branchProduct.findUniqueOrThrow({ where: { branchId_productId: { branchId: branch.id, productId } } })).stockMilli;
      await tx.inventoryLog.create({ data: { accountId: account.id, branchId: branch.id, productId, type: "SALE", changeMilli: -qty, stockAfterMilli: after, refId: created.id, userId: a.cashierId, createdAt: movedAt } });
    }
  }

  if (account.batchTracking) {
    for (const item of created.items) {
      const m = a.lines[item.position]!;
      if (!m.productId || !m.trackStock) continue;
      const { allocations, shortfall } = await takeFromBatches(tx, { branchId: branch.id, productId: m.productId, qtyMilli: item.qtyMilli, preferredBatchId: m.batchId, fallbackCost: m.costPrice });
      if (allocations.length) {
        await tx.orderItemBatch.createMany({ data: allocations.map((x) => ({ orderItemId: item.id, batchId: x.batchId, qtyMilli: x.qtyMilli, unitCost: x.unitCost })) });
        await tx.orderItem.update({ where: { id: item.id }, data: { unitCost: blendedUnitCost(allocations, shortfall, m.costPrice) } });
      }
    }
    return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: orderInclude });
  }
  return created;
}
