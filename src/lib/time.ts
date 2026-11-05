// Day/month boundaries in the shop's time zone (e.g. Asia/Kolkata), as UTC instants.

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(m.year), Number(m.month) - 1, Number(m.day), Number(m.hour), Number(m.minute), Number(m.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export function startOfDay(now: Date, timeZone: string): Date {
  const off = offsetMs(now, timeZone);
  const local = new Date(now.getTime() + off);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off);
}

export function startOfMonth(now: Date, timeZone: string): Date {
  const off = offsetMs(now, timeZone);
  const local = new Date(now.getTime() + off);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - off);
}
