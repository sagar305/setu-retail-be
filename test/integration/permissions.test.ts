// Permission sweep: every route in /openapi.json, so a new route can't ship
// without its gate (docs/PLAN.md, Phase 8).
import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../../src/openapi.js";
import { harness, resetDb, signIn, signUpOwner, TEST_DB, tokenFrom, type H } from "./harness.js";

type Method = "get" | "post" | "patch" | "put" | "delete";
const doc = buildOpenApiDocument("test") as { paths: Record<string, Partial<Record<Method, { security?: unknown[] }>>> };
const fill = (path: string) => path.replace(/\{[^}]+\}/g, randomUUID());
const ALL = Object.entries(doc.paths).flatMap(([path, ops]) => (Object.keys(ops) as Method[]).map((m) => ({ method: m, path, secure: (ops[m]!.security ?? [1]).length > 0 })));

// Signed in by a different credential (device key, cron secret) or public on purpose.
const NOT_BEARER = new Set(["get /health", "get /health/db", "get /internal/cron/reminders", "get /sync/pack", "post /sync/orders", "post /sync/customers", "post /sync/money"]);

describe.skipIf(!TEST_DB)("permissions (Postgres)", () => {
  let h: H;
  let owner: Awaited<ReturnType<typeof signIn>>;
  let manager: Awaited<ReturnType<typeof signIn>>;
  let cashier: Awaited<ReturnType<typeof signIn>>;
  let other: Awaited<ReturnType<typeof signIn>>;
  let branchId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    h = harness();
    owner = await signIn(h, (await signUpOwner(h)).username);
    other = await signIn(h, (await signUpOwner(h)).username);
    branchId = owner.me.branches[0].id;
    const staff = async (role: "MANAGER" | "CASHIER", username: string) => {
      await owner.as("post", "/staff").send({ name: username, email: `${username}@example.com`, username, role, branchIds: [branchId] });
      await request(h.app).post("/auth/accept-invite").send({ token: tokenFrom(h.mailer.lastLink(`${username}@example.com`)), password: "staff-pass-1" });
      return signIn(h, username, "staff-pass-1");
    };
    manager = await staff("MANAGER", "permmanager");
    cashier = await staff("CASHIER", "permcashier");
    ids.product = (await owner.as("post", "/products").send({ name: "Tea", price: 10000, gstRateBp: 500 })).body.product.id;
    ids.customer = (await owner.as("post", "/customers").send({ name: "Meera", phone: "9000011111" })).body.customer.id;
    ids.supplier = (await owner.as("post", "/suppliers").send({ name: "Bharat Traders" })).body.supplier.id;
  }, 60_000);

  it("every bearer route answers 401 without a token", async () => {
    const leaks: string[] = [];
    for (const r of ALL) {
      const key = `${r.method} ${r.path}`;
      if (!r.secure || NOT_BEARER.has(key) || r.path.startsWith("/admin/auth/")) continue;
      const res = await request(h.app)[r.method](fill(r.path)).send({});
      if (res.status !== 401) leaks.push(`${key} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
    expect(ALL.length).toBeGreaterThan(100);
  });

  it("a shop owner's token opens no /admin route", async () => {
    const leaks: string[] = [];
    for (const r of ALL.filter((x) => x.path.startsWith("/admin/") && !x.path.startsWith("/admin/auth/"))) {
      const res = await owner.as(r.method, fill(r.path)).send({});
      if (res.status !== 401) leaks.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it("device-key and cron routes refuse requests without their credential", async () => {
    for (const key of NOT_BEARER) {
      if (key.startsWith("get /health")) continue;
      const [method, path] = key.split(" ") as [Method, string];
      const res = await request(h.app)[method](path).send({});
      expect(res.status, key).toBe(401);
    }
  });

  // What the plan's role table (§5) says each role can't do.
  const OWNER_ONLY: [Method, string][] = [
    ["post", "/branches"],
    ["patch", "/settings"],
    ["get", "/account/plan"],
    ["post", "/account/license/check"],
    ["post", "/imports/free-pos"],
  ];
  const MANAGER_UP: [Method, string][] = [
    ["get", "/staff"],
    ["get", "/reports/sales"],
    ["get", "/reports/gst"],
    ["get", "/reports/staff"],
    ["get", "/reports/profit"],
    ["get", "/reports/branches"],
    ["get", "/audit-log"],
    ["get", "/suppliers"],
    ["get", "/purchases"],
    ["post", "/products"],
    ["post", "/imports/products"],
  ];

  it("cashiers can't reach manager or owner screens", async () => {
    const leaks: string[] = [];
    for (const [m, p] of [...OWNER_ONLY, ...MANAGER_UP]) {
      const res = await cashier.as(m, `${p}?branchId=${branchId}`).send({});
      if (res.status !== 403) leaks.push(`${m} ${p} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it("managers can't reach owner-only screens", async () => {
    const leaks: string[] = [];
    for (const [m, p] of OWNER_ONLY) {
      const res = await manager.as(m, p).send({});
      if (res.status !== 403) leaks.push(`${m} ${p} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it("another shop sees nothing of this shop's records", async () => {
    const probes: [Method, string][] = [
      ["get", `/products/${ids.product}`],
      ["patch", `/products/${ids.product}`],
      ["patch", `/customers/${ids.customer}`],
      ["get", `/suppliers/${ids.supplier}/ledger`],
      ["get", `/reports/dashboard?branchId=${branchId}`],
      ["get", `/reports/stock-log?branchId=${branchId}`],
      ["post", "/orders"],
    ];
    const leaks: string[] = [];
    for (const [m, p] of probes) {
      const body = p === "/orders" ? { id: randomUUID(), branchId, counterId: randomUUID(), items: [], payments: [] } : { name: "hijack" };
      const res = await other.as(m, p).send(body);
      if (![400, 403, 404].includes(res.status)) leaks.push(`${m} ${p} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
    // And nothing was changed.
    expect((await owner.as("get", `/products/${ids.product}`)).body.product.name).toBe("Tea");
  });
});
