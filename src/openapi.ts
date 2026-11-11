import "./zodOpenApi.js";
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z, type ZodType } from "zod";
import * as S from "./schemas.js";
import * as P from "./schemas2.js";
import { PinBody, SyncCustomer, SyncCustomersBody, SyncMoneyBody, SyncMoneyOp, SyncOrder, SyncOrdersBody } from "./routes/sync.js";
import * as F from "./schemas4.js";
import { ReceiveBody, TransferBody, TransferDto } from "./routes/transfers.js";
import { AuditEntryDto, BranchComparisonDto, StockAcrossDto, TransferReportDto } from "./routes/branchReports.js";
import { BarcodeGenerateBody, BranchReceiptBody, ReceiptTemplateBody, ReceiptTemplateDto } from "./routes/receipts.js";
import * as A from "./schemasAdmin.js";
import { ConflictDto, ResolveBody } from "./routes/conflicts.js";
import { CustomerImportBody, CustomerRow, FreePosImportBody, ProductImportBody, ProductRow } from "./routes/imports.js";


// Every route registers its request/response schemas here, so the frontend can
// generate a typed client from /openapi.json instead of copying types by hand.
export const registry = new OpenAPIRegistry();

const bearer = registry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer", bearerFormat: "JWT" });

export const HealthResponse = registry.register(
  "HealthResponse",
  z.object({
    status: z.literal("ok"),
    service: z.literal("setu-retail-be"),
    version: z.string(),
    time: z.iso.datetime(),
  }),
);

export const ErrorResponse = registry.register(
  "ErrorResponse",
  z.object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
  }),
);

const Me = registry.register("Me", S.MeDto);
const Session = registry.register("Session", S.SessionDto);
const Branch = registry.register("Branch", S.BranchDto);
const Staff = registry.register("Staff", S.StaffDto);
const Plan = registry.register("Plan", S.PlanDto);

const json = (schema: ZodType) => ({ content: { "application/json": { schema } } });
const errors = { 400: { description: "Invalid request", ...json(ErrorResponse) }, 401: { description: "Not signed in", ...json(ErrorResponse) } };

type Method = "get" | "post" | "patch" | "put" | "delete";
function route(method: Method, path: string, summary: string, opts: { body?: ZodType; ok: ZodType | null; status?: number; secure?: boolean; tag: string }) {
  registry.registerPath({
    method,
    path,
    summary,
    tags: [opts.tag],
    security: opts.secure === false ? [] : [{ [bearer.name]: [] }],
    request: opts.body ? { body: { content: { "application/json": { schema: opts.body } } } } : undefined,
    responses: {
      [opts.status ?? 200]: opts.ok ? { description: "OK", ...json(opts.ok) } : { description: "No content" },
      ...errors,
    },
  });
}

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Liveness check",
  tags: ["health"],
  responses: { 200: { description: "API is up", ...json(HealthResponse) } },
});
registry.registerPath({
  method: "get",
  path: "/health/db",
  summary: "Database connectivity check",
  tags: ["health"],
  responses: {
    200: { description: "Database reachable", ...json(z.object({ status: z.literal("ok") })) },
    503: { description: "Database unreachable", ...json(ErrorResponse) },
  },
});

const open = { secure: false, tag: "auth" } as const;
route("post", "/auth/signup", "Create a business account (owner + first branch); emails a verification link", { ...open, body: S.SignupBody, ok: z.object({ status: z.literal("verification_sent"), email: z.string() }), status: 201 });
route("post", "/auth/verify-email", "Verify email; starts the 3-month Basic trial for a new owner", { ...open, body: S.VerifyEmailBody, ok: z.object({ verified: z.literal(true) }) });
route("post", "/auth/resend-verification", "Send the verification link again", { ...open, body: S.EmailOnlyBody, ok: z.object({ status: z.string() }), status: 202 });
route("post", "/auth/login", "Sign in with email or username; sets the 12-hour refresh cookie", { ...open, body: S.LoginBody, ok: Session });
route("post", "/auth/refresh", "New access token from the refresh cookie (rotates it)", { ...open, ok: Session });
route("get", "/auth/session-check", "Read-only: what the API sees of this browser's sign-in cookie (names only, never values); for diagnosing sign-outs", {
  ...open,
  ok: z.object({ cookiesReceived: z.array(z.string()), sessionCookie: z.boolean(), serverTime: z.string(), session: z.enum(["ok", "revoked", "expired", "token_already_used", "unknown_token", "no_session_cookie", "no_cookies_at_all"]), expiresAt: z.string().optional(), lastUsedAt: z.string().nullable().optional() }),
});
route("post", "/auth/logout", "Sign this device out", { ...open, ok: null, status: 204 });
route("post", "/auth/forgot-password", "Email a password-reset link", { ...open, body: S.EmailOnlyBody, ok: z.object({ status: z.string() }), status: 202 });
route("post", "/auth/reset-password", "Set a new password from the emailed link; signs out every device", { ...open, body: S.ResetPasswordBody, ok: z.object({ reset: z.literal(true) }) });
route("get", "/auth/invite/{token}", "Details for an invite link", { ...open, ok: z.object({ name: z.string(), email: z.string(), username: z.string(), role: S.RoleEnum, businessName: z.string() }) });
route("post", "/auth/accept-invite", "Staff sets their password from the invite link", { ...open, body: S.AcceptInviteBody, ok: z.object({ accepted: z.literal(true), username: z.string() }) });
route("get", "/me", "The signed-in user, account, branches and plan", { tag: "auth", ok: Me });

