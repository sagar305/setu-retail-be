import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { corsOrigins, type Env } from "./config/env.js";
import { errorHandler, notFound } from "./http/errors.js";
import { buildOpenApiDocument } from "./openapi.js";
import { healthRouter } from "./routes/health.js";
import { VERSION } from "./version.js";

export type AppDeps = {
  env: Env;
  /** Pings the database; omitted when no database is configured. */
  checkDb?: () => Promise<void>;
};

export function createApp({ env, checkDb }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // Vercel (and most hosts) sit behind one proxy hop.
  app.set("trust proxy", 1);

  app.use(helmet());

  const allowed = new Set(corsOrigins(env));
  app.use(
    cors({
      // Requests with no Origin (curl, server-to-server) are allowed; browsers
      // must come from a listed origin.
      origin: (origin, done) => done(null, !origin || allowed.has(origin)),
      credentials: true,
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL }));

  app.use(healthRouter(checkDb));

  const openApi = buildOpenApiDocument(VERSION);
  app.get("/openapi.json", (_req, res) => {
    res.json(openApi);
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
