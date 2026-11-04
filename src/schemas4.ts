// Phase 4a request/response schemas (connected money tools).
import "./zodOpenApi.js";
import { z } from "zod";
import { TOOL_SLUGS } from "./services/books.js";

const Name = z.string().trim().min(1, "Required.").max(120);
const Amount = z.number().int().min(1, "Enter an amount.").max(1_000_000_000);
const Paise = z.number().int().min(0).max(1_000_000_000);
const Text = (max: number) => z.string().trim().max(max);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd.");
const At = z.iso.datetime();

export const ToolsPatch = z.partialRecord(z.enum(TOOL_SLUGS), z.boolean());

export const SupplierBody = z.object({
  name: Name,
  phone: Text(20).optional(),
  email: Text(200).optional(),
  gstin: Text(15).optional(),
  stateCode: Text(2).optional(),
  address: Text(300).optional(),
  notes: Text(500).optional(),
});
export const SupplierPatchBody = SupplierBody.partial();

export const ExpenseBody = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  spentAt: At.optional(),
  category: Name,
  description: Text(300).optional(),
  amount: Amount,
  methodId: z.uuid(),
  supplierId: z.uuid().nullable().optional(),
});
export const ExpensePatchBody = ExpenseBody.omit({ id: true, branchId: true }).partial();

export const PaymentBody = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  amount: Amount,
  methodId: z.uuid(),
  occurredAt: At.optional(),
  note: Text(300).optional(),
});
export const OpeningBody = z.object({
  id: z.uuid(),
  amount: Amount,
  /** The day the dues are from (counts as the oldest bill). */
  date: Day,
  /** Suppliers only: when it must be paid. */
  dueDate: Day.optional(),
  note: Text(300).optional(),
});
export const VoidBody = z.object({ reason: Text(300).optional() });

export const CashEntryBody = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  type: z.enum(["IN", "OUT"]),
  amount: Amount,
  description: Name,
  occurredAt: At.optional(),
});
export const CashOpeningBody = z.object({ branchId: z.uuid(), day: Day, amount: Paise });

export const PurchaseLineBody = z.object({
  /** A product in the catalogue (stock goes up), or leave out for a free-text line. */
  productId: z.uuid().nullable().optional(),
  name: Text(200).optional(),
  hsn: z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})?$/, "HSN is 4, 6 or 8 digits.").optional(),
  qtyMilli: z.number().int().min(1).max(1_000_000_000),
  /** Cost per unit before GST, as on the supplier's bill. */
  unitCost: Paise,
  gstRateBp: z.number().int().min(0).max(10_000),
  batchNo: Text(60).optional(),
  expiry: Day.nullable().optional(),
});
export const PurchaseBody = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  supplierId: z.uuid(),
  billNumber: Text(60).min(1, "Enter the supplier's bill number."),
  billDate: Day,
  dueDate: Day.nullable().optional(),
  lines: z.array(PurchaseLineBody).min(1).max(300),
  paidAmount: Paise,
  paidMethodId: z.uuid().nullable().optional(),
  notes: Text(500).optional(),
  /** What the screen showed; refused if the server's total differs. */
  expectedTotal: Paise.optional(),
});
export const PurchaseCancelBody = z.object({ reason: Text(300).min(1, "Say why.") });
export const PurchaseReturnBody = z.object({
  id: z.uuid(),
  mode: z.enum(["CREDIT_NOTE", "REPLACEMENT"]),
  items: z.array(z.object({ purchaseItemId: z.uuid(), qtyMilli: z.number().int().min(1) })).min(1).max(300),
  note: Text(300).optional(),
});
export const ReplacementBody = z.object({ batchNo: Text(60).optional(), expiry: Day.nullable().optional() });

// ── DTOs ──
const Money = z.number().int();
export const SupplierDto = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string(),
  gstin: z.string().nullable(),
  stateCode: z.string().nullable(),
  address: z.string(),
  notes: z.string(),
  balance: Money,
  createdAt: z.string(),
});
export const ExpenseDto = z.object({
  id: z.string(),
  branchId: z.string(),
  spentAt: z.string(),
  category: z.string(),
  description: z.string(),
  amount: Money,
  methodId: z.string().nullable(),
  methodName: z.string(),
  kind: z.string(),
  supplierId: z.string().nullable(),
  supplierName: z.string().nullable(),
  userName: z.string(),
  offline: z.boolean(),
});
export const StatementDto = z.object({
  balance: Money,
  open: Money,
  advance: Money,
  rows: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      type: z.string(),
      ref: z.string(),
      note: z.string(),
      debit: Money,
      credit: Money,
      balance: Money,
      methodName: z.string(),
      branchId: z.string().nullable(),
      voidable: z.boolean(),
      dueDate: z.string().nullable(),
    }),
  ),
  openItems: z.array(z.object({ id: z.string(), type: z.string(), ref: z.string(), at: z.string(), dueDate: z.string().nullable(), amount: Money, paid: Money, open: Money })),
});
export const CashBookDto = z.object({
  branchId: z.string(),
  opening: z.object({ day: z.string(), amount: Money }).nullable(),
  days: z.array(
    z.object({
      day: z.string(),
      opening: Money,
      in: Money,
      out: Money,
      closing: Money,
      lines: z.array(z.object({ id: z.string(), at: z.string(), day: z.string(), direction: z.enum(["IN", "OUT"]), amount: Money, source: z.string(), label: z.string(), deletable: z.boolean() })),
    }),
  ),
});
const Tax = { taxable: Money, cgst: Money, sgst: Money, igst: Money, total: Money };
export const PurchaseItemDto = z.object({
  id: z.string(),
  productId: z.string().nullable(),
  name: z.string(),
  hsn: z.string(),
  unit: z.string(),
  qtyMilli: z.number().int(),
  unitCost: Money,
  gstRateBp: z.number().int(),
  ...Tax,
  batchNo: z.string(),
  expiry: z.string().nullable(),
  returnedQtyMilli: z.number().int(),
});
export const PurchaseReturnDto = z.object({
  id: z.string(),
  mode: z.enum(["CREDIT_NOTE", "REPLACEMENT"]),
  status: z.enum(["SETTLED", "PENDING", "RECEIVED"]),
  occurredAt: z.string(),
  receivedAt: z.string().nullable(),
  note: z.string(),
  taxableTotal: Money,
  cgstTotal: Money,
  sgstTotal: Money,
  igstTotal: Money,
  total: Money,
  items: z.array(z.object({ id: z.string(), purchaseItemId: z.string().nullable(), name: z.string(), qtyMilli: z.number().int(), ...Tax })),
});
export const PurchaseDto = z.object({
  id: z.string(),
  branchId: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  billNumber: z.string(),
  billDate: z.string(),
  dueDate: z.string().nullable(),
  interState: z.boolean(),
  taxableTotal: Money,
  cgstTotal: Money,
  sgstTotal: Money,
  igstTotal: Money,
  total: Money,
  paidAmount: Money,
  paidMethodName: z.string(),
  returnedTotal: Money,
  notes: z.string(),
  stockApplied: z.boolean(),
  imported: z.boolean(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string(),
  createdAt: z.string(),
  items: z.array(PurchaseItemDto),
  returns: z.array(PurchaseReturnDto),
});
export const PurchaseSummaryDto = PurchaseDto.omit({ items: true, returns: true }).extend({ itemCount: z.number().int() });