route("get", "/account/plan", "Plan, limits and usage (owner)", { tag: "account", ok: z.object({ plan: Plan, usage: z.record(z.string(), z.number()), keepActiveReviewPending: z.boolean() }) });
route("post", "/account/license/check", "Check a license key and preview its effect (owner)", { tag: "account", body: S.LicenseKeyBody, ok: z.object({ plan: z.object({ code: z.string(), name: z.string() }), days: z.number(), needsChoice: z.boolean(), options: z.array(z.object({ choice: z.enum(["now", "later"]).nullable(), convertedDays: z.number(), startsAt: z.string(), endsAt: z.string() })) }) });
route("post", "/account/license/redeem", "Redeem a license key (owner)", { tag: "account", body: S.RedeemBody, ok: z.object({ plan: Plan, keepActiveReviewPending: z.boolean() }) });
route("get", "/account/keep-active", "Branches and staff to choose from after a downgrade (owner)", { tag: "account", ok: z.object({ limits: z.object({ maxBranches: z.number().nullable(), maxStaff: z.number().nullable() }), branches: z.array(Branch), staff: z.array(z.object({ id: z.string(), name: z.string(), role: S.RoleEnum, withinPlan: z.boolean(), createdAt: z.string() })) }) });
route("post", "/account/keep-active", "Choose which branches and staff stay active (owner)", { tag: "account", body: S.KeepActiveBody, ok: z.object({ saved: z.literal(true) }) });

route("get", "/branches", "Branches the user can work in", { tag: "branches", ok: z.object({ branches: z.array(Branch) }) });
route("post", "/branches", "Add a branch (owner; plan limit applies)", { tag: "branches", body: S.BranchBody, ok: z.object({ branch: Branch }), status: 201 });
route("patch", "/branches/{id}", "Edit a branch (owner)", { tag: "branches", body: S.BranchPatchBody, ok: z.object({ branch: Branch }) });

route("get", "/staff", "Staff the user can manage", { tag: "staff", ok: z.object({ staff: z.array(Staff) }) });
route("post", "/staff", "Invite a manager or cashier (emails a set-password link; plan limit applies)", { tag: "staff", body: S.InviteStaffBody, ok: z.object({ staff: Staff }), status: 201 });
route("post", "/staff/{id}/resend-invite", "Send the invite email again", { tag: "staff", ok: z.object({ sent: z.literal(true) }) });
route("patch", "/staff/{id}", "Change name, role, branches, or remove/restore access", { tag: "staff", body: S.StaffPatchBody, ok: z.object({ staff: Staff }) });

// ── Phase 2a: POS ──
const Settings = registry.register("Settings", P.SettingsDto);
const PaymentMethod = registry.register("PaymentMethod", P.PaymentMethodDto);
const Counter = registry.register("Counter", P.CounterDto);
const Category = registry.register("Category", P.CategoryDto);
const Product = registry.register("Product", P.ProductDto);
const Customer = registry.register("Customer", P.CustomerDto);
const Order = registry.register("Order", P.OrderDto);
const OrderSummary = registry.register("OrderSummary", P.OrderSummaryDto);
const HeldCart = registry.register("HeldCart", P.HeldCartDto);
registry.register("OrderBody", P.OrderBody);
registry.register("ProductBody", P.ProductBody);

route("get", "/settings", "POS settings and business details for receipts", { tag: "settings", ok: Settings });
route("patch", "/settings", "Change POS settings (owner)", { tag: "settings", body: P.SettingsPatchBody, ok: Settings });
const TaxGroup = registry.register("TaxGroup", P.TaxGroupDto);
route("get", "/tax-groups", "Tax groups (custom tax mode); products counts the ones that use each", { tag: "settings", ok: z.object({ groups: z.array(TaxGroup) }) });
route("post", "/tax-groups", "Add a tax group (owner); the first one is the default", { tag: "settings", body: P.TaxGroupBody, ok: z.object({ group: TaxGroup }), status: 201 });
route("patch", "/tax-groups/{id}", "Edit a tax group or make it the default (owner); bills keep their taxes", { tag: "settings", body: P.TaxGroupBody.partial(), ok: z.object({ group: TaxGroup }) });
route("delete", "/tax-groups/{id}", "Remove a tax group (owner); its products use the default group", { tag: "settings", ok: null, status: 204 });
route("get", "/payment-methods", "Payment methods", { tag: "settings", ok: z.object({ methods: z.array(PaymentMethod) }) });
route("post", "/payment-methods", "Add a payment method (owner)", { tag: "settings", body: P.PaymentMethodBody, ok: z.object({ method: PaymentMethod }), status: 201 });
route("patch", "/payment-methods/{id}", "Edit a payment method (owner)", { tag: "settings", body: P.PaymentMethodBody.partial(), ok: z.object({ method: PaymentMethod }) });
route("get", "/counters", "Counters of a branch (?branchId=)", { tag: "counters", ok: z.object({ counters: z.array(Counter) }) });
route("post", "/counters", "Register this device as a counter (gets its own bill series)", { tag: "counters", body: P.CounterBody, ok: z.object({ counter: Counter }), status: 201 });
route("patch", "/counters/{id}", "Rename a counter", { tag: "counters", body: P.CounterPatchBody, ok: z.object({ counter: Counter }) });

