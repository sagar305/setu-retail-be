// Phase 2a request schemas (catalogue, customers, counters, orders).
import "./zodOpenApi.js";
import { z } from "zod";
import { ToolsPatch } from "./schemas4.js";

const Name = z.string().trim().min(1, "Required.").max(120);
const Paise = z.number().int().min(0).max(1_000_000_000);
const Milli = z.number().int();
const Text = (max: number) => z.string().trim().max(max);

export const SettingsPatchBody = z.object({
  taxEnabled: z.boolean().optional(),
  allowNegativeStock: z.boolean().optional(),
  cashierMaxDiscountBp: z.number().int().min(0).max(10_000).optional(),
  receiptFooter: Text(300).optional(),
  receiptPaperSize: z.enum(["80mm", "58mm", "a4"]).optional(),
  batchTracking: z.boolean().optional(),
  /** Connected tools to switch on (true) or off (false); others stay as they are. */
  tools: ToolsPatch.optional(),
  /** Udhaar is due this many days after the bill (Invoice Aging). */
  creditDays: z.number().int().min(0).max(365).optional(),
  /** Shop logo for receipts: a PNG/JPEG/WebP data URL up to ~150 KB, or null to remove. */
  /** The shop's UPI ID, e.g. sharmastores@okaxis; "" to remove. */
  upiId: z.union([z.literal(""), z.string().trim().regex(/^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/i, "Enter a UPI ID like shopname@okaxis.")]).optional(),
  printUpiQrOnReceipt: z.boolean().optional(),
  logoDataUrl: z.string().max(200_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Use a PNG, JPEG or WebP image.").nullable().optional(),
});

export const PaymentMethodBody = z.object({
  name: Name,
  kind: z.enum(["CASH", "UPI", "CARD", "CREDIT", "OTHER"]),
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(1000).optional(),
});

export const CounterBody = z.object({ branchId: z.uuid(), name: Text(60).optional() });
export const CounterPatchBody = z.object({ name: Name });

export const CategoryBody = z.object({ name: Name });

export const ProductBody = z.object({
  /** Set by the device when the product was made offline (Phase 9b). */
  id: z.uuid().optional(),
  name: Name,
  categoryId: z.uuid().nullable().optional(),
  sku: Text(60).optional(),
  barcode: Text(60).optional(),
  hsn: z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})?$/, "HSN is 4, 6 or 8 digits.").optional(),
  gstRateBp: z.number().int().min(0).max(10_000).optional(),
  taxInclusive: z.boolean().optional(),
  unit: Text(20).optional(),
  price: Paise,
  costPrice: Paise.nullable().optional(),
  trackStock: z.boolean().optional(),
  lowStockMilli: Milli.min(0).nullable().optional(),
  /** Opening stock in branches the user manages. */
  openingStock: z.array(z.object({ branchId: z.uuid(), qtyMilli: Milli.min(0) })).optional(),
});
export const ProductPatchBody = ProductBody.omit({ openingStock: true, id: true }).partial();
export const BranchPriceBody = z.object({ price: Paise.nullable() });
export const StockAdjustBody = z.object({
  branchId: z.uuid(),
  type: z.enum(["ADD", "REDUCE", "SET"]),
  qtyMilli: Milli.min(0),
  note: Text(200).optional(),
});

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd.");
export const BatchBody = z.object({
  branchId: z.uuid(),
  batchNo: Text(60).optional(),
  expiry: Day.nullable().optional(),
  costPrice: Paise.nullable().optional(),
  qtyMilli: Milli.min(1),
  note: Text(200).optional(),
});
export const BatchPatchBody = z.object({ batchNo: Text(60).optional(), expiry: Day.nullable().optional(), costPrice: Paise.nullable().optional() });

