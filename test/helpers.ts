import { createApp, type AppDeps } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

export function testApp(overrides: Partial<AppDeps> = {}) {
  const env = loadEnv({ NODE_ENV: "test", CORS_ORIGINS: "https://app.retail-pos.setutechnology.com" });
  return createApp({ env, ...overrides });
}
