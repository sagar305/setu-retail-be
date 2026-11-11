// Builds the demo shop on an EMPTY demo database, through the real API (run
// in-process here), so every bill, stock movement and report is exactly what
// the app would have made:
//
//   DATABASE_URL=<demo db> DEMO_RESET_EXPECT_DB=<its name> npm run demo:seed
//
// "Setu Demo Mart" on Platinum, sized to show the app handling a big shop:
// - 5 branches in Bengaluru, a counter each (2 at the busiest), GST on
// - ~2,000 products in 12 categories, opening stock in every branch
// - 1,500 customers, some buying on udhaar and paying it back
// - 6 months of bills (~40,000; busier at weekends), cash / UPI / card / udhaar
// - 15 suppliers with purchase bills every fortnight per branch, part-paid
// - monthly rent, salaries and electricity per branch, plus small expenses
// Sizes can be changed with DEMO_BRANCHES, DEMO_PRODUCTS, DEMO_CUSTOMERS,
// DEMO_DAYS and DEMO_BILLS_PER_DAY (per branch, on average).
//
// Logins, all with DEMO_PASSWORD (default below), shown on the demo sign-in
// screen, so never reuse that password:
//   owner    the shop owner (every branch, everything)
//   manager  manager of Koramangala (B2)
//   cashier  cashier at Indiranagar (B1)
// plus a cashier on each other branch, who make most of that branch's bills.
//
// Then tidy anything by hand in the app, and capture it: `npm run demo:dump`.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { getPrisma } from "../src/db/client.js";
import { computeBill } from "../src/lib/gst.js";
import { MemoryMailer } from "../src/mail/mailer.js";
import { markAsDemo } from "../src/services/demoReset.js";
import { addMonths } from "../src/services/plans.js";

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const PASSWORD = process.env["DEMO_PASSWORD"] ?? "demo-shop-1234";
const BRANCHES = Math.min(num("DEMO_BRANCHES", 5), 8);
const PRODUCTS = num("DEMO_PRODUCTS", 2_000);
const CUSTOMERS = num("DEMO_CUSTOMERS", 1_500);
const DAYS = num("DEMO_DAYS", 180);
const BILLS_PER_DAY = num("DEMO_BILLS_PER_DAY", 45);

const env = loadEnv({ ...process.env, NODE_ENV: "development", RATE_LIMITS: "off", DEMO_RESET_ENABLED: "0", LOG_LEVEL: "silent" });
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

// Emails stay in memory: the seeder reads the staff invite links from it.
const mailer = new MemoryMailer();
const server = createApp({ env, prisma, mailer }).listen(0);
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
/** Popular things first: index 0 is picked far more often than the last. */
const POPULAR_SKEW = 2.2;
const popular = <T>(xs: readonly T[], skew = POPULAR_SKEW) => xs[Math.min(xs.length - 1, Math.floor(xs.length * rand() ** skew))]!;
const shuffle = <T>(xs: T[]) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
};