export const CustomerBody = z.object({
  /** Set by the device when the customer was added offline (Phase 9b). */
  id: z.uuid().optional(),
  name: Name,
  phone: Text(20).optional(),
  email: z.union([z.email(), z.literal("")]).optional(),
  address: Text(300).optional(),
  gstin: Text(15).optional(),
  stateCode: z.union([z.string().regex(/^\d{2}$/, "Two-digit state code."), z.literal("")]).optional(),
  notes: Text(500).optional(),
  /** Udhaar due after this many days; null = the shop's setting. */
  creditDays: z.number().int().min(0).max(365).nullable().optional(),
});
export const CustomerPatchBody = CustomerBody.omit({ id: true }).partial();

export const DiscountBody = z.object({ type: z.enum(["flat", "percent"]), value: z.number().int().min(0) });

export const OrderBody = z.object({
  /** Client-generated, so a retried request can't create the bill twice. */
  id: z.uuid(),
  branchId: z.uuid(),
  counterId: z.uuid(),
  customerId: z.uuid().nullable().optional(),
  lines: z.array(z.object({ productId: z.uuid(), qtyMilli: Milli.min(1).max(100_000_000), batchId: z.uuid().nullable().optional() })).min(1, "Add at least one item.").max(500),
  discount: DiscountBody.optional(),
  payments: z.array(z.object({ methodId: z.uuid(), amount: Paise })).min(1).max(5),
  note: Text(300).optional(),
  /** The counter's own number for this bill (B1-C2-00045). */
  invoiceNumber: z.string().regex(/^B\d+-C\d+-\d{5,9}$/).optional(),
});

export const CancelBody = z.object({ reason: Text(300).min(1, "Give a reason.") });
export const ReturnBody = z.object({
  counterId: z.uuid(),
  items: z.array(z.object({ orderItemId: z.uuid(), qtyMilli: Milli.min(1) })).min(1),
  refundMethodId: z.uuid(),
  reason: Text(300).min(1, "Give a reason."),
});

export const HeldCartBody = z.object({
  branchId: z.uuid(),
  label: Text(60).min(1),
  payload: z.object({
    lines: z.array(z.object({ productId: z.uuid(), qtyMilli: Milli.min(1) })).max(500),
    customerId: z.uuid().nullable().optional(),
    discount: DiscountBody.optional(),
  }),
});

