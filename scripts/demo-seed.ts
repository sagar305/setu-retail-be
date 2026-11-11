// Builds the demo shop on an EMPTY demo database, through the real API (run
// in-process here), so every bill, stock movement and report is exactly what
// the app would have made:
//
//   DATABASE_URL=<demo db> DEMO_RESET_EXPECT_DB=<its name> npm run demo:seed
//
// - "Setu Demo Mart": two branches (Indiranagar, Koramangala), GST on,
//   Platinum for a year, 36 products in 6 categories, 10 customers.
// - Three weeks of bills on each branch's counter (cash, UPI, card, udhaar),
//   plus a few expenses.
// - The owner signs in with DEMO_LOGIN / DEMO_PASSWORD (defaults below). That
//   pair is shown on the demo sign-in screen, so it must never be reused.
//
// Then tidy anything by hand in the app, and capture it: `npm run demo:dump`.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { getPrisma } from "../src/db/client.js";
import { computeBill } from "../src/lib/gst.js";
import { LogMailer } from "../src/mail/mailer.js";
import { addMonths } from "../src/services/plans.js";

const EMAIL = process.env["DEMO_LOGIN"] ?? "demo@setutechnology.com";
const USERNAME = process.env["DEMO_USERNAME"] ?? "demo";
const PASSWORD = process.env["DEMO_PASSWORD"] ?? "demo-shop-1234";
const DAYS = Number(process.env["DEMO_DAYS"] ?? 21);

const env = loadEnv({ ...process.env, NODE_ENV: "development", RATE_LIMITS: "off", DEMO_RESET_ENABLED: "0" });
const prisma = getPrisma();

// Refuse anything but the demo database, and anything that already has shops.
const [{ name: dbName }] = (await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT current_database() AS name`)) as [{ name: string }];
if (!env.DEMO_RESET_EXPECT_DB || env.DEMO_RESET_EXPECT_DB !== dbName) {
  console.error(`Refusing to seed "${dbName}": set DEMO_RESET_EXPECT_DB=${dbName} to confirm it's the demo database.`);
  process.exit(1);
}
if ((await prisma.account.count()) > 0) {
  console.error(`"${dbName}" already has shops. Seed an empty, migrated database (npm run db:deploy && npm run db:seed).`);
  process.exit(1);
}
if ((await prisma.plan.count()) === 0) {
  console.error("No plans yet: run `npm run db:seed` first.");
  process.exit(1);
}

const server = createApp({ env, prisma, mailer: new LogMailer() }).listen(0);
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const ORIGIN = env.CORS_ORIGINS.split(",")[0]!.trim();
let token = "";