// ── Catalogue: category → items × brands × sizes ─────────────────────────
type Item = [name: string, price: number, gst: number, hsn: string];
type Category = { items: Item[]; brands: string[]; sizes: [label: string, factor: number, unit?: string][] };
const CATALOGUE: Record<string, Category> = {
  "Rice, atta & dals": {
    items: [["Basmati Rice", 15_000, 500, "1006"], ["Sona Masoori Rice", 7_000, 500, "1006"], ["Whole Wheat Atta", 5_500, 0, "1101"], ["Toor Dal", 16_000, 0, "0713"], ["Moong Dal", 14_000, 0, "0713"], ["Chana Dal", 11_000, 0, "0713"], ["Urad Dal", 15_000, 0, "0713"], ["Masoor Dal", 12_000, 0, "0713"], ["Besan", 9_000, 0, "1106"], ["Rava", 6_000, 0, "1103"], ["Poha", 7_000, 0, "1904"], ["Rajma", 16_000, 0, "0713"]],
    brands: ["India Gate", "Aashirvaad", "Tata Sampann", "Daawat", "24 Mantra", "Fortune", "Organic Tattva", "Pillsbury"],
    sizes: [["500 g", 0.55], ["1 kg", 1], ["2 kg", 1.9], ["5 kg", 4.5]],
  },
  "Oils & ghee": {
    items: [["Sunflower Oil", 15_500, 500, "1512"], ["Mustard Oil", 18_000, 500, "1514"], ["Groundnut Oil", 22_000, 500, "1508"], ["Rice Bran Oil", 16_000, 500, "1515"], ["Cow Ghee", 60_000, 1200, "0405"], ["Coconut Oil", 24_000, 500, "1513"]],
    brands: ["Fortune", "Saffola", "Dhara", "Gold Winner", "Amul", "Patanjali", "Parachute"],
    sizes: [["500 ml", 0.55], ["1 L", 1], ["2 L", 1.95], ["5 L", 4.6]],
  },
  "Spices & masalas": {
    items: [["Turmeric Powder", 4_000, 500, "0910"], ["Red Chilli Powder", 5_000, 500, "0904"], ["Coriander Powder", 3_500, 500, "0909"], ["Garam Masala", 7_000, 500, "0910"], ["Sambar Powder", 6_000, 500, "0910"], ["Chicken Masala", 6_500, 500, "0910"], ["Jeera", 9_000, 500, "0909"], ["Black Pepper", 12_000, 500, "0904"]],
    brands: ["MDH", "Everest", "Catch", "Eastern", "Aachi", "MTR"],
    sizes: [["50 g", 0.5], ["100 g", 1], ["200 g", 1.9], ["500 g", 4.4]],
  },
  Dairy: {
    items: [["Toned Milk", 2_700, 0, "0401"], ["Curd", 3_500, 0, "0403"], ["Butter", 6_000, 1200, "0405"], ["Cheese Slices", 14_500, 1200, "0406"], ["Paneer", 9_000, 500, "0406"], ["Fresh Cream", 7_000, 500, "0401"], ["Lassi", 2_500, 1200, "0403"]],
    brands: ["Amul", "Nandini", "Mother Dairy", "Milky Mist", "Heritage", "Akshayakalpa"],
    sizes: [["200 g", 0.5], ["500 g", 1], ["1 kg", 1.9]],
  },
  "Snacks & namkeen": {
    items: [["Potato Chips", 2_000, 1200, "2005"], ["Aloo Bhujia", 5_500, 1200, "2106"], ["Masala Peanuts", 4_000, 1200, "2008"], ["Nachos", 5_000, 1200, "1904"], ["Khakhra", 6_000, 1200, "1905"], ["Mixture", 4_500, 1200, "2106"], ["Popcorn", 3_000, 1200, "1904"]],
    brands: ["Lay's", "Haldiram's", "Bikaji", "Balaji", "Kurkure", "Bingo", "Act II"],
    sizes: [["50 g", 0.5], ["150 g", 1], ["400 g", 2.4]],
  },
  "Biscuits & chocolates": {
    items: [["Glucose Biscuits", 1_000, 1800, "1905"], ["Cream Biscuits", 3_000, 1800, "1905"], ["Cookies", 4_000, 1800, "1905"], ["Marie Biscuits", 3_500, 1800, "1905"], ["Milk Chocolate", 5_000, 1800, "1806"], ["Dark Chocolate", 10_000, 1800, "1806"], ["Wafers", 3_000, 1800, "1905"]],
    brands: ["Parle", "Britannia", "Sunfeast", "Cadbury", "Nestlé", "Amul", "Unibic"],
    sizes: [["75 g", 0.6], ["150 g", 1], ["300 g", 1.9]],
  },
  Beverages: {
    items: [["Tea", 30_000, 500, "0902"], ["Instant Coffee", 23_000, 1800, "2101"], ["Filter Coffee", 18_000, 500, "0901"], ["Cola", 4_000, 2800, "2202"], ["Fruit Juice", 12_500, 1200, "2009"], ["Packaged Water", 2_000, 1800, "2201"], ["Energy Drink", 12_500, 2800, "2202"], ["Health Drink", 25_000, 1800, "1901"]],
    brands: ["Tata", "Brooke Bond", "Bru", "Nescafé", "Coca-Cola", "Pepsi", "Real", "Bisleri", "Bournvita"],
    sizes: [["250 g/ml", 0.5], ["500 g/ml", 1], ["1 kg/L", 1.9]],
  },
  "Personal care": {
    items: [["Toothpaste", 12_000, 1800, "3306"], ["Bath Soap", 6_000, 1800, "3401"], ["Shampoo", 21_000, 1800, "3305"], ["Hair Oil", 15_000, 1800, "3305"], ["Body Lotion", 29_900, 1800, "3304"], ["Face Wash", 18_000, 1800, "3304"], ["Deodorant", 22_000, 1800, "3307"], ["Handwash", 9_900, 1800, "3401"]],
    brands: ["Colgate", "Dove", "Head & Shoulders", "Parachute", "Nivea", "Himalaya", "Dettol", "Lifebuoy", "Pears"],
    sizes: [["small", 0.6], ["regular", 1], ["family pack", 1.8]],
  },
  Household: {
    items: [["Detergent Powder", 14_000, 1800, "3402"], ["Liquid Detergent", 22_000, 1800, "3402"], ["Dishwash Bar", 3_500, 1800, "3402"], ["Dishwash Liquid", 11_000, 1800, "3402"], ["Toilet Cleaner", 10_500, 1800, "3402"], ["Floor Cleaner", 22_500, 1800, "3808"], ["Mosquito Repellent", 8_500, 1800, "3808"], ["Garbage Bags", 9_900, 1800, "3923"]],
    brands: ["Surf Excel", "Ariel", "Tide", "Vim", "Harpic", "Lizol", "Good Knight", "Exo"],
    sizes: [["small", 0.6], ["regular", 1], ["large", 1.9]],
  },
  "Baby care": {
    items: [["Diapers", 45_000, 1200, "9619"], ["Baby Wipes", 15_000, 1200, "3401"], ["Baby Lotion", 20_000, 1800, "3304"], ["Baby Powder", 14_000, 1800, "3304"], ["Baby Food", 30_000, 1800, "1901"]],
    brands: ["Pampers", "Huggies", "Johnson's", "Himalaya", "Cerelac", "MamyPoko"],
    sizes: [["small", 0.6], ["medium", 1], ["large", 1.7]],
  },
  "Fruits & vegetables": {
    items: [["Onion", 4_000, 0, "0703"], ["Tomato", 3_500, 0, "0702"], ["Potato", 3_500, 0, "0701"], ["Banana", 6_000, 0, "0803"], ["Apple", 18_000, 0, "0808"], ["Carrot", 6_000, 0, "0706"], ["Green Chilli", 1_000, 0, "0709"], ["Coriander Leaves", 1_000, 0, "0709"]],
    brands: ["Farm Fresh", "Organic"],
    sizes: [["250 g", 0.3], ["500 g", 0.55], ["1 kg", 1, "kg"]],
  },
  "Frozen & ready to eat": {
    items: [["Frozen Peas", 9_000, 500, "0710"], ["Frozen Parathas", 12_000, 1800, "1905"], ["Instant Noodles", 1_400, 1200, "1902"], ["Ready Meal", 9_900, 1200, "2106"], ["Ice Cream", 25_000, 1800, "2105"], ["Pasta", 6_000, 1200, "1902"]],
    brands: ["Safal", "McCain", "Maggi", "MTR", "Kwality Walls", "Haldiram's", "Yippee"],
    sizes: [["single", 0.5], ["regular", 1], ["family pack", 2]],
  },
};

