// Phase 7: Setu team (super-admin) request/response schemas.
import "./zodOpenApi.js";
import { z } from "zod";
import { PASSWORD_MAX, PASSWORD_MIN } from "./lib/password.js";
import { MAX_LICENSE_DAYS } from "./lib/licenseKey.js";

const Email = z.email().max(200);
const Code = z.string().trim().min(6).max(8);
const Reason = z.string().trim().min(3, "Say why (at least 3 characters).").max(500);
const At = z.string();

export const AdminLoginBody = z.object({ email: Email, password: z.string().min(1).max(PASSWORD_MAX) });
export const AdminCodeBody = z.object({ token: z.string().min(1), code: Code });
export const AdminAcceptBody = z.object({ token: z.string().min(1), password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) });
export const AdminCreateBody = z.object({ email: Email, name: z.string().trim().min(1).max(120) });

export const AdminDto = z.object({ id: z.string(), email: z.string(), name: z.string(), status: z.enum(["INVITED", "ACTIVE", "DISABLED"]), twoFactor: z.boolean(), lastLoginAt: At.nullable(), createdAt: At });
export const AdminLoginStep = z.discriminatedUnion("step", [
  z.object({ step: z.literal("code"), token: z.string() }),
  z.object({ step: z.literal("setup"), token: z.string(), secret: z.string(), otpauthUrl: z.string() }),
]);
export const AdminSessionDto = z.object({ accessToken: z.string(), expiresIn: z.number().int(), admin: AdminDto });

export const AccountStatus = z.enum(["trial", "paid", "granted", "expired", "unverified", "locked"]);
export const AccountRowDto = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  ownerName: z.string(),
  ownerEmail: z.string(),
  status: AccountStatus,
  planCode: z.string().nullable(),
  planName: z.string().nullable(),
  /** When the last plan on the timeline ends (null = never started). */
  endsAt: At.nullable(),
  daysLeft: z.number().int(),
  branches: z.number().int(),
  lastActiveAt: At.nullable(),
  createdAt: At,
});
export const DashboardDto = z.object({
  accounts: z.number().int(),
  trial: z.number().int(),
  paidByPlan: z.array(z.object({ code: z.string(), name: z.string(), accounts: z.number().int() })),
  granted: z.number().int(),
  expired: z.number().int(),
  unverified: z.number().int(),
  locked: z.number().int(),
  expiringIn14Days: z.number().int(),
  signupsThisMonth: z.number().int(),
  remindersLast7Days: z.number().int(),
});

const Limits = z.object({ maxBranches: z.number().int().nullable(), maxStaff: z.number().int().nullable(), maxProducts: z.number().int().nullable(), maxCustomers: z.number().int().nullable(), maxOrdersPerMonth: z.number().int().nullable() });
export const AccountDetailDto = z.object({
  account: AccountRowDto.extend({ taxNumber: z.string().nullable(), timezone: z.string(), lockedAt: At.nullable(), lockReason: z.string().nullable(), ownerVerified: z.boolean(), ownerId: z.string().nullable() }),
  plan: z.object({ expired: z.boolean(), daysLeft: z.number().int(), code: z.string().nullable(), name: z.string().nullable(), source: z.string().nullable(), limits: Limits.nullable() }),
  usage: z.object({ branches: z.number().int(), staff: z.number().int(), products: z.number().int(), customers: z.number().int(), ordersThisMonth: z.number().int() }),
  timeline: z.array(z.object({ planCode: z.string(), planName: z.string(), source: z.string(), startsAt: At, endsAt: At })),
  redemptions: z.array(z.object({ id: z.string(), planCode: z.string(), days: z.number().int(), mode: z.string(), convertedDays: z.number().int(), redeemedAt: At, custom: z.boolean() })),
  issuedKeys: z.array(z.object({ id: z.string(), days: z.number().int(), limits: Limits, note: z.string(), issuedBy: z.string(), issuedAt: At, redeemedAt: At.nullable(), revokedAt: At.nullable() })),
  reminders: z.array(z.object({ endsAt: At, step: z.number().int(), sentAt: At, manual: z.boolean() })),
  activity: z.array(z.object({ id: z.string(), adminName: z.string(), action: z.string(), data: z.unknown(), createdAt: At })),
});

export const LockBody = z.object({ reason: Reason });
export const UnlockBody = z.object({ note: z.string().trim().max(500).optional() });
export const AddDaysBody = z.object({ days: z.number().int().min(1).max(365), reason: Reason });
export const BulkRemindBody = z.object({ withinDays: z.number().int().min(1).max(60) });

const Limit = z.number().int().min(1).max(100_000_000).nullable();
export const IssueKeyBody = z.object({
  accountId: z.uuid(),
  days: z.number().int().min(1).max(MAX_LICENSE_DAYS),
  maxBranches: z.number().int().min(101, "Contact-sales keys are for more than 100 branches.").max(100_000),
  maxStaff: Limit,
  maxProducts: Limit,
  maxCustomers: Limit,
  maxOrdersPerMonth: Limit,
  note: z.string().trim().max(500).default(""),
});
export const IssuedKeyRowDto = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  days: z.number().int(),
  limits: Limits,
  note: z.string(),
  issuedBy: z.string(),
  issuedAt: At,
  redeemedAt: At.nullable(),
  revokedAt: At.nullable(),
});
export const RedemptionRowDto = z.object({ id: z.string(), accountId: z.string(), accountName: z.string(), planCode: z.string(), days: z.number().int(), mode: z.string(), redeemedAt: At, custom: z.boolean() });
export const AdminActivityDto = z.object({ id: z.string(), adminId: z.string().nullable(), adminName: z.string(), action: z.string(), accountId: z.string().nullable(), accountName: z.string().nullable(), data: z.unknown(), ip: z.string().nullable(), createdAt: At });
