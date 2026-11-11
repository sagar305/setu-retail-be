// Demo reset (demo deployment only).
//
// A public demo fills up with whatever visitors type into it. The demo shop is
// kept as a snapshot (`npm run demo:dump`), and every DEMO_RESET_INTERVAL_HOURS
// the database is wiped and that snapshot restored.
//
// - Vercel has no long-running process, so there is no timer: the first request
//   after a reset time (daily at 00:00 UTC by default) starts the reset in the
//   background (routes/demo.ts). Nobody visiting means nothing to reset. A
//   newly deployed snapshot is loaded at once.
// - Every timestamp and date is moved forward by the time since the snapshot,
//   so the bills from "today" in the snapshot are today's bills again, the plan
//   never runs out and expiry dates stay ahead.
// - It all runs in one transaction under an advisory lock: other requests see
//   the old data until the new data is in, and only one instance resets.
// - It refuses to touch a database whose name isn't DEMO_RESET_EXPECT_DB, or
//   one with shops in it that was never marked as the demo's (Prisma Postgres
//   names every database "postgres", so the name alone can't tell them apart).
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { resolve } from "node:path";
import { createGunzip } from "node:zlib";
import type { Env } from "../config/env.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export const DUMP_FORMAT = 2;
/** Rows per snapshot line: each line is one upload, so none gets big. */
const CHUNK_ROWS = 2_000;
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

/**
 * The snapshot file (gzip): one JSON line of metadata, then lines of
 * `{"t": table, "rows": [up to CHUNK_ROWS rows]}`, parent tables first. The
 * file is streamed: only the metadata line is read to check which snapshot is
 * deployed, and during a restore each line goes to Postgres as it is (no JSON
 * parsing in Node, so bigints stay exact and memory stays low).
 */
export type DumpMeta = { format: number; capturedAt: string; database: string; timezone: string; counts: Record<string, number> };
export type DemoDump = { meta: DumpMeta; lines: () => AsyncIterable<string> };

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

/** The snapshot, line by line (see DemoDump): metadata first, then rows, parent tables first. */
export async function* dumpLines(db: Db, now: Date): AsyncGenerator<string> {
  const names = await insertOrder(db, (await tables(db)).filter((t) => !UNCAPTURED_TABLES.has(t)));
  const counts: Record<string, number> = {};
  for (const t of names) {
    const [row] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${q(t)}`);
    counts[t] = row?.n ?? 0;
  }
  const [tz] = await db.$queryRawUnsafe<{ timezone: string | null }[]>(`SELECT (SELECT timezone FROM accounts ORDER BY "createdAt" LIMIT 1) AS timezone`);
  const meta: DumpMeta = { format: DUMP_FORMAT, capturedAt: now.toISOString(), database: await currentDatabase(db), timezone: tz?.timezone ?? "Asia/Kolkata", counts };
  yield JSON.stringify(meta);
  for (const t of names) {
    for (let offset = 0; offset < counts[t]!; offset += CHUNK_ROWS) {
      // Postgres writes the JSON itself, so bigints and json columns come out exactly.
      const [row] = await db.$queryRawUnsafe<{ line: string }[]>(
        // jsonb: one line per chunk (json_agg puts line breaks between rows), bigints exact.
        `SELECT jsonb_build_object('t', ${`'${t.replace(/'/g, "''")}'`}, 'rows', jsonb_agg(to_jsonb(x)))::text AS line
         FROM (SELECT * FROM ${q(t)} ORDER BY ctid LIMIT ${CHUNK_ROWS} OFFSET ${offset}) x`,
      );
      if (row?.line) yield row.line;
    }
  }
}

/** The whole snapshot as one string (tests, small databases). */
export async function dumpDatabase(db: Db, now: Date): Promise<string> {
  const out: string[] = [];
  for await (const line of dumpLines(db, now)) out.push(line);
  return out.join("\n") + "\n";
}

function parseMeta(line: string | undefined): DumpMeta {
  const meta = (line ? JSON.parse(line) : null) as DumpMeta | null;
  if (!meta || meta.format !== DUMP_FORMAT || !meta.capturedAt) throw new Error("Not a Setu Retail demo snapshot (re-capture it with npm run demo:dump).");
  return meta;
}

/** A snapshot held in memory (tests). */
export function parseDump(text: string): DemoDump {
  const lines = text.split("\n").filter(Boolean);
  const meta = parseMeta(lines[0]);
  return {
    meta,
    lines: async function* () {
      yield* lines.slice(1);
    },
  };
}

/** Lines of the snapshot file (gzip or plain), streamed. */
async function* fileLines(file: string): AsyncGenerator<string> {
  const head = Buffer.alloc(2);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  const raw = createReadStream(file);
  const input = head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(createGunzip()) : raw;
  // Read a piece only once the last line is in: the file never piles up in memory.
  const decoder = new StringDecoder("utf8");
  let rest = "";
  try {
    for await (const piece of input as AsyncIterable<Buffer>) {
      rest += decoder.write(piece);
      let at: number;
      while ((at = rest.indexOf("\n")) !== -1) {
        const line = rest.slice(0, at);
        rest = rest.slice(at + 1);
        if (line) yield line;
      }
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    raw.destroy();
  }
}

/** The snapshot file, relative to the project root: reads only its first line now, the rest when restoring. */
export async function readDumpFile(path: string): Promise<DemoDump> {
  const file = resolve(process.cwd(), path);
  let first: string | undefined;
  for await (const line of fileLines(file)) {
    first = line;
    break;
  }
  return {
    meta: parseMeta(first),
    lines: async function* () {
      let skipped = false;
      for await (const line of fileLines(file)) {
        if (skipped) yield line;
        skipped = true;
      }
    },
  };
}

// ── Restore ───────────────────────────────────────────────────────────────

/** Calendar date in a time zone, as days since 1970 (for shifting DATE columns). */
function dayNumber(at: Date, timeZone: string): number {
  const [y, m, d] = at.toLocaleDateString("en-CA", { timeZone }).split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

export type RestoreResult = { status: "restored"; rows: number; shiftedMs: number } | { status: "busy" } | { status: "fresh" };

/** When the demo was last reset, and from which snapshot (null before the first reset). */
export async function demoState(db: Db): Promise<{ lastResetAt: Date; capturedAt: Date } | null> {
  const [exists] = await db.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT to_regclass(${`'${STATE_TABLE}'`}) IS NOT NULL AS ok`);
  if (!exists?.ok) return null;
  const [row] = await db.$queryRawUnsafe<{ at: Date; captured: Date }[]>(`SELECT last_reset_at AS at, captured_at AS captured FROM ${q(STATE_TABLE)} WHERE id = 1`);
  return row ? { lastResetAt: row.at, capturedAt: row.captured } : null;
}