function catalogue(limit: number) {
  const all: { category: string; name: string; price: number; gst: number; hsn: string; unit: string }[] = [];
  for (const [category, c] of Object.entries(CATALOGUE)) {
    for (const [item, base, gst, hsn] of c.items) {
      for (const brand of c.brands) {
        const brandFactor = 0.85 + ((brand.length * 7) % 10) / 20;
        for (const [size, factor, unit] of c.sizes) {
          // Shelf prices end in whole rupees, like a printed MRP.
          const price = Math.max(500, Math.round((base * factor * brandFactor) / 100) * 100);
          all.push({ category, name: `${brand} ${item} ${size}`, price, gst, hsn, unit: unit ?? "pcs" });
        }
      }
    }
  }
  return shuffle(all).slice(0, limit);
}

const FIRST = ["Priya", "Rahul", "Ananya", "Mohammed", "Sneha", "Vikram", "Lakshmi", "Arjun", "Kavya", "Rohan", "Divya", "Karthik", "Meera", "Suresh", "Pooja", "Aditya", "Nisha", "Imran", "Deepa", "Varun", "Asha", "Naveen", "Shruti", "Manoj", "Fatima", "Ganesh", "Ritu", "Sanjay", "Anjali", "Prakash", "Swati", "Joseph", "Bhavya", "Harish", "Neha", "Ravi"];
const LAST = ["Sharma", "Verma", "Iyer", "Reddy", "Singh", "Narayan", "Menon", "Rao", "Patil", "Kumar", "Nair", "Gowda", "Shetty", "Joshi", "Khan", "Das", "Pillai", "Hegde", "Kulkarni", "Fernandes", "Bhat", "Agarwal", "Mehta", "Chatterjee"];
const BRANCH_INFO = [
  ["Indiranagar", "100 Feet Road, Indiranagar, Bengaluru 560038"],
  ["Koramangala", "80 Feet Road, Koramangala, Bengaluru 560034"],
  ["HSR Layout", "27th Main, HSR Layout, Bengaluru 560102"],
  ["Whitefield", "ITPL Main Road, Whitefield, Bengaluru 560066"],
  ["Jayanagar", "11th Main, Jayanagar 4th Block, Bengaluru 560011"],
  ["Malleshwaram", "Sampige Road, Malleshwaram, Bengaluru 560003"],
  ["JP Nagar", "24th Main, JP Nagar, Bengaluru 560078"],
  ["Hebbal", "Bellary Road, Hebbal, Bengaluru 560024"],
] as const;
const SUPPLIERS = ["Sri Balaji Traders", "Karnataka Wholesale Mart", "Metro Cash & Carry", "Hindustan Distributors", "Annapurna Agencies", "Sai Ram Enterprises", "Nandini Dairy Depot", "Fresh Farms Supply", "Royal FMCG Distributors", "Ganesh Provisions Wholesale", "Coastal Spices Co.", "Bharat Beverages", "CleanHome Distributors", "Little Ones Baby Store Supply", "Frozen Express Logistics"];

