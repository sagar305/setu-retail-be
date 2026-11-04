/** Prisma unique-constraint violation, optionally on a given field. */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (typeof err !== "object" || err === null || (err as { code?: unknown }).code !== "P2002") return false;
  if (!field) return true;
  const meta = (err as { meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } } }).meta;
  const target = meta?.target ?? meta?.driverAdapterError?.cause?.constraint?.fields;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes(field);
}
