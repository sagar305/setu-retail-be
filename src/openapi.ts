import "./zodOpenApi.js";
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z, type ZodType } from "zod";
import * as S from "./schemas.js";
import * as P from "./schemas2.js";
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
route("get", "/reports/gst", `GST by rate (returns netted), by HSN, B2B/B2C, credit notes ${Range}`, { tag: "reports", ok: GstReport });
route("get", "/reports/stock", "Stock value, low/out/below zero, expiring batches (?branchId=)", { tag: "reports", ok: StockReport });
route("get", "/reports/staff", `Sales by cashier and counter; margin by product ${Range}`, { tag: "reports", ok: StaffReport });
route("get", "/reports/stock-log", `Stock movements in a branch ${Range}`, { tag: "reports", ok: StockLog });

route("post", "/imports/products", "Import products (CSV rows); matches SKU, barcode, then name", { tag: "imports", body: ProductImportBody, ok: ImportResult });
route("post", "/imports/customers", "Import customers (CSV rows); matches mobile, then name", { tag: "imports", body: CustomerImportBody, ok: ImportResult });
route("post", "/imports/free-pos", "Import a free Browser POS backup (POS_BACKUP.json) into a branch (owner)", { tag: "imports", body: FreePosImportBody, ok: z.object({ products: ImportResult, customers: ImportResult, categories: z.number().int(), paymentMethodsAdded: z.number().int(), batches: z.number().int(), skipped: z.object({ orders: z.number().int() }) }) });

export function buildOpenApiDocument(version: string) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Setu Retail API", version },
    servers: [{ url: "https://api.retail-pos.setutechnology.com" }],
  });
}
