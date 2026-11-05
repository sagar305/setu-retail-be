// Canonical forms for identifiers we compare or keep unique.

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 3–30 chars: letters, digits, dot, underscore, hyphen. Stored lower-case. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,29}$/;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Digits only. Indian numbers keep their last 10 digits so "+91 98765 43210",
 * "098765 43210" and "9876543210" are the same phone. Returns null when the
 * number can't be a phone.
 */
export function normalizePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length >= 8 && digits.length <= 15) return digits;
  return null;
}

/** Upper-case, no spaces or dashes. GSTIN (15 chars) or another country's tax id. */
export function normalizeTaxNumber(tax: string): string | null {
  const cleaned = tax.replace(/[\s-]/g, "").toUpperCase();
  if (!cleaned) return null;
  return /^[A-Z0-9]{5,20}$/.test(cleaned) ? cleaned : null;
}

/** Indian GSTIN: 2-digit state, 10-char PAN, entity, Z, checksum. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