route("get", "/categories", "Product categories", { tag: "catalogue", ok: z.object({ categories: z.array(Category) }) });
route("post", "/categories", "Add a category", { tag: "catalogue", body: P.CategoryBody, ok: z.object({ category: Category }), status: 201 });
route("patch", "/categories/{id}", "Rename a category", { tag: "catalogue", body: P.CategoryBody, ok: z.object({ category: Category }) });
route("delete", "/categories/{id}", "Remove a category", { tag: "catalogue", ok: null, status: 204 });
route("get", "/products", "Products with this branch's price and stock (?branchId=&q=&categoryId=&limit=&offset=)", { tag: "catalogue", ok: z.object({ products: z.array(Product), total: z.number().int() }) });
route("get", "/products/{id}", "A product with price and stock per branch", { tag: "catalogue", ok: z.object({ product: Product, branches: z.array(z.object({ branchId: z.string(), code: z.string(), name: z.string(), price: z.number().nullable(), stockMilli: z.number(), withinPlan: z.boolean() })) }) });
route("post", "/products", "Add a product (owner/manager; plan limit applies)", { tag: "catalogue", body: P.ProductBody, ok: z.object({ product: Product }), status: 201 });
route("patch", "/products/{id}", "Edit a product", { tag: "catalogue", body: P.ProductPatchBody, ok: z.object({ product: Product }) });
route("delete", "/products/{id}", "Stop selling a product (kept for old bills)", { tag: "catalogue", ok: null, status: 204 });
route("put", "/products/{id}/branches/{branchId}", "Set or clear a branch's own price", { tag: "catalogue", body: P.BranchPriceBody, ok: z.object({ product: Product }) });
route("post", "/products/{id}/stock", "Add, reduce or set a branch's stock", { tag: "catalogue", body: P.StockAdjustBody, ok: z.object({ stockMilli: z.number().int() }) });
route("get", "/products/{id}/stock-history", "Stock movements in a branch (?branchId=)", { tag: "catalogue", ok: z.object({ history: z.array(z.object({ id: z.string(), type: z.string(), changeMilli: z.number(), stockAfterMilli: z.number(), note: z.string(), refId: z.string().nullable(), createdAt: z.string() })) }) });

route("get", "/customers", "Customers (?q= name, phone or GSTIN)", { tag: "customers", ok: z.object({ customers: z.array(Customer), total: z.number().int() }) });
route("get", "/customers/{id}", "A customer", { tag: "customers", ok: z.object({ customer: Customer }) });
route("post", "/customers", "Add a customer (any role; plan limit applies)", { tag: "customers", body: P.CustomerBody, ok: z.object({ customer: Customer }), status: 201 });
route("patch", "/customers/{id}", "Edit a customer (owner/manager)", { tag: "customers", body: P.CustomerPatchBody, ok: z.object({ customer: Customer }) });

route("post", "/orders", "Create a bill (idempotent on id)", { tag: "orders", body: P.OrderBody, ok: z.object({ order: Order, replayed: z.boolean().optional() }), status: 201 });
route("get", "/orders", "Bills (?branchId=&from=&to=&status=&q=&before=&limit=); cashiers: own bills today", { tag: "orders", ok: z.object({ orders: z.array(OrderSummary) }) });
route("get", "/orders/{id}", "A bill with items, payments and credit notes", { tag: "orders", ok: z.object({ order: Order }) });
route("post", "/orders/{id}/cancel", "Cancel a bill and put stock back (owner/manager)", { tag: "orders", body: P.CancelBody, ok: z.object({ order: Order }) });
route("post", "/orders/{id}/returns", "Return items: issues a GST credit note (owner/manager)", { tag: "orders", body: P.ReturnBody, ok: z.object({ order: Order }), status: 201 });
route("get", "/held-carts", "Held bills in a branch (?branchId=)", { tag: "orders", ok: z.object({ carts: z.array(HeldCart) }) });
route("post", "/held-carts", "Hold a bill", { tag: "orders", body: P.HeldCartBody, ok: z.object({ cart: HeldCart }), status: 201 });
route("delete", "/held-carts/{id}", "Remove a held bill", { tag: "orders", ok: null, status: 204 });

// ── Phase 2b: batches, reports, imports ──
const Batch = registry.register("Batch", P.BatchDto);
registry.register("ProductImportRow", ProductRow);
registry.register("CustomerImportRow", CustomerRow);
const ImportResult = registry.register("ImportResult", z.object({ created: z.number().int(), updated: z.number().int(), errors: z.array(z.object({ row: z.number().int(), message: z.string() })) }));
const Money = z.number().int();
const Range = "(?from=&to= ISO instants, ?branchId=)";

route("get", "/products/{id}/batches", "Batches in stock for a product in a branch, earliest expiry first", { tag: "batches", ok: z.object({ batches: z.array(Batch) }) });
route("post", "/products/{id}/batches", "Receive stock as a batch (batch no., expiry, cost)", { tag: "batches", body: P.BatchBody, ok: z.object({ batch: Batch }), status: 201 });
route("patch", "/batches/{id}", "Correct a batch's number, expiry or cost", { tag: "batches", body: P.BatchPatchBody, ok: z.object({ batch: Batch }) });
route("get", "/batches/expiring", "Batches expiring within ?days= (default 90)", { tag: "batches", ok: z.object({ batches: z.array(Batch.extend({ branchId: z.string(), productName: z.string(), unit: z.string() })) }) });