export async function lastResetAt(db: Db): Promise<Date | null> {
  return (await demoState(db))?.lastResetAt ?? null;
}

/**
 * Nothing to do: reset in this window, from the snapshot now deployed. A newly
 * deployed snapshot is loaded at once rather than at the next reset time.
 */
export function isFresh(state: { lastResetAt: Date; capturedAt: Date } | null, since: Date, dump: DemoDump): boolean {
  return Boolean(state && state.lastResetAt >= since && state.capturedAt.getTime() === new Date(dump.meta.capturedAt).getTime());
}

/**
 * Marks a database as the demo's, so resets may wipe it even though it has
 * shops in it (the seeder and `demo:restore --mark-demo` call this).
 */
export async function markAsDemo(db: Db, at: Date, capturedAt: Date = at): Promise<void> {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${q(STATE_TABLE)} (id int PRIMARY KEY, last_reset_at timestamptz NOT NULL, captured_at timestamptz NOT NULL)`);
  await db.$executeRawUnsafe(
    `INSERT INTO ${q(STATE_TABLE)} (id, last_reset_at, captured_at) VALUES (1, $1::timestamptz, $2::timestamptz)
     ON CONFLICT (id) DO UPDATE SET last_reset_at = EXCLUDED.last_reset_at, captured_at = EXCLUDED.captured_at`,
    at.toISOString(),
    capturedAt.toISOString(),
  );
}

/**
 * Second guard, for hosts where every database has the same name (Prisma
 * Postgres, Supabase: "postgres"): a database with shops in it is only wiped
 * if it was marked as the demo's. An empty, freshly migrated one is fine.
 */
async function assertDemoDatabase(db: Db, name: string, allowUnmarked: boolean) {
  const [marked] = await db.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT to_regclass(${`'${STATE_TABLE}'`}) IS NOT NULL AS ok`);
  if (marked?.ok || allowUnmarked) return;
  const [hasAccounts] = await db.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT to_regclass('accounts') IS NOT NULL AS ok`);
  if (!hasAccounts?.ok) return;
  const [row] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM accounts`);
  if ((row?.n ?? 0) > 0) {
    throw new Error(
      `Refusing to reset database "${name}": it has shops in it and was never set up as the demo. If it really is the demo database, run \`npm run demo:restore -- --yes --mark-demo\` once.`,
    );
  }
}

/**
 * Wipe the database and load the snapshot, shifted to `now`. With
 * `skipIfResetSince`, does nothing when another instance already reset after
 * that time from this same snapshot (checked under the lock).
 */
