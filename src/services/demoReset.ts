// Demo reset (demo deployment only).
//
// A public demo fills up with whatever visitors type into it. The demo shop is
// kept as a snapshot (`npm run demo:dump`), and every DEMO_RESET_INTERVAL_HOURS
// the database is wiped and that snapshot restored.
//
// - Vercel has no long-running process, so there is no timer: the first request
//   after a reset time (00:00, 02:00, 04:00 … UTC for 2 hours) does the reset
//   before it is answered. Nobody visiting means nothing to reset.
// - Every timestamp and date is moved forward by the time since the snapshot,
//   so the bills from "today" in the snapshot are today's bills again, the plan
//   never runs out and expiry dates stay ahead.
// - It all runs in one transaction under an advisory lock: other requests see
//   the old data until the new data is in, and only one instance resets.
// - It refuses to touch a database whose name isn't DEMO_RESET_EXPECT_DB.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Env } from "../config/env.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export const DUMP_FORMAT = 1;
export const STATE_TABLE = "_demo_state";
/** pg advisory lock id for resets ("SETUDEMO" as a number). */
const LOCK_KEY = 5_345_544_669n;

/** Never wiped: the migration history and the reset bookkeeping. */
const KEEP_TABLES = new Set(["_prisma_migrations", STATE_TABLE]);
/**
 * Wiped but never captured: sign-ins and one-time links (a reset signs
 * everyone out), rate limits, replay keys, and the Setu team's own logins.
 */
export const UNCAPTURED_TABLES = new Set(["sessions", "one_time_tokens", "rate_limits", "idempotency_keys", "super_admins", "admin_sessions", "admin_tokens", "admin_audit_logs"]);

export type DumpMeta = { format: number; capturedAt: string; database: string; timezone: string; tables: Record<string, unknown> };
/** The snapshot file: its parsed metadata, plus the raw text handed to Postgres as is (no bigint rounding). */
export type DemoDump = { meta: DumpMeta; text: string };

type Db = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Column = { table: string; column: string; type: string };

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

// ── Schedule ──────────────────────────────────────────────────────────────

const intervalMs = (hours: number) => Math.round(hours * 3_600_000);
/** The most recent reset time at or before `now`. */
export function lastBoundary(now: Date, hours: number): Date {
  const ms = intervalMs(hours);
  return new Date(Math.floor(now.getTime() / ms) * ms);
}
export function nextBoundary(now: Date, hours: number): Date {
  return new Date(lastBoundary(now, hours).getTime() + intervalMs(hours));
}

// ── Reading the database's shape ──────────────────────────────────────────

async function tables(db: Db): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ name: string }[]>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((r) => r.name).filter((t) => !KEEP_TABLES.has(t));
}

async function columns(db: Db): Promise<Map<string, Column[]>> {
  const rows = await db.$queryRawUnsafe<Column[]>(
    `SELECT table_name AS "table", column_name AS "column", data_type AS "type" FROM information_schema.columns
     WHERE table_schema = current_schema() AND is_generated = 'NEVER' ORDER BY table_name, ordinal_position`,
  );
  const map = new Map<string, Column[]>();
  for (const r of rows) map.set(r.table, [...(map.get(r.table) ?? []), r]);
  return map;
}

/** Tables ordered so every table comes after the tables it references. */
export function parentsFirst(names: string[], edges: { child: string; parent: string }[]): string[] {
  const set = new Set(names);
  const needs = new Map(names.map((n) => [n, new Set<string>()]));
  for (const e of edges) if (e.child !== e.parent && set.has(e.child) && set.has(e.parent)) needs.get(e.child)!.add(e.parent);
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < names.length) {
    const ready = names.filter((n) => !done.has(n) && [...needs.get(n)!].every((p) => done.has(p)));
    if (!ready.length) throw new Error(`Foreign keys form a loop between: ${names.filter((n) => !done.has(n)).join(", ")}`);
    for (const n of ready) {
      done.add(n);
      out.push(n);
    }
  }
  return out;
}

async function insertOrder(db: Db, names: string[]): Promise<string[]> {
  const edges = await db.$queryRawUnsafe<{ child: string; parent: string }[]>(
    `SELECT ch.relname AS child, pa.relname AS parent FROM pg_constraint c
     JOIN pg_class ch ON ch.oid = c.conrelid JOIN pg_class pa ON pa.oid = c.confrelid JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.contype = 'f' AND n.nspname = current_schema()`,
  );
  return parentsFirst(names, edges);
}

