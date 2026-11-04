/** What changed between two records, for the audit log: { field: [before, after] }. */
export function changes<T extends Record<string, unknown>>(before: T, patch: Partial<T>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const b = before[k];
    const same = b instanceof Date || v instanceof Date ? String(b) === String(v) : JSON.stringify(b) === JSON.stringify(v);
    if (!same) out[k] = [b ?? null, v ?? null];
  }
  return out;
}
