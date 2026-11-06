import request from "supertest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryMailer } from "../../src/mail/mailer.js";
import { APP_ORIGIN, db, harness, resetDb, signIn, signUpOwner, TEST_DB, type H } from "./harness.js";

describe.skipIf(!TEST_DB)("hardening (Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rate-limits sign-in per login and answers 429 with Retry-After", async () => {
    const h = harness(undefined, { rateLimits: true });
    const o = await signUpOwner(h);
    // 20 tries per login per 15 minutes (the per-login lockout also kicks in after 5 wrong passwords).
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await request(h.app).post("/auth/login").send({ login: o.username, password: "wrong-pass-1" })).status;
    expect(last).toBe(429);
    const r = await request(h.app).post("/auth/login").send({ login: o.username, password: "s3cret-pass" });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("rate_limited");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(800);
    // Another login from the same IP is still fine.
    const other = await signUpOwner(h);
    expect((await request(h.app).post("/auth/login").send({ login: other.username, password: "s3cret-pass" })).status).toBe(200);
    // The window resets.
    h.clock.now = new Date(h.clock.now.getTime() + 16 * 60_000);
    expect((await request(h.app).post("/auth/login").send({ login: o.username, password: "s3cret-pass" })).status).toBe(200);
    // Keys are hashes, not emails.
    const keys = await db().rateLimit.findMany();
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k.key))).toBe(true);
  });

  it("limits reset-password emails to 5 an hour per address", async () => {
    const h = harness(undefined, { rateLimits: true });
    const o = await signUpOwner(h);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await request(h.app).post("/auth/forgot-password").send({ email: o.email })).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it("a Contact-sales key starts after a paid plan, and now on a trial", async () => {
    const h = harness();
    const paid = await signUpOwner(h);
    const trial = await signUpOwner(h);
    const issue = async (accountEmail: string) => {
      const account = await db().account.findFirstOrThrow({ where: { users: { some: { email: accountEmail } } } });
      const { issueLicenseKey, readLicenseKey } = await import("../../src/lib/licenseKey.js");
      const key = issueLicenseKey(`custom-${account.id}`, "custom", 365, h.env.RETAIL_LICENSE_SECRET);
      const { keyId } = readLicenseKey(key, h.env.RETAIL_LICENSE_SECRET)!;
      const plan = await db().plan.create({ data: { code: `custom-${keyId}`, name: "Custom", isPublic: false, maxBranches: 200, maxStaff: null, maxProducts: null, maxCustomers: null, maxOrdersPerMonth: null } });
      await db().issuedKey.create({ data: { keyId, accountId: account.id, planId: plan.id, days: 365, issuedById: account.id } });
      return key;
    };

    const p = await signIn(h, paid.username);
    await p.as("post", "/account/license/redeem").send({ key: h.key("gold", 365), choice: "now" });
    const goldEnds = (await p.as("get", "/me")).body.plan.current.endsAt as string;
    const customForPaid = await issue(paid.email);
    const check = await p.as("post", "/account/license/check").send({ key: customForPaid });
    expect(check.body).toMatchObject({ needsChoice: false, options: [{ startsAt: goldEnds }] });
    // Even asking for "now" keeps the Gold days.
    const redeem = await p.as("post", "/account/license/redeem").send({ key: customForPaid, choice: "now" });
    expect(redeem.status).toBe(200);
    expect(redeem.body.plan.current).toMatchObject({ code: "gold", endsAt: goldEnds });
    expect(redeem.body.plan.queued[0]).toMatchObject({ startsAt: goldEnds });

    const t = await signIn(h, trial.username);
    const customForTrial = await issue(trial.email);
    const r = await t.as("post", "/account/license/redeem").send({ key: customForTrial });
    expect(r.status).toBe(200);
    expect(r.body.plan.current.code).toMatch(/^custom-/);
  });

  it("puts the sign-in cookies under COOKIE_PATH_PREFIX", async () => {
    const env = loadEnv({ NODE_ENV: "test", CORS_ORIGINS: APP_ORIGIN, APP_URL: APP_ORIGIN, RATE_LIMITS: "off", COOKIE_PATH_PREFIX: "/api" });
    const mailer = new MemoryMailer();
    const app = createApp({ env, prisma: db(), mailer, now: () => new Date("2026-11-04T10:00:00Z") });
    const h = { ...harness(), app, mailer } as H;
    const o = await signUpOwner(h);
    const login = await request(app).post("/auth/login").send({ login: o.username, password: "s3cret-pass" });
    expect((login.headers["set-cookie"] as unknown as string[])[0]).toContain("Path=/api/auth");
    expect(() => loadEnv({ NODE_ENV: "test", COOKIE_PATH_PREFIX: "api/" })).toThrow(/COOKIE_PATH_PREFIX/);
  });
});
