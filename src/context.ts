import type { Env } from "./config/env.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import type { Mailer } from "./mail/mailer.js";

/** Everything a route needs, injected so tests can swap the database, mail and clock. */
export type Ctx = {
  env: Env;
  prisma: PrismaClient;
  mailer: Mailer;
  now: () => Date;
};