// ── Responses ──
const Iso = z.iso.datetime();
const Kind = z.enum(["CASH", "UPI", "CARD", "CREDIT", "OTHER"]);
export const SettingsDto = z.object({
  business: z.object({ name: z.string(), phone: z.string(), taxNumber: z.string().nullable(), currency: z.string(), timezone: z.string() }),
  taxEnabled: z.boolean(),
  allowNegativeStock: z.boolean(),
  cashierMaxDiscountBp: z.number().int(),
  receiptFooter: z.string(),
  receiptPaperSize: z.enum(["80mm", "58mm", "a4"]),
  batchTracking: z.boolean(),
  /** Connected tools: on (true) or switched off by the owner. */
  tools: z.record(z.string(), z.boolean()),
  creditDays: z.number().int(),
  logoDataUrl: z.string().nullable(),
  upiId: z.string(),
  printUpiQrOnReceipt: z.boolean(),
});
export const PaymentMethodDto = z.object({ id: z.uuid(), name: z.string(), kind: Kind, active: z.boolean(), sort: z.number().int() });
export const CounterDto = z.object({ id: z.uuid(), branchId: z.uuid(), code: z.string(), name: z.string(), lastSeenAt: Iso.nullable() });
export const CategoryDto = z.object({ id: z.uuid(), name: z.string() });
export const ProductDto = z.object({
  id: z.uuid(),
  name: z.string(),
  categoryId: z.uuid().nullable(),
  sku: z.string(),
  barcode: z.string(),
  hsn: z.string(),
  gstRateBp: z.number().int(),
  taxInclusive: z.boolean(),
  unit: z.string(),
  defaultPrice: z.number().int(),
  branchPrice: z.number().int().nullable(),
  price: z.number().int(),
  costPrice: z.number().int().nullable().optional(),
  trackStock: z.boolean(),
  stockMilli: z.number().int(),
  lowStockMilli: z.number().int().nullable(),
  stockStatus: z.enum(["untracked", "out", "low", "ok"]),
  archived: z.boolean(),
  /** Earliest expiry among this branch's batches in stock (batch tracking on). */
  nextExpiry: z.string().nullable().optional(),
});
export const BatchDto = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  batchNo: z.string(),
  expiry: z.string().nullable(),
  costPrice: z.number().int().nullable(),
  qtyMilli: z.number().int(),
  opening: z.boolean(),
  receivedAt: Iso,
  status: z.enum(["expired", "soon", "ok", "none"]),
});
export const CustomerDto = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  email: z.string(),
  address: z.string(),
  gstin: z.string().nullable(),
  stateCode: z.string().nullable(),
  notes: z.string(),
  creditDays: z.number().int().nullable(),
  createdAt: Iso,
});
const Amounts = { taxable: z.number().int(), cgst: z.number().int(), sgst: z.number().int(), igst: z.number().int(), total: z.number().int() };
export const OrderDto = z.object({
  id: z.uuid(),
  invoiceNumber: z.string(),
  status: z.enum(["COMPLETED", "CANCELLED"]),
  createdAt: Iso,
  branch: z.object({ id: z.uuid(), code: z.string(), name: z.string(), address: z.string(), phone: z.string(), gstin: z.string().nullable(), stateCode: z.string().nullable() }),
  counter: z.object({ code: z.string(), name: z.string() }),
  cashierId: z.uuid(),
  cashierName: z.string().nullable(),
  customer: z.object({ id: z.uuid(), name: z.string(), phone: z.string(), gstin: z.string().nullable() }).nullable(),
  placeOfSupply: z.string().nullable(),
  interState: z.boolean(),
  taxEnabled: z.boolean(),
  discount: DiscountBody,
  subtotal: z.number().int(),
  discountTotal: z.number().int(),
  taxableTotal: z.number().int(),
  cgstTotal: z.number().int(),
  sgstTotal: z.number().int(),
  igstTotal: z.number().int(),
  total: z.number().int(),
  returnedTotal: z.number().int(),
  note: z.string(),
  cancelledAt: Iso.nullable(),
  cancelReason: z.string(),
  offline: z.boolean(),
  priceDiffers: z.boolean(),
  items: z.array(
    z.object({
      id: z.uuid(),
      productId: z.uuid().nullable(),
      name: z.string(),
      hsn: z.string(),
      unit: z.string(),
      qtyMilli: z.number().int(),
      unitPrice: z.number().int(),
      gstRateBp: z.number().int(),
      taxInclusive: z.boolean(),
      gross: z.number().int(),
      discount: z.number().int(),
      ...Amounts,
      returnedQtyMilli: z.number().int(),
      batches: z.array(z.object({ batchNo: z.string(), expiry: z.string().nullable(), qtyMilli: z.number().int() })),
    }),
  ),
  payments: z.array(z.object({ methodId: z.uuid().nullable(), methodName: z.string(), kind: Kind, amount: z.number().int() })),
  creditNotes: z.array(
    z.object({
      id: z.uuid(),
      number: z.string(),
      reason: z.string(),
      refundMethodName: z.string(),
      taxableTotal: z.number().int(),
      cgstTotal: z.number().int(),
      sgstTotal: z.number().int(),
      igstTotal: z.number().int(),
      total: z.number().int(),
      createdAt: Iso,
      items: z.array(z.object({ orderItemId: z.uuid(), qtyMilli: z.number().int(), total: z.number().int() })),
    }),
  ),
});
export const OrderSummaryDto = z.object({
  id: z.uuid(),
  invoiceNumber: z.string(),
  status: z.enum(["COMPLETED", "CANCELLED"]),
  createdAt: Iso,
  branchId: z.uuid(),
  customerName: z.string(),
  total: z.number().int(),
  returnedTotal: z.number().int(),
  cashierId: z.uuid(),
  offline: z.boolean(),
  priceDiffers: z.boolean(),
  paymentMethods: z.array(z.string()),
});
export const HeldCartDto = z.object({ id: z.uuid(), label: z.string(), payload: HeldCartBody.shape.payload, userId: z.uuid(), createdAt: Iso });
