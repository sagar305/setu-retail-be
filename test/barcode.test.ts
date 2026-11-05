import { describe, expect, it } from "vitest";
import { ean13CheckDigit, inStoreEan13 } from "../src/routes/receipts.js";

describe("EAN-13", () => {
  it("computes the check digit", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1); // 4006381333931
    expect(ean13CheckDigit("890123456789")).toBe(0); // 8901234567890
  });
  it("makes in-store codes starting with 2 with a valid check digit", () => {
    let i = 0;
    const code = inStoreEan13(() => [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1][i++ % 11]!);
    expect(code).toMatch(/^2\d{12}$/);
    expect(Number(code[12])).toBe(ean13CheckDigit(code.slice(0, 12)));
  });
});