async function call<T = Record<string, any>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any -- script reading API JSON
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(token && !headers["x-device-key"] ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

// Same numbers on every run, so two seeds of the demo look alike.
let state = 20261107;
const rand = () => ((state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const CATALOGUE: Record<string, [name: string, price: number, gst: number, hsn: string, unit?: string][]> = {
  Groceries: [
    ["Aashirvaad Atta 5 kg", 28_500, 0, "1101"],
    ["India Gate Basmati Rice 1 kg", 16_900, 500, "1006"],
    ["Toor Dal 1 kg", 15_800, 0, "0713"],
    ["Fortune Sunflower Oil 1 L", 15_500, 500, "1512"],
    ["Tata Salt 1 kg", 2_800, 0, "2501"],
    ["Sugar 1 kg", 4_800, 500, "1701"],
  ],
  Dairy: [
    ["Amul Taaza Milk 500 ml", 2_700, 0, "0401"],
    ["Amul Butter 100 g", 6_000, 1200, "0405"],
    ["Nandini Curd 500 g", 3_500, 0, "0403"],
    ["Amul Cheese Slices 200 g", 14_500, 1200, "0406"],
    ["Paneer 200 g", 9_000, 500, "0406"],
    ["Eggs (tray of 6)", 4_800, 0, "0407", "tray"],
  ],
  Snacks: [
    ["Lay's Classic Salted 52 g", 2_000, 1200, "2005"],
    ["Haldiram's Aloo Bhujia 200 g", 5_500, 1200, "2106"],
    ["Parle-G 800 g", 9_000, 1800, "1905"],
    ["Britannia Good Day 200 g", 4_000, 1800, "1905"],
    ["Kurkure Masala Munch 90 g", 2_000, 1200, "2106"],
    ["Cadbury Dairy Milk 50 g", 5_000, 1800, "1806"],
  ],
  Beverages: [
    ["Tata Tea Gold 500 g", 30_500, 500, "0902"],
    ["Bru Instant Coffee 100 g", 23_000, 1800, "2101"],
    ["Coca-Cola 750 ml", 4_000, 2800, "2202"],
    ["Real Mixed Fruit Juice 1 L", 12_500, 1200, "2009"],
    ["Bisleri Water 1 L", 2_000, 1800, "2201"],
    ["Red Bull 250 ml", 12_500, 2800, "2202"],
  ],
  "Personal care": [
    ["Colgate Strong Teeth 200 g", 12_000, 1800, "3306"],
    ["Dove Soap 100 g (pack of 3)", 17_500, 1800, "3401"],
    ["Head & Shoulders 180 ml", 21_000, 1800, "3305"],
    ["Dettol Handwash 200 ml", 9_900, 1800, "3401"],
    ["Nivea Body Lotion 200 ml", 29_900, 1800, "3304"],
    ["Gillette Guard Razor", 3_500, 1800, "8212"],
  ],
  Household: [
    ["Surf Excel Easy Wash 1 kg", 14_000, 1800, "3402"],
    ["Vim Dishwash Bar 300 g", 3_500, 1800, "3402"],
    ["Harpic Toilet Cleaner 500 ml", 10_500, 1800, "3402"],
    ["Lizol Floor Cleaner 975 ml", 22_500, 1800, "3808"],
    ["Good Knight Refill", 8_500, 1800, "3808"],
    ["Garbage Bags (30 pcs)", 9_900, 1800, "3923", "pack"],
  ],
};

const CUSTOMERS = [
  ["Priya Sharma", "9845012345"],
  ["Rahul Verma", "9886023456"],
  ["Ananya Iyer", "9900134567"],
  ["Mohammed Faizal", "9741045678"],
  ["Sneha Reddy", "9036156789"],
  ["Vikram Singh", "9611267890"],
  ["Lakshmi Narayan", "9480378901"],
  ["Arjun Menon", "9739489012"],
  ["Kavya Rao", "9008590123"],
  ["Hotel Sagar (bulk)", "8041234567"],
] as const;

try {
  console.log(`Seeding the demo shop on "${dbName}"…`);
  await call("POST", "/auth/signup", { businessName: "Setu Demo Mart", ownerName: "Demo Owner", email: EMAIL, username: USERNAME, password: PASSWORD, phone: "9000000001" });
  const user = await prisma.user.update({ where: { username: USERNAME }, data: { emailVerifiedAt: new Date() } });
  const platinum = await prisma.plan.findUniqueOrThrow({ where: { code: "platinum" } });
  const started = new Date(Date.now() - (DAYS + 7) * 86_400_000);
  await prisma.subscription.create({ data: { accountId: user.accountId, planId: platinum.id, source: "KEY", startsAt: started, endsAt: addMonths(started, 12) } });

  const login = await call("POST", "/auth/login", { login: USERNAME, password: PASSWORD });
  token = login.accessToken;
  const ownerId: string = login.me.user.id;
  await call("PATCH", "/settings", { taxEnabled: true, receiptFooter: "Thank you for shopping at Setu Demo Mart!" });

  const b1 = login.me.branches[0] as { id: string };
  await call("PATCH", `/branches/${b1.id}`, { name: "Indiranagar", address: "100 Feet Road, Indiranagar, Bengaluru 560038", phone: "8041110001", stateCode: "29" });
  const b2 = (await call("POST", "/branches", { name: "Koramangala", address: "80 Feet Road, Koramangala, Bengaluru 560034", phone: "8041110002", stateCode: "29" })).branch as { id: string };
  const branches = [b1.id, b2.id];

  const methods = (await call("GET", "/payment-methods")).methods as { id: string; kind: string }[];
  const method = (kind: string) => methods.find((m) => m.kind === kind)!.id;

  type P = { id: string; name: string; hsn: string; unit: string; price: number; gst: number };
  const products: P[] = [];
  for (const [category, items] of Object.entries(CATALOGUE)) {
    const cat = (await call("POST", "/categories", { name: category })).category as { id: string };
    for (const [name, price, gst, hsn, unit = "pcs"] of items) {
      const body = {
        name,
        categoryId: cat.id,
        hsn,
        unit,
        price,
        costPrice: Math.round(price * 0.8),
        gstRateBp: gst,
        taxInclusive: true,
        trackStock: true,
        lowStockMilli: 10_000,
        barcode: `890${String(products.length + 1).padStart(10, "0")}`,
        openingStock: branches.map((branchId) => ({ branchId, qtyMilli: between(150, 400) * 1000 })),
      };
      const p = (await call("POST", "/products", body)).product as { id: string };
      products.push({ id: p.id, name, hsn, unit, price, gst });
    }
  }
  console.log(`  ${products.length} products`);

  const customers: string[] = [];
  for (const [name, phone] of CUSTOMERS) customers.push(((await call("POST", "/customers", { name, phone })).customer as { id: string }).id);

  // One counter per branch; bills go in the way an offline counter syncs them, with their real times.
  let bills = 0;
  const now = Date.now();
  for (const [i, branchId] of branches.entries()) {
    const r = await call("POST", "/counters", { branchId, name: "Counter 1" });
    const prefix = `B${i + 1}-${(r.counter as { code: string }).code}-`;
    const key = r.deviceKey as string;
    let seq = 1;
    for (let day = DAYS; day >= 0; day--) {
      const orders = [];
      const count = between(10, 22) + (i === 0 ? 6 : 0);
      for (let n = 0; n < count; n++) {
        // 09:00–21:30 IST on that day.
        const midnightIst = Math.floor((now + 5.5 * 3600_000) / 86_400_000) * 86_400_000 - 5.5 * 3600_000 - day * 86_400_000;
        const at = midnightIst + (9 * 60 + between(0, 750)) * 60_000;
        if (at > now - 60_000) continue;
        const lines = [...new Set(Array.from({ length: between(1, 6) }, () => pick(products)))].map((p) => ({
          productId: p.id,
          name: p.name,
          hsn: p.hsn,
          unit: p.unit,
          unitPrice: p.price,
          gstRateBp: p.gst,
          taxInclusive: true,
          qtyMilli: between(1, 3) * 1000,
        }));
        const discount = rand() < 0.1 ? { type: "percent" as const, value: 500 } : { type: "flat" as const, value: 0 };
        const total = computeBill(lines, discount, { taxEnabled: true, interState: false }).total;
        const roll = rand();
        const kind = roll < 0.45 ? "CASH" : roll < 0.85 ? "UPI" : roll < 0.95 ? "CARD" : "CREDIT";
        const customerId = kind === "CREDIT" || rand() < 0.25 ? pick(customers) : null;
        orders.push({ id: randomUUID(), cashierId: ownerId, invoiceNumber: `${prefix}${String(seq++).padStart(5, "0")}`, createdAt: new Date(at).toISOString(), customerId, taxEnabled: true, discount, lines, payments: [{ methodId: method(kind), amount: total }], total });
      }
      orders.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (!orders.length) continue;
      const res = await call<{ results: { status: string; message?: string }[] }>("POST", "/sync/orders", { orders }, { "x-device-key": key });
      const bad = res.results.filter((x) => x.status !== "saved");
      if (bad.length) throw new Error(`Bills not saved: ${JSON.stringify(bad.slice(0, 3))}`);
      bills += orders.length;
    }
  }
  console.log(`  ${bills} bills over ${DAYS + 1} days`);

  for (const [category, amount, ago] of [["Rent", 4_500_000, 20], ["Electricity", 680_000, 12], ["Salaries", 3_600_000, 6], ["Transport", 45_000, 3], ["Supplies", 120_000, 1]] as const) {
    await call("POST", "/expenses", { id: randomUUID(), branchId: b1.id, spentAt: new Date(now - ago * 86_400_000).toISOString(), category, amount, methodId: method(category === "Transport" ? "CASH" : "UPI") });
  }

  console.log(`Done. Sign in as ${USERNAME} (or ${EMAIL}) / ${PASSWORD}, check it over, then run: npm run demo:dump`);
} finally {
  server.close();
  await prisma.$disconnect();
}
