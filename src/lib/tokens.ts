import { createHash, randomBytes } from "node:crypto";

/** 256-bit random token, URL-safe. Sent to the user; never stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What we store and look tokens up by. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
