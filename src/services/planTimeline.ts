// Pure plan-timeline maths: which plan is active now, and what redeeming a
// key does to the timeline. No database access, so it is fully unit-tested.

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Segment = {
  id: string;
  planCode: string;
  /** Monthly INR price in paise; null for custom plans. */
  monthlyPriceInr: number | null;
  source: "TRIAL" | "KEY";
  startsAt: Date;
  endsAt: Date;
};

export type TimelineState = {
  current: Segment | null;
  queued: Segment[];
  /** True when nothing is active now (trial or plan over, or never started). */
  expired: boolean;
  /** Whole days left on the current segment, rounded up (0 when expired). */
  daysLeft: number;
};

export function timelineState(segments: readonly Segment[], now: Date): TimelineState {
  const sorted = [...segments].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const t = now.getTime();
  const current = [...sorted].reverse().find((s) => s.startsAt.getTime() <= t && s.endsAt.getTime() > t) ?? null;
  const queued = sorted.filter((s) => s.startsAt.getTime() > t);
  return {
    current,
    queued,
    expired: current === null,
    daysLeft: current ? Math.ceil((current.endsAt.getTime() - t) / DAY_MS) : 0,
  };
}

export type RedeemMode = "EXTEND" | "SWITCH_NOW" | "START_LATER";

export type RedeemInput = {
  planCode: string;
  monthlyPriceInr: number | null;
  days: number;
  /** Only asked when the key is for a different plan than the current one. */
  choice?: "now" | "later";
};

export type RedeemPlan = {
  mode: RedeemMode;
  /** Days added from converting what was left of the current paid plan. */
  convertedDays: number;
  newSegment: { startsAt: Date; endsAt: Date };
  /** Cut the current segment short (SWITCH_NOW). */
  endCurrent: { id: string; endsAt: Date } | null;
  /** Queued segments moved to start after the new one. */
  shifted: { id: string; startsAt: Date; endsAt: Date }[];
  /** True when the caller must ask the owner "now or later?" first. */
  needsChoice: boolean;
};

/**
 * - Same plan as now, or nothing active → the days are added on (EXTEND),
 *   after anything already queued.
 * - Different plan, "later" → starts when the last queued/current plan ends.
 * - Different plan, "now" → starts now. Days left on the current *paid* plan
 *   are converted by monthly price (60 Gold days ≈ 30 Platinum days) and
 *   added. Days left on a free trial are not converted. Anything queued moves
 *   back to start after the new plan.
 */
export function planRedemption(segments: readonly Segment[], now: Date, input: RedeemInput): RedeemPlan {
  const state = timelineState(segments, now);
  const t = now.getTime();
  const addDays = (from: number, days: number) => new Date(from + days * DAY_MS);
  const lastEnd = Math.max(t, ...segments.map((s) => s.endsAt.getTime()));

  const differentPlan = state.current !== null && state.current.planCode !== input.planCode;

  if (!differentPlan) {
    const start = state.current || state.queued.length ? lastEnd : t;
    return {
      mode: "EXTEND",
      convertedDays: 0,
      newSegment: { startsAt: new Date(start), endsAt: addDays(start, input.days) },
      endCurrent: null,
      shifted: [],
      needsChoice: false,
    };
  }

  if (input.choice !== "now" && input.choice !== "later") {
    return { ...planRedemption(segments, now, { ...input, choice: "later" }), needsChoice: true };
  }

  if (input.choice === "later") {
    return {
      mode: "START_LATER",
      convertedDays: 0,
      newSegment: { startsAt: new Date(lastEnd), endsAt: addDays(lastEnd, input.days) },
      endCurrent: null,
      shifted: [],
      needsChoice: false,
    };
  }

  const current = state.current!;
  const remainingDays = Math.floor((current.endsAt.getTime() - t) / DAY_MS);
  const canConvert =
    current.source === "KEY" && current.monthlyPriceInr !== null && input.monthlyPriceInr !== null && input.monthlyPriceInr > 0;
  const convertedDays = canConvert
    ? Math.floor((remainingDays * current.monthlyPriceInr!) / input.monthlyPriceInr!)
    : 0;
  const newEnd = addDays(t, input.days + convertedDays);
  const oldCurrentEnd = current.endsAt.getTime();
  const shifted = state.queued.map((q) => {
    const offset = q.startsAt.getTime() - oldCurrentEnd;
    const length = q.endsAt.getTime() - q.startsAt.getTime();
    const startsAt = new Date(newEnd.getTime() + Math.max(0, offset));
    return { id: q.id, startsAt, endsAt: new Date(startsAt.getTime() + length) };
  });

  return {
    mode: "SWITCH_NOW",
    convertedDays,
    newSegment: { startsAt: new Date(t), endsAt: newEnd },
    endCurrent: { id: current.id, endsAt: new Date(t) },
    shifted,
    needsChoice: false,
  };
}
