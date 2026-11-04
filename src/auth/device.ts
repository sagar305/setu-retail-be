// A counter's device key: "<counterId>.<secret>", sent as X-Device-Key.
// It can only read its branch's offline pack and push that counter's bills,
// so a counter can sync even when the person signed in offline with a PIN.
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Ctx } from "../context.js";
import type { Account, Branch, Counter } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import { hashToken, newToken } from "../lib/tokens.js";
import { planState, type PlanState } from "../services/plans.js";

export type DeviceContext = { counter: Counter; branch: Branch; account: Account; plan: PlanState };

declare module "express-serve-static-core" {
  interface Request {
    device?: DeviceContext;
  }
}

export function newDeviceKey(counterId: string) {
  const secret = newToken();
  return { key: `${counterId}.${secret}`, hash: hashToken(secret) };
}

export function deviceAuth(ctx: Ctx): RequestHandler {
  return async (req, _res, next) => {
    const raw = req.get("x-device-key") ?? "";
    const dot = raw.indexOf(".");
    const id = raw.slice(0, dot);
    const secret = raw.slice(dot + 1);
    if (dot < 1 || !/^[0-9a-f-]{36}$/i.test(id) || !secret) return next(new AppError(401, "device_key_missing", "This counter needs to be set up again. Open Billing while online."));
    const counter = await ctx.prisma.counter.findUnique({ where: { id }, include: { branch: { include: { account: true } } } });
    const want = counter?.deviceKeyHash ? Buffer.from(counter.deviceKeyHash, "hex") : null;
    const got = Buffer.from(hashToken(secret), "hex");
    if (!counter || !want || want.length !== got.length || !timingSafeEqual(want, got)) {
      return next(new AppError(401, "device_key_invalid", "This counter's key is no longer valid. Open Billing while online."));
    }
    const { branch } = counter;
    if (branch.account.lockedBySetuAt) return next(new AppError(403, "account_locked", "This account is locked. Contact Setu support."));
    if (branch.archivedAt) return next(new AppError(403, "branch_unavailable", "This branch is closed."));
    const plan = await planState(ctx.prisma, branch.accountId, ctx.now());
    const { account, ...plainBranch } = branch;
    req.device = { counter, branch: plainBranch as Branch, account, plan };
    next();
  };
}

export function device(req: Parameters<RequestHandler>[0]): DeviceContext {
  if (!req.device) throw new AppError(401, "device_key_missing", "Counter not set up.");
  return req.device;
}