async function currentDatabase(db: Db): Promise<string> {
  const [row] = await db.$queryRawUnsafe<{ name: string }[]>(`SELECT current_database() AS name`);
  return row!.name;
}

// ── Dump ──────────────────────────────────────────────────────────────────

/** The snapshot as text: `{format, capturedAt, database, timezone, tables: {name: [rows…]}}`. */
export async function dumpDatabase(db: Db, now: Date): Promise<string> {
  const names = (await tables(db)).filter((t) => !UNCAPTURED_TABLES.has(t));
  const parts: string[] = [];
  for (const t of names) {
    // Postgres writes the JSON itself, so bigints and json columns come out exactly.
    const [row] = await db.$queryRawUnsafe<{ rows: string }[]>(`SELECT COALESCE(json_agg(x), '[]'::json)::text AS rows FROM ${q(t)} x`);
    parts.push(`${JSON.stringify(t)}:${row!.rows}`);
  }
  const [tz] = await db.$queryRawUnsafe<{ timezone: string | null }[]>(`SELECT (SELECT timezone FROM accounts ORDER BY "createdAt" LIMIT 1) AS timezone`);
  const head = { format: DUMP_FORMAT, capturedAt: now.toISOString(), database: await currentDatabase(db), timezone: tz?.timezone ?? "Asia/Kolkata" };
  return `${JSON.stringify(head).slice(0, -1)},"tables":{${parts.join(",")}}}`;
}

export function parseDump(text: string): DemoDump {
  const meta = JSON.parse(text) as DumpMeta;
  if (meta.format !== DUMP_FORMAT || !meta.capturedAt || typeof meta.tables !== "object") throw new Error("Not a Setu Retail demo snapshot.");
  return { meta, text };
}

/** Reads the snapshot file (gzip or plain JSON), relative to the project root. */
export function readDumpFile(path: string): DemoDump {
  const buf = readFileSync(resolve(process.cwd(), path));
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return parseDump(text);
}

// ── Restore ───────────────────────────────────────────────────────────────

