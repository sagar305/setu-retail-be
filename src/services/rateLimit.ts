// Rate limits for sign-in, sign-up and email endpoints, counted in Postgres so
// every serverless instance shares them (docs/PLAN.md, Phase 8).
//
// Fixed windows: the first hit starts the window, and each hit after the
// limit gets 429 with Retry-After until the window resets. Keys are SHA-256
// hashes of rule + IP or email, so the table holds no personal data.
// Per-login lockouts (5 wrong passwords → 15 minutes) still apply on top.
import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { Ctx } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";

export type Rule = {
  /** Short name, part of the key. */
  name: string;
  max: number;
  windowSeconds: number;
  /** What is counted: the IP, an email from the body… null skips the rule. */
  by: (req: Request) => string | null | undefined;
};

const MIN = 60;
const lower = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);
const byIp = (req: Request) => req.ip ?? null;
const byBody = (field: string) => (req: Request) => lower((req.body as Record<string, unknown> | undefined)?.[field]);

/** The limits, in one place. IP limits are generous: a whole shop (or office) may share one IP. */
export const RULES = {
  login: [
    { name: "login-ip", max: 60, windowSeconds: 15 * MIN, by: byIp },
    { name: "login-id", max: 20, windowSeconds: 15 * MIN, by: byBody("login") },
  ],
  signup: [{ name: "signup-ip", max: 10, windowSeconds: 60 * MIN, by: byIp }],
  emailLink: [
    { name: "email-ip", max: 20, windowSeconds: 60 * MIN, by: byIp },
    { name: "email-to", max: 5, windowSeconds: 60 * MIN, by: byBody("email") },
  ],
  token: [{ name: "token-ip", max: 30, windowSeconds: 15 * MIN, by: byIp }],
  adminLogin: [
    { name: "admin-ip", max: 20, windowSeconds: 15 * MIN, by: byIp },
    { name: "admin-id", max: 10, windowSeconds: 15 * MIN, by: byBody("email") },
  ],
  adminCode: [{ name: "admin-code-ip", max: 20, windowSeconds: 15 * MIN, by: byIp }],
} satisfies Record<string, Rule[]>;

const keyOf = (rule: string, who: string) => createHash("sha256").update(`${rule}\n${who}`).digest("hex");

/** Count one hit; returns seconds to wait when over the limit, else 0. */
export async function hit(ctx: Ctx, rule: Rule, who: string): Promise<number> {
  const now = ctx.now();
  const resetAt = new Date(now.getTime() + rule.windowSeconds * 1000);
  const [row] = await ctx.prisma.$queryRaw<{ count: number; resetAt: Date }[]>(Prisma.sql`
    INSERT INTO rate_limits (key, count, "resetAt") VALUES (${keyOf(rule.name, who)}, 1, ${resetAt})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits."resetAt" <= ${now} THEN 1 ELSE rate_limits.count + 1 END,
      "resetAt" = CASE WHEN rate_limits."resetAt" <= ${now} THEN ${resetAt} ELSE rate_limits."resetAt" END
    RETURNING count, "resetAt"`);
  if (!row || row.count <= rule.max) return 0;
  return Math.max(1, Math.ceil((row.resetAt.getTime() - now.getTime()) / 1000));
}

export function rateLimit(ctx: Ctx, rules: readonly Rule[]): RequestHandler {
  return async (req, res, next) => {
    if (ctx.env.RATE_LIMITS === "off") return next();
    try {
      for (const rule of rules) {
        const who = rule.by(req);
        if (!who) continue;
        const wait = await hit(ctx, rule, who);
        if (wait) {
          res.set("Retry-After", String(wait));
          const minutes = Math.ceil(wait / 60);
          return next(new AppError(429, "rate_limited", `Too many tries. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`, { retryAfterSeconds: wait }));
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Daily clean-up of finished windows. */
export async function pruneRateLimits(ctx: Ctx): Promise<number> {
  const r = await ctx.prisma.rateLimit.deleteMany({ where: { resetAt: { lt: ctx.now() } } });
  return r.count;
}
