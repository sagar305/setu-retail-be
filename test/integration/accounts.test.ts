import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db, harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

describe.skipIf(!TEST_DB)("plans, branches and staff (Postgres)", () => {
  let h: H;
  beforeEach(async () => {
    await resetDb();
    h = harness();
  });

  async function owner() {
    const o = await signUpOwner(h);
    return { ...o, ...(await signIn(h, o.username)) };
  }

  async function invite(as: Awaited<ReturnType<typeof owner>>["as"], body: Record<string, unknown>) {
    return as("post", "/staff").send(body);
  }

  async function acceptInvite(email: string, password = "staff-pass-1") {
    const res = await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink(email)), password });
    expect(res.status).toBe(200);
  }

  it("Basic trial allows one branch; a Gold key allows more, with codes B2, B3…", async () => {
    const o = await owner();
    const blocked = await o.as("post", "/branches").send({ name: "Indiranagar" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: "plan_limit", details: { limit: "branches", max: 1 } });

    const gold = h.key("gold", 365);
    const check = await o.as("post", "/account/license/check").send({ key: gold });
    expect(check.body).toMatchObject({ plan: { code: "gold" }, days: 365, needsChoice: true });

    const noChoice = await o.as("post", "/account/license/redeem").send({ key: gold });
    expect(noChoice.body.error.code).toBe("choice_required");

    const redeem = await o.as("post", "/account/license/redeem").send({ key: gold, choice: "now" });
    expect(redeem.status).toBe(200);
    expect(redeem.body.plan.current).toMatchObject({ code: "gold", source: "KEY" });

    const b2 = await o.as("post", "/branches").send({ name: "Indiranagar", gstin: "29ABCDE1234F1Z5" });
    expect(b2.status).toBe(201);
    expect(b2.body.branch).toMatchObject({ code: "B2", stateCode: "29" });
    const b3 = await o.as("post", "/branches").send({ name: "Jayanagar" });
    expect(b3.body.branch.code).toBe("B3");

    const used = await o.as("post", "/account/license/redeem").send({ key: gold, choice: "now" });
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe("key_used");
  });

  it("rejects forged keys", async () => {
    const o = await owner();
    const r = await o.as("post", "/account/license/check").send({ key: "SETU-R-AAAAAA-BBBBBB-CCCCCC-DDDDDD" });
    expect(r.body.error.code).toBe("invalid_key");
  });

  it("switching Gold → Platinum now converts the remaining Gold days by price", async () => {
    const o = await owner();
    await o.as("post", "/account/license/redeem").send({ key: h.key("gold", 60), choice: "now" });
    const check = await o.as("post", "/account/license/check").send({ key: h.key("platinum", 30) });
    const now = check.body.options.find((x: { choice: string }) => x.choice === "now");
    // 60 Gold days × ₹499 / ₹999 = 29 Platinum days.
    expect(now.convertedDays).toBe(29);
  });

  it("same-plan key extends; owner-only plan screens", async () => {
    const o = await owner();
    const r = await o.as("post", "/account/license/redeem").send({ key: h.key("basic", 30) });
    expect(r.status).toBe(200);
    // The trial (3 months) is followed by 30 more days of Basic.
    expect(r.body.plan.queued).toEqual([expect.objectContaining({ code: "basic" })]);
  });

  it("owner invites a cashier, who sets a password and signs in with their username", async () => {
    const o = await owner();
    const branchId = o.me.branches[0].id;
    const inv = await invite(o.as, { name: "Ravi Kumar", email: "ravi@example.com", username: "ravi.c", role: "CASHIER", branchIds: [branchId] });
    expect(inv.status).toBe(201);
    expect(inv.body.staff.status).toBe("INVITED");
    expect(h.mailer.last("ravi@example.com")?.subject).toMatch(/added you/);

    const info = await request(h.app).get(`/auth/invite/${tokenFrom(h.mailer.lastLink("ravi@example.com"))}`);
    expect(info.body).toMatchObject({ name: "Ravi Kumar", role: "CASHIER" });

    await acceptInvite("ravi@example.com");
    const cashier = await signIn(h, "ravi.c", "staff-pass-1");
    expect(cashier.me.user.role).toBe("CASHIER");
    expect(cashier.me.branches.map((b: { code: string }) => b.code)).toEqual(["B1"]);

    // Cashiers can't manage staff, branches or the plan.
    expect((await cashier.as("get", "/staff")).status).toBe(403);
    expect((await cashier.as("post", "/branches").send({ name: "X" })).status).toBe(403);
    expect((await cashier.as("get", "/account/plan")).status).toBe(403);
  });

  it("a cashier gets exactly one branch; managers can add cashiers only, in their branches", async () => {
    const o = await owner();
    await o.as("post", "/account/license/redeem").send({ key: h.key("gold", 365), choice: "now" });
    const b1 = o.me.branches[0].id;
    const b2 = (await o.as("post", "/branches").send({ name: "Second" })).body.branch.id;

    const two = await invite(o.as, { name: "C", email: "c@example.com", username: "ccc", role: "CASHIER", branchIds: [b1, b2] });
    expect(two.body.error.code).toBe("one_branch");

    await invite(o.as, { name: "Meena", email: "meena@example.com", username: "meena", role: "MANAGER", branchIds: [b1] });
    await acceptInvite("meena@example.com");
    const m = await signIn(h, "meena", "staff-pass-1");

    expect((await invite(m.as, { name: "M2", email: "m2@example.com", username: "mgr2", role: "MANAGER", branchIds: [b1] })).status).toBe(403);
    expect((await invite(m.as, { name: "C2", email: "c2@example.com", username: "cash2", role: "CASHIER", branchIds: [b2] })).body.error.code).toBe("bad_branch");
    expect((await invite(m.as, { name: "C3", email: "c3@example.com", username: "cash3", role: "CASHIER", branchIds: [b1] })).status).toBe(201);

    const list = await m.as("get", "/staff");
    expect(list.body.staff.map((s: { username: string }) => s.username).sort()).toEqual(["cash3", "meena"]);
  });

  it("staff limit: Basic allows 3", async () => {
    const o = await owner();
    const b1 = o.me.branches[0].id;
    for (let i = 1; i <= 3; i++) {
      expect((await invite(o.as, { name: `C${i}`, email: `c${i}@example.com`, username: `cash${i}`, role: "CASHIER", branchIds: [b1] })).status).toBe(201);
    }
    const fourth = await invite(o.as, { name: "C4", email: "c4@example.com", username: "cash4", role: "CASHIER", branchIds: [b1] });
    expect(fourth.body.error).toMatchObject({ code: "plan_limit", details: { limit: "staff", max: 3 } });
  });

  it("removing a staff member's access signs them out at once", async () => {
    const o = await owner();
    const inv = await invite(o.as, { name: "R", email: "r@example.com", username: "rrr", role: "CASHIER", branchIds: [o.me.branches[0].id] });
    await acceptInvite("r@example.com");
    const c = await signIn(h, "rrr", "staff-pass-1");
    expect((await o.as("patch", `/staff/${inv.body.staff.id}`).send({ disabled: true })).status).toBe(200);
    expect((await c.as("get", "/me")).status).toBe(401);
    await expect(signIn(h, "rrr", "staff-pass-1")).rejects.toThrow(/403/);
  });

  it("when the plan ends: staff are locked out, the owner can only renew", async () => {
    const o = await owner();
    await invite(o.as, { name: "R", email: "r@example.com", username: "rrr", role: "CASHIER", branchIds: [o.me.branches[0].id] });
    await acceptInvite("r@example.com");

    h.advanceDays(93); // past the 3-month trial
    await expect(signIn(h, "rrr", "staff-pass-1")).rejects.toThrow(/402/);

    const fresh = await signIn(h, o.username);
    expect(fresh.me.plan.expired).toBe(true);
    expect((await fresh.as("get", "/branches")).status).toBe(402);
    expect((await fresh.as("get", "/account/plan")).status).toBe(200);

    const renew = await fresh.as("post", "/account/license/redeem").send({ key: h.key("basic", 30) });
    expect(renew.body.plan.current.code).toBe("basic");
    expect((await fresh.as("get", "/branches")).status).toBe(200);
    await expect(signIn(h, "rrr", "staff-pass-1")).resolves.toBeTruthy();
  });

  it("after a downgrade the oldest branches and staff stay active and the owner can choose others", async () => {
    const o = await owner();
    await o.as("post", "/account/license/redeem").send({ key: h.key("gold", 30), choice: "now" });
    const b2 = (await o.as("post", "/branches").send({ name: "Second" })).body.branch;
    const b3 = (await o.as("post", "/branches").send({ name: "Third" })).body.branch;
    // Basic starts after Gold ends.
    await o.as("post", "/account/license/redeem").send({ key: h.key("basic", 365), choice: "later" });

    h.advanceDays(31);
    const later = await signIn(h, o.username);
    expect(later.me.account.keepActiveReviewPending).toBe(true);
    const codes = (later.me.branches as { code: string; withinPlan: boolean }[]).map((b) => `${b.code}:${b.withinPlan}`);
    expect(codes).toEqual(["B1:true", "B2:false", "B3:false"]);

    const review = await later.as("get", "/account/keep-active");
    expect(review.body.limits).toEqual({ maxBranches: 1, maxStaff: 3 });

    const tooMany = await later.as("post", "/account/keep-active").send({ branchIds: [b2.id, b3.id], staffIds: [] });
    expect(tooMany.body.error.code).toBe("over_limit");
    expect((await later.as("post", "/account/keep-active").send({ branchIds: [b3.id], staffIds: [] })).status).toBe(200);

    const me = (await later.as("get", "/me")).body;
    expect(me.account.keepActiveReviewPending).toBe(false);
    expect(me.branches.filter((b: { withinPlan: boolean }) => b.withinPlan).map((b: { code: string }) => b.code)).toEqual(["B3"]);
    // Read-only branches can't be edited.
    const edit = await later.as("patch", `/branches/${b2.id}`).send({ name: "Renamed" });
    expect(edit.body.error.code).toBe("branch_read_only");
  });

  it("one account can never touch another's branches or staff", async () => {
    const a = await owner();
    const b = await owner();
    const bBranch = b.me.branches[0].id;
    expect((await a.as("patch", `/branches/${bBranch}`).send({ name: "Mine now" })).status).toBe(404);
    expect((await invite(a.as, { name: "X", email: "x@example.com", username: "xxx", role: "CASHIER", branchIds: [bBranch] })).body.error.code).toBe("bad_branch");
    const bInvite = await invite(b.as, { name: "Y", email: "y@example.com", username: "yyy", role: "CASHIER", branchIds: [bBranch] });
    expect((await a.as("patch", `/staff/${bInvite.body.staff.id}`).send({ disabled: true })).status).toBe(404);
    const aList = await a.as("get", "/staff");
    expect(aList.body.staff.map((s: { username: string }) => s.username)).toEqual([a.username]);
  });

  it("writes an audit trail", async () => {
    const o = await owner();
    await o.as("post", "/account/license/redeem").send({ key: h.key("gold", 30), choice: "now" });
    await o.as("post", "/branches").send({ name: "Second" });
    const actions = (await db().auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["account.created", "trial.started", "license.redeemed", "branch.created"]));
  });
});
