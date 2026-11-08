import "./zodOpenApi.js";
// Request and response shapes. Routes validate with these and src/openapi.ts
// publishes them, so the frontend's generated client matches exactly.
import { z } from "zod";
import { USERNAME_PATTERN } from "./lib/normalize.js";
import { PASSWORD_MAX, PASSWORD_MIN } from "./lib/password.js";

export const Password = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters.`);
export const Email = z.email("Enter a valid email.").max(254);
export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, "3–30 letters, digits, dots, dashes or underscores; start with a letter or digit.");
const Name = z.string().trim().min(1, "Required.").max(80);
const Token = z.string().min(20).max(200);

export const SignupBody = z.object({
  businessName: Name,
  ownerName: Name,
  email: Email,
  username: Username,
  password: Password,
  phone: z.string().trim().min(6).max(20),
  taxNumber: z.string().trim().max(30).optional().or(z.literal("")),
});
export const VerifyEmailBody = z.object({ token: Token });
export const EmailOnlyBody = z.object({ email: Email });
export const LoginBody = z.object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(PASSWORD_MAX) });
export const ResetPasswordBody = z.object({ token: Token, password: Password });
export const AcceptInviteBody = z.object({ token: Token, password: Password });

export const RoleEnum = z.enum(["OWNER", "MANAGER", "CASHIER"]);

export const BranchBody = z.object({
  name: Name,
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(20).optional(),
  gstin: z.string().trim().max(30).optional().or(z.literal("")),
  stateCode: z
    .string()
    .trim()
    .regex(/^\d{2}$/, "Two-digit GST state code, e.g. 29.")
    .optional()
    .or(z.literal("")),
});
export const BranchPatchBody = BranchBody.partial();

export const InviteStaffBody = z.object({
  name: Name,
  email: Email,
  username: Username,
  role: z.enum(["MANAGER", "CASHIER"]),
  branchIds: z.array(z.uuid()).min(1, "Pick at least one branch."),
});
export const StaffPatchBody = z.object({
  name: Name.optional(),
  role: z.enum(["MANAGER", "CASHIER"]).optional(),
  branchIds: z.array(z.uuid()).min(1).optional(),
  disabled: z.boolean().optional(),
});

export const LicenseKeyBody = z.object({ key: z.string().trim().min(10).max(120) });
export const RedeemBody = LicenseKeyBody.extend({ choice: z.enum(["now", "later"]).optional() });
export const KeepActiveBody = z.object({ branchIds: z.array(z.uuid()), staffIds: z.array(z.uuid()) });

// ── Responses ──
export const UserDto = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  username: z.string(),
  role: RoleEnum,
});
export const BranchDto = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  address: z.string(),
  phone: z.string(),
  gstin: z.string().nullable(),
  stateCode: z.string().nullable(),
  withinPlan: z.boolean(),
  /** This branch's receipt design; null = the business default. */
  receiptTemplateId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const LimitsDto = z.object({
  maxBranches: z.number().int().nullable(),
  maxStaff: z.number().int().nullable(),
  maxProducts: z.number().int().nullable(),
  maxCustomers: z.number().int().nullable(),
  maxOrdersPerMonth: z.number().int().nullable(),
});
export const PlanDto = z.object({
  expired: z.boolean(),
  daysLeft: z.number().int(),
  current: z
    .object({
      code: z.string(),
      name: z.string(),
      source: z.enum(["TRIAL", "KEY", "GRANT"]),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      limits: LimitsDto,
    })
    .nullable(),
  queued: z.array(z.object({ code: z.string(), name: z.string(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })),
});
export const MeDto = z.object({
  user: UserDto,
  account: z.object({
    id: z.uuid(),
    name: z.string(),
    currency: z.string(),
    timezone: z.string(),
    keepActiveReviewPending: z.boolean(),
  }),
  branches: z.array(BranchDto),
  plan: PlanDto,
});
export const SessionDto = z.object({ accessToken: z.string(), expiresIn: z.number().int(), me: MeDto });
export const StaffDto = UserDto.extend({
  status: z.enum(["INVITED", "ACTIVE", "DISABLED"]),
  withinPlan: z.boolean(),
  branchIds: z.array(z.uuid()),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
