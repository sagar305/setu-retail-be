// Tax mode helpers: India GST, or the shop's own taxes in tax groups.
import { z } from "zod";
import type { TaxAmount, TaxPart } from "./gst.js";

export const TaxPartSchema = z.object({ name: z.string().trim().min(1).max(30), rateBp: z.number().int().min(0).max(10_000) });
/** A tax group's taxes: none (exempt) to 5. */
export const TaxPartsSchema = z.array(TaxPartSchema).max(5);
export const TaxAmountSchema = TaxPartSchema.extend({ amount: z.number().int() });

/** A stored taxes JSON column as a list (bad or old data reads as none). */
export function asTaxes(v: unknown): TaxAmount[] {
  const r = z.array(TaxAmountSchema).safeParse(v);
  return r.success ? r.data : [];
}
export function asTaxParts(v: unknown): TaxPart[] {
  const r = z.array(TaxPartSchema).safeParse(v);
  return r.success ? r.data : [];
}

export type GroupLike = { id: string; taxes: unknown; isDefault: boolean; archivedAt: Date | null };

/**
 * A product's custom taxes: its group, else the default group, else none.
 * Undefined in India GST mode (the GST rate is used).
 */
export function productTaxes(mode: "INDIA_GST" | "CUSTOM", taxGroupId: string | null, groups: readonly GroupLike[]): TaxPart[] | undefined {
  if (mode !== "CUSTOM") return undefined;
  const live = groups.filter((g) => !g.archivedAt);
  const g = (taxGroupId ? live.find((x) => x.id === taxGroupId) : undefined) ?? live.find((x) => x.isDefault);
  return g ? asTaxParts(g.taxes) : [];
}

/** A tax number in the shop's own tax mode: letters, digits, spaces, dots, dashes, slashes; 3–30. */
export function cleanTaxId(v: string): string | null {
  const t = v.trim().replace(/\s+/g, " ").toUpperCase();
  return /^[A-Z0-9][A-Z0-9 ./-]{1,28}[A-Z0-9]$/.test(t) ? t : null;
}

/** An item tax code (HSN in India, HS code elsewhere): letters, digits, dots, dashes; up to 20. */
export const ItemCode = z.string().trim().regex(/^[A-Za-z0-9.-]{0,20}$/, "Use letters, digits, dots or dashes (up to 20).");

/** India GST: HSN is 4, 6 or 8 digits. Throws a message for the field, or returns null when fine. */
export function itemCodeError(mode: "INDIA_GST" | "CUSTOM", code: string | undefined | null, label = "HSN"): string | null {
  if (!code || mode !== "INDIA_GST") return null;
  return /^(\d{4}|\d{6}|\d{8})$/.test(code) ? null : `${label} is 4, 6 or 8 digits.`;
}

/**
 * Custom tax mode: the tax group for an imported "Tax %" (one tax at that
 * rate, named after the shop's tax label). Reuses a matching group or makes one.
 */
export async function groupForRate(
  db: { taxGroup: { findMany: (a: { where: { accountId: string; archivedAt: null } }) => Promise<{ id: string; taxes: unknown }[]>; create: (a: { data: { accountId: string; name: string; taxes: TaxPart[] } }) => Promise<{ id: string }> } },
  account: { id: string; taxLabel: string },
  rateBp: number,
  cache: Map<number, string>,
): Promise<string> {
  const hit = cache.get(rateBp);
  if (hit) return hit;
  const groups = await db.taxGroup.findMany({ where: { accountId: account.id, archivedAt: null } });
  const match = groups.find((g) => {
    const t = asTaxParts(g.taxes);
    return rateBp === 0 ? t.length === 0 : t.length === 1 && t[0]!.rateBp === rateBp;
  });
  const label = account.taxLabel || "Tax";
  const id = match?.id ?? (await db.taxGroup.create({ data: { accountId: account.id, name: rateBp === 0 ? "No tax" : `${label} ${rateBp / 100}%`, taxes: rateBp === 0 ? [] : [{ name: label, rateBp }] } })).id;
  cache.set(rateBp, id);
  return id;
}

export function validCurrency(c: string): boolean {
  if (!/^[A-Z]{3}$/.test(c)) return false;
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency").includes(c) ?? true;
  } catch {
    return false;
  }
}
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type TaxAccount = { taxMode: "INDIA_GST" | "CUSTOM"; taxNumberLabel: string };

/**
 * A customer's, supplier's or branch's tax number, cleaned: a GSTIN in India
 * GST mode, any tax ID (VAT No, TRN, ABN…) in custom mode. Null when it isn't valid.
 */
export function parseTaxNumber(account: TaxAccount, raw: string): string | null {
  if (account.taxMode === "CUSTOM") return cleanTaxId(raw);
  const g = raw.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) ? g : null;
}
export const taxNumberMessage = (account: TaxAccount) => (account.taxMode === "CUSTOM" ? `Enter a valid ${account.taxNumberLabel || "tax number"}.` : "Enter a valid 15-character GSTIN.");
/** The GST state code a GSTIN starts with (India GST only). */
export const stateFromTaxNumber = (account: TaxAccount, taxNumber: string | null | undefined) => (account.taxMode === "INDIA_GST" && taxNumber ? taxNumber.slice(0, 2) : null);
