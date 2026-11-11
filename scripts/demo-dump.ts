// Captures the demo database as the snapshot the demo resets to:
//
//   DATABASE_URL=<demo db> DEMO_RESET_EXPECT_DB=<its name> npm run demo:dump
//
// Writes DEMO_RESET_DUMP_PATH (default demo-dump/demo.json.gz). Commit it;
// the next deploy of the demo picks it up. Sign-ins, rate limits and the Setu
// team's admin logins are never captured.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadEnv } from "../src/config/env.js";
import { getPrisma } from "../src/db/client.js";
import { dumpDatabase, parseDump } from "../src/services/demoReset.js";

const env = loadEnv({ ...process.env, DEMO_RESET_ENABLED: "0" });
const prisma = getPrisma();
try {
  const [{ name }] = (await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT current_database() AS name`)) as [{ name: string }];
  if (env.DEMO_RESET_EXPECT_DB !== name) {
    console.error(`Refusing to dump "${name}": set DEMO_RESET_EXPECT_DB=${name} to confirm it's the demo database.`);
    process.exit(1);
  }
  const text = await dumpDatabase(prisma, new Date());
  const { meta } = parseDump(text);
  const file = resolve(process.cwd(), env.DEMO_RESET_DUMP_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, gzipSync(text, { level: 9 }));
  const counts = Object.entries(meta.tables)
    .map(([t, rows]) => [t, (rows as unknown[]).length] as const)
    .filter(([, n]) => n > 0);
  console.log(`Wrote ${env.DEMO_RESET_DUMP_PATH}: ${counts.map(([t, n]) => `${t} ${n}`).join(", ")}`);
} finally {
  await prisma.$disconnect();
}