/** Calendar date in a time zone, as days since 1970 (for shifting DATE columns). */
function dayNumber(at: Date, timeZone: string): number {
  const [y, m, d] = at.toLocaleDateString("en-CA", { timeZone }).split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

export type RestoreResult = { status: "restored"; rows: number; shiftedMs: number } | { status: "busy" } | { status: "fresh" };

export async function lastResetAt(db: Db): Promise<Date | null> {
  const [exists] = await db.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT to_regclass(${`'${STATE_TABLE}'`}) IS NOT NULL AS ok`);
  if (!exists?.ok) return null;
  const [row] = await db.$queryRawUnsafe<{ at: Date }[]>(`SELECT last_reset_at AS at FROM ${q(STATE_TABLE)} WHERE id = 1`);
  return row?.at ?? null;
}

/**
 * Wipe the database and load the snapshot, shifted to `now`. With
 * `skipIfResetSince`, does nothing when another instance already reset after
 * that time (checked under the lock).
 */
export async function restoreDatabase(
  prisma: PrismaClient,
  dump: DemoDump,
  now: Date,
  opts: { expectDb: string; skipIfResetSince?: Date; wait?: boolean },
): Promise<RestoreResult> {
  return prisma.$transaction(
    async (tx) => {
      const name = await currentDatabase(tx);
      if (name !== opts.expectDb) throw new Error(`Refusing to reset database "${name}": DEMO_RESET_EXPECT_DB is "${opts.expectDb}".`);

      if (opts.wait) await tx.$queryRawUnsafe(`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${LOCK_KEY})) l`);
      else {
        const [lock] = await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`);
        if (!lock?.ok) return { status: "busy" } as const;
      }
      if (opts.skipIfResetSince) {
        const last = await lastResetAt(tx);
        if (last && last >= opts.skipIfResetSince) return { status: "fresh" } as const;
      }

      const names = await tables(tx);
      const cols = await columns(tx);
      const order = await insertOrder(tx, names);
      const shiftedMs = Math.max(0, now.getTime() - new Date(dump.meta.capturedAt).getTime());
      const shiftDays = Math.max(0, dayNumber(now, dump.meta.timezone) - dayNumber(new Date(dump.meta.capturedAt), dump.meta.timezone));

      if (names.length) await tx.$executeRawUnsafe(`TRUNCATE ${names.map(q).join(", ")} RESTART IDENTITY CASCADE`);

      // The snapshot goes up once; each table reads its rows from it inside Postgres.
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE _demo_load (doc jsonb) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO _demo_load (doc) VALUES ($1::jsonb)`, dump.text);

      let rows = 0;
      for (const t of order) {
        const dumped = dump.meta.tables[t];
        if (UNCAPTURED_TABLES.has(t) || !Array.isArray(dumped) || !dumped.length) continue;
        // Only the columns the snapshot has: one added by a later migration takes its default.
        const keys = new Set(Object.keys(dumped[0] as object));
        const list = (cols.get(t) ?? []).filter((c) => keys.has(c.column));
        const select = list.map(({ column, type }) => {
          const c = `r.${q(column)}`;
          if (type.startsWith("timestamp")) return `${c} + (${Math.trunc(shiftedMs)}::bigint * interval '1 millisecond')`;
          if (type === "date") return `${c} + ${Math.trunc(shiftDays)}`;
          return c;
        });
        rows += await tx.$executeRawUnsafe(
          `INSERT INTO ${q(t)} (${list.map((c) => q(c.column)).join(", ")})
           SELECT ${select.join(", ")} FROM jsonb_populate_recordset(NULL::${q(t)}, (SELECT doc->'tables'->${`'${t.replace(/'/g, "''")}'`} FROM _demo_load)) r`,
        );
      }

      // Serial columns (e.g. inventory_logs.seq) carry on after the restored rows.
      const serials = await tx.$queryRawUnsafe<{ table: string; column: string; seq: string }[]>(
        `SELECT table_name AS "table", column_name AS "column", pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq
         FROM information_schema.columns WHERE table_schema = current_schema() AND column_default LIKE 'nextval(%'`,
      );
      for (const s of serials) {
        if (!s.seq || KEEP_TABLES.has(s.table)) continue;
        await tx.$executeRawUnsafe(`SELECT setval('${s.seq.replace(/'/g, "''")}', COALESCE((SELECT MAX(${q(s.column)}) FROM ${q(s.table)}), 0) + 1, false)`);
      }

      await tx.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${q(STATE_TABLE)} (id int PRIMARY KEY, last_reset_at timestamptz NOT NULL, captured_at timestamptz NOT NULL)`);
      await tx.$executeRawUnsafe(
        `INSERT INTO ${q(STATE_TABLE)} (id, last_reset_at, captured_at) VALUES (1, $1::timestamptz, $2::timestamptz)
         ON CONFLICT (id) DO UPDATE SET last_reset_at = EXCLUDED.last_reset_at, captured_at = EXCLUDED.captured_at`,
        now.toISOString(),
        dump.meta.capturedAt,
      );
      return { status: "restored", rows, shiftedMs } as const;
    },
    { timeout: 180_000, maxWait: 15_000 },
  );
}

// ── The schedule, per API instance ────────────────────────────────────────

type Log = { info: (o: object, m: string) => void; error: (o: object, m: string) => void };

/**
 * Keeps the demo on schedule. `ensureFresh()` is awaited by every request: it
 * costs nothing until a reset time passes, then one database read, and the
 * reset itself on the instance that gets there first.
 */
export class DemoResetter {
  private freshUntil = 0;
  private running: Promise<void> | null = null;
  private dump: DemoDump | null = null;

  constructor(
    private readonly env: Env,
    private readonly prisma: PrismaClient,
    private readonly now: () => Date,
    private readonly log: Log,
    private readonly load: () => DemoDump = () => readDumpFile(env.DEMO_RESET_DUMP_PATH),
  ) {}

  get resetting() {
    return this.running !== null;
  }

  ensureFresh(): Promise<void> {
    if (this.now().getTime() < this.freshUntil) return Promise.resolve();
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check() {
    const now = this.now();
    const hours = this.env.DEMO_RESET_INTERVAL_HOURS;
    const boundary = lastBoundary(now, hours);
    const next = nextBoundary(now, hours).getTime();
    try {
      const last = await lastResetAt(this.prisma);
      if (last && last >= boundary) {
        this.freshUntil = next;
        return;
      }
      this.dump ??= this.load();
      const result = await restoreDatabase(this.prisma, this.dump, now, { expectDb: this.env.DEMO_RESET_EXPECT_DB!, skipIfResetSince: boundary });
      // Another instance is mid-reset: look again in a few seconds.
      this.freshUntil = result.status === "busy" ? now.getTime() + 5_000 : next;
      if (result.status === "restored") this.log.info({ rows: result.rows, shiftedMs: result.shiftedMs }, "demo data restored");
    } catch (err) {
      // Never fail the visitor's request over it; try again in a minute.
      this.freshUntil = now.getTime() + 60_000;
      this.log.error({ err }, "demo reset failed");
    }
  }
}
