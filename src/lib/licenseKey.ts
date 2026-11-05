// ---------------------------------------------------------------------------
// Setu Retail license keys ("SETU-R-…").
//
// Issued by setutechnology.com after payment (Setu_main, Phase 6) and, for
// Contact-sales deals only, by the Setu super-admin (Phase 7). Redeemed here.
// The issuing copy must stay byte-for-byte compatible: keep the shared test
// vector in test/licenseKey.test.ts passing in both repos.
//
// Modelled on the QR Menu key (Setu_main/lib/qrMenuLicense.ts) with a plan
// byte added and its own secret and AAD, so a QR Menu key can never redeem
// here and vice versa.
//
//   iv (12) | AES-256-GCM( version (1) | plan (1) | days (uint16) | keyId (10) ) | tag (16)
//
// - Encrypted + authenticated: can't be read, forged or edited without
//   RETAIL_LICENSE_SECRET.
// - Deterministic per order: iv and keyId come from the order id, so looking
//   up a paid order twice gives the same key. keyId is stored on redemption,
//   which makes a key single-use.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_BYTES = 10;
const PAYLOAD_BYTES = 1 + 1 + 2 + KEY_ID_BYTES;
const TOKEN_BYTES = IV_BYTES + PAYLOAD_BYTES + TAG_BYTES;
const BODY_CHARS = Math.ceil((TOKEN_BYTES * 8) / 5);
const AAD = Buffer.from("setu-retail-license");
const PREFIX = "SETUR";
const GROUP = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Ten years. */
export const MAX_LICENSE_DAYS = 3660;

/** Plan byte → plan. "custom" keys (Contact sales) resolve via their keyId. */
export const PLAN_BYTES = { basic: 1, gold: 2, platinum: 3, custom: 9 } as const;
export type LicensePlan = keyof typeof PLAN_BYTES;

export type License = { keyId: string; plan: LicensePlan; days: number };

function deriveKeys(secret: string) {
  if (!secret) throw new Error("A license secret is required.");
  return {
    enc: createHash("sha256").update(`enc:${secret}`).digest(),
    mac: createHash("sha256").update(`mac:${secret}`).digest(),
  };
}

function base32Encode(bytes: Buffer): string {
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

function base32Decode(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function format(body: string): string {
  const groups = body.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? [];
  return ["SETU", "R", ...groups].join("-");
}

/** Undo grouping, case and the usual misreadings (base32 has no 0, 1 or 8). */
function normalise(input: string): string {
  let text = input.toUpperCase().replace(/[\s-]+/g, "");
  if (text.length === PREFIX.length + BODY_CHARS && text.startsWith(PREFIX)) text = text.slice(PREFIX.length);
  return text.replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B");
}

export function issueLicenseKey(orderId: string, plan: LicensePlan, days: number, secret: string): string {
  if (!Number.isInteger(days) || days < 1 || days > MAX_LICENSE_DAYS) {
    throw new Error(`License days must be a whole number from 1 to ${MAX_LICENSE_DAYS}.`);
  }
  const keys = deriveKeys(secret);
  const iv = createHmac("sha256", keys.mac).update(`iv:${orderId}`).digest().subarray(0, IV_BYTES);
  const keyId = createHmac("sha256", keys.mac).update(`id:${orderId}`).digest().subarray(0, KEY_ID_BYTES);

  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload.writeUInt8(VERSION, 0);
  payload.writeUInt8(PLAN_BYTES[plan], 1);
  payload.writeUInt16BE(days, 2);
  keyId.copy(payload, 4);

  const cipher = createCipheriv("aes-256-gcm", keys.enc, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return format(base32Encode(Buffer.concat([iv, encrypted, cipher.getAuthTag()])));
}

/** null for anything that isn't a genuine, unedited key. */
export function readLicenseKey(input: string, secret: string): License | null {
  const body = normalise(input);
  if (body.length !== BODY_CHARS) return null;
  const token = base32Decode(body);
  if (!token || token.length < TOKEN_BYTES) return null;

  const keys = deriveKeys(secret);
  const iv = token.subarray(0, IV_BYTES);
  const encrypted = token.subarray(IV_BYTES, IV_BYTES + PAYLOAD_BYTES);
  const tag = token.subarray(IV_BYTES + PAYLOAD_BYTES, TOKEN_BYTES);
  let payload: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.enc, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    payload = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    return null;
  }
  if (payload.readUInt8(0) !== VERSION) return null;
  const planByte = payload.readUInt8(1);
  const plan = (Object.keys(PLAN_BYTES) as LicensePlan[]).find((p) => PLAN_BYTES[p] === planByte);
  const days = payload.readUInt16BE(2);
  if (!plan || days < 1 || days > MAX_LICENSE_DAYS) return null;
  return { keyId: payload.subarray(4).toString("hex"), plan, days };
}
