import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { base32Decode, totpCode, totpStep } from "../../src/lib/totp.js";
import { hashToken } from "../../src/lib/tokens.js";
import { APP_ORIGIN, CRON, db, harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

const ADMIN_PASS = "admin-pass-123";

describe.skipIf(!TEST_DB)("super-admin (Postgres)", () => {
  let h: H;
  beforeEach(async () => {
    await resetDb();
    h = harness();
  });

  const code = (secret: string, offset = 0) => totpCode(base32Decode(secret), totpStep(h.clock.now) + offset);

  /** Invite → set password → first sign-in links the authenticator app. */
  async function newAdmin(email = "ops@setutechnology.com", name = "Ops") {
    const admin = await db().superAdmin.create({ data: { email, name, status: "INVITED" } });
    const token = `invite-${email}`;
    await db().adminToken.create({ data: { adminId: admin.id, tokenHash: hashToken(token), expiresAt: new Date(h.clock.now.getTime() + 3600_000) } });
    expect((await request(h.app).get(`/admin/auth/invite/${token}`)).body).toEqual({ email, name });
    expect((await request(h.app).post("/admin/auth/accept").send({ token, password: ADMIN_PASS })).status).toBe(200);
    const agent = request.agent(h.app);
    const step1 = await agent.post("/admin/auth/login").send({ email, password: ADMIN_PASS });
    expect(step1.body).toMatchObject({ step: "setup" });
    expect(step1.body.otpauthUrl).toContain(encodeURIComponent(email));
    const secret = step1.body.secret as string;
    const wrong = await agent.post("/admin/auth/setup-2fa").send({ token: step1.body.token, code: "000000" });
    expect(wrong.body.error.code).toBe("invalid_code");
    const done = await agent.post("/admin/auth/setup-2fa").send({ token: step1.body.token, code: code(secret) });
    expect(done.status).toBe(200);
    // The test clock is in the past, so the agent's cookie jar would drop the cookie: send it by hand.
    const cookie = (done.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    expect(done.body.admin).toMatchObject({ email, twoFactor: true, status: "ACTIVE" });
    const me = { id: admin.id, email, secret, agent, cookie, accessToken: done.body.accessToken as string, as: (method: "get" | "post", path: string) => agent[method](path).set("Authorization", `Bearer ${me.accessToken}`), relogin: async () => {} };
    /** After moving the clock: sign in again with a fresh code. */
    me.relogin = async () => {
      const l = await request(h.app).post("/admin/auth/login").send({ email, password: ADMIN_PASS });
      const v = await request(h.app).post("/admin/auth/verify").send({ token: l.body.token, code: code(secret) });
      expect(v.status).toBe(200);
      me.accessToken = v.body.accessToken;
    };
    return me;
  }

  async function owner(over: Partial<Record<string, string>> = {}) {
    const o = await signUpOwner(h, over);
    const account = await db().account.findFirstOrThrow({ where: { users: { some: { email: o.email } } } });
    return { ...o, accountId: account.id };
  }

  it("signs in with password then authenticator code; codes work once; tokens don't cross over", async () => {
    const a = await newAdmin();
    expect((await a.as("get", "/admin/me")).body.admin.email).toBe(a.email);

    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const login = await request(h.app).post("/admin/auth/login").send({ email: a.email, password: ADMIN_PASS });
    expect(login.body.step).toBe("code");
    const c = code(a.secret);
    expect((await request(h.app).post("/admin/auth/verify").send({ token: login.body.token, code: c })).status).toBe(200);
    const again = await request(h.app).post("/admin/auth/login").send({ email: a.email, password: ADMIN_PASS });
    const replay = await request(h.app).post("/admin/auth/verify").send({ token: again.body.token, code: c });
    expect(replay.body.error.code).toBe("invalid_code");

    // A shop owner's token is not an admin token, and the other way round.
    const o = await owner();
    const shop = await signIn(h, o.username);
    expect((await request(h.app).get("/admin/dashboard").set("Authorization", `Bearer ${shop.token}`)).status).toBe(401);
    expect((await request(h.app).get("/me").set("Authorization", `Bearer ${a.accessToken}`)).status).toBe(401);
    expect((await request(h.app).get("/admin/dashboard")).status).toBe(401);

    // The mfa step token can't be used as an access token.
    expect((await request(h.app).get("/admin/me").set("Authorization", `Bearer ${again.body.token}`)).status).toBe(401);
  });

  it("locks after 5 wrong attempts; refresh rotates; logout ends the session", async () => {
    const a = await newAdmin();
    const refreshed = await request(h.app).post("/admin/auth/refresh").set("Origin", APP_ORIGIN).set("Cookie", a.cookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.admin.email).toBe(a.email);
    const rotated = (refreshed.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    expect(rotated).not.toBe(a.cookie);
    expect((await request(h.app).post("/admin/auth/refresh").set("Origin", "https://evil.example").set("Cookie", rotated)).status).toBe(403);
    // Replaying the old cookie ends the session.
    expect((await request(h.app).post("/admin/auth/refresh").set("Origin", APP_ORIGIN).set("Cookie", a.cookie)).status).toBe(401);
    expect((await request(h.app).post("/admin/auth/refresh").set("Origin", APP_ORIGIN).set("Cookie", rotated)).status).toBe(401);
    const b = await newAdmin("b2@setutechnology.com", "B2");
    expect((await request(h.app).post("/admin/auth/logout").set("Origin", APP_ORIGIN).set("Cookie", b.cookie)).status).toBe(204);
    expect((await request(h.app).post("/admin/auth/refresh").set("Origin", APP_ORIGIN).set("Cookie", b.cookie)).status).toBe(401);
    expect((await request(h.app).get("/admin/me").set("Authorization", `Bearer ${refreshed.body.accessToken}`)).status).toBe(401);

    for (let i = 0; i < 5; i++) await request(h.app).post("/admin/auth/login").send({ email: a.email, password: "wrong-password" });
    const locked = await request(h.app).post("/admin/auth/login").send({ email: a.email, password: ADMIN_PASS });
    expect(locked.status).toBe(429);
    const failures = await db().adminAuditLog.count({ where: { action: "admin.sign_in_failed", adminId: a.id, data: { path: ["what"], equals: "password" } } });
    expect(failures).toBe(5);
  });

  it("dashboard and account list show plan, status and counts only", async () => {
    const a = await newAdmin();
    const trial = await owner({ businessName: "Sharma Kirana" });
    const paid = await owner({ businessName: "Gupta Medical" });
    const shop = await signIn(h, paid.username);
    await shop.as("post", "/account/license/redeem").send({ key: h.key("gold", 365), choice: "now" });
    await request(h.app).post("/auth/signup").send({ businessName: "Never Verified", ownerName: "N", email: "nv@example.com", username: "neververified", password: "s3cret-pass", phone: "9000000001" });

    const dash = await a.as("get", "/admin/dashboard");
    expect(dash.body).toMatchObject({ accounts: 3, trial: 1, unverified: 1, expired: 0, locked: 0, signupsThisMonth: 3, paidByPlan: [{ code: "gold", accounts: 1 }] });

    const list = await a.as("get", "/admin/accounts");
    expect(list.body.total).toBe(3);
    const byName = Object.fromEntries(list.body.accounts.map((r: { name: string; status: string }) => [r.name, r]));
    expect(byName["Sharma Kirana"]).toMatchObject({ status: "trial", planCode: "basic", daysLeft: 92, branches: 1 });
    expect(byName["Gupta Medical"]).toMatchObject({ status: "paid", planCode: "gold" });
    expect(byName["Never Verified"]).toMatchObject({ status: "unverified", planCode: null, endsAt: null });

    expect((await a.as("get", "/admin/accounts?q=sharma")).body.accounts.map((r: { id: string }) => r.id)).toEqual([trial.accountId]);
    expect((await a.as("get", `/admin/accounts?q=${encodeURIComponent(paid.email)}`)).body.total).toBe(1);
    expect((await a.as("get", "/admin/accounts?status=unverified")).body.total).toBe(1);

    const detail = await a.as("get", `/admin/accounts/${paid.accountId}`);
    expect(detail.body.plan).toMatchObject({ code: "gold", source: "KEY", limits: { maxBranches: 10 } });
    expect(detail.body.usage).toEqual({ branches: 1, staff: 0, products: 0, customers: 0, ordersThisMonth: 0 });
    expect(detail.body.redemptions).toHaveLength(1);
    expect(Object.keys(detail.body).sort()).toEqual(["account", "activity", "issuedKeys", "plan", "redemptions", "reminders", "timeline", "usage"]);
    expect((await a.as("get", "/admin/accounts/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  it("lock stops everyone with a generic message; unlock lets them back", async () => {
    const a = await newAdmin();
    const o = await owner();
    const shop = await signIn(h, o.username);
    expect((await a.as("post", `/admin/accounts/${o.accountId}/lock`).send({ reason: "" })).status).toBe(400);
    expect((await a.as("post", `/admin/accounts/${o.accountId}/lock`).send({ reason: "Chargeback on payment" })).status).toBe(200);

    const blocked = await shop.as("get", "/me");
    expect(blocked.body.error).toEqual({ code: "account_locked", message: "This account is locked. Contact Setu support." });
    expect((await request(h.app).post("/auth/login").send({ login: o.username, password: "s3cret-pass" })).body.error.code).toBe("account_locked");

    const detail = await a.as("get", `/admin/accounts/${o.accountId}`);
    expect(detail.body.account).toMatchObject({ status: "locked", lockReason: "Chargeback on payment" });
    const shopAudit = await db().auditLog.findFirst({ where: { accountId: o.accountId, action: "account.locked_by_setu" } });
    expect(shopAudit?.data ?? null).toBeNull(); // the reason stays with the Setu team

    expect((await a.as("post", `/admin/accounts/${o.accountId}/unlock`).send({})).status).toBe(200);
    expect((await request(h.app).post("/auth/login").send({ login: o.username, password: "s3cret-pass" })).status).toBe(200);
  });

  it("adds free days after the timeline, and brings an ended account back", async () => {
    const a = await newAdmin();
    const o = await owner();
    const before = (await a.as("get", `/admin/accounts/${o.accountId}`)).body.account.endsAt as string;
    const add = await a.as("post", `/admin/accounts/${o.accountId}/add-days`).send({ days: 30, reason: "Setup took long" });
    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({ planCode: "basic", startsAt: before });
    expect(new Date(add.body.endsAt).getTime() - new Date(before).getTime()).toBe(30 * 86_400_000);

    h.advanceDays(200);
    await a.relogin();
    expect((await a.as("get", `/admin/accounts/${o.accountId}`)).body.account.status).toBe("expired");
    const back = await a.as("post", `/admin/accounts/${o.accountId}/add-days`).send({ days: 10, reason: "Goodwill" });
    expect(back.body.startsAt).toBe(h.clock.now.toISOString());
    const shop = await signIn(h, o.username);
    expect(shop.me.plan).toMatchObject({ expired: false, daysLeft: 10, current: { source: "GRANT", code: "basic" } });
    const log = await db().auditLog.findMany({ where: { accountId: o.accountId, action: "license.days_added" } });
    expect(log).toHaveLength(2);
  });

  it("Contact-sales key: >100 branches, emailed to the owner, redeemable only on its account, revocable until used", async () => {
    const a = await newAdmin();
    const big = await owner({ businessName: "Chain Mart" });
    const other = await owner();
    const limits = { maxStaff: 1000, maxProducts: null, maxCustomers: null, maxOrdersPerMonth: null };
    expect((await a.as("post", "/admin/keys").send({ accountId: big.accountId, days: 365, maxBranches: 100, ...limits })).status).toBe(400);

    const issued = await a.as("post", "/admin/keys").send({ accountId: big.accountId, days: 365, maxBranches: 250, ...limits, note: "PO 4471" });
    expect(issued.status).toBe(201);
    expect(issued.body.key).toMatch(/^SETU-R-/);
    expect(issued.body.emailedTo).toBe(big.email);
    const mail = h.mailer.last(big.email)!;
    expect(mail.text).toContain(issued.body.key);
    expect(mail.text).toContain("250 branches");
    expect(issued.body.redeemUrl).toContain(`/settings/plan#key=${encodeURIComponent(issued.body.key)}`);

    const otherShop = await signIn(h, other.username);
    expect((await otherShop.as("post", "/account/license/check").send({ key: issued.body.key })).body.error.code).toBe("key_other_account");

    const shop = await signIn(h, big.username);
    const redeem = await shop.as("post", "/account/license/redeem").send({ key: issued.body.key, choice: "now" });
    expect(redeem.status).toBe(200);
    expect(redeem.body.plan.current).toMatchObject({ source: "KEY", limits: { maxBranches: 250, maxStaff: 1000, maxProducts: null } });
    expect((await a.as("post", `/admin/keys/${issued.body.id}/revoke`)).body.error.code).toBe("key_used");

    const second = await a.as("post", "/admin/keys").send({ accountId: big.accountId, days: 30, maxBranches: 300, ...limits });
    expect((await a.as("post", `/admin/keys/${second.body.id}/revoke`)).status).toBe(200);
    expect((await shop.as("post", "/account/license/check").send({ key: second.body.key })).body.error.code).toBe("invalid_key");

    const keys = await a.as("get", "/admin/keys");
    expect(keys.body.keys.map((k: { redeemedAt: string | null; revokedAt: string | null }) => [Boolean(k.redeemedAt), Boolean(k.revokedAt)])).toEqual([
      [false, true],
      [true, false],
    ]);
    const dash = await a.as("get", "/admin/dashboard");
    expect(dash.body.paidByPlan).toEqual([{ code: "custom", name: "Custom (Contact sales)", accounts: 1 }]);
    const redemptions = await a.as("get", "/admin/redemptions");
    expect(redemptions.body.redemptions[0]).toMatchObject({ accountName: "Chain Mart", custom: true });
    const activity = await a.as("get", `/admin/activity?accountId=${big.accountId}`);
    expect(activity.body.entries.map((e: { action: string }) => e.action)).toEqual(["key.revoked", "key.issued", "key.issued"]);
  });

  it("automatic reminders at 14, 7 and 1 days, each once; by hand for one or many", async () => {
    const a = await newAdmin();
    const o = await owner();
    const cron = () => request(h.app).get("/internal/cron/reminders").set("Authorization", `Bearer ${CRON}`);
    expect((await request(h.app).get("/internal/cron/reminders")).status).toBe(401);
    expect((await cron()).body).toEqual({ sent: 0, checked: 0 });

    const endsAt = new Date((await a.as("get", `/admin/accounts/${o.accountId}`)).body.account.endsAt);
    const at = (daysLeft: number) => {
      h.clock.now = new Date(endsAt.getTime() - daysLeft * 86_400_000);
    };
    const sentTo = () => h.mailer.sent.filter((m) => m.to === o.email && /plan ends/.test(m.subject)).map((m) => m.subject);

    at(13.5);
    expect((await cron()).body.sent).toBe(1);
    expect((await cron()).body.sent).toBe(0);
    at(10);
    expect((await cron()).body.sent).toBe(0);
    at(6.2);
    expect((await cron()).body.sent).toBe(1);
    at(0.5);
    expect((await cron()).body.sent).toBe(1);
    expect((await cron()).body.sent).toBe(0);
    expect(sentTo()).toEqual(["Your Setu Retail plan ends in 14 days", "Your Setu Retail plan ends in 7 days", "Your Setu Retail plan ends tomorrow"]);
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    await a.relogin();
    expect((await a.as("post", `/admin/accounts/${o.accountId}/remind`)).body).toEqual({ sent: true });
    const bulk = await a.as("post", "/admin/reminders").send({ withinDays: 30 });
    expect(bulk.body).toEqual({ sent: 0, skipped: 1 }); // reminded in the last 24 hours
    const detail = await a.as("get", `/admin/accounts/${o.accountId}`);
    expect(detail.body.reminders.map((r: { step: number }) => r.step)).toEqual([0, 1, 7, 14]);

    // A new key pushes the end date out: no more reminders until the new end nears.
    const shop = await signIn(h, o.username);
    await shop.as("post", "/account/license/redeem").send({ key: h.key("basic", 365) });
    expect((await cron()).body.sent).toBe(0);
  });

  it("emails the owner a verification or reset link on request", async () => {
    const a = await newAdmin();
    await request(h.app).post("/auth/signup").send({ businessName: "Late Shop", ownerName: "L", email: "late@example.com", username: "lateshop", password: "s3cret-pass", phone: "9000000002" });
    const acc = await db().account.findFirstOrThrow({ where: { name: "Late Shop" } });
    const n = h.mailer.sent.length;
    expect((await a.as("post", `/admin/accounts/${acc.id}/send-reset`)).status).toBe(200);
    expect((await a.as("post", `/admin/accounts/${acc.id}/resend-verification`)).body).toEqual({ sent: true, to: "late@example.com" });
    expect(h.mailer.sent.length).toBe(n + 2);
    const verify = await request(h.app).post("/auth/verify-email").send({ token: tokenFrom(h.mailer.lastLink("late@example.com")) });
    expect(verify.status).toBe(200);
    expect((await a.as("post", `/admin/accounts/${acc.id}/resend-verification`)).body.error.code).toBe("already_verified");
    expect((await a.as("post", `/admin/accounts/${acc.id}/remind`)).body).toEqual({ sent: true });
  });

  it("manages the team: invite, reset, turn off; not yourself", async () => {
    const a = await newAdmin();
    const invite = await a.as("post", "/admin/admins").send({ email: "Priya@SetuTechnology.com", name: "Priya" });
    expect(invite.status).toBe(201);
    expect(invite.body.admin).toMatchObject({ email: "priya@setutechnology.com", status: "INVITED", twoFactor: false });
    const link = h.mailer.lastLink("priya@setutechnology.com")!;
    expect(link).toContain("/super-admin/accept?token=");
    expect((await a.as("post", "/admin/admins").send({ email: "priya@setutechnology.com", name: "P" })).status).toBe(409);
    expect((await request(h.app).post("/admin/auth/accept").send({ token: tokenFrom(link), password: "priya-pass-1" })).status).toBe(200);

    expect((await a.as("post", `/admin/admins/${a.id}/disable`)).body.error.code).toBe("not_yourself");
    const b = await newAdmin("b@setutechnology.com", "B");
    expect((await b.as("get", "/admin/me")).status).toBe(200);
    expect((await a.as("post", `/admin/admins/${b.id}/disable`)).body.admin.status).toBe("DISABLED");
    expect((await b.as("get", "/admin/me")).status).toBe(401);
    expect((await request(h.app).post("/admin/auth/login").send({ email: b.email, password: ADMIN_PASS })).status).toBe(401);

    const reset = await a.as("post", `/admin/admins/${invite.body.admin.id}/reset`);
    expect(reset.body.admin).toMatchObject({ status: "INVITED", twoFactor: false });
    const list = await a.as("get", "/admin/admins");
    expect(list.body.admins.map((x: { email: string }) => x.email)).toEqual(["ops@setutechnology.com", "priya@setutechnology.com", "b@setutechnology.com"]);
    const actions = (await a.as("get", "/admin/activity")).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.invited", "admin.disabled", "admin.reset", "admin.signed_in", "admin.two_factor_set_up"]));
  });
});
