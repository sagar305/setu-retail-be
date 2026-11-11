// Resets the demo by hand, without waiting for the next reset time:
//
//   DATABASE_URL=<demo db> DEMO_RESET_EXPECT_DB=<its name> npm run demo:restore -- --yes
//
// Wipes EVERYTHING in that database and loads the snapshot, dated to now.
import "dotenv/config";
import { loadEnv } from "../src/config/env.js";
import { getPrisma } from "../src/db/client.js";
import { readDumpFile, restoreDatabase } from "../src/services/demoReset.js";

if (!process.argv.includes("--yes")) {
  console.error("This wipes the whole database and restores the demo snapshot. Run again with --yes.");
  process.exit(1);
}
const env = loadEnv({ ...process.env, DEMO_RESET_ENABLED: "0" });
if (!env.DEMO_RESET_EXPECT_DB) {
  console.error("Set DEMO_RESET_EXPECT_DB to the demo database's name.");
  process.exit(1);
}
const prisma = getPrisma();
try {
  const dump = readDumpFile(env.DEMO_RESET_DUMP_PATH);
  const result = await restoreDatabase(prisma, dump, new Date(), { expectDb: env.DEMO_RESET_EXPECT_DB, wait: true });
  console.log(result.status === "restored" ? `Restored ${result.rows} rows from the snapshot of ${dump.meta.capturedAt}.` : result.status);
} finally {
  await prisma.$disconnect();
}
