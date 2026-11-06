// Load test (docs/PLAN.md, Phase 8). Target: 200 shops, 500 counters billing
// at a busy hour (~10 bills/second), with dashboards open and counters
// refreshing their offline pack.
//
//   1. Seed (shops, counters, products) through the real API:
//        DATABASE_URL=... API=http://localhost:4000 npx tsx scripts/load-test.ts seed
//      The API must run with RATE_LIMITS=off (200 sign-ups from one IP).
//      Sign-ups are verified directly in the database (the emailed link is hashed).
//   2. Run:
//        API=http://localhost:4000 RATE=10 SECONDS=60 npx tsx scripts/load-test.ts run
//
// Never point this at production: it creates 200 shops.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getPrisma } from "../src/db/client.js";
import { addMonths } from "../src/services/plans.js";

const API = (process.env["API"] ?? "http://localhost:4000").replace(/\/$/, "");
const FILE = process.env["LOAD_FILE"] ?? "load-seed.json";
const SHOPS = Number(process.env["SHOPS"] ?? 200);
const COUNTERS = Number(process.env["COUNTERS"] ?? 500);
const PRODUCTS = Number(process.env["PRODUCTS"] ?? 20);

type Counter = { key: string; prefix: string; next: number; cashierId: string; cash: string; products: { id: string; name: string; price: number }[] };
type Seed = { counters: Counter[]; owners: { login: string; branchId: string }[] };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + path, { method, headers: { "content-type": "application/json", origin: "http://localhost:5173", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return (data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test script reading API JSON
}

async function seed() {
  const prisma = getPrisma();
  const basic = await prisma.plan.findUniqueOrThrow({ where: { code: "gold" } });
  const seedData: Seed = { counters: [], owners: [] };
  const run = Date.now().toString(36);
  for (let s = 0; s < SHOPS; s++) {
    const username = `load${run}${s}`;
    await call("POST", "/auth/signup", { businessName: `Load Shop ${s}`, ownerName: `Owner ${s}`, email: `${username}@load.test`, username, password: "load-pass-123", phone: `7${run.slice(-4).replace(/\D/g, "0")}${String(s).padStart(5, "0")}`.slice(0, 10) });
    const user = await prisma.user.update({ where: { username }, data: { emailVerifiedAt: new Date() } });
    const now = new Date();
    await prisma.subscription.create({ data: { accountId: user.accountId, planId: basic.id, source: "KEY", startsAt: now, endsAt: addMonths(now, 12) } });
    const login = await call("POST", "/auth/login", { login: username, password: "load-pass-123" });
    const auth = { authorization: `Bearer ${login.accessToken as string}` };
    const me = login.me as { user: { id: string }; branches: { id: string; code: string }[] };
    const branchId = me.branches[0]!.id;
    seedData.owners.push({ login: username, branchId });
    const methods = (await call("GET", "/payment-methods", undefined, auth)).methods as { id: string; kind: string }[];
    const cash = methods.find((m) => m.kind === "CASH")!.id;
    const products = [];
    for (let p = 0; p < PRODUCTS; p++) {
      const price = 1000 + p * 750;
      const r = await call("POST", "/products", { name: `Item ${p}`, price, gstRateBp: [0, 500, 1200, 1800][p % 4], openingStock: [{ branchId, qtyMilli: 1_000_000 }] }, auth);
      products.push({ id: (r.product as { id: string }).id, name: `Item ${p}`, price });
    }
    const counters = Math.floor(COUNTERS / SHOPS) + (s < COUNTERS % SHOPS ? 1 : 0);
    for (let c = 0; c < counters; c++) {
      const r = await call("POST", "/counters", { branchId, name: `Counter ${c + 1}` }, auth);
      const counter = r.counter as { code: string };
      seedData.counters.push({ key: r.deviceKey as string, prefix: `${me.branches[0]!.code}-${counter.code}-`, next: 1, cashierId: me.user.id, cash, products });
    }
    if ((s + 1) % 20 === 0) console.log(`seeded ${s + 1}/${SHOPS} shops, ${seedData.counters.length} counters`);
  }
  writeFileSync(FILE, JSON.stringify(seedData));
  console.log(`Wrote ${FILE}: ${SHOPS} shops, ${seedData.counters.length} counters.`);
  await prisma.$disconnect();
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);

async function run() {
  const seedData = JSON.parse(readFileSync(FILE, "utf8")) as Seed;
  const RATE = Number(process.env["RATE"] ?? 10);
  const SECONDS = Number(process.env["SECONDS"] ?? 60);
  // Owners with a dashboard open (refreshing every 30 s) and counters refreshing their pack every 5 minutes.
  const REPORTS_PER_SEC = Number(process.env["REPORTS"] ?? seedData.owners.length / 30);
  const PACKS_PER_SEC = Number(process.env["PACKS"] ?? seedData.counters.length / 300);

  const tokens: string[] = [];
  for (const o of seedData.owners.slice(0, 50)) tokens.push((await call("POST", "/auth/login", { login: o.login, password: "load-pass-123" })).accessToken as string);

  const stats: Record<string, { ms: number[]; errors: number; codes: Record<string, number> }> = {};
  const record = (kind: string, ms: number, ok: boolean, code: string) => {
    const s = (stats[kind] ??= { ms: [], errors: 0, codes: {} });
    s.ms.push(ms);
    if (!ok) {
      s.errors += 1;
      s.codes[code] = (s.codes[code] ?? 0) + 1;
    }
  };
  const timed = async (kind: string, fn: () => Promise<Response>, check?: (body: unknown) => boolean) => {
    const t = performance.now();
    try {
      const res = await fn();
      const body = await res.json().catch(() => null);
      record(kind, performance.now() - t, res.ok && (!check || check(body)), String(res.status));
    } catch (e) {
      record(kind, performance.now() - t, false, (e as Error).message.slice(0, 40));
    }
  };

  // Each run numbers its bills from a fresh range, so re-runs don't reuse numbers already saved.
  const base = (Math.floor(Date.now() / 1000) % 90_000) * 1000 + 1;
  for (const c of seedData.counters) c.next = base;
  let i = 0;
  const bill = () => {
    const c = seedData.counters[i++ % seedData.counters.length]!;
    const lines = [0, 1, 2].map((k) => c.products[(i + k * 7) % c.products.length]!).map((p) => ({ productId: p.id, name: p.name, hsn: "", unit: "pcs", unitPrice: p.price, gstRateBp: 0, taxInclusive: true, qtyMilli: 1000 }));
    const total = lines.reduce((s, l) => s + l.unitPrice, 0);
    const body = { orders: [{ id: randomUUID(), cashierId: c.cashierId, invoiceNumber: `${c.prefix}${String(c.next++).padStart(8, "0")}`, createdAt: new Date().toISOString(), taxEnabled: false, discount: { type: "flat", value: 0 }, lines, payments: [{ methodId: c.cash, amount: total }], total }] };
    return timed("bill", () => fetch(`${API}/sync/orders`, { method: "POST", headers: { "content-type": "application/json", "x-device-key": c.key }, body: JSON.stringify(body) }), (b) => (b as { results?: { status: string }[] }).results?.[0]?.status === "saved");
  };
  const report = () => {
    const k = Math.floor(Math.random() * tokens.length);
    const o = seedData.owners[k]!;
    return timed("dashboard", () => fetch(`${API}/reports/dashboard?branchId=${o.branchId}`, { headers: { authorization: `Bearer ${tokens[k]}` } }));
  };
  const pack = () => {
    const c = seedData.counters[Math.floor(Math.random() * seedData.counters.length)]!;
    return timed("offline pack", () => fetch(`${API}/sync/pack`, { headers: { "x-device-key": c.key } }));
  };

  console.log(`Running ${SECONDS}s: ${RATE} bills/s, ${REPORTS_PER_SEC.toFixed(1)} dashboards/s, ${PACKS_PER_SEC.toFixed(1)} offline packs/s against ${API}`);
  const inflight = new Set<Promise<void>>();
  const start = performance.now();
  const due = { bill: 0, report: 0, pack: 0 };
  let peak = 0;
  while (performance.now() - start < SECONDS * 1000) {
    const t = (performance.now() - start) / 1000;
    const fire = (fn: () => Promise<void>) => {
      const p = fn().finally(() => inflight.delete(p));
      inflight.add(p);
    };
    for (; due.bill < t * RATE; due.bill++) fire(bill);
    for (; due.report < t * REPORTS_PER_SEC; due.report++) fire(report);
    for (; due.pack < t * PACKS_PER_SEC; due.pack++) fire(pack);
    peak = Math.max(peak, inflight.size);
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(inflight);
  const elapsed = (performance.now() - start) / 1000;
  console.log(`\nDone in ${elapsed.toFixed(1)}s, at most ${peak} requests in flight.`);
  console.log("kind            count   /sec    p50    p95    p99   errors");
  for (const [kind, s] of Object.entries(stats)) {
    console.log(`${kind.padEnd(14)} ${String(s.ms.length).padStart(6)} ${(s.ms.length / elapsed).toFixed(1).padStart(6)} ${pct(s.ms, 50).toFixed(0).padStart(5)}ms ${pct(s.ms, 95).toFixed(0).padStart(5)}ms ${pct(s.ms, 99).toFixed(0).padStart(5)}ms ${String(s.errors).padStart(6)} ${Object.keys(s.codes).length ? JSON.stringify(s.codes) : ""}`);
  }
}

const mode = process.argv[2];
if (mode === "seed") await seed();
else if (mode === "run") await run();
else {
  console.error("Usage: npx tsx scripts/load-test.ts seed|run");
  process.exit(1);
}
