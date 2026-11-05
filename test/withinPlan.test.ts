import { describe, expect, it } from "vitest";
import { chooseWithinPlan } from "../src/services/withinPlan.js";

const rows = (flags: boolean[]) => flags.map((withinPlan, i) => ({ id: `r${i + 1}`, withinPlan }));
const ids = (s: Set<string>) => [...s].sort();

describe("chooseWithinPlan", () => {
  it("keeps everything when within the limit or unlimited", () => {
    expect(ids(chooseWithinPlan(rows([true, false]), 5).keep)).toEqual(["r1", "r2"]);
    expect(ids(chooseWithinPlan(rows([true, true, true]), null).keep)).toEqual(["r1", "r2", "r3"]);
  });

  it("keeps the oldest when a smaller plan starts", () => {
    const r = chooseWithinPlan(rows([true, true, true]), 1);
    expect(ids(r.keep)).toEqual(["r1"]);
    expect(r.trimmed).toBe(true);
  });

  it("respects the owner's earlier pick", () => {
    // Owner chose r3 last time; limit still 1.
    const r = chooseWithinPlan(rows([false, false, true]), 1);
    expect(ids(r.keep)).toEqual(["r3"]);
    expect(r.trimmed).toBe(false);
  });

  it("brings back the oldest read-only ones on upgrade", () => {
    const r = chooseWithinPlan(rows([false, false, true, false]), 3);
    expect(ids(r.keep)).toEqual(["r1", "r2", "r3"]);
  });
});
