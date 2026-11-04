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

## Database

`DATABASE_URL` can point at any PostgreSQL (Neon, Supabase, RDS, self-hosted). On Vercel use the provider's **pooled** connection string.
Schema: `prisma/schema.prisma`; migrations: `prisma/migrations/`. The Prisma client is generated into `src/generated/` (git-ignored).

## Deploy (Vercel)

- Project root = this repo. `vercel.json` sends every request to `api/index.ts` and runs `npm run vercel-build` (Prisma generate).
- Env vars: `NODE_ENV=production`, `DATABASE_URL`, `CORS_ORIGINS=https://app.retail-pos.setutechnology.com`, `APP_URL=https://app.retail-pos.setutechnology.com`, `JWT_SECRET`, `RETAIL_LICENSE_SECRET` (same as setutechnology.com), `RESEND_API_KEY`, `MAIL_FROM` (a sender on a domain verified in Resend). The API refuses to start in production without them.
- Domain: `api.retail-pos.setutechnology.com`.
- Migrations are **not** run on deploy (so a preview build can't touch production data). Run `npm run db:deploy` against the target database before promoting a release that adds one.
