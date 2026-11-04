import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_ORIGIN, db, harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

describe.skipIf(!TEST_DB)("auth (Postgres)", () => {
  let h: H;
  beforeEach(async () => {
    await resetDb();
    h = harness();
  });

  it("signup → verify → trial → login → /me", async () => {
    const signup = await request(h.app).post("/auth/signup").send({
      businessName: "Sharma Stores",
      ownerName: "Anil Sharma",
      email: "Anil@Example.com",
      username: "anil",
      password: "s3cret-pass",
      phone: "+91 98765 43210",
      taxNumber: "29abcde1234f1z5",
    });
    expect(signup.status).toBe(201);
    expect(h.mailer.last("anil@example.com")?.subject).toMatch(/Verify/);

    const early = await request(h.app).post("/auth/login").send({ login: "anil", password: "s3cret-pass" });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe("email_not_verified");

    const verify = await request(h.app).post("/auth/verify-email").send({ token: tokenFrom(h.mailer.lastLink()) });
    expect(verify.status).toBe(200);
    const again = await request(h.app).post("/auth/verify-email").send({ token: tokenFrom(h.mailer.lastLink()) });
    expect(again.body.error.code).toBe("link_invalid");

    const { me, as } = await signIn(h, "ANIL@example.com");
    expect(me.user).toMatchObject({ role: "OWNER", username: "anil", email: "anil@example.com" });
    expect(me.plan.current).toMatchObject({ code: "basic", source: "TRIAL" });
    expect(me.plan.current.endsAt).toBe("2027-02-04T10:00:00.000Z");
    expect(me.branches).toEqual([expect.objectContaining({ code: "B1", gstin: "29ABCDE1234F1Z5", stateCode: "29" })]);

    const meRes = await as("get", "/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.account.name).toBe("Sharma Stores");
  });

  it("refuses a second trial by email, phone or tax number, and taken usernames", async () => {
    await signUpOwner(h, { email: "a@x.com", username: "shopa", phone: "9876500001", taxNumber: "29ABCDE1234F1Z5" });
    const base = { businessName: "B", ownerName: "B", password: "s3cret-pass" };
    const cases: [Record<string, string>, string][] = [
      [{ email: "A@X.com", username: "shopb", phone: "9876500002" }, "email_taken"],
      [{ email: "b@x.com", username: "SHOPA", phone: "9876500002" }, "username_taken"],
      [{ email: "b@x.com", username: "shopb", phone: "+91 98765-00001" }, "phone_used"],
      [{ email: "b@x.com", username: "shopb", phone: "9876500002", taxNumber: "29 abcde1234f1z5" }, "tax_number_used"],
    ];
    for (const [over, code] of cases) {
      const res = await request(h.app).post("/auth/signup").send({ ...base, ...over });
      expect(res.status, code).toBe(409);
      expect(res.body.error.code).toBe(code);
    }
  });

  it("locks sign-in for 15 minutes after 5 wrong passwords", async () => {
    const owner = await signUpOwner(h);
    for (let i = 0; i < 5; i++) {
      const r = await request(h.app).post("/auth/login").send({ login: owner.username, password: "wrong-pass" });
      expect(r.status).toBe(401);
    }
    const locked = await request(h.app).post("/auth/login").send({ login: owner.username, password: owner.password });
    expect(locked.status).toBe(429);
    h.clock.now = new Date(h.clock.now.getTime() + 16 * 60_000);
    await expect(signIn(h, owner.username)).resolves.toBeTruthy();
  });

  it("does not reveal whether a login exists", async () => {
    const r = await request(h.app).post("/auth/login").send({ login: "nobody", password: "whatever-pass" });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("invalid_credentials");
  });

  it("refresh rotates the cookie; replaying the old one revokes the session", async () => {
    const owner = await signUpOwner(h);
    const { agent, cookie: original } = await signIn(h, owner.username);

    const first = await agent.post("/auth/refresh").set("Origin", APP_ORIGIN);
    expect(first.status).toBe(200);
    const rotated = (first.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    expect(rotated).not.toBe(original);

    // Someone replays the cookie from before the rotation.
    const replay = await request(h.app).post("/auth/refresh").set("Cookie", original);
    expect(replay.status).toBe(401);
    // The whole session is now dead, including the legitimate new cookie.
    expect((await request(h.app).post("/auth/refresh").set("Cookie", rotated)).status).toBe(401);
    const session = await db().session.findFirstOrThrow({ where: { user: { username: owner.username } } });
    expect(session.revokedAt).not.toBeNull();
  });

  it("ends the session after one 12-hour shift", async () => {
    const owner = await signUpOwner(h);
    const { agent, as } = await signIn(h, owner.username);
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 3600_000);
    expect((await agent.post("/auth/refresh")).status).toBe(200);
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 3600_000);
    const late = await agent.post("/auth/refresh");
    expect(late.status).toBe(401);
    expect(late.body.error.code).toBe("session_ended");
    expect((await as("get", "/me")).status).toBe(401);
  });

  it("rejects refresh from a foreign origin", async () => {
    const owner = await signUpOwner(h);
    const { agent } = await signIn(h, owner.username);
    const r = await agent.post("/auth/refresh").set("Origin", "https://evil.example");
    expect(r.status).toBe(403);
  });

  it("logout ends the session", async () => {
    const owner = await signUpOwner(h);
    const { agent, as } = await signIn(h, owner.username);
    expect((await agent.post("/auth/logout")).status).toBe(204);
    expect((await as("get", "/me")).status).toBe(401);
    expect((await agent.post("/auth/refresh")).status).toBe(401);
  });

  it("password reset sets a new password and signs out every device", async () => {
    const owner = await signUpOwner(h);
    const { as } = await signIn(h, owner.username);
    expect((await request(h.app).post("/auth/forgot-password").send({ email: owner.email })).status).toBe(202);
    expect((await request(h.app).post("/auth/forgot-password").send({ email: "nobody@example.com" })).status).toBe(202);

    const reset = await request(h.app).post("/auth/reset-password").send({ token: tokenFrom(h.mailer.lastLink(owner.email)), password: "brand-new-pass" });
    expect(reset.status).toBe(200);
    expect((await as("get", "/me")).status).toBe(401);
    await expect(signIn(h, owner.username)).rejects.toThrow();
    await expect(signIn(h, owner.username, "brand-new-pass")).resolves.toBeTruthy();
  });

  it("resend-verification sends a fresh link and the old one stops working", async () => {
    await request(h.app).post("/auth/signup").send({ businessName: "S", ownerName: "O", email: "late@example.com", username: "late", password: "s3cret-pass", phone: "9000000001" });
    const oldToken = tokenFrom(h.mailer.lastLink("late@example.com"));
    await request(h.app).post("/auth/resend-verification").send({ email: "late@example.com" });
    const newToken = tokenFrom(h.mailer.lastLink("late@example.com"));
    expect(newToken).not.toBe(oldToken);
    expect((await request(h.app).post("/auth/verify-email").send({ token: oldToken })).status).toBe(400);
    expect((await request(h.app).post("/auth/verify-email").send({ token: newToken })).status).toBe(200);
  });
});