/** How busy each branch is, relative to DEMO_BILLS_PER_DAY. */
const BRANCH_SIZE = [1.3, 1.1, 1, 0.85, 0.75, 0.7, 0.65, 0.6];
const DAY_MS = 86_400_000;
const IST_MS = 5.5 * 3_600_000;
/** Midnight IST, `daysAgo` days before today. */
const istMidnight = (now: number, daysAgo: number) => Math.floor((now + IST_MS) / DAY_MS) * DAY_MS - IST_MS - daysAgo * DAY_MS;
const ymd = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

try {
  console.log(`Seeding the demo shop on "${dbName}": ${BRANCHES} branches, ${PRODUCTS} products, ${CUSTOMERS} customers, ${DAYS} days…`);
  const now = Date.now();
  const start = istMidnight(now, DAYS + 7);

  await call("POST", "/auth/signup", { businessName: "Setu Demo Mart", ownerName: "Demo Owner", email: "owner.demo@setutechnology.com", username: "owner", password: PASSWORD, phone: "9000000001" });
  const user = await prisma.user.update({ where: { username: "owner" }, data: { emailVerifiedAt: new Date() } });
  const platinum = await prisma.plan.findUniqueOrThrow({ where: { code: "platinum" } });
  await prisma.subscription.create({ data: { accountId: user.accountId, planId: platinum.id, source: "KEY", startsAt: new Date(start), endsAt: addMonths(new Date(start), 12) } });

  const login = await call("POST", "/auth/login", { login: "owner", password: PASSWORD });
  token = login.accessToken;
  const ownerId: string = login.me.user.id;
  await call("PATCH", "/settings", { taxEnabled: true, receiptFooter: "Thank you for shopping at Setu Demo Mart!" });

  // ── Branches and staff ──
  const branches: string[] = [];
  for (let i = 0; i < BRANCHES; i++) {
    const [name, address] = BRANCH_INFO[i]!;
    const body = { name, address, phone: `80411100${String(i + 1).padStart(2, "0")}`, stateCode: "29" };
    if (i === 0) {
      const id = (login.me.branches[0] as { id: string }).id;
      await call("PATCH", `/branches/${id}`, body);
      branches.push(id);
    } else branches.push(((await call("POST", "/branches", body)).branch as { id: string }).id);
  }

  // Staff join through the real invite link, like a shop's staff would.
  const staff = async (name: string, username: string, role: "MANAGER" | "CASHIER", branchId: string) => {
    const email = `${username}.demo@setutechnology.com`;
    await call("POST", "/staff", { name, email, username, role, branchIds: [branchId] });
    const link = mailer.lastLink(email);
    const inviteToken = link && new URL(link).searchParams.get("token");
    if (!inviteToken) throw new Error(`No invite link for ${email}`);
    const saved = token;
    token = "";
    await call("POST", "/auth/accept-invite", { token: inviteToken, password: PASSWORD });
    token = saved;
    return (await prisma.user.findUniqueOrThrow({ where: { username } })).id;
  };
  // Who rings up most bills on each branch's counters (the owner covers the rest).
  const usualCashier: string[] = [await staff("Kiran Patil", "cashier", "CASHIER", branches[0]!)];
  if (BRANCHES > 1) usualCashier.push(await staff("Anita Desai", "manager", "MANAGER", branches[1]!));
  for (let i = 2; i < BRANCHES; i++) usualCashier.push(await staff(`${pick(FIRST)} ${pick(LAST)}`, `cashier${i + 1}`, "CASHIER", branches[i]!));
  console.log(`  ${BRANCHES} branches, ${usualCashier.length + 1} people (${elapsed()})`);

  const methods = (await call("GET", "/payment-methods")).methods as { id: string; kind: string }[];
  const method = (kind: string) => methods.find((m) => m.kind === kind)!.id;

  // ── Products ──
  type P = { id: string; name: string; hsn: string; unit: string; price: number; gst: number };
  const categoryIds = new Map<string, string>();
  for (const name of Object.keys(CATALOGUE)) categoryIds.set(name, ((await call("POST", "/categories", { name })).category as { id: string }).id);
  // Best sellers are cheap everyday things, not the 5 kg packs. Each product's
  // opening stock covers what it is expected to sell in the period (from its
  // place in this order and the branch's size), so stock stays positive and
  // only a few things run low.
  const items = catalogue(PRODUCTS).sort((a, b) => a.price - b.price + (rand() - 0.5) * 8_000);
  const share = (rank: number) => ((rank + 1) / items.length) ** (1 / POPULAR_SKEW) - (rank / items.length) ** (1 / POPULAR_SKEW);
  const billsAt = (branch: number) => BILLS_PER_DAY * BRANCH_SIZE[branch]! * 1.1 * (DAYS + 1);
  const products: P[] = [];
  for (const [rank, item] of items.entries()) {
    const body = {
      name: item.name,
      categoryId: categoryIds.get(item.category),
      hsn: item.hsn,
      unit: item.unit,
      price: item.price,
      costPrice: Math.round(item.price * (0.72 + rand() * 0.12)),
      gstRateBp: item.gst,
      taxInclusive: true,
      trackStock: true,
      lowStockMilli: 10_000,
      barcode: `890${String(products.length + 1).padStart(10, "0")}`,
      openingStock: branches.map((branchId, b) => {
        // Expected sales, plus room for a busy spell (3 standard deviations).
        const expected = billsAt(b) * 3.6 * 1.5 * share(rank);
        return { branchId, qtyMilli: (Math.ceil(expected * (1.3 + rand() * 0.4) + 3 * Math.sqrt(expected * 3)) + between(15, 50)) * 1000 };
      }),
    };
    const p = (await call("POST", "/products", body)).product as { id: string };
    products.push({ id: p.id, name: item.name, hsn: item.hsn, unit: item.unit, price: item.price, gst: item.gst });
    if (products.length % 500 === 0) console.log(`  ${products.length} products (${elapsed()})`);
  }
  const byPopularity = products;

  // ── Customers ──
  const customers: string[] = [];
  const phones = new Set<string>();
  while (customers.length < CUSTOMERS) {
    const phone = `${pick(["9", "8", "7", "6"])}${String(between(0, 999_999_999)).padStart(9, "0")}`;
    if (phones.has(phone)) continue;
    phones.add(phone);
    const name = customers.length % 40 === 39 ? `${pick(["Hotel", "Cafe", "Mess", "Bakery"])} ${pick(LAST)} (bulk)` : `${pick(FIRST)} ${pick(LAST)}`;
    customers.push(((await call("POST", "/customers", { name, phone })).customer as { id: string }).id);
  }
  // A few hundred regulars do most of the named buying (and all the udhaar).
  const regulars = customers.slice(0, Math.max(10, Math.floor(customers.length / 6)));
  console.log(`  ${customers.length} customers (${elapsed()})`);

  // ── Bills: counters sync them in, with their real times ──
  let bills = 0;
  const udhaar = new Map<string, { branchId: string; amount: number }>();
  for (const [i, branchId] of branches.entries()) {
    const counters: { key: string; prefix: string; seq: number }[] = [];
    for (let c = 0; c < (i === 0 ? 2 : 1); c++) {
      const r = await call("POST", "/counters", { branchId, name: `Counter ${c + 1}` });
      counters.push({ key: r.deviceKey as string, prefix: `B${i + 1}-${(r.counter as { code: string }).code}-`, seq: 1 });
    }
    // Bigger branches sell more.
    const size = BRANCH_SIZE[i]!;
    for (let day = DAYS; day >= 0; day--) {
      const midnight = istMidnight(now, day);
      const weekday = new Date(midnight + IST_MS).getUTCDay();
      const weekend = weekday === 0 || weekday === 6 ? 1.35 : 1;
      // A little growth over the months, so the trend charts go up.
      const growth = 0.85 + 0.3 * (1 - day / DAYS);
      const count = Math.round(BILLS_PER_DAY * size * weekend * growth * (0.8 + rand() * 0.4));
      const byCounter = new Map<number, Record<string, unknown>[]>();
      const times = Array.from({ length: count }, () => midnight + (9 * 60 + between(0, 750)) * 60_000)
        .filter((at) => at < now - 60_000)
        .sort((a, b) => a - b);
      for (const at of times) {
        const lines = [...new Set(Array.from({ length: between(1, 7) }, () => popular(byPopularity)))].map((p) => ({
          productId: p.id,
          name: p.name,
          hsn: p.hsn,
          unit: p.unit,
          unitPrice: p.price,
          gstRateBp: p.gst,
          taxInclusive: true,
          qtyMilli: (rand() < 0.75 ? 1 : between(2, 4)) * 1000,
        }));
        const discount = rand() < 0.08 ? { type: "percent" as const, value: pick([200, 500, 1000]) } : { type: "flat" as const, value: 0 };
        const total = computeBill(lines, discount, { taxEnabled: true, interState: false }).total;
        const roll = rand();
        const kind = roll < 0.4 ? "CASH" : roll < 0.84 ? "UPI" : roll < 0.97 ? "CARD" : "CREDIT";
        const customerId = kind === "CREDIT" ? pick(regulars) : rand() < 0.3 ? (rand() < 0.7 ? pick(regulars) : pick(customers)) : null;
        if (kind === "CREDIT" && customerId) {
          const owed = udhaar.get(customerId) ?? { branchId, amount: 0 };
          owed.amount += total;
          udhaar.set(customerId, owed);
        }
        const c = counters.length > 1 && rand() < 0.4 ? 1 : 0;
        const counter = counters[c]!;
        const list = byCounter.get(c) ?? [];
        list.push({ id: randomUUID(), cashierId: rand() < 0.85 ? usualCashier[i]! : ownerId, invoiceNumber: `${counter.prefix}${String(counter.seq++).padStart(6, "0")}`, createdAt: new Date(at).toISOString(), customerId, taxEnabled: true, discount, lines, payments: [{ methodId: method(kind), amount: total }], total });
        byCounter.set(c, list);
      }
      for (const [c, orders] of byCounter) {
        for (let k = 0; k < orders.length; k += 100) {
          const res = await call<{ results: { status: string; message?: string }[] }>("POST", "/sync/orders", { orders: orders.slice(k, k + 100) }, { "x-device-key": counters[c]!.key });
          const bad = res.results.filter((x) => x.status !== "saved");
          if (bad.length) throw new Error(`Bills not saved: ${JSON.stringify(bad.slice(0, 3))}`);
        }
        bills += orders.length;
      }
    }
    console.log(`  branch ${i + 1}/${BRANCHES}: ${bills} bills so far (${elapsed()})`);
  }

  // Most udhaar is paid back; some is still open (it shows in Invoice Aging).
  let paidBack = 0;
  for (const [customerId, owed] of udhaar) {
    if (rand() < 0.25) continue;
    const amount = Math.floor((owed.amount * (0.6 + rand() * 0.4)) / 100) * 100;
    if (amount < 100) continue;
    await call("POST", `/customers/${customerId}/payments`, { id: randomUUID(), branchId: owed.branchId, amount, methodId: method(rand() < 0.5 ? "CASH" : "UPI"), occurredAt: new Date(now - between(1, 20) * DAY_MS).toISOString() });
    paidBack += 1;
  }
  console.log(`  ${udhaar.size} udhaar customers, ${paidBack} paid back (${elapsed()})`);

  // ── Suppliers and purchase bills (restocking) ──
  const suppliers: string[] = [];
  for (const [n, name] of SUPPLIERS.entries()) {
    suppliers.push(((await call("POST", "/suppliers", { name, phone: `80422200${String(n).padStart(2, "0")}`, stateCode: "29" })).supplier as { id: string }).id);
  }
  let purchases = 0;
  const backdate: { id: string; at: number }[] = [];
  for (const [i, branchId] of branches.entries()) {
    for (let day = DAYS - 3; day >= 1; day -= 14) {
      const at = istMidnight(now, day) + 11 * 3_600_000;
      const lines = [...new Set(Array.from({ length: between(15, 40) }, () => popular(byPopularity, 1.6)))].map((p) => ({
        productId: p.id,
        qtyMilli: between(12, 60) * 1000,
        unitCost: Math.round((p.price * 0.75) / (1 + p.gst / 10_000)),
        gstRateBp: p.gst,
      }));
      const id = randomUUID();
      const r = await call("POST", "/purchases", { id, branchId, supplierId: pick(suppliers), billNumber: `INV-${ymd(at).replace(/-/g, "")}-${i + 1}${between(100, 999)}`, billDate: ymd(at), dueDate: ymd(at + 30 * DAY_MS), lines, paidAmount: 0 });
      const total = (r.purchase as { total: number }).total;
      // Paid in full, in part, or still due (the newest ones), like a real shop.
      const paid = day < 20 ? 0 : rand() < 0.7 ? total : Math.floor((total * 0.5) / 100) * 100;
      if (paid > 0) await call("POST", `/suppliers/${(r.purchase as { supplierId: string }).supplierId}/payments`, { id: randomUUID(), branchId, amount: paid, methodId: method(rand() < 0.6 ? "UPI" : "CASH"), occurredAt: new Date(at + between(3, 25) * DAY_MS).toISOString() });
      backdate.push({ id, at });
      purchases += 1;
    }
  }
  console.log(`  ${SUPPLIERS.length} suppliers, ${purchases} purchase bills (${elapsed()})`);

  // A stock count found some items damaged or expired: these few now run low,
  // so the low-stock alerts have something to show.
  const lowStock = shuffle(products.slice(0, 400)).slice(0, 30);
  for (const p of lowStock) {
    const branchId = pick(branches);
    await call("POST", `/products/${p.id}/stock`, { branchId, type: "SET", qtyMilli: between(2, 9) * 1000, note: pick(["Stock count: damaged packs", "Stock count: expired", "Stock count"]) });
  }

  // ── Expenses ──
  let expenses = 0;
  for (const [i, branchId] of branches.entries()) {
    for (let day = DAYS; day >= 0; day--) {
      const at = istMidnight(now, day) + 18 * 3_600_000;
      const dom = new Date(at + IST_MS).getUTCDate();
      const items: [string, number, string][] = [];
      if (dom === 1) items.push(["Rent", 4_500_000 - i * 400_000, "UPI"]);
      if (dom === 1) items.push(["Salaries", 6_000_000 - i * 500_000, "UPI"]);
      if (dom === 5) items.push(["Electricity", between(500_000, 900_000), "UPI"]);
      if (dom === 7) items.push(["Internet & phone", 149_900, "UPI"]);
      if (rand() < 0.12) items.push([pick(["Transport", "Supplies", "Repairs", "Other"]), between(20, 300) * 100, "CASH"]);
      for (const [category, amount, kind] of items) {
        await call("POST", "/expenses", { id: randomUUID(), branchId, spentAt: new Date(at).toISOString(), category, amount, methodId: method(kind) });
        expenses += 1;
      }
    }
  }
  console.log(`  ${expenses} expenses (${elapsed()})`);

  // ── Dates: the shop was set up when its plan started, not today ──
  const setup = new Date(start + DAY_MS);
  await prisma.$executeRawUnsafe(`UPDATE "accounts" SET "createdAt" = $1::timestamptz`, setup.toISOString());
  for (const table of ["branches", "categories", "products", "users", "counters", "payment_methods", "suppliers"]) {
    await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "createdAt" = $1::timestamptz + (random() * interval '20 days')`, setup.toISOString());
  }
  // Customers joined over the months.
  await prisma.$executeRawUnsafe(`UPDATE "customers" SET "createdAt" = $1::timestamptz + (random() * ($2::timestamptz - $1::timestamptz))`, setup.toISOString(), new Date(now - DAY_MS).toISOString());
  // Opening stock was counted on set-up day; purchase stock arrived on the bill date.
  await prisma.$executeRawUnsafe(`UPDATE "inventory_logs" SET "createdAt" = $1::timestamptz WHERE "type" = 'OPENING'`, setup.toISOString()).catch(() => undefined);
  for (const b of backdate) {
    await prisma.$executeRawUnsafe(`UPDATE "purchases" SET "createdAt" = $2::timestamptz WHERE "id" = $1::uuid`, b.id, new Date(b.at).toISOString());
    await prisma.$executeRawUnsafe(`UPDATE "inventory_logs" SET "createdAt" = $2::timestamptz WHERE "refId" = $1::uuid`, b.id, new Date(b.at).toISOString());
  }

  // Marked as the demo's database, so resets may wipe it although it now has a shop.
  await markAsDemo(prisma, new Date());
  console.log(`Done in ${elapsed()}: ${bills} bills. Sign in as owner, manager or cashier / ${PASSWORD}, check it over, then run: npm run demo:dump`);
  console.log(`Demo app env: VITE_DEMO_LOGIN=Owner=owner|${PASSWORD};Manager=manager|${PASSWORD};Cashier=cashier|${PASSWORD}`);
} finally {
  server.close();
  await prisma.$disconnect();
}
