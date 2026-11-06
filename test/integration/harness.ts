// Real-Postgres harness. Runs only when TEST_DATABASE_URL is set (CI sets it).
import { execSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { PUBLIC_PLANS } from "../../src/config/plans.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { issueLicenseKey, type LicensePlan } from "../../src/lib/licenseKey.js";
import { MemoryMailer } from "../../src/mail/mailer.js";

export const TEST_DB = process.env["TEST_DATABASE_URL"];
export const APP_ORIGIN = "http://localhost:5173";
export const CRON = "test-cron-secret-0123456789";

let prisma: PrismaClient | undefined;
let migrated = false;

export function db(): PrismaClient {
  if (!TEST_DB) throw new Error("TEST_DATABASE_URL not set");
  if (!migrated) {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_DB }, stdio: "pipe" });
    migrated = true;
  }
  prisma ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DB }) });
  return prisma;
}

export async function resetDb() {
  const p = db();
  await p.$executeRawUnsafe("TRUNCATE accounts, trial_claims, plans, inventory_logs, held_carts, expenses, customer_ledger_entries, cash_entries, cash_openings, supplier_ledger_entries, stock_transfers, super_admins, admin_audit_logs, rate_limits, idempotency_keys, conflicts CASCADE");
  for (const plan of PUBLIC_PLANS) await p.plan.create({ data: { ...plan, isPublic: true } });
}

export function harness(start = "2026-11-04T10:00:00Z", opts: { rateLimits?: boolean } = {}) {
  const clock = { now: new Date(start) };
  const mailer = new MemoryMailer();
  const env = loadEnv({ NODE_ENV: "test", CORS_ORIGINS: APP_ORIGIN, APP_URL: APP_ORIGIN, CRON_SECRET: CRON, RATE_LIMITS: opts.rateLimits ? "on" : "off" });
  const app = createApp({ env, prisma: db(), mailer, now: () => clock.now });
  const advanceDays = (days: number) => {
    clock.now = new Date(clock.now.getTime() + days * 86_400_000);
  };
  let orderSeq = 0;
  const key = (plan: LicensePlan, days: number) => issueLicenseKey(`order-${Date.now()}-${orderSeq++}`, plan, days, env.RETAIL_LICENSE_SECRET);
  return { app, mailer, clock, advanceDays, key, env };
}

export type H = ReturnType<typeof harness>;

export const tokenFrom = (link: string | undefined) => new URL(link!).searchParams.get("token")!;

let n = 0;
/** Sign up an owner and verify their email. Returns credentials. */
export async function signUpOwner(h: H, over: Partial<Record<string, string>> = {}) {
  n += 1;
  const body = {
    businessName: `Shop ${n}`,
    ownerName: `Owner ${n}`,
    email: `owner${n}@example.com`,
    username: `owner${n}`,
    password: "s3cret-pass",
    phone: `98765${String(n).padStart(5, "0")}`,
    ...over,
  };
  const res = await request(h.app).post("/auth/signup").send(body);
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const verify = await request(h.app).post("/auth/verify-email").send({ token: tokenFrom(h.mailer.lastLink(body.email)) });
  if (verify.status !== 200) throw new Error(`verify failed: ${verify.status}`);
  return body;
}

/** Signs in with an agent that keeps the refresh cookie. */
export async function signIn(h: H, login: string, password = "s3cret-pass") {
  const agent = request.agent(h.app);
  const res = await agent.post("/auth/login").send({ login, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.accessToken as string;
  const as = (method: "get" | "post" | "patch" | "put" | "delete", path: string) => agent[method](path).set("Authorization", `Bearer ${token}`);
  const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  return { agent, token, me: res.body.me, as, cookie };
}
