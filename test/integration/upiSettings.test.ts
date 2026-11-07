import { beforeEach, describe, expect, it } from "vitest";
import { harness, resetDb, signIn, signUpOwner, TEST_DB } from "./harness.js";

describe.skipIf(!TEST_DB)("UPI settings (Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("saves the shop's UPI ID and the receipt QR option; refuses a malformed ID", async () => {
    const h = harness();
    const o = await signIn(h, (await signUpOwner(h)).username);
    expect((await o.as("get", "/settings")).body).toMatchObject({ upiId: "", printUpiQrOnReceipt: false });
    const ok = await o.as("patch", "/settings").send({ upiId: "sharmastores@okaxis", printUpiQrOnReceipt: true });
    expect(ok.body).toMatchObject({ upiId: "sharmastores@okaxis", printUpiQrOnReceipt: true });
    expect((await o.as("patch", "/settings").send({ upiId: "not a upi id" })).status).toBe(400);
    expect((await o.as("patch", "/settings").send({ upiId: "" })).body.upiId).toBe("");
  });
});
