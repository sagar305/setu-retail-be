import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { dumpDatabase, parseDump, STATE_TABLE } from "../../src/services/demoReset.js";
import { MemoryMailer } from "../../src/mail/mailer.js";
import { APP_ORIGIN, db, harness, resetDb, signIn, signUpOwner, TEST_DB } from "./harness.js";

describe.skipIf(!TEST_DB)("demo reset (Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    await db().$executeRawUnsafe(`DROP TABLE IF EXISTS "${STATE_TABLE}"`);
  });

  async function dbName() {
    const [row] = await db().$queryRawUnsafe<{ name: string }[]>(`SELECT current_database() AS name`);
    return row!.name;
  }

  function demoApp(text: string, clock: { now: Date }, expectDb: string) {
    const env = loadEnv({ NODE_ENV: "test", CORS_ORIGINS: APP_ORIGIN, APP_URL: APP_ORIGIN, RATE_LIMITS: "off", DEMO_RESET_ENABLED: "1", DEMO_RESET_EXPECT_DB: expectDb, DEMO_RESET_INTERVAL_HOURS: "2" });
    return createApp({ env, prisma: db(), mailer: new MemoryMailer(), now: () => clock.now, loadDemoDump: () => parseDump(text) });
  }

  it("restores the snapshot dated to now, once per reset time, and signs everyone out", async () => {
    const h = harness("2026-11-04T10:00:00Z");
    const owner = await signUpOwner(h);
    const o = await signIn(h, owner.username);
    const kept = await o.as("post", "/products").send({ name: "Kept", price: 1000 });
    expect(kept.status).toBe(201);
    const before = (await db().product.findUniqueOrThrow({ where: { id: kept.body.product.id } })).createdAt.getTime();
    const text = await dumpDatabase(db(), h.clock.now);
    expect(text).not.toContain('"sessions"');

    await o.as("post", "/products").send({ name: "Visitor's junk", price: 500 });

    const clock = { now: new Date("2026-11-07T05:30:00Z") };
    const app = demoApp(text, clock, await dbName());
    const status = await request(app).get("/demo/reset");
    expect(status.body).toMatchObject({ enabled: true, intervalHours: 2, nextResetAt: "2026-11-07T06:00:00.000Z", secondsUntilReset: 1800, resetting: false });

    const products = await db().product.findMany();
    expect(products.map((p) => p.name)).toEqual(["Kept"]);
    // Moved forward by exactly the time since the snapshot (2 days 19.5 hours).
    expect(products[0]!.createdAt.getTime() - before).toBe(clock.now.getTime() - h.clock.now.getTime());
    expect(await db().session.count()).toBe(0);

    // The demo login still works after a reset.
    const login = await request(app).post("/auth/login").set("origin", APP_ORIGIN).send({ login: owner.username, password: "s3cret-pass" });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;

    // Same reset window: changes stay.
    clock.now = new Date("2026-11-07T05:40:00Z");
    const added = await request(app).post("/products").set("authorization", `Bearer ${token}`).send({ name: "Added after reset", price: 700 });
    expect(added.status).toBe(201);
    await request(app).get("/demo/reset");
    expect(await db().product.count()).toBe(2);

    // Next reset time: gone again.
    clock.now = new Date("2026-11-07T06:00:01Z");
    await request(app).get("/demo/reset");
    expect((await db().product.findMany()).map((p) => p.name)).toEqual(["Kept"]);
  });

  it("never locks a demo login, however many wrong passwords are typed", async () => {
    const h = harness();
    const owner = await signUpOwner(h);
    const app = demoApp(await dumpDatabase(db(), h.clock.now), { now: h.clock.now }, await dbName());
    for (let i = 0; i < 7; i++) {
      const wrong = await request(app).post("/auth/login").set("origin", APP_ORIGIN).send({ login: owner.username, password: "not-the-password" });
      expect(wrong.status).toBe(401);
    }
    const right = await request(app).post("/auth/login").set("origin", APP_ORIGIN).send({ login: owner.username, password: "s3cret-pass" });
    expect(right.status).toBe(200);
  });

  it("never wipes a database with another name", async () => {
    const h = harness();
    const owner = await signUpOwner(h);
    const text = await dumpDatabase(db(), h.clock.now);
    const o = await signIn(h, owner.username);
    await o.as("post", "/products").send({ name: "Real shop's product", price: 500 });

    const app = demoApp(text, { now: new Date("2026-11-07T05:30:00Z") }, "some_other_db");
    const res = await request(app).get("/demo/reset");
    expect(res.status).toBe(200);
    expect(await db().product.count()).toBe(1);
  });
});
