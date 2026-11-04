// Vercel serverless entry: every request is rewritten here (see vercel.json).
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { checkDatabase } from "../src/db/client.js";

const env = loadEnv();

export default createApp({ env, checkDb: env.DATABASE_URL ? checkDatabase : undefined });