const SalesReport = registry.register("SalesReport", z.object({
  from: z.string(), to: z.string(), bills: z.number().int(), gross: Money, discounts: Money, sales: Money, returns: Money, returnCount: z.number().int(), net: Money, averageBill: Money,
  cancelled: z.object({ count: z.number().int(), total: Money }),
  byPayment: z.array(z.object({ method: z.string(), kind: z.string(), amount: Money })),
  refundsByMethod: z.array(z.object({ method: z.string(), amount: Money })),
  topProducts: z.array(z.object({ productId: z.string().nullable(), name: z.string(), unit: z.string(), qtyMilli: z.number().int(), amount: Money })),
  byBranch: z.array(z.object({ branchId: z.string(), bills: z.number().int(), sales: Money })),
  byDay: z.array(z.object({ day: z.string(), bills: z.number().int(), sales: Money })),
}));
const Tax = { taxable: Money, cgst: Money, sgst: Money, igst: Money, total: Money };
const GstReport = registry.register("GstReport", z.object({
  from: z.string(), to: z.string(),
  byRate: z.array(z.record(z.string(), z.number())),
  byHsn: z.array(z.object({ hsn: z.string(), rateBp: z.number().int(), unit: z.string(), qtyMilli: z.number().int(), ...Tax })),
  b2b: z.array(z.object({ invoiceNumber: z.string(), date: z.string(), customerName: z.string(), customerGstin: z.string().nullable(), placeOfSupply: z.string().nullable(), interState: z.boolean(), ...Tax })),
  b2c: z.array(z.object({ interState: z.boolean(), placeOfSupply: z.string().nullable(), bills: z.number().int(), ...Tax })),
  creditNotes: z.array(z.object({ number: z.string(), date: z.string(), invoiceNumber: z.string(), customerName: z.string(), customerGstin: z.string().nullable(), ...Tax })),
}));
const StockReport = registry.register("StockReport", z.object({
  branchId: z.string(), value: Money, missingCost: z.number().int(),
  counts: z.object({ tracked: z.number().int(), low: z.number().int(), out: z.number().int(), negative: z.number().int() }),
  items: z.array(z.object({ productId: z.string(), name: z.string(), unit: z.string(), stockMilli: z.number().int(), costPrice: Money.nullable(), value: Money, status: z.enum(["ok", "low", "out", "negative"]) })),
  batchTracking: z.boolean(),
  expiring: z.array(z.object({ batchId: z.string(), productName: z.string(), unit: z.string(), batchNo: z.string(), expiry: z.string().nullable(), qtyMilli: z.number().int(), value: Money.nullable(), bucket: z.enum(["expired", "30", "60", "90"]) })),
}));
const StaffReport = registry.register("StaffReport", z.object({
  from: z.string(), to: z.string(),
  byCashier: z.array(z.object({ userId: z.string(), name: z.string(), role: S.RoleEnum.nullable(), bills: z.number().int(), sales: Money, discounts: Money, returns: Money })),
  byCounter: z.array(z.object({ counterId: z.string(), code: z.string(), name: z.string(), bills: z.number().int(), sales: Money })),
  margin: z.array(z.object({ productId: z.string().nullable(), name: z.string(), unit: z.string(), qtyMilli: z.number().int(), revenue: Money, cost: Money.nullable(), margin: Money.nullable(), marginBp: z.number().int().nullable() })),
}));
const StockLog = registry.register("StockLog", z.object({ log: z.array(z.object({ id: z.string(), createdAt: z.string(), productName: z.string(), unit: z.string(), type: z.string(), changeMilli: z.number().int(), stockAfterMilli: z.number().int(), note: z.string(), userName: z.string() })) }));
const Dashboard = registry.register("Dashboard", z.object({
  today: z.object({ sales: Money, net: Money, bills: z.number().int(), averageBill: Money, returns: Money, creditGiven: Money, byPayment: SalesReport.shape.byPayment, byBranch: SalesReport.shape.byBranch, topProducts: SalesReport.shape.topProducts }),
  yesterday: z.object({ sales: Money, bills: z.number().int() }),
  week: z.array(z.object({ day: z.string(), sales: Money, bills: z.number().int() })),
  lowStock: z.array(z.object({ productId: z.string(), name: z.string(), unit: z.string(), branchId: z.string(), stockMilli: z.number().int(), status: z.enum(["low", "out", "negative"]) })),
  expiringSoon: z.number().int(),
}));

route("get", "/reports/dashboard", "Today, yesterday, last 7 days, low stock, expiring soon (?branchId=)", { tag: "reports", ok: Dashboard });
route("get", "/reports/sales", `Sales summary ${Range}`, { tag: "reports", ok: SalesReport });
const TaxReport = registry.register("TaxReport", z.object({
  from: z.string(),
  to: z.string(),
  bills: z.number().int(),
  taxableSales: z.number().int(),
  totalSales: z.number().int(),
  byTax: z.array(z.object({ name: z.string(), rateBp: z.number().int(), sales: z.number().int(), returns: z.number().int(), collected: z.number().int(), purchases: z.number().int(), purchaseReturns: z.number().int(), paid: z.number().int(), net: z.number().int() })),
  invoices: z.array(z.object({ invoiceNumber: z.string(), date: z.string(), customerName: z.string(), customerTaxNumber: z.string().nullable(), taxable: z.number().int(), tax: z.number().int(), total: z.number().int() })),
}));
route("get", "/reports/taxes", `Custom taxes: collected on sales and paid on supplier bills, by tax and rate, net of returns ${Range}`, { tag: "reports", ok: TaxReport });
route("get", "/reports/gst", `GST by rate (returns netted), by HSN, B2B/B2C, credit notes ${Range}`, { tag: "reports", ok: GstReport });
route("get", "/reports/stock", "Stock value, low/out/below zero, expiring batches (?branchId=)", { tag: "reports", ok: StockReport });
route("get", "/reports/staff", `Sales by cashier and counter; margin by product ${Range}`, { tag: "reports", ok: StaffReport });
route("get", "/reports/stock-log", `Stock movements in a branch ${Range}, &productId=`, { tag: "reports", ok: StockLog });

route("post", "/imports/products", "Import products (CSV rows); matches SKU, barcode, then name", { tag: "imports", body: ProductImportBody, ok: ImportResult });
route("post", "/imports/customers", "Import customers (CSV rows); matches mobile, then name", { tag: "imports", body: CustomerImportBody, ok: ImportResult });
route("post", "/imports/free-pos", "Import a free Browser POS backup (POS_BACKUP.json) into a branch (owner)", { tag: "imports", body: FreePosImportBody, ok: z.object({ books: z.object({ suppliers: z.number().int(), expenses: z.number().int(), cashEntries: z.number().int(), customerLedger: z.number().int(), supplierLedger: z.number().int(), purchases: z.number().int(), purchaseReturns: z.number().int() }), products: ImportResult, customers: ImportResult, categories: z.number().int(), paymentMethodsAdded: z.number().int(), batches: z.number().int(), skipped: z.object({ orders: z.number().int() }) }) });

