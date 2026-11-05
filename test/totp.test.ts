import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  newTotpSecret,
  otpauthUrl,
  totpCode,
  totpStep,
  verifyTotp,
} from "../src/lib/totp.js";

// RFC 6238 Appendix B, SHA-1 seed.
const RFC_SECRET = Buffer.from("12345678901234567890");

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(totpCode(RFC_SECRET, totpStep(new Date(59_000)), 8)).toBe("94287082");
    expect(totpCode(RFC_SECRET, totpStep(new Date(1_111_111_109_000)), 8)).toBe("07081804");
    expect(totpCode(RFC_SECRET, totpStep(new Date(2_000_000_000_000)), 8)).toBe("69279037");
    expect(totpCode(RFC_SECRET, totpStep(new Date(1_111_111_109_000)))).toBe("081804");
  });

  it("base32 round-trips", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
    expect(base32Decode("gezd gnbv-gy3t")).toEqual(base32Decode("GEZDGNBVGY3T"));
  });

  it("accepts the current, previous and next code once each", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = new Date(1_111_111_109_000);
    const step = totpStep(now);
    const code = (s: number) => totpCode(RFC_SECRET, s);
    expect(verifyTotp(secret, code(step), now, null)).toBe(step);
    expect(verifyTotp(secret, code(step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, code(step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, code(step - 2), now, null)).toBeNull();
    // Used once: the same (or an older) step is refused.
    expect(verifyTotp(secret, code(step), now, step)).toBeNull();
    expect(verifyTotp(secret, code(step + 1), now, step)).toBe(step + 1);
    expect(verifyTotp(secret, "12345", now, null)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now, null)).toBeNull();
    expect(verifyTotp(secret, `${code(step).slice(0, 3)} ${code(step).slice(3)}`, now, null)).toBe(step);
  });

  it("stores the secret encrypted, readable only with the same server secret", () => {
    const s = newTotpSecret();
    const enc = encryptTotpSecret(s, "server-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(enc).not.toContain(s);
    expect(decryptTotpSecret(enc, "server-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(s);
    expect(decryptTotpSecret(enc, "another-secret-bbbbbbbbbbbbbbbbbbbbbbbbb")).toBeNull();
    expect(decryptTotpSecret("garbage", "server-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("builds an otpauth link", () => {
    expect(otpauthUrl("ABC", "a@setu.com")).toBe("otpauth://totp/Setu%20Retail%20Admin%3Aa%40setu.com?secret=ABC&issuer=Setu%20Retail%20Admin&algorithm=SHA1&digits=6&period=30");
  });
});
