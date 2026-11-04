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
| `npm test` | Vitest (no database needed) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run db:migrate` | Create a migration while developing (`prisma migrate dev`) |
| `npm run db:deploy` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:seed` | Insert missing public plans; never overwrites edited limits |

## Endpoints (Phase 0)

| Route | |
|---|---|
| `GET /health` | Liveness |
| `GET /health/db` | Database reachable? `503` if not |
| `GET /openapi.json` | OpenAPI 3.1 spec — the frontend generates its client from this |

## Database

`DATABASE_URL` can point at any PostgreSQL (Neon, Supabase, RDS, self-hosted). On Vercel use the provider's **pooled** connection string.
Schema: `prisma/schema.prisma`; migrations: `prisma/migrations/`. The Prisma client is generated into `src/generated/` (git-ignored).

## Deploy (Vercel)

- Project root = this repo. `vercel.json` sends every request to `api/index.ts` and runs `npm run vercel-build` (Prisma generate).
- Env vars: `NODE_ENV=production`, `DATABASE_URL`, `CORS_ORIGINS=https://app.retail-pos.setutechnology.com`.
- Domain: `api.retail-pos.setutechnology.com`.
- Migrations are **not** run on deploy (so a preview build can't touch production data). Run `npm run db:deploy` against the target database before promoting a release that adds one.