// ── Phase 3: offline ──
const device = registry.registerComponent("securitySchemes", "deviceKey", { type: "apiKey", in: "header", name: "X-Device-Key" });
registry.register("SyncOrder", SyncOrder);
registry.register("SyncCustomer", SyncCustomer);
const SyncResults = registry.register("SyncResults", z.object({ results: z.array(z.object({ id: z.string(), status: z.enum(["saved", "duplicate", "rejected", "retry"]), invoiceNumber: z.string().optional(), message: z.string().optional() })) }));
const OfflinePack = registry.register("OfflinePack", z.object({
  at: z.string(),
  settings: Settings,
  account: z.object({ id: z.string(), name: z.string(), timezone: z.string(), currency: z.string() }),
  branch: z.object({ id: z.string(), code: z.string(), name: z.string(), address: z.string(), phone: z.string(), gstin: z.string().nullable(), stateCode: z.string().nullable(), receiptTemplateId: z.string().nullable() }),
  counter: z.object({ id: z.string(), code: z.string(), name: z.string(), nextInvoiceNumber: z.number().int() }),
  plan: z.object({ expired: z.boolean() }),
  methods: z.array(PaymentMethod),
  categories: z.array(Category),
  products: z.array(Product),
  batches: z.array(Batch),
  customers: z.array(Customer),
  users: z.array(z.object({ id: z.string(), name: z.string(), username: z.string(), role: S.RoleEnum, pin: z.object({ hash: z.string(), salt: z.string(), iterations: z.number().int() }) })),
  customerBalances: z.array(z.object({ customerId: z.string(), balance: z.number().int() })),
  suppliers: z.array(z.object({ id: z.string(), name: z.string(), phone: z.string(), balance: z.number().int() })),
  expenseCategories: z.array(z.string()),
  receiptTemplates: z.array(ReceiptTemplateDto),
  taxGroups: z.array(TaxGroup),
}));
registry.register("SyncMoneyOp", SyncMoneyOp);
route("get", "/me/pin", "Has the signed-in user set a counter PIN?", { tag: "offline", ok: z.object({ pinSet: z.boolean() }) });
route("put", "/me/pin", "Set the counter PIN for offline sign-in (needs the password)", { tag: "offline", body: PinBody, ok: z.object({ pinSet: z.literal(true) }) });
route("delete", "/me/pin", "Remove the counter PIN", { tag: "offline", ok: null, status: 204 });
route("post", "/counters/{id}/device-key", "Give this device a new counter key (replaces the old one)", { tag: "offline", ok: z.object({ deviceKey: z.string() }) });
for (const [method, path, summary, body, ok] of [
  ["get", "/sync/pack", "Everything a counter needs to bill offline (X-Device-Key)", undefined, OfflinePack],
  ["post", "/sync/customers", "Push customers added offline (X-Device-Key)", SyncCustomersBody, SyncResults],
  ["post", "/sync/orders", "Push bills made offline; saved as charged; 402 while the plan has ended (X-Device-Key)", SyncOrdersBody, SyncResults],
  ["post", "/sync/money", "Push expenses, payments received and payments made offline (ops: SyncMoneyOp[]); 402 while the plan has ended (X-Device-Key)", SyncMoneyBody, SyncResults],
] as const) {
  registry.registerPath({
    method,
    path,
    summary,
    tags: ["offline"],
    security: [{ [device.name]: [] }],
    request: body ? { body: { content: { "application/json": { schema: body } } } } : undefined,
    responses: { 200: { description: "OK", ...json(ok) }, ...errors, 402: { description: "Plan ended", ...json(ErrorResponse) } },
  });
}

