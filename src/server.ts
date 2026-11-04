// Local development server. On Vercel the app is served by api/index.ts.
import "dotenv/config";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { checkDatabase } from "./db/client.js";

const env = loadEnv();
const app = createApp({ env, checkDb: env.DATABASE_URL ? checkDatabase : undefined });

app.listen(env.PORT, () => {
  console.log(`Setu Retail API listening on http://localhost:${env.PORT}`);
});
