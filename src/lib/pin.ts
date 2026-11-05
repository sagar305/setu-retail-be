// Counter PIN for offline sign-in. The verifier is PBKDF2-SHA256 so the
// browser can check it with WebCrypto when there is no internet.
import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";

export const PIN_PATTERN = /^\d{4,6}$/;
export const PIN_ITERATIONS = 100_000;

function derive(pin: string, saltHex: string, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => pbkdf2(pin, Buffer.from(saltHex, "hex"), iterations, 32, "sha256", (e, k) => (e ? reject(e) : resolve(k))));
}

export async function makePinVerifier(pin: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(pin, salt, PIN_ITERATIONS)).toString("hex");
  return { pinHash: hash, pinSalt: salt, pinIterations: PIN_ITERATIONS };
}

export async function checkPin(pin: string, v: { pinHash: string; pinSalt: string; pinIterations: number }) {
  const got = await derive(pin, v.pinSalt, v.pinIterations);
  const want = Buffer.from(v.pinHash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
