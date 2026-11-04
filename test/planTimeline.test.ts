import { describe, expect, it } from "vitest";
import { DAY_MS, planRedemption, timelineState, type Segment } from "../src/services/planTimeline.js";

const NOW = new Date("2026-11-04T10:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * DAY_MS);
const seg = (over: Partial<Segment>): Segment => ({
  id: "s1",
  planCode: "gold",
  monthlyPriceInr: 49_900,
  source: "KEY",
  startsAt: day(-10),
  endsAt: day(212),
  ...over,
});

describe("timelineState", () => {
  it("finds the active plan and days left", () => {
    const s = timelineState([seg({})], NOW);
    expect(s.current?.planCode).toBe("gold");
    expect(s.daysLeft).toBe(212);
    expect(s.expired).toBe(false);
  });

  it("is expired when the last plan has ended", () => {
    expect(timelineState([seg({ endsAt: day(-1) })], NOW).expired).toBe(true);
    expect(timelineState([], NOW).expired).toBe(true);
  });

  it("lists queued plans", () => {
    const s = timelineState([seg({}), seg({ id: "s2", planCode: "platinum", startsAt: day(212), endsAt: day(577) })], NOW);
    expect(s.queued.map((q) => q.id)).toEqual(["s2"]);
  });
});

describe("planRedemption", () => {
  it("adds days on when the key is for the current plan", () => {
    const r = planRedemption([seg({})], NOW, { planCode: "gold", monthlyPriceInr: 49_900, days: 365 });
    expect(r.mode).toBe("EXTEND");
    expect(r.newSegment).toEqual({ startsAt: day(212), endsAt: day(577) });
    expect(r.needsChoice).toBe(false);
  });

  it("starts now when nothing is active", () => {
    const r = planRedemption([seg({ endsAt: day(-3) })], NOW, { planCode: "platinum", monthlyPriceInr: 99_900, days: 30 });
    expect(r.mode).toBe("EXTEND");
    expect(r.newSegment).toEqual({ startsAt: NOW, endsAt: day(30) });
  });

  it("asks now-or-later for a different plan", () => {
    const r = planRedemption([seg({})], NOW, { planCode: "platinum", monthlyPriceInr: 99_900, days: 365 });
    expect(r.needsChoice).toBe(true);
  });

  it("switch now converts remaining paid days by price (212 Gold → 105 Platinum)", () => {
    const r = planRedemption([seg({})], NOW, {
      planCode: "platinum",
      monthlyPriceInr: 99_900,
      days: 365,
      choice: "now",
    });
    expect(r.mode).toBe("SWITCH_NOW");
    expect(r.convertedDays).toBe(Math.floor((212 * 49_900) / 99_900));
    expect(r.convertedDays).toBe(105);
    expect(r.endCurrent).toEqual({ id: "s1", endsAt: NOW });
    expect(r.newSegment).toEqual({ startsAt: NOW, endsAt: day(365 + 105) });
  });

  it("does not convert free trial days", () => {
    const r = planRedemption([seg({ planCode: "basic", source: "TRIAL", monthlyPriceInr: 24_900 })], NOW, {
      planCode: "gold",
      monthlyPriceInr: 49_900,
      days: 30,
      choice: "now",
    });
    expect(r.convertedDays).toBe(0);
    expect(r.newSegment.endsAt).toEqual(day(30));
  });

  it("start later begins when the current plan ends", () => {
    const r = planRedemption([seg({})], NOW, { planCode: "platinum", monthlyPriceInr: 99_900, days: 365, choice: "later" });
    expect(r.mode).toBe("START_LATER");
    expect(r.newSegment).toEqual({ startsAt: day(212), endsAt: day(577) });
    expect(r.endCurrent).toBeNull();
  });

  it("switch now pushes queued plans back after the new one", () => {
    const queued = seg({ id: "q", planCode: "basic", startsAt: day(212), endsAt: day(242) });
    const r = planRedemption([seg({}), queued], NOW, {
      planCode: "platinum",
      monthlyPriceInr: 99_900,
      days: 10,
      choice: "now",
    });
    const newEnd = day(10 + 105);
    expect(r.shifted).toEqual([{ id: "q", startsAt: newEnd, endsAt: new Date(newEnd.getTime() + 30 * DAY_MS) }]);
  });
});