// ── Phase 4a: connected money tools ──
{
  const Supplier = registry.register("Supplier", F.SupplierDto);
  const Expense = registry.register("Expense", F.ExpenseDto);
  const Statement = registry.register("Statement", F.StatementDto);
  const CashBook = registry.register("CashBook", F.CashBookDto);
  const Purchase = registry.register("Purchase", F.PurchaseDto);
  const PurchaseSummary = registry.register("PurchaseSummary", F.PurchaseSummaryDto);
  registry.register("PurchaseBody", F.PurchaseBody);
  const M = z.number().int();
  const t = "tools";
  route("get", "/suppliers", "Suppliers with what you owe each (?q=)", { tag: t, ok: z.object({ suppliers: z.array(Supplier) }) });
  route("post", "/suppliers", "Add a supplier", { tag: t, body: F.SupplierBody, ok: z.object({ supplier: Supplier }), status: 201 });
  route("get", "/suppliers/{id}", "A supplier", { tag: t, ok: z.object({ supplier: Supplier }) });
  route("patch", "/suppliers/{id}", "Edit a supplier", { tag: t, body: F.SupplierPatchBody, ok: z.object({ supplier: Supplier }) });
  route("delete", "/suppliers/{id}", "Remove a supplier with nothing owed", { tag: t, ok: null, status: 204 });

  route("get", "/expense-categories", "Expense categories (defaults + used)", { tag: t, ok: z.object({ categories: z.array(z.string()) }) });
  route("get", "/expenses", "Expenses (?branchId=&from=&to= yyyy-mm-dd, &category=) with totals by category", { tag: t, ok: z.object({ from: z.string(), to: z.string(), total: M, byCategory: z.array(z.object({ category: z.string(), amount: M })), expenses: z.array(Expense) }) });
  route("post", "/expenses", "Record an expense (idempotent on id)", { tag: t, body: F.ExpenseBody, ok: z.object({ expense: Expense, replayed: z.boolean().optional() }), status: 201 });
  route("patch", "/expenses/{id}", "Edit an expense", { tag: t, body: F.ExpensePatchBody, ok: z.object({ expense: Expense }) });
  route("delete", "/expenses/{id}", "Delete an expense", { tag: t, ok: null, status: 204 });

  const withCustomer = Statement.extend({ customer: Customer });
  route("get", "/ledger/customers", "Customers with udhaar (or advance) balances", { tag: t, ok: z.object({ owed: M, advance: M, customers: z.array(z.object({ customer: Customer, balance: M })) }) });
  route("get", "/customers/{id}/ledger", "A customer's udhaar statement; payments clear the oldest bills first", { tag: t, ok: withCustomer });
  route("post", "/customers/{id}/payments", "Receive a payment (any role; idempotent on id)", { tag: t, body: F.PaymentBody, ok: withCustomer, status: 201 });
  route("post", "/customers/{id}/opening", "Udhaar from before Setu Retail (owner/manager)", { tag: t, body: F.OpeningBody, ok: withCustomer, status: 201 });
  route("post", "/ledger/customer-entries/{id}/void", "Undo a payment or opening entry", { tag: t, body: F.VoidBody, ok: Statement });

  const withSupplier = Statement.extend({ supplier: Supplier });
  route("get", "/ledger/suppliers", "Suppliers you owe (or have an advance with)", { tag: t, ok: z.object({ owed: M, advance: M, suppliers: z.array(z.object({ supplier: Supplier, balance: M })) }) });
  route("get", "/suppliers/{id}/ledger", "A supplier statement; payments clear the oldest bills first", { tag: t, ok: withSupplier });
  route("post", "/suppliers/{id}/payments", "Record a payment made (idempotent on id)", { tag: t, body: F.PaymentBody, ok: withSupplier, status: 201 });
  route("post", "/suppliers/{id}/opening", "Dues from before Setu Retail", { tag: t, body: F.OpeningBody, ok: withSupplier, status: 201 });
  route("post", "/ledger/supplier-entries/{id}/void", "Undo a payment or opening entry", { tag: t, body: F.VoidBody, ok: Statement });

  route("get", "/cash-book", "A branch's cash book by day (?branchId=&from=&to= yyyy-mm-dd, up to 3 months)", { tag: t, ok: CashBook });
  route("post", "/cash-book/entries", "Add a manual cash in/out line (idempotent on id)", { tag: t, body: F.CashEntryBody, ok: z.object({ saved: z.literal(true) }), status: 201 });
  route("delete", "/cash-book/entries/{id}", "Delete a manual cash line", { tag: t, ok: null, status: 204 });
  route("put", "/cash-book/opening", "Set the branch's first opening balance (owner)", { tag: t, body: F.CashOpeningBody, ok: z.object({ opening: z.object({ day: z.string(), amount: M }) }) });

  route("get", "/purchases", "Supplier bills (?branchId=&supplierId=&from=&to=&q=)", { tag: t, ok: z.object({ totals: z.object({ bills: z.number().int(), total: M, inputGst: M }), purchases: z.array(PurchaseSummary) }) });
  route("post", "/purchases", "Enter a supplier bill: adds stock, sets cost, records input GST (idempotent on id)", { tag: t, body: F.PurchaseBody, ok: z.object({ purchase: Purchase, replayed: z.boolean().optional() }), status: 201 });
  route("get", "/purchases/{id}", "A supplier bill with items and returns", { tag: t, ok: z.object({ purchase: Purchase }) });
  route("post", "/purchases/{id}/cancel", "Cancel a supplier bill and take its stock back out", { tag: t, body: F.PurchaseCancelBody, ok: z.object({ purchase: Purchase }) });
  route("post", "/purchases/{id}/returns", "Return goods to the supplier (credit note or replacement)", { tag: t, body: F.PurchaseReturnBody, ok: z.object({ purchase: Purchase }), status: 201 });
  route("post", "/purchase-returns/{id}/receive", "The replacement arrived: stock comes back in", { tag: t, body: F.ReplacementBody, ok: z.object({ purchase: Purchase }) });
}

// ── Phase 4b: report tools, receipt designs, barcodes ──
{
  const M = z.number().int();
  const t = "tools";
  const Buckets = z.object({ current: M, d30: M, d60: M, d90: M, d90plus: M });
  const Aged = z.object({ id: z.string(), type: z.string(), ref: z.string(), at: z.string(), dueDate: z.string().nullable(), amount: M, paid: M, open: M, branchId: z.string().nullable(), dueDay: z.string(), bucket: z.enum(["current", "d30", "d60", "d90", "d90plus"]), daysOverdue: z.number().int() });
  const party = { name: z.string(), phone: z.string(), open: M, buckets: Buckets, items: z.array(Aged), maxDaysOverdue: z.number().int() };
  const common = { asOf: z.string(), buckets: z.array(z.object({ key: z.string(), label: z.string() })), totals: Buckets, total: M };
  const CustomerAging = registry.register("CustomerAging", z.object({ ...common, creditDays: z.number().int(), parties: z.array(z.object({ customerId: z.string(), creditDays: z.number().int(), ...party })) }));
  const SupplierAging = registry.register("SupplierAging", z.object({ ...common, parties: z.array(z.object({ supplierId: z.string(), ...party })), dueThisWeek: z.array(Aged.extend({ supplierId: z.string(), name: z.string() })) }));
  const P = { revenue: M, cost: M, expenses: M, grossProfit: M, netProfit: M };
  const Profit = registry.register("ProfitReport", z.object({ from: z.string(), to: z.string(), period: z.enum(["day", "month"]), ...P, grossMarginBp: z.number().int().nullable(), uncosted: z.object({ lines: z.number().int(), revenue: M }), byPeriod: z.array(z.object({ period: z.string(), ...P })), byBranch: z.array(z.object({ branchId: z.string(), ...P })), expensesByCategory: z.array(z.object({ category: z.string(), amount: M })) }));
  const Q = z.number().int();
  const StockRegister = registry.register("StockRegister", z.object({ branchId: z.string(), from: z.string(), to: z.string(), value: M, missingCost: z.number().int(), items: z.array(z.object({ productId: z.string(), name: z.string(), sku: z.string(), unit: z.string(), opening: Q, purchases: Q, sales: Q, returns: Q, adjustments: Q, supplierReturns: Q, closing: Q, value: M.nullable() })) }));
  const Template = registry.register("ReceiptTemplate", ReceiptTemplateDto);
  route("get", "/reports/aging/customers", "Invoice Aging: udhaar due after credit days, by how overdue", { tag: t, ok: CustomerAging });
  route("get", "/reports/aging/suppliers", "Payables Aging: unpaid supplier bills by due date", { tag: t, ok: SupplierAging });
  route("get", "/reports/profit", "Profit: net sales before GST − cost of goods − expenses (?from=&to= yyyy-mm-dd, &branchId=)", { tag: t, ok: Profit });
  route("get", "/reports/stock-register", "Opening, in, out and closing stock per product in a branch (?branchId=&from=&to=)", { tag: t, ok: StockRegister });
  route("get", "/receipt-templates", "Saved receipt designs", { tag: t, ok: z.object({ templates: z.array(Template) }) });
  route("post", "/receipt-templates", "Save a receipt design (the first becomes the default)", { tag: t, body: ReceiptTemplateBody, ok: z.object({ template: Template }), status: 201 });
  route("patch", "/receipt-templates/{id}", "Edit a receipt design", { tag: t, body: ReceiptTemplateBody.partial(), ok: z.object({ template: Template }) });
  route("post", "/receipt-templates/{id}/default", "Make a design the business default", { tag: t, ok: z.object({ template: Template }) });
  route("delete", "/receipt-templates/{id}", "Delete a receipt design", { tag: t, ok: null, status: 204 });
  route("put", "/receipt-templates/branches/{branchId}", "Pick a branch's receipt design (null = business default)", { tag: t, body: BranchReceiptBody, ok: z.object({ branchId: z.string(), templateId: z.string().nullable() }) });
  route("post", "/products/barcodes", "Make in-store EAN-13 barcodes for products without one", { tag: t, body: BarcodeGenerateBody, ok: z.object({ generated: z.array(z.object({ productId: z.string(), barcode: z.string() })), skipped: z.number().int() }) });
}

