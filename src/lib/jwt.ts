import { SignJWT, jwtVerify } from "jose";
import type { Role } from "../generated/prisma/enums.js";

export const ACCESS_TOKEN_SECONDS = 15 * 60;

export type AccessClaims = { sub: string; acc: string; role: Role; sid: string };

const ISSUER = "setu-retail";
const encoder = new TextEncoder();

export async function signAccessToken(claims: AccessClaims, secret: string, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ acc: claims.acc, role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_SECONDS)
    .sign(encoder.encode(secret));
}

export async function verifyAccessToken(token: string, secret: string, now: Date): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      issuer: ISSUER,
      algorithms: ["HS256"],
      currentDate: now,
    });
    const { sub, acc, role, sid } = payload as Record<string, unknown>;
    if (typeof sub !== "string" || typeof acc !== "string" || typeof sid !== "string") return null;
    if (role !== "OWNER" && role !== "MANAGER" && role !== "CASHIER") return null;
    return { sub, acc, role, sid };
  } catch {
    return null;
  }
}

// ── Setu team (super-admin) tokens ──
// A different issuer and a key derived from JWT_SECRET, so a shop user's token
// can never pass as an admin token, or the other way round.

const ADMIN_ISSUER = "setu-retail-admin";
const adminKey = (secret: string) => encoder.encode(`${secret}|super-admin`);

export type AdminTokenPurpose = "access" | "mfa" | "setup";
export type AdminClaims = { sub: string; purpose: AdminTokenPurpose; sid?: string; tse?: string };

export async function signAdminToken(claims: AdminClaims, secret: string, now: Date, seconds: number): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ purpose: claims.purpose, ...(claims.sid ? { sid: claims.sid } : {}), ...(claims.tse ? { tse: claims.tse } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ADMIN_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + seconds)
    .sign(adminKey(secret));
}

export async function verifyAdminToken(token: string, secret: string, now: Date, purpose: AdminTokenPurpose): Promise<AdminClaims | null> {
  try {
    const { payload } = await jwtVerify(token, adminKey(secret), { issuer: ADMIN_ISSUER, algorithms: ["HS256"], currentDate: now });
    const { sub, purpose: p, sid, tse } = payload as Record<string, unknown>;
    if (typeof sub !== "string" || p !== purpose) return null;
    return { sub, purpose, sid: typeof sid === "string" ? sid : undefined, tse: typeof tse === "string" ? tse : undefined };
  } catch {
    return null;
  }
}
