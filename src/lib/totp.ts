// Authenticator-app codes (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, 6 digits)
// for Setu team sign-in. Works with Google Authenticator, Microsoft
// Authenticator, 1Password, Authy and others.
//
// The shared secret is stored encrypted (AES-256-GCM) with a key derived from
// JWT_SECRET, so a database dump alone can't produce codes. Changing
// JWT_SECRET therefore means every super-admin sets up 2FA again.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next code too, for clocks a little off. */
const WINDOW = 1;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what authenticator apps expect). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const totpStep = (now: Date) => Math.floor(now.getTime() / 1000 / STEP_SECONDS);

export function totpCode(secret: Buffer, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, "0");
}

/**
 * The time step the code belongs to, or null. A step at or before `lastStep`
 * is refused, so each code works once.
 */
export function verifyTotp(secretBase32: string, code: string, now: Date, lastStep: number | null): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(now);
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const step = current + delta;
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

/** The link an authenticator app reads from the QR code. */
export function otpauthUrl(secretBase32: string, email: string): string {
  const issuer = "Setu Retail Admin";
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

const encKey = (jwtSecret: string) => createHash("sha256").update(`totp:${jwtSecret}`).digest();

export function encryptTotpSecret(secretBase32: string, jwtSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(jwtSecret), iv);
  const body = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((b) => b.toString("base64url")).join(".");
}

export function decryptTotpSecret(stored: string, jwtSecret: string): string | null {
  try {
    const [iv, body, tag] = stored.split(".").map((p) => Buffer.from(p, "base64url"));
    if (!iv || !body || !tag) return null;
    const decipher = createDecipheriv("aes-256-gcm", encKey(jwtSecret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
