// Small helpers every app wrote by hand. No imports and no top-level code, so any bundle can take one function
// without pulling anything else.

/** "1 issue", "3 issues"; `pluralWord` for the words that do not take an "s" ("1 story", "2 stories"). */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** A count in a badge: "99+" past 99, so it keeps its width. */
export const capCount = (n: number): string => (n > 99 ? "99+" : String(n));

/** What to show for anything thrown: an Error's message, otherwise the value as text. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The items in lists by key, in first-seen order (`Map.groupBy` is not in the lib we compile against). */
export function groupBy<T, K>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/** The list with `item` taken out when it is in it, else added at the end: a person or a label picked on a multi-pick page. */
export function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * mulberry32: the same seed gives the same numbers in [0, 1) on every run. Saved fuzz seeds, the generated fixtures,
 * the `perf:net` base and every person's generated avatar depend on the sequence: util.test.ts pins it.
 */
export function seeded(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
