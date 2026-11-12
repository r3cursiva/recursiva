// The steps of every list's keys (RSVA-425), apart from the screens so that they can be tested without a DOM.

/** The key with a letter in lower case, so that Shift or Caps Lock does not change which shortcut it is. */
export const normKey = (e: KeyboardEvent): string => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

/** One row down for J and ↓, one up for K and ↑, 0 for any other key. */
export const stepKey = (key: string): -1 | 0 | 1 => (key === "j" || key === "ArrowDown" ? 1 : key === "k" || key === "ArrowUp" ? -1 : 0);

/** The row `by` rows from row `at`, staying at the ends; the first row when none is at hand (`at` < 0). */
export function stepIn<T>(rows: readonly T[], at: number, by: number): T | undefined {
  return rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + by))];
}

/** The row after `row`, else the one before: where a selection goes when its row leaves the list (the first row for one not in it). */
export function neighbour<T>(rows: readonly T[], row: T): T | undefined {
  const at = rows.indexOf(row);
  return rows[at + 1] ?? rows[at - 1];
}
