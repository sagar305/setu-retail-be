// Idempotency-Key for changes (Phase 9b). Devices save changes locally and
// send them later, possibly more than once (a timeout, a second tab, a retry
// after the app closed). With the same key, the first answer is returned again
// instead of applying the change twice.
//
// - Only for signed-in requests that change something (not GET), and only when
//   the client sends the header. The key is tied to the user who sent it.
// - A request still running under the key → 409 "in_progress" (try later).
// - Server errors (5xx) are not remembered, so a retry runs again.
// - Kept 7 days (pruned by the daily job).
import type { Request, RequestHandler, Response } from "express";
import type { Ctx } from "../context.js";
import { isUniqueViolation } from "../db/errors.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { AppError } from "./errors.js";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_KEEP_DAYS = 7;
const KEY = /^[A-Za-z0-9_-]{16,80}$/;

export function idempotency(ctx: Ctx): RequestHandler {
  return async (req: Request, res: Response, next) => {
    const key = req.get(IDEMPOTENCY_HEADER);
    if (!key || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!KEY.test(key)) return next(new AppError(400, "bad_idempotency_key", "Idempotency-Key must be 16–80 letters, digits, - or _."));
    const header = req.get("authorization") ?? "";
    const claims = header.startsWith("Bearer ") ? await verifyAccessToken(header.slice(7), ctx.env.JWT_SECRET, ctx.now()) : null;
    if (!claims) return next(); // the route answers 401 itself; nothing to remember
    const path = req.originalUrl.split("?")[0]!;

    try {
      const existing = await ctx.prisma.idempotencyKey.findUnique({ where: { key } });
      if (existing) {
        if (existing.userId !== claims.sub || existing.method !== req.method || existing.path !== path) {
          return next(new AppError(422, "idempotency_key_reused", "This change id was already used for something else."));
        }
        if (existing.status === null) return next(new AppError(409, "in_progress", "This change is still being saved. Try again in a moment."));
        res.set("Idempotent-Replay", "true");
        if (existing.status === 204) return void res.status(204).end();
        return void res.status(existing.status).json(existing.body);
      }
      await ctx.prisma.idempotencyKey.create({ data: { key, userId: claims.sub, method: req.method, path, createdAt: ctx.now() } });
    } catch (err) {
      if (isUniqueViolation(err)) return next(new AppError(409, "in_progress", "This change is still being saved. Try again in a moment."));
      return next(err);
    }

    // Remember the answer once it's sent.
    let body: unknown = null;
    const json = res.json.bind(res);
    res.json = (b: unknown) => {
      body = b;
      return json(b);
    };
    res.on("finish", () => {
      const status = res.statusCode;
      const done = status >= 500 ? ctx.prisma.idempotencyKey.delete({ where: { key } }) : ctx.prisma.idempotencyKey.update({ where: { key }, data: { status, body: (body ?? undefined) as never } });
      done.catch(() => {});
    });
    next();
  };
}

export async function pruneIdempotencyKeys(ctx: Ctx): Promise<number> {
  const r = await ctx.prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(ctx.now().getTime() - IDEMPOTENCY_KEEP_DAYS * 86_400_000) } } });
  return r.count;
}
