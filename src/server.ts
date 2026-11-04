// Local development server. On Vercel the app is served by api/index.ts.
import "dotenv/config";
import { buildApp } from "./bootstrap.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
buildApp(env).listen(env.PORT, () => {
  console.log(`Setu Retail API listening on http://localhost:${env.PORT}`);
});
