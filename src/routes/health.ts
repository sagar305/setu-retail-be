import { Router } from "express";
import { AppError } from "../http/errors.js";
import { VERSION } from "../version.js";

export function healthRouter(checkDb?: () => Promise<void>): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "setu-retail-be", version: VERSION, time: new Date().toISOString() });
  });

  router.get("/health/db", async (req, res, next) => {
    if (!checkDb) return next(new AppError(503, "db_not_configured", "Database is not configured."));
    try {
      await checkDb();
      res.json({ status: "ok" });
    } catch (err) {
      req.log?.warn({ err }, "database check failed");
      next(new AppError(503, "db_unreachable", "Database is unreachable."));
    }
  });

  return router;
}
