// Search by key and title, shared by the palettes of the web and the TUI. The web's issue search: every issue of the
// workspace is in memory, so search is a scan, not a request.
//
// Compared on 10 000 synthetic issues (apps/web/src/lib/search.bench.ts, Node 24, M-series Mac):
// - Base UI's built-in filter (not run): a collator call per item, and without a cap every match becomes a DOM option;
// - an array of lowercased "key title" strings scanned with includes(), ranked, capped at 50: median 0.56 ms per query,
//   max 1.4 ms; building the array takes 0.6 ms;
// - one joined string scanned with indexOf(), offsets mapped back to issues: 0.01 ms for one word because it stops at
//   the first 50 hits, but it cannot rank (an exact key may be hit 51st) or match several words without per-issue
//   checks, which is the array again.
// The array is fast enough by two orders of magnitude for a 16 ms frame and keeps ranking simple. It is built when the
// palette opens and dropped when it closes.

export interface SearchDoc<T> {
  item: T;
  /** "INFRA-12" */
  key: string;
  /** Lowercased "infra-12 title", what tokens match against. */
  hay: string;
  /** Lowercased title. */
  title: string;
}

export function buildIndex<T>(items: Iterable<T>, key: (item: T) => string, title: (item: T) => string): SearchDoc<T>[] {
  const out: SearchDoc<T>[] = [];
  for (const item of items) {
    const k = key(item);
    const t = title(item).toLowerCase();
    out.push({ item, key: k, hay: `${k.toLowerCase()} ${t}`, title: t });
  }
  return out;
}

/** `q` begins a word of `text` somewhere from `from` on: after a character that is not a letter or a digit. */
function startsWord(text: string, q: string, from: number): boolean {
  for (let i = from; i >= 0; i = text.indexOf(q, i + 1)) if (!/[\p{L}\p{N}]/u.test(text[i - 1] ?? "")) return true;
  return false;
}

/** The query in lowercase and its words, as `rank` takes them. */
export function queryOf(query: string): { q: string; words: string[] } {
  const q = query.trim().toLowerCase();
  return { q, words: q ? q.split(/\s+/) : [] };
}

/**
 * How well a doc matches a query (`queryOf`), best first: 0 exact key, 1 key prefix ("infra-1" → INFRA-1, INFRA-12…),
 * 2 title starting with the query, 3 a word of the title starting with its first word ("order" finds "by order:due"),
 * 4 anywhere. -1 when a word of the query is in neither the key nor the title.
 */
export function rank(d: SearchDoc<unknown>, { q, words }: { q: string; words: readonly string[] }): number {
  for (const w of words) if (!d.hay.includes(w)) return -1;
  const k = d.key.toLowerCase();
  if (k === q) return 0;
  if (k && k.startsWith(q)) return 1;
  if (d.title.startsWith(q)) return 2;
  const at = d.title.indexOf(words[0]!);
  return at >= 0 && startsWord(d.title, words[0]!, at) ? 3 : 4;
}

/**
 * Items matching every word of `query`, best first by `rank`. Within a rank, index order (callers pass the most relevant
 * order, e.g. recently updated first). At most `limit` results.
 */
export function search<T>(docs: readonly SearchDoc<T>[], query: string, limit = 50): T[] {
  const parsed = queryOf(query);
  if (!parsed.q) return [];
  const ranks: T[][] = [[], [], [], [], []];
  for (const d of docs) {
    const r = rank(d, parsed);
    if (r < 0) continue;
    const bucket = ranks[r]!;
    if (bucket.length < limit) bucket.push(d.item);
  }
  return ranks.flat().slice(0, limit);
}

/**
 * Items whose key is the query, then, with `prefix`, those whose key starts with it ("pl" → PLNR, PLANE), in index
 * order: what a typed key jumps to before any title match. Only a single word can be a key.
 */
export function byKey<T>(docs: readonly SearchDoc<T>[], query: string, prefix: boolean): T[] {
  const q = query.trim().toLowerCase();
  if (!q || /\s/.test(q)) return [];
  const exact: T[] = [];
  const starts: T[] = [];
  for (const d of docs) {
    const k = d.key.toLowerCase();
    if (k === q) exact.push(d.item);
    else if (prefix && k.startsWith(q)) starts.push(d.item);
  }
  return [...exact, ...starts];
}
