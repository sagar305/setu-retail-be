import { describe, expect, it } from "vitest";
import { GSTIN_PATTERN, normalizeEmail, normalizePhone, normalizeTaxNumber, USERNAME_PATTERN } from "../src/lib/normalize.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";

describe("normalize", () => {
  it("treats Indian phone formats as the same number", () => {
    for (const p of ["+91 98765 43210", "098765-43210", "9876543210", "91 9876543210"]) {
      expect(normalizePhone(p)).toBe("9876543210");
    }
    expect(normalizePhone("123")).toBeNull();
  });

  it("cleans tax numbers", () => {
    expect(normalizeTaxNumber(" 29abcde1234f1z5 ")).toBe("29ABCDE1234F1Z5");
    expect(GSTIN_PATTERN.test("29ABCDE1234F1Z5")).toBe(true);
    expect(normalizeTaxNumber("")).toBeNull();
    expect(normalizeTaxNumber("@@")).toBeNull();
  });

  it("lower-cases emails and checks usernames", () => {
    expect(normalizeEmail("  Anil@Shop.IN ")).toBe("anil@shop.in");
    expect(USERNAME_PATTERN.test("ravi.cashier")).toBe(true);
    expect(USERNAME_PATTERN.test("ab")).toBe(false);
    expect(USERNAME_PATTERN.test("has space")).toBe(false);
  });
});

describe("passwords", () => {
  it("hash and verify", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
  });
});
