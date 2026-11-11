# setu-retail-be

API for **Setu Retail**, the premium cloud POS from [Setu Technology](https://setutechnology.com).
Frontend: [`setu-retail-fe`](https://github.com/sagar305/setu-retail-fe). Build plan: [`docs/PLAN.md`](docs/PLAN.md).

**Stack:** Node 22 · TypeScript · Express 5 · Prisma 7 (PostgreSQL) · zod + OpenAPI · Vitest · deployed on Vercel.

## Run locally

```bash
cp .env.example .env          # set DATABASE_URL to any Postgres
npm install                   # npm 10 works from the lockfile; use npm 11+ if you change dependencies
npm run db:generate
npm run db:deploy             # apply migrations
npm run db:seed               # create Basic / Gold / Platinum
npm run dev                   # http://localhost:4000/health
```

| Script | What it does |
|---|---|
| `npm run dev` | API with reload |
| `npm test` | Vitest. Integration tests run too when `TEST_DATABASE_URL` points at an empty Postgres database |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run db:migrate` | Create a migration while developing (`prisma migrate dev`) |
| `npm run db:deploy` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:seed` | Insert missing public plans; never overwrites edited limits |
| `npm run demo:seed` | Build the sample shop on an empty demo database (see [Demo](#demo-deployment)) |
| `npm run demo:dump` | Capture the demo database as `demo-dump/demo.json.gz` |
| `npm run demo:restore -- --yes` | Wipe the demo database and restore that snapshot now |

## Endpoints

Full spec: `GET /openapi.json`. Summary:

| Area | Routes |
|---|---|
| Health | `GET /health`, `GET /health/db` |
| Auth (public) | `POST /auth/signup`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `GET /auth/invite/{token}`, `POST /auth/accept-invite` |
| Signed in | `GET /me` |
| Plan (owner; works after expiry) | `GET /account/plan`, `POST /account/license/check`, `POST /account/license/redeem`, `GET`/`POST /account/keep-active` |
| Branches | `GET /branches`, `POST /branches` (owner), `PATCH /branches/{id}` (owner) |
| Staff (owner, manager) | `GET /staff`, `POST /staff`, `POST /staff/{id}/resend-invite`, `PATCH /staff/{id}` |

### How sign-in works
- Access token (JWT, 15 min) in the `Authorization: Bearer` header; refresh token in an http-only `setu_rt` cookie scoped to `/auth`.
- A sign-in lasts **one 12-hour shift**; refresh rotates the cookie, and replaying an old one revokes the session.
- 5 wrong passwords lock that login for 15 minutes. Disabling a user or resetting a password signs out every device.
- Every request re-checks the session, user and plan in the database, so removing access takes effect immediately.

### Plans
- New owners get **3 months of Basic** once they verify their email; one trial per email, and a phone or GSTIN already used by another account is refused.
- When the plan ends, staff can't sign in and the owner sees only the plan screens until a key is redeemed.
- A key for the current plan adds days. For a different plan the owner chooses **switch now** (days left on a paid plan are converted by price; trial days are not) or **start after the current plan**.
- If a smaller plan leaves too many branches or staff, the oldest stay active, the rest become read-only, and the owner can choose others on the keep-active screen.

### Super-admin (Setu team)
- Separate logins (`super_admins`), not shop users: email + password, then a 6-digit code from an authenticator app (TOTP). The first sign-in after an invite or reset links the app. Admin sessions last 8 hours (`setu_admin_rt` cookie scoped to `/admin/auth`).
- **First admin:** run `npm run admin:create -- you@setutechnology.com "Your Name"` against the production database. It prints (and emails) a one-time set-password link to `/super-admin/accept`. The same command resets an existing admin who lost their phone. Admins can then invite each other in the app.
- The super-admin sees counts only (plan, expiry, usage vs limits, keys, reminders), never bills or customers. Every action is logged in `admin_audit_logs`.
- Contact-sales keys (>100 branches) are issued for one account and only redeem there; they can be cancelled until redeemed.
- Plan-ending emails go out automatically at 14, 7 and 1 days before the end, from the daily Vercel Cron job (`vercel.json`, 09:00 IST) calling `GET /internal/cron/reminders` with `Authorization: Bearer $CRON_SECRET`.
- The authenticator secrets are encrypted with a key derived from `JWT_SECRET`: changing `JWT_SECRET` means every admin links their app again (use `admin:create` to reset).

### Hardening (Phase 8)
- **Rate limits.** Sign-in, sign-up, email links and admin sign-in are counted in Postgres (`rate_limits`; keys are SHA-256 hashes, never emails). Over the limit, the API answers `429` with `Retry-After`. Limits live in `src/services/rateLimit.ts`. `RATE_LIMITS=off` is for tests and load tests only.
- **Permissions.** `test/integration/permissions.test.ts` walks every route in `/openapi.json`:
  - no token → 401;
  - a shop token on `/admin/*` → 401;
  - role limits for cashiers and managers;
  - one shop can't read or change another's records.
- **Load test.** `scripts/load-test.ts` (`seed`, then `run`). At the target (200 shops, 500 counters, 10 bills/s plus dashboards and offline-pack refreshes), one API process answered bills in 38 ms typically (60 ms for the slowest 5%) with no errors. It stayed clean up to about 50 bills/s per process. Never run it against production.
- **Connections.** `DATABASE_POOL_MAX` (default 5) caps database connections per serverless instance, so many instances fit in the database's connection limit.
- **Backups.** A nightly encrypted `pg_dump` runs as a GitHub Actions artifact, kept 90 days. Setup and restore steps: [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md).

## Database

`DATABASE_URL` can point at any PostgreSQL (Neon, Supabase, RDS, self-hosted). On Vercel use the provider's **pooled** connection string.
Schema: `prisma/schema.prisma`; migrations: `prisma/migrations/`. The Prisma client is generated into `src/generated/` (git-ignored).

## Deploy (Vercel)

- Project root = this repo. `vercel.json` sends every request to `api/index.ts` and runs `npm run vercel-build` (Prisma generate).
- Env vars: `NODE_ENV=production`, `DATABASE_URL`, `CORS_ORIGINS=https://app.retail-pos.setutechnology.com`, `APP_URL=https://app.retail-pos.setutechnology.com`, `JWT_SECRET`, `RETAIL_LICENSE_SECRET` (same as setutechnology.com), `RESEND_API_KEY`, `MAIL_FROM` (a sender on a domain verified in Resend). The API refuses to start in production without them. Also set `CRON_SECRET` (16+ random characters; Vercel sends it to the cron job) or the automatic plan reminders are off. The sign-in cookie works whether the web app reaches the API directly or through its own `/api/*` rewrite; `COOKIE_PATH_PREFIX` is no longer needed.
- Domain: `api.retail-pos.setutechnology.com`.
- Migrations are **not** run on deploy (so a preview build can't touch production data). Run `npm run db:deploy` against the target database before promoting a release that adds one.

## Demo deployment

A public demo (`demo.retail-pos.setutechnology.com`) is **a second Vercel project on this same repo, with its own database**. Visitors sign in with a shared login; every 2 hours the database is wiped and the sample shop restored, so whatever they type disappears.

**How the reset works** (`src/services/demoReset.ts`). Vercel has no long-running process, so there is no timer: reset times are counted from midnight UTC (00:00, 02:00, 04:00 … for 2 hours) and **the first request after a reset time** wipes every table and loads `demo-dump/demo.json.gz` before it is answered (about a second for the sample shop). It runs in one transaction under an advisory lock, so other requests see the old data until the new data is in and only one instance resets. Every timestamp is moved forward by the time since the snapshot (dates by whole days), so yesterday's bills in the snapshot are always yesterday's, the plan never runs out and batch expiries stay ahead. Sign-ins, rate limits, replay keys and the Setu team's admin logins are never captured, so a reset signs every visitor out. `GET /demo/reset` reports the next reset time for the countdown in the web app (`enabled: false` everywhere else).

| Variable | Default | |
|---|---|---|
| `DEMO_RESET_ENABLED` | off | Master switch (`1`/`true`). Nothing is wiped without it. |
| `DEMO_RESET_EXPECT_DB` | — | Required with the switch: the only database name a reset may wipe. A mistyped `DATABASE_URL` pointing at production is refused. |
| `DEMO_RESET_INTERVAL_HOURS` | `2` | 0.25 to 168. |
| `DEMO_RESET_DUMP_PATH` | `demo-dump/demo.json.gz` | Bundled into the function by `vercel.json` (`includeFiles`). |

**Changing the demo shop.** Restore the snapshot into the demo database (or a local copy), change it in the app, then capture it again and commit:

```bash
export DATABASE_URL=<demo database, direct URL> DEMO_RESET_EXPECT_DB=<its name>
npm run demo:restore -- --yes   # start from the current snapshot
# … edit in the app …
npm run demo:dump               # writes demo-dump/demo.json.gz
```

To build it from nothing: an empty database, `npm run db:deploy && npm run db:seed && npm run demo:seed` (sample shop, three weeks of bills), then `npm run demo:dump`. After a migration that adds a required column with no default, run `demo:restore` + `demo:dump` again so the snapshot has it; until then a failed reset is rolled back and the demo keeps its current data.