// ── Phase 5: multi-branch ──
{
  const t = "branches";
  const Transfer = registry.register("Transfer", TransferDto);
  route("get", "/transfers", "Stock transfers touching your branches (?branchId=&status=)", { tag: t, ok: z.object({ transfers: z.array(Transfer) }) });
  route("post", "/transfers", "Send stock to another branch (in transit; idempotent on id)", { tag: t, body: TransferBody, ok: z.object({ transfer: Transfer, replayed: z.boolean().optional() }), status: 201 });
  route("get", "/transfers/{id}", "A transfer", { tag: t, ok: z.object({ transfer: Transfer }) });
  route("post", "/transfers/{id}/receive", "Receive at the other branch; short/damaged back to sender or written off", { tag: t, body: ReceiveBody, ok: z.object({ transfer: Transfer }) });
  route("post", "/transfers/{id}/cancel", "Cancel while in transit: stock back to the sender", { tag: t, ok: z.object({ transfer: Transfer }) });
  route("get", "/reports/branches", "Branches side by side (?from=&to= yyyy-mm-dd)", { tag: t, ok: registry.register("BranchComparison", BranchComparisonDto) });
  route("get", "/reports/stock-across", "Each product's stock in every branch, with transfer suggestions (?q=&only=suggestions)", { tag: t, ok: registry.register("StockAcross", StockAcrossDto) });
  route("get", "/reports/transfers", "Transfers in a period, in transit, shortages (?from=&to=)", { tag: t, ok: registry.register("TransferReport", TransferReportDto) });
  const Entry = registry.register("AuditEntry", AuditEntryDto);
  route("get", "/audit-log", "Audit log (?from=&to=&branchId=&userId=&action= prefix, &before= cursor, &limit=); managers see their branches", { tag: t, ok: z.object({ entries: z.array(Entry), next: z.string().nullable() }) });
  route("get", "/audit-log/filters", "Actions and people for the audit log filters", { tag: t, ok: z.object({ actions: z.array(z.string()), users: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })) }) });
}

