// Captures the demo database as the snapshot the demo resets to:
//
//   DATABASE_URL=<demo db> DEMO_RESET_EXPECT_DB=<its name> npm run demo:dump
//
// Writes DEMO_RESET_DUMP_PATH (default demo-dump/demo.json.gz). Commit it;
// the next deploy of the demo picks it up. Sign-ins, rate limits and the Setu
// team's admin logins are never captured.
import "dotenv/config";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { loadEnv } from "../src/config/env.js";
import { getPrisma } from "../src/db/client.js";
import { dumpLines, type DumpMeta } from "../src/services/demoReset.js";

const env = loadEnv({ ...process.env, DEMO_RESET_ENABLED: "0" });
const prisma = getPrisma();
try {
  const [{ name }] = (await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT current_database() AS name`)) as [{ name: string }];
  if (env.DEMO_RESET_EXPECT_DB !== name) {
    console.error(`Refusing to dump "${name}": set DEMO_RESET_EXPECT_DB=${name} to confirm it's the demo database.`);
    process.exit(1);
  }
  const file = resolve(process.cwd(), env.DEMO_RESET_DUMP_PATH);
  mkdirSync(dirname(file), { recursive: true });
  let meta: DumpMeta | undefined;
  // Streamed straight into the gzip file, so a big shop never sits in memory.
  async function* lines() {
    for await (const line of dumpLines(prisma, new Date())) {
      meta ??= JSON.parse(line) as DumpMeta;
      yield line + "\n";
    }
  }
  await pipeline(Readable.from(lines()), createGzip({ level: 9 }), createWriteStream(file));
  if (!meta) throw new Error("Nothing was written.");
  const counts = Object.entries(meta.counts).filter(([, n]) => n > 0);
  console.log(`Wrote ${env.DEMO_RESET_DUMP_PATH} (${(statSync(file).size / 1_048_576).toFixed(1)} MB): ${counts.map(([t, n]) => `${t} ${n}`).join(", ")}`);
} finally {
  await prisma.$disconnect();
}
