import { Router, type RequestHandler } from "express";
import type { Env } from "../config/env.js";
import { nextBoundary, type DemoResetter } from "../services/demoReset.js";

/**
 * Runs before every request on the demo deployment so the data is reset on
 * schedule (see services/demoReset.ts). Health checks don't trigger it.
 */
export function demoResetMiddleware(resetter: DemoResetter): RequestHandler {
  return (req, _res, next) => {
    if (req.path.startsWith("/health") || req.path === "/openapi.json") return next();
    resetter.ensureFresh().then(() => next(), next);
  };
}

/** When the demo data is next wiped, for the countdown in the web app. Off everywhere but the demo. */
export function demoRouter(env: Env, now: () => Date, resetter?: DemoResetter): Router {
  const router = Router();
  router.get("/demo/reset", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!env.DEMO_RESET_ENABLED || !resetter) {
      res.json({ enabled: false, intervalHours: null, nextResetAt: null, secondsUntilReset: null, resetting: false, lastResetAt: null, loadedSnapshotAt: null, deployedSnapshotAt: null, problem: null });
      return;
    }
    const at = now();
    const next = nextBoundary(at, env.DEMO_RESET_INTERVAL_HOURS);
    res.json({
      enabled: true,
      intervalHours: env.DEMO_RESET_INTERVAL_HOURS,
      nextResetAt: next.toISOString(),
      secondsUntilReset: Math.max(0, Math.ceil((next.getTime() - at.getTime()) / 1000)),
      resetting: resetter.resetting,
      ...(await resetter.describe()),
    });
  });
  return router;
}
