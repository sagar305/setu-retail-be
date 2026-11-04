# Setu Retail — Cloud POS (premium) — Build Plan v1.6

Status: Phases 0–3 built. Phase 4a in progress.

## 1. Confirmed decisions

| Area | Decision |
|---|---|
| Product | Premium, cloud version of the free Browser Based POS (`/products/browser-based-pos`), sold as **Setu Retail** |
| Repos | UI → `sagar305/setu-retail-fe` · API → `sagar305/setu-retail-be` · buy page + key issuing → `sagar305/setu_main` |
| Frontend | Vite + React + TypeScript, installable app that works offline (service worker + IndexedDB), Tailwind |
| Backend | Node.js + TypeScript (Express), deployed on Vercel as serverless functions |
| Database | PostgreSQL, any provider, connected by `DATABASE_URL` (pooled URL on Vercel). Prisma ORM + migrations |
| Hosting | FE and BE both on Vercel |
| Domains | App: `app.retail-pos.setutechnology.com` · API: `api.retail-pos.setutechnology.com` (same parent, so login cookies stay first-party) |
| Brand | Same tokens as setutechnology.com: indigo `#26306B`, saffron `#F2A03D`, ink `#0E1124`, cream `#ECEAE3` / paper `#F2EFE7`, muted `#5F6478`, Sora font |
| Roles | Owner/Admin, Manager, Cashier (standard split, §5) |
| Staff ↔ branch | Manager: one or more branches. Cashier: exactly one branch |
| Login | Every user has email + username + password. Log in with either email or username |
| Plans | Basic 1 branch · Gold 10 · Platinum 100 · more than 100 → "Contact sales" |
| Other limits | Placeholders kept in a `plans` table, editable without a code change (§6) |
| Trial | New owner gets **3 months of Basic** free, **after verifying their email**. One trial per email; refused if the **tax number or phone** already belongs to another account |
| Expiry | Online: **fully locked**, only the owner can sign in, only to redeem a key. Offline counters **keep billing with no time limit**, but the server **refuses their sync** until the plan is renewed |
| Payment | Key bought on setutechnology.com (Cashfree ₹ / PayPal $, same as QR Menu), redeemed in Settings. Keys are issued by the website after payment. **Only exception**: "Contact sales" deals above 100 branches, where Setu generates a key by hand once payment is received |
| Offline | Billing + payment received work offline for everyone; expenses + payment made offline for owner/manager only. All sync later |
| Invoice numbers | Series per branch + counter, e.g. `B1-C2-00045` (no clashes offline) |
| GST | Prices **include GST**. Premium receipts have CGST/SGST/IGST split, HSN codes and place of supply |
| Branch prices | Products shared across the business; each branch can set its **own price** (falls back to the default price) |
| Email | Sent with **Resend directly** from setu-retail-be and Setu_main |
| Features | Everything in the free POS + all 12 connected tools rebuilt inside retail FE on cloud data |
| Phase-1 extras | Import from free POS backup · stock transfer between branches · audit log · super-admin at hidden `/super-admin` route |

### Connected tools (Phase 4, v1.6)

| Area | Decision |
|---|---|
| Split | **4a money tools**: Customer Ledger, Cash Book, Expense Tracker, Supplier Book, Purchase Register, Supplier Ledger (expenses and payments work offline). **4b reports**: Invoice Aging, Payables Aging, Profit Dashboard, Stock Register, Barcode Generator, Receipt Designer |
| On / off | Settings → Connected tools, like the free POS. Owner turns each tool on or off; off tools leave the menu. Udhaar at checkout only while Customer Ledger is on. All on for new accounts |
| Cash Book | **Per branch, automatic**: cash sales, cash refunds, cash expenses, cash customer payments and cash supplier payments post on their own, plus manual in/out entries. A day's opening = the previous day's closing; the owner sets the first opening balance |
| Purchases | Supplier bill adds stock to a branch (batches with expiry when batch tracking is on), updates cost price and records **input GST per line** (CGST/SGST or IGST by supplier state). Paid now, on credit, or part-paid with a due date. Purchase returns: credit note (reduces what you owe) or replacement (pending until the goods come back) |
| Payments | Customer payments clear the **oldest unpaid udhaar first**; payments to suppliers clear the oldest unpaid bills first. Aging is based on that |
| Old dues | Shops coming from the free browser POS import their **full history** (ledger, supplier ledger, purchases, expenses, cash book). Others enter an **opening balance** per customer or supplier with a date, counted as the oldest bill |

