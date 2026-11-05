# CLAUDE.md — setu-retail-be

API for Setu Retail (premium cloud POS). The full agreed plan is `docs/PLAN.md`; follow it, and ask before changing a decision recorded there.

## Commands
- `npm run dev`, `npm test`, `npm run lint`, `npm run typecheck`
- `npm run db:generate` after any `prisma/schema.prisma` change; `npm run db:migrate -- --name <change>` to create a migration
- Local Postgres for manual checks: set `DATABASE_URL` in `.env`

## Conventions
- ESM + `NodeNext`: relative imports end in `.js`.
- `createApp(deps)` in `src/app.ts` builds the app; dependencies (db checks, later repositories) are injected so tests run without a database.
- Every route registers its zod request/response schemas in `src/openapi.ts` (or a module it imports) so `/openapi.json` stays complete.
- Errors: throw `AppError(status, code, message)`; never send raw error messages or stack traces to clients.
- Money is integer minor units (paise/cents). IDs are UUIDs (client-generated for offline-created records).
- Every tenant table carries `account_id` (and `branch_id` where relevant); every query is scoped by it.
- Plan limits live in the `plans` table; `src/config/plans.ts` only seeds them.
- Pin exact dependency versions. Use npm 11+ to change dependencies (npm 10 crashes resolving vite/vitest optional peers); `npm ci` with npm 10 is fine.

## Git
- Branches `claude/<topic>`; PR into `main`. CI (lint, typecheck, test, migrations against Postgres 16) must pass.
