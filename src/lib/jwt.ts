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