### Prices (GST included)

| Plan | Branches | ₹ / month | ₹ / year | $ / month | $ / year |
|---|---|---|---|---|---|
| Basic | 1 | 249 | 2,499 | 4.99 | 49.99 |
| Gold | 10 | 499 | 4,999 | 9.99 | 99.99 |
| Platinum | 100 | 999 | 9,999 | 19.99 | 199.99 |

---

## 2. Architecture

```
 setutechnology.com (Setu_main, Next.js)          setu-retail-fe (Vite PWA)
 ├─ /products/retail  → plan + buy                 ├─ IndexedDB (Dexie): cache + outbox
 ├─ /api/retail/checkout  (Cashfree/PayPal)        ├─ Service worker: app works offline
 └─ webhook → issue SETU-R key → email (Resend)    └─ sync engine ⇄ API
                         │                                   │ HTTPS (JWT)
                         ▼                                   ▼
                 key typed into Settings ──────►  setu-retail-be (Express on Vercel)
                                                   ├─ auth, RBAC, plan limits
                                                   ├─ /sync push / pull
                                                   └─ Prisma ──► PostgreSQL (DATABASE_URL)
```

- **Multi-tenant**: every row carries `account_id` (and `branch_id` where relevant). A single query helper adds the account and branch filter, and tests check that one account can never read another's data.
- **API contract**: request/response shapes defined once with zod in BE → OpenAPI spec → FE generates its typed client. FE and BE stay in step without copying types.
- **Money**: stored as integer minor units (paise / cents) to avoid rounding errors.
- **IDs**: UUIDs generated on the client, so a bill made offline already has its final ID.

---

## 3. Database (main tables)

**Tenancy & access**
- `accounts` (business: name, currency, timezone, tax number, logo, UPI ID)
- `branches` (account, name, address, phone, GSTIN, **state code** for GST, invoice code e.g. `B1`, active, created_at; oldest = default kept on downgrade)
- `users` (account, email, **email_verified_at**, username, password_hash, role, active, last_login) · `user_branches` (manager → many, cashier → one)
- `refresh_tokens`, `password_resets`, `email_verifications`, `trial_claims` (stops repeat trials, see §9)
- `devices` (registered counters per branch: counter code e.g. `C2`, next invoice number, last sync)

**Plans & billing**
- `plans` (code, name, limits JSON: branches, staff, products, customers, orders/month)
- `subscriptions` (account, plan, starts_at, ends_at, source: trial | key)
- `license_redemptions` (key_id **unique** → a key works only once, account, plan, days, redeemed_at)

**Catalogue & stock** (from free POS `lib/pos/types.ts`)
- `categories`, `products` (account-wide catalogue: default price, cost, SKU, barcode, **HSN code, GST rate**, tax-inclusive, unit, image)
- `branch_prices` (product × branch: selling price override; no row = default price)
- `branch_stock` (product × branch: stock, low-stock threshold), `batches` (batch, expiry, cost, qty per branch)
- `inventory_logs` (opening / add / reduce / sale / restock / adjust / transfer)
- `stock_transfers` + `stock_transfer_items` (from branch → to branch, status: sent / received)

**Sales**
- `customers` (account-wide; GSTIN + state for B2B / IGST), `payment_methods`
- `orders` (branch, device, cashier, invoice number `B1-C2-00045`, place of supply, totals, discount, CGST/SGST/IGST totals, status), `order_items` (HSN, GST rate, CGST/SGST/IGST per line), `order_payments`
- `held_carts`
- `settings` (per account + per branch overrides: receipt, tax, paper size, connected tools, auto-lock)

**Connected tools**
- Customer ledger entries (credit sales, payments received) · cash book entries · expenses + expense categories
- `suppliers`, `purchases` + `purchase_items`, supplier ledger entries (purchases on credit, payments made)
- `receipt_templates`
- Profit dashboard, stock register, invoice aging, payables aging, barcode → **reports computed from the tables above** (no extra tables)

**Platform**
- `audit_logs` (who, role, branch, action, entity, before/after, time, device)
- `sync_ops` (op_id **unique**, so a retried sync never applies twice)

---

## 4. Offline billing & sync

What works offline: **billing (incl. hold/recall, add customer, print receipt), expenses, payment received, payment made** (with their cash book entries).
Needs internet: product/price edits, stock adjustments, transfers, reports, staff/branch/settings, key redemption.

