import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { corsOrigins, type Env } from "./config/env.js";
import type { Ctx } from "./context.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { AppError, errorHandler, notFound } from "./http/errors.js";
import { LogMailer, type Mailer } from "./mail/mailer.js";
import { buildOpenApiDocument } from "./openapi.js";
import { accountRouter } from "./routes/account.js";
import { authRouter } from "./routes/auth.js";
import { branchesRouter } from "./routes/branches.js";
import { healthRouter } from "./routes/health.js";
import { staffRouter } from "./routes/staff.js";
import { catalogueRouter } from "./routes/catalogue.js";
import { customersRouter } from "./routes/customers.js";
import { ordersRouter } from "./routes/orders.js";
import { settingsRouter } from "./routes/settings.js";
import { reportsRouter } from "./routes/reports.js";
import { importsRouter } from "./routes/imports.js";
import { syncRouter } from "./routes/sync.js";
import { auditContext } from "./services/audit.js";
import { booksRouter } from "./routes/books.js";
import { purchasesRouter } from "./routes/purchases.js";
import { toolReportsRouter } from "./routes/toolReports.js";
import { receiptsRouter } from "./routes/receipts.js";
import { transfersRouter } from "./routes/transfers.js";
import { branchReportsRouter } from "./routes/branchReports.js";
import { VERSION } from "./version.js";

export type AppDeps = {
  env: Env;
  /** Omitted in unit tests that don't touch the database; data routes then answer 503. */
  prisma?: PrismaClient;
  mailer?: Mailer;
  now?: () => Date;
  /** Pings the database; omitted when no database is configured. */
  checkDb?: () => Promise<void>;
};

export function createApp({ env, prisma, mailer, now, checkDb }: AppDeps): Express {
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

  // Imports (CSV rows, free POS backups) can be large; everything else stays small.
  app.use("/imports", express.json({ limit: "15mb" }));
  app.use("/sync", express.json({ limit: "5mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(auditContext);
  app.use(pinoHttp({ level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL }));

  app.use(healthRouter(checkDb));

  const openApi = buildOpenApiDocument(VERSION);
  app.get("/openapi.json", (_req, res) => {
    res.json(openApi);
  });

  if (prisma) {
    const ctx: Ctx = { env, prisma, mailer: mailer ?? new LogMailer(), now: now ?? (() => new Date()) };
    app.use(authRouter(ctx, allowed));
    app.use(accountRouter(ctx));
    app.use(branchesRouter(ctx));
    app.use(staffRouter(ctx));
    app.use(settingsRouter(ctx));
    app.use(receiptsRouter(ctx));
    app.use(catalogueRouter(ctx));
    app.use(customersRouter(ctx));
    app.use(ordersRouter(ctx));
    app.use(reportsRouter(ctx));
    app.use(toolReportsRouter(ctx));
    app.use(branchReportsRouter(ctx));
    app.use(transfersRouter(ctx));
    app.use(importsRouter(ctx));
    app.use(booksRouter(ctx));
    app.use(purchasesRouter(ctx));
    app.use(syncRouter(ctx));
  } else {
    app.use(["/auth", "/me", "/account", "/branches", "/staff", "/settings", "/payment-methods", "/counters", "/categories", "/products", "/customers", "/orders", "/held-carts", "/reports", "/batches", "/imports", "/sync", "/suppliers", "/expenses", "/expense-categories", "/ledger", "/cash-book", "/purchases", "/purchase-returns", "/receipt-templates", "/transfers", "/audit-log"], (_req, _res, next) =>
      next(new AppError(503, "db_not_configured", "Database is not configured.")),
    );
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
