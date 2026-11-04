import { createApp } from "./app.js";
import type { Env } from "./config/env.js";
import { checkDatabase, getPrisma } from "./db/client.js";
import { LogMailer, ResendMailer } from "./mail/mailer.js";

/** The real app: Postgres, Resend (or the log in dev), the system clock. */
export function buildApp(env: Env) {
  const hasDb = Boolean(env.DATABASE_URL);
  return createApp({
    env,
    prisma: hasDb ? getPrisma() : undefined,
    mailer: env.RESEND_API_KEY ? new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM) : new LogMailer(),
    checkDb: hasDb ? checkDatabase : undefined,
  });
}
