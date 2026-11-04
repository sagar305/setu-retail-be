import { describe, expect, it } from "vitest";
import { issueLicenseKey, readLicenseKey } from "../src/lib/licenseKey.js";

const SECRET = "test-secret-do-not-use-in-production";

describe("license keys", () => {
  it("round-trips plan and days", () => {
    const key = issueLicenseKey("order_123", "gold", 365, SECRET);
    expect(key).toMatch(/^SETU-R-[A-Z2-7]{6}(-[A-Z2-7]{1,6})+$/);
    expect(readLicenseKey(key, SECRET)).toMatchObject({ plan: "gold", days: 365 });
  });

  it("is the same key for the same order, different for another", () => {
    expect(issueLicenseKey("order_1", "basic", 30, SECRET)).toBe(issueLicenseKey("order_1", "basic", 30, SECRET));
    expect(issueLicenseKey("order_1", "basic", 30, SECRET)).not.toBe(issueLicenseKey("order_2", "basic", 30, SECRET));
  });

  it("forgives case, spaces, missing dashes and 0/1/8 misreadings", () => {
    const key = issueLicenseKey("order_9", "platinum", 30, SECRET);
    const messy = ` ${key.toLowerCase().replace(/-/g, " ")} `.replace(/o/g, "0").replace(/i/g, "1").replace(/b/g, "8");
    expect(readLicenseKey(messy, SECRET)).toMatchObject({ plan: "platinum", days: 30 });
  });

  it("rejects edited keys, other secrets and junk", () => {
    const key = issueLicenseKey("order_5", "basic", 30, SECRET);
    // Change one character in the middle (the last one is partly padding).
    const i = Math.floor(key.length / 2);
    const swapped = key[i] === "A" ? "B" : "A";
    expect(readLicenseKey(key.slice(0, i) + swapped + key.slice(i + 1), SECRET)).toBeNull();
    expect(readLicenseKey(key, "another-secret")).toBeNull();
    expect(readLicenseKey("SETU-HELLO", SECRET)).toBeNull();
    expect(readLicenseKey("", SECRET)).toBeNull();
  });

  it("rejects bad day counts when issuing", () => {
    expect(() => issueLicenseKey("o", "basic", 0, SECRET)).toThrow();
    expect(() => issueLicenseKey("o", "basic", 3661, SECRET)).toThrow();
  });

  // Shared vector: the issuing copy in Setu_main must produce exactly this.
  it("matches the shared test vector", () => {
    const key = issueLicenseKey("vector-order-0001", "gold", 365, "setu-retail-vector-secret");
    expect(key).toBe(VECTOR);
    expect(readLicenseKey(VECTOR, "setu-retail-vector-secret")).toEqual({
      plan: "gold",
      days: 365,
      keyId: expect.stringMatching(/^[0-9a-f]{20}$/),
    });
  });
});

const VECTOR = "SETU-R-456JWV-EW33LS-QS56ZP-7PAGP6-IK2VLU-OO3B53-IB2T5V-TXWE2Z-XDAMNH-KRVT6S-HIX63F-YQ";