export async function restoreDatabase(
  prisma: PrismaClient,
  dump: DemoDump,
  now: Date,
  opts: { expectDb: string; skipIfResetSince?: Date; wait?: boolean; allowUnmarked?: boolean },
): Promise<RestoreResult> {
  return prisma.$transaction(
    async (tx) => {
      const name = await currentDatabase(tx);
      if (name !== opts.expectDb) throw new Error(`Refusing to reset database "${name}": DEMO_RESET_EXPECT_DB is "${opts.expectDb}".`);
      await assertDemoDatabase(tx, name, opts.allowUnmarked ?? false);

      if (opts.wait) await tx.$queryRawUnsafe(`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${LOCK_KEY})) l`);
      else {
        const [lock] = await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`);
        if (!lock?.ok) return { status: "busy" } as const;
      }
      if (opts.skipIfResetSince && isFresh(await demoState(tx), opts.skipIfResetSince, dump)) return { status: "fresh" } as const;

      const names = await tables(tx);
      const cols = await columns(tx);
      const shiftedMs = Math.max(0, now.getTime() - new Date(dump.meta.capturedAt).getTime());
      const shiftDays = Math.max(0, dayNumber(now, dump.meta.timezone) - dayNumber(new Date(dump.meta.capturedAt), dump.meta.timezone));

      if (names.length) await tx.$executeRawUnsafe(`TRUNCATE ${names.map(q).join(", ")} RESTART IDENTITY CASCADE`);

      // Lines come parents first (the order of the snapshot), one upload each.
      const known = new Set(names);
      const sqlFor = new Map<string, string>();
      let rows = 0;
      for await (const line of dump.lines()) {
        const t = /^\{"t"\s*:\s*"([^"]+)"/.exec(line)?.[1];
        if (!t) throw new Error("Damaged demo snapshot line.");
        if (UNCAPTURED_TABLES.has(t) || !known.has(t)) continue;
        let sql = sqlFor.get(t);
        if (!sql) {
          // Only the columns the snapshot has: one added by a later migration takes its default.
          const keyRows = await tx.$queryRawUnsafe<{ k: string }[]>(`SELECT jsonb_object_keys(($1::jsonb)->'rows'->0) AS k`, line);
          const keys = new Set(keyRows.map((r) => r.k));
          const list = (cols.get(t) ?? []).filter((c) => keys.has(c.column));
          const select = list.map(({ column, type }) => {
            const c = `r.${q(column)}`;
            if (type.startsWith("timestamp")) return `${c} + (${Math.trunc(shiftedMs)}::bigint * interval '1 millisecond')`;
            if (type === "date") return `${c} + ${Math.trunc(shiftDays)}`;
            return c;
          });
          sql = `INSERT INTO ${q(t)} (${list.map((c) => q(c.column)).join(", ")})
           SELECT ${select.join(", ")} FROM jsonb_populate_recordset(NULL::${q(t)}, ($1::jsonb)->'rows') r`;
          sqlFor.set(t, sql);
        }
        rows += await tx.$executeRawUnsafe(sql, line);
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

      await markAsDemo(tx, now, new Date(dump.meta.capturedAt));
      return { status: "restored", rows, shiftedMs } as const;
    },
    // A big snapshot over the network takes a while; Vercel allows the function 300 s.
    { timeout: 280_000, maxWait: 15_000 },
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
  /** Why the last reset didn't happen, as a short code for /demo/reset (never the raw message). */
  private problem: string | null = null;
  private running: Promise<void> | null = null;
  private dump: DemoDump | null = null;

  constructor(
    private readonly env: Env,
    private readonly prisma: PrismaClient,
    private readonly now: () => Date,
    private readonly log: Log,
    private readonly load: () => DemoDump | Promise<DemoDump> = () => readDumpFile(env.DEMO_RESET_DUMP_PATH),
  ) {}

  private restoring = false;

  /** True only while the data is actually being replaced (not during the quick freshness check). */
  get resetting() {
    return this.restoring;
  }

  /** What's loaded now, for /demo/reset (helps check a demo deploy from a browser). */
  async describe() {
    const state = await demoState(this.prisma).catch(() => null);
    let deployed: string | null;
    try {
      this.dump ??= await this.load();
      deployed = this.dump.meta.capturedAt;
    } catch {
      deployed = null;
    }
    return {
      lastResetAt: state?.lastResetAt.toISOString() ?? null,
      loadedSnapshotAt: state?.capturedAt.toISOString() ?? null,
      deployedSnapshotAt: deployed ? new Date(deployed).toISOString() : null,
      problem: this.problem,
    };
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
      this.dump ??= await this.load();
      if (isFresh(await demoState(this.prisma), boundary, this.dump)) {
        this.freshUntil = next;
        return;
      }
      this.restoring = true;
      const result = await restoreDatabase(this.prisma, this.dump, now, { expectDb: this.env.DEMO_RESET_EXPECT_DB!, skipIfResetSince: boundary }).finally(() => {
        this.restoring = false;
      });
      // Another instance is mid-reset: look again in a few seconds.
      this.freshUntil = result.status === "busy" ? now.getTime() + 5_000 : next;
      this.problem = null;
      if (result.status === "restored") this.log.info({ rows: result.rows, shiftedMs: result.shiftedMs }, "demo data restored");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.problem = /DEMO_RESET_EXPECT_DB/.test(message)
        ? "wrong_database_name"
        : /never set up as the demo/.test(message)
          ? "database_has_real_shops"
          : /ENOENT|snapshot/i.test(message)
            ? "snapshot_missing"
            : "reset_failed";
      // Never fail the visitor's request over it; try again in a minute.
      this.freshUntil = now.getTime() + 60_000;
      this.log.error({ err }, "demo reset failed");
    }
  }
}