How it works:
1. Device keeps a local copy of products, customers, payment methods, settings (pulled on login, refreshed by `/sync/pull?since=`).
2. Each offline action is written locally **and** into an outbox with a client UUID.
3. When online, the outbox is pushed in order to `/sync/push`; the server applies each op in a DB transaction and records `op_id` so retries are safe.
4. Stock is applied as a **change** (−2), not an overwrite. If two counters sell the last unit offline, stock goes negative and is flagged on the dashboard and in reports.
5. **Invoice numbers**: each counter (device) has its own series per branch, `B<branch>-C<counter>-<00001>`, so two offline counters can never give the same number.
6. **Plan expired**: the counter keeps working offline as long as needed; `/sync/push` is refused with "plan expired" and the bills stay safely in the outbox until the owner redeems a key, then they sync.
7. Offline sign-in works only for users who have signed in on that device before (their session is cached).
8. Sync status chip on screen: Online / Offline (n bills waiting) / Sync blocked — plan expired / Sync error.

---

## 5. Roles & permissions (standard split)

| Capability | Owner/Admin | Manager | Cashier |
|---|---|---|---|
| Billing, hold/recall, print receipt | ✅ | ✅ | ✅ |
| Add customer at billing | ✅ | ✅ | ✅ |
| Discount | any | any | up to cap (default **10%**, owner can change) |
| See cost price / margin | ✅ | ✅ | ❌ |
| Cancel / refund a bill | ✅ | ✅ (own branches) | ❌ |
| Products, categories, stock, batches | ✅ | ✅ (own branches' stock) | view only |
| Stock transfer | ✅ | ✅ (between own branches) | ❌ |
| Customers & customer ledger | ✅ | ✅ | add + receive payment |
| Expenses / payment made | ✅ | ✅ | ❌ |
| Reports & tools | all branches | own branches | own sales today only |
| Manage cashiers | ✅ | ✅ (own branches) | ❌ |
| Manage managers, branches | ✅ | ❌ | ❌ |
| Plan, license key, billing | ✅ | ❌ | ❌ |
| Audit log | ✅ | own branches | ❌ |
| Import from free POS | ✅ | ❌ | ❌ |

Enforced on the **server** (every route checks role + branch), and the UI hides what a role can't use.

---

## 6. Plans, limits, trial, keys

### Placeholder limits (editable in `plans` table)

| Limit | Basic | Gold | Platinum |
|---|---|---|---|
| Branches | 1 | 10 | 100 |
| Staff users (excl. owner) | 3 | 30 | 300 |
| Products | 1,000 | 10,000 | 100,000 |
| Customers | 2,000 | 20,000 | Unlimited |
| Orders / month | 3,000 | 30,000 | Unlimited |

- Limits are checked on the server when creating a branch, staff user, product, customer or order. FE shows usage bars in Settings → Plan and an "Upgrade" prompt near the limit.
- Offline-created bills are **never rejected** for the order limit at sync (the sale already happened); the account is flagged over-limit instead.

### Redeeming a key for a different plan
The owner is asked which they want:
- **Switch now**: new plan starts today; the days left on the current plan are converted by price into days on the new plan (e.g. 60 Gold days → ~30 Platinum days).
- **Start after current plan**: current plan continues; the new key starts when it ends.

Same plan → days are simply added.

### Downgrade over the branch limit
When the active plan allows fewer branches than exist (e.g. 5 branches → Basic), the owner must **pick which branch to keep working with**; the **oldest branch is pre-selected**. Other branches and their data are kept but cannot be opened until the owner upgrades.

### Downgrade over staff / product / customer limits
The owner chooses which staff, products and customers stay active. **The oldest are pre-selected automatically**, with an "Auto-select oldest" button, so the owner can just confirm. The rest become **read-only** until the owner upgrades or removes some:
- staff: cannot sign in
- products: visible, cannot be sold or edited
- customers: visible with their balance, cannot be edited or billed

### Trial & expiry
- Sign-up creates account + first branch + owner. After the owner **verifies their email**, `subscription(source=trial, plan=Basic, 3 months)` starts.
- Reminders in-app (and by email) at 14, 7, 1 days before end.
- On expiry: **fully locked** online. Only the owner can sign in, and sees only the "Redeem key / Buy" screen. Data is kept, not deleted. Offline counters: see §4.6.

### License key (new `SETU-R…` format, mirrors QR Menu `lib/qrMenuLicense.ts`)
- AES-256-GCM, authenticated: `version | plan (Basic/Gold/Platinum) | days | keyId`, base32 with `SETU-R` prefix.
- Separate secret `RETAIL_LICENSE_SECRET` (not shared with QR Menu). Same file in Setu_main (issues) and setu-retail-be (redeems), with a shared test vector in both repos.
- Single use: `license_redemptions.key_id` is unique.
- Keys are issued by the website after a successful payment.
- **Manual keys only for Contact-sales deals (>100 branches)**, generated by the Setu team in the retail app's **`/super-admin`** page after payment is received. The Setu team types **every limit** into the key form: branches (>100), staff, products, customers, orders/month, plus days. The limits are saved as a custom plan in the database and the key points to it. The backend therefore also holds the issuing secret, and only super-admin users can call the issue endpoint (every issue is audit-logged).

---

## 7. Screens (setu-retail-fe)

**Public**: Sign up · Verify email · Login (email or username) · Forgot / reset password · Locked / Redeem key (with switch-now / start-later choice) · Pick branch after downgrade
**App shell**: branch switcher (owner/manager), sync chip, auto-lock, role-aware nav
**POS (from free POS)**: Dashboard · Sell (billing) · Products (+ batches, CSV import/export) · Orders · Customers · Reports · Settings (business, branch, receipt, tax, payment methods, staff, plan & key, connected tools, import from free POS)
**Connected tools (12)**: Receipt Designer · Customer Ledger (Udhaar) · Cash Book · Invoice Aging · Expense Tracker · Purchase Register · Supplier Book · Supplier Ledger · Payables Aging · Profit Dashboard · Stock Register · Barcode Generator
**New**: Branches · Stock transfers · Audit log
**/super-admin** (Setu team only): accounts, plan & expiry, usage vs limits, redeemed keys history, lock/unlock account, **issue Contact-sales key** (>100 branches only)

Mobile-first; billing screen usable on a phone and on a counter PC with barcode scanner + thermal printer (80mm / 58mm / A4, as in free POS).

---

## 8. Setu_main changes (website)

- `lib/retailLicense.ts` — issue `SETU-R` keys (+ tests).
- `content/en/pricing.json` — Setu Retail from "in-development" to "paid", 3 tiers, IN/INTL prices, "3 months free".
- `/products/retail` — plan cards + buy flow (choose plan, monthly/yearly, email) and payment status page, reusing the QR Menu Cashfree/PayPal routes (refactored to take a `product` param rather than duplicating them).
- Webhook → issue key → show on status page + email via Resend.
- Free POS page: "Upgrade to Setu Retail" link + note that the backup file can be imported.
- Pricing FAQ text ("All of them except QR Menu…") updated.

---

## 9. Open questions

None. All answered (v1.5: Contact-sales key limits typed per key; owner picks active staff/products/customers after downgrade, oldest auto-selected).

---

## 10. Build phases

| Phase | Scope | Repo |
|---|---|---|
| 0 | BE scaffold (Express + TS + Prisma + zod/OpenAPI + tests), FE scaffold (Vite + Tailwind brand tokens + PWA shell), Vercel configs, CI (lint, typecheck, test) | BE, FE |
| 1 | Auth (sign up, login, reset), accounts, branches, staff, roles, plans + trial + lock, key redeem | BE, FE |
| 2 | Core POS online: products/categories/batches/stock, customers, payment methods, billing, orders, receipts, held carts, dashboard, reports, settings | BE, FE |
| 3 | Offline: local DB, outbox, `/sync`, invoice series, conflict flags | BE, FE |
| 4a | Money tools: customer ledger, cash book, expenses, suppliers, purchases (+ returns, input GST), supplier ledger; expenses and payments offline; tool on/off; free POS history import | BE, FE |
| 4b | Reports tools: invoice aging, payables aging, profit dashboard, stock register, barcode generator, receipt designer | BE, FE |
| 5 | Multi-branch: transfers, branch reports, audit log viewer | BE, FE |
| 6 | Setu_main: retail key, pricing, buy page, checkout, webhook, email | Setu_main |
| 7 | Super-admin, import from free POS backup (`POS_BACKUP.json`) | BE, FE |
| 8 | Hardening: permission tests, sync tests, load test, DB backups, docs, launch | all |

Each phase = its own branch + PR (Setu_main PRs into `stage`, per its CLAUDE.md).
