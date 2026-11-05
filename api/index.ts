// Vercel serverless entry: every request is rewritten here (see vercel.json).
import { buildApp } from "../src/bootstrap.js";
import { loadEnv } from "../src/config/env.js";

export default buildApp(loadEnv());
