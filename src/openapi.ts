import "./zodOpenApi.js";
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z, type ZodType } from "zod";
import * as S from "./schemas.js";


// Every route registers its request/response schemas here, so the frontend can
// generate a typed client from /openapi.json instead of copying types by hand.
export const registry = new OpenAPIRegistry();

const bearer = registry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer", bearerFormat: "JWT" });

export const HealthResponse = registry.register(
  "HealthResponse",
  z.object({
    status: z.literal("ok"),
    service: z.literal("setu-retail-be"),
    version: z.string(),
    time: z.iso.datetime(),
  }),
);

export const ErrorResponse = registry.register(
  "ErrorResponse",
  z.object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
  }),
);

const Me = registry.register("Me", S.MeDto);
const Session = registry.register("Session", S.SessionDto);
const Branch = registry.register("Branch", S.BranchDto);
const Staff = registry.register("Staff", S.StaffDto);
const Plan = registry.register("Plan", S.PlanDto);

const json = (schema: ZodType) => ({ content: { "application/json": { schema } } });
const errors = { 400: { description: "Invalid request", ...json(ErrorResponse) }, 401: { description: "Not signed in", ...json(ErrorResponse) } };

type Method = "get" | "post" | "patch";
function route(method: Method, path: string, summary: string, opts: { body?: ZodType; ok: ZodType | null; status?: number; secure?: boolean; tag: string }) {
  registry.registerPath({
    method,
    path,
    summary,
    tags: [opts.tag],
    security: opts.secure === false ? [] : [{ [bearer.name]: [] }],
    request: opts.body ? { body: { content: { "application/json": { schema: opts.body } } } } : undefined,
    responses: {
      [opts.status ?? 200]: opts.ok ? { description: "OK", ...json(opts.ok) } : { description: "No content" },
      ...errors,
    },
  });
}

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Liveness check",
  tags: ["health"],
  responses: { 200: { description: "API is up", ...json(HealthResponse) } },
});
registry.registerPath({
  method: "get",
  path: "/health/db",
  summary: "Database connectivity check",
  tags: ["health"],
  responses: {
    200: { description: "Database reachable", ...json(z.object({ status: z.literal("ok") })) },
    503: { description: "Database unreachable", ...json(ErrorResponse) },
  },
});

const open = { secure: false, tag: "auth" } as const;
route("post", "/auth/signup", "Create a business account (owner + first branch); emails a verification link", { ...open, body: S.SignupBody, ok: z.object({ status: z.literal("verification_sent"), email: z.string() }), status: 201 });
route("post", "/auth/verify-email", "Verify email; starts the 3-month Basic trial for a new owner", { ...open, body: S.VerifyEmailBody, ok: z.object({ verified: z.literal(true) }) });
route("post", "/auth/resend-verification", "Send the verification link again", { ...open, body: S.EmailOnlyBody, ok: z.object({ status: z.string() }), status: 202 });
route("post", "/auth/login", "Sign in with email or username; sets the 12-hour refresh cookie", { ...open, body: S.LoginBody, ok: Session });
route("post", "/auth/refresh", "New access token from the refresh cookie (rotates it)", { ...open, ok: Session });
route("post", "/auth/logout", "Sign this device out", { ...open, ok: null, status: 204 });
route("post", "/auth/forgot-password", "Email a password-reset link", { ...open, body: S.EmailOnlyBody, ok: z.object({ status: z.string() }), status: 202 });
route("post", "/auth/reset-password", "Set a new password from the emailed link; signs out every device", { ...open, body: S.ResetPasswordBody, ok: z.object({ reset: z.literal(true) }) });
route("get", "/auth/invite/{token}", "Details for an invite link", { ...open, ok: z.object({ name: z.string(), email: z.string(), username: z.string(), role: S.RoleEnum, businessName: z.string() }) });
route("post", "/auth/accept-invite", "Staff sets their password from the invite link", { ...open, body: S.AcceptInviteBody, ok: z.object({ accepted: z.literal(true), username: z.string() }) });
route("get", "/me", "The signed-in user, account, branches and plan", { tag: "auth", ok: Me });

route("get", "/account/plan", "Plan, limits and usage (owner)", { tag: "account", ok: z.object({ plan: Plan, usage: z.record(z.string(), z.number()), keepActiveReviewPending: z.boolean() }) });
route("post", "/account/license/check", "Check a license key and preview its effect (owner)", { tag: "account", body: S.LicenseKeyBody, ok: z.object({ plan: z.object({ code: z.string(), name: z.string() }), days: z.number(), needsChoice: z.boolean(), options: z.array(z.object({ choice: z.enum(["now", "later"]).nullable(), convertedDays: z.number(), startsAt: z.string(), endsAt: z.string() })) }) });
route("post", "/account/license/redeem", "Redeem a license key (owner)", { tag: "account", body: S.RedeemBody, ok: z.object({ plan: Plan, keepActiveReviewPending: z.boolean() }) });
route("get", "/account/keep-active", "Branches and staff to choose from after a downgrade (owner)", { tag: "account", ok: z.object({ limits: z.object({ maxBranches: z.number().nullable(), maxStaff: z.number().nullable() }), branches: z.array(Branch), staff: z.array(z.object({ id: z.string(), name: z.string(), role: S.RoleEnum, withinPlan: z.boolean(), createdAt: z.string() })) }) });
route("post", "/account/keep-active", "Choose which branches and staff stay active (owner)", { tag: "account", body: S.KeepActiveBody, ok: z.object({ saved: z.literal(true) }) });

route("get", "/branches", "Branches the user can work in", { tag: "branches", ok: z.object({ branches: z.array(Branch) }) });
route("post", "/branches", "Add a branch (owner; plan limit applies)", { tag: "branches", body: S.BranchBody, ok: z.object({ branch: Branch }), status: 201 });
route("patch", "/branches/{id}", "Edit a branch (owner)", { tag: "branches", body: S.BranchPatchBody, ok: z.object({ branch: Branch }) });

route("get", "/staff", "Staff the user can manage", { tag: "staff", ok: z.object({ staff: z.array(Staff) }) });
route("post", "/staff", "Invite a manager or cashier (emails a set-password link; plan limit applies)", { tag: "staff", body: S.InviteStaffBody, ok: z.object({ staff: Staff }), status: 201 });
route("post", "/staff/{id}/resend-invite", "Send the invite email again", { tag: "staff", ok: z.object({ sent: z.literal(true) }) });
route("patch", "/staff/{id}", "Change name, role, branches, or remove/restore access", { tag: "staff", body: S.StaffPatchBody, ok: z.object({ staff: Staff }) });

export function buildOpenApiDocument(version: string) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Setu Retail API", version },
    servers: [{ url: "https://api.retail-pos.setutechnology.com" }],
  });
}