// ── Phase 7: Setu team (super-admin) ──
{
  const t = "super-admin";
  const Admin = registry.register("SuperAdmin", A.AdminDto);
  const AdminSession = registry.register("AdminSession", A.AdminSessionDto);
  const Ok = (k: string) => z.object({ [k]: z.boolean() });
  route("post", "/admin/auth/login", "Admin sign-in, step 1: email + password → code step (or authenticator setup on first sign-in)", { tag: t, body: A.AdminLoginBody, ok: registry.register("AdminLoginStep", A.AdminLoginStep), secure: false });
  route("post", "/admin/auth/setup-2fa", "Admin sign-in, first time: confirm the authenticator app with a code", { tag: t, body: A.AdminCodeBody, ok: AdminSession, secure: false });
  route("post", "/admin/auth/verify", "Admin sign-in, step 2: authenticator code", { tag: t, body: A.AdminCodeBody, ok: AdminSession, secure: false });
  route("post", "/admin/auth/refresh", "New admin access token from the refresh cookie", { tag: t, ok: AdminSession, secure: false });
  route("post", "/admin/auth/logout", "End the admin session", { tag: t, ok: null, status: 204, secure: false });
  route("get", "/admin/auth/invite/{token}", "Who an admin invite / reset link is for", { tag: t, ok: z.object({ email: z.string(), name: z.string() }), secure: false });
  route("post", "/admin/auth/accept", "Set an admin password from an invite / reset link", { tag: t, body: A.AdminAcceptBody, ok: z.object({ accepted: z.boolean(), email: z.string() }), secure: false });
  route("get", "/admin/me", "The signed-in admin", { tag: t, ok: z.object({ admin: Admin }) });
  route("get", "/admin/dashboard", "Totals: accounts, trial, paying by plan, expiring, sign-ups", { tag: t, ok: registry.register("AdminDashboard", A.DashboardDto) });
  const Row = registry.register("AdminAccountRow", A.AccountRowDto);
  route("get", "/admin/accounts", "Accounts (?q=&status=trial|paid|granted|expired|unverified|locked&expiring=days&limit=&offset=)", { tag: t, ok: z.object({ accounts: z.array(Row), total: z.number().int() }) });
  route("get", "/admin/accounts/{id}", "One account: plan, usage vs limits, timeline, keys, reminders, Setu activity (counts only)", { tag: t, ok: registry.register("AdminAccountDetail", A.AccountDetailDto) });
  route("post", "/admin/accounts/{id}/lock", "Lock an account (reason kept for the Setu team only)", { tag: t, body: A.LockBody, ok: Ok("locked") });
  route("post", "/admin/accounts/{id}/unlock", "Unlock an account", { tag: t, body: A.UnlockBody, ok: Ok("locked") });
  route("post", "/admin/accounts/{id}/add-days", "Add free days of the current (or last) plan, after the timeline", { tag: t, body: A.AddDaysBody, ok: z.object({ planCode: z.string(), startsAt: z.string(), endsAt: z.string() }) });
  route("post", "/admin/accounts/{id}/resend-verification", "Email the owner a new verification link", { tag: t, ok: z.object({ sent: z.boolean(), to: z.string() }) });
  route("post", "/admin/accounts/{id}/send-reset", "Email the owner a password reset link", { tag: t, ok: z.object({ sent: z.boolean(), to: z.string() }) });
  route("post", "/admin/accounts/{id}/remind", "Email the owner a plan-ending (or ended) reminder now", { tag: t, ok: Ok("sent") });
  route("post", "/admin/reminders", "Remind everyone whose plan ends within N days (skips anyone reminded in the last 24 h)", { tag: t, body: A.BulkRemindBody, ok: z.object({ sent: z.number().int(), skipped: z.number().int() }) });
  route("post", "/admin/keys", "Issue a Contact-sales key (>100 branches) for one account; shown once and emailed to the owner", { tag: t, body: A.IssueKeyBody, ok: z.object({ id: z.string(), key: z.string(), emailedTo: z.string().nullable(), redeemUrl: z.string() }), status: 201 });
  route("post", "/admin/keys/{id}/revoke", "Cancel an issued key that hasn't been redeemed", { tag: t, ok: Ok("revoked") });
  route("get", "/admin/keys", "Issued Contact-sales keys", { tag: t, ok: z.object({ keys: z.array(registry.register("IssuedKey", A.IssuedKeyRowDto)) }) });
  route("get", "/admin/redemptions", "All redeemed keys, newest first (?before= cursor)", { tag: t, ok: z.object({ redemptions: z.array(registry.register("AdminRedemption", A.RedemptionRowDto)), next: z.string().nullable() }) });
  route("get", "/admin/activity", "What the Setu team did (?adminId=&accountId=&action= prefix&before=)", { tag: t, ok: z.object({ entries: z.array(registry.register("AdminActivity", A.AdminActivityDto)), next: z.string().nullable() }) });
  route("get", "/admin/admins", "The Setu team", { tag: t, ok: z.object({ admins: z.array(Admin) }) });
  route("post", "/admin/admins", "Invite a Setu team member (emails a set-password link)", { tag: t, body: A.AdminCreateBody, ok: z.object({ admin: Admin }), status: 201 });
  route("post", "/admin/admins/{id}/reset", "Reset another admin's password and authenticator app", { tag: t, ok: z.object({ admin: Admin }) });
  route("post", "/admin/admins/{id}/disable", "Turn another admin off", { tag: t, ok: z.object({ admin: Admin }) });
  route("post", "/admin/admins/{id}/enable", "Turn an admin back on (sends a new set-password link)", { tag: t, ok: z.object({ admin: Admin }) });
  route("get", "/internal/cron/reminders", "Daily job: plan-ending emails at 14, 7 and 1 days (Bearer CRON_SECRET)", { tag: t, ok: z.object({ sent: z.number().int(), checked: z.number().int() }), secure: false });
}

// ── Phase 9b: changes made offline ──
{
  const t = "review";
  const Conflict = registry.register("Conflict", ConflictDto);
  route("get", "/conflicts/count", "How many items wait in the owner's review list", { tag: t, ok: z.object({ open: z.number().int() }) });
  route("get", "/conflicts", "The owner's review list (?status=resolved for history)", { tag: t, ok: z.object({ conflicts: z.array(Conflict) }) });
  route("post", "/conflicts/{id}/resolve", "Pick: keep cloud / use device value, discard / restore, keep both / merge", { tag: t, body: ResolveBody, ok: z.object({ conflict: Conflict }) });
}

// ── Demo deployment ──
route("get", "/demo/reset", "When the demo data is next wiped (enabled: false everywhere but the demo)", {
  tag: "demo",
  secure: false,
  ok: z.object({
    enabled: z.boolean(),
    intervalHours: z.number().nullable(),
    nextResetAt: z.iso.datetime().nullable(),
    secondsUntilReset: z.number().int().nullable(),
    resetting: z.boolean(),
    /** Last reset, and the snapshot it loaded vs the one deployed (they match once the new one is in). */
    lastResetAt: z.iso.datetime().nullable(),
    loadedSnapshotAt: z.iso.datetime().nullable(),
    deployedSnapshotAt: z.iso.datetime().nullable(),
    /** Why the last reset didn't happen: wrong_database_name, database_has_real_shops, snapshot_missing or reset_failed. */
    problem: z.string().nullable(),
  }),
});

export function buildOpenApiDocument(version: string) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Setu Retail API", version },
    servers: [{ url: "https://api.retail-pos.setutechnology.com" }],
  });
}
