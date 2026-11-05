/**
 * Prisma unique-constraint violation, optionally on a given field. Prisma
 * reports the field list (`meta.target`) outside transactions and only the
 * index name (e.g. "orders_accountId_invoiceNumber_key") inside them, so both
 * are checked.
 */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (typeof err !== "object" || err === null || (err as { code?: unknown }).code !== "P2002") return false;
  if (!field) return true;
  type Cause = { constraint?: { fields?: unknown; index?: unknown }; originalMessage?: unknown };
  const meta = (err as { meta?: { target?: unknown; driverAdapterError?: { cause?: Cause } } }).meta;
  const cause = meta?.driverAdapterError?.cause;
  const parts = [meta?.target, cause?.constraint?.fields, cause?.constraint?.index, cause?.originalMessage];
  return parts.some((p) => (Array.isArray(p) ? p.join(",") : String(p ?? "")).includes(field));
}
