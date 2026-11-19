// Three-way merge of descriptions: two people edit the same text from one version, and both edits stay.
//
// A save is the whole document, so the merge works on documents, not on steps: the text both started from (base), the
// one being saved (mine) and the one that got in first (theirs). What only one side changed is taken from it; where both
// changed the same place, a block both edited merges inside (blocks, then characters), and what still collides keeps
// both versions, theirs first, rather than lose either. The server merges a save made from an older text (write.ts,
// updateDocument), and an open editor merges a text that arrives while someone is typing in it (rich-editors.tsx).
//
// The comparison is a longest common subsequence by Myers' algorithm on keys: whole blocks at the block level, a
// character with its marks (or an inline node) inside a block. Its edit distance is capped, so a rewritten long paragraph
// costs linear time and is treated as one change.
import { canonical, pushText, type DocMark, type DocNode } from "./doc.ts";
import { DocError, validateDoc } from "./validate.ts";

/**
 * `mine` and `theirs` were both edited from `base`; the merged text, valid and in canonical form, or null when it cannot
 * be (too large, or no valid shape): the caller then keeps refusing the save as before.
 */
export function mergeDocs(base: DocNode, mine: DocNode, theirs: DocNode): DocNode | null {
  for (const deep of [true, false]) {
    const merged = mergeNode(base, mine, theirs, deep);
    if (!merged) continue;
    try {
      return validateDoc(merged);
    } catch (e) {
      if (!(e instanceof DocError)) throw e;
    }
  }
  return null;
}

// ── Blocks ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Blocks whose content is inline: merged character by character. */
const TEXTBLOCKS = new Set(["paragraph", "heading", "code_block", "table_cell"]);

/**
 * One node both sides may have changed; null when they changed it in ways that do not merge (another type, the same
 * characters), so the sequence around it keeps both. `deep` false merges only the document's own blocks, each whole: the fallback when a
 * finer merge comes out invalid (a table row of another width).
 */
function mergeNode(o: DocNode, a: DocNode, b: DocNode, deep: boolean): DocNode | null {
  const ko = canonical(o);
  const ka = canonical(a);
  const kb = canonical(b);
  if (ka === ko || ka === kb) return b;
  if (kb === ko) return a;
  if (a.type !== o.type || b.type !== o.type || (!deep && o.type !== "doc")) return null;
  const n: DocNode = { type: o.type };
  const attrs = mergeAttrs(o.attrs, a.attrs, b.attrs);
  if (attrs) n.attrs = attrs;
  const content = TEXTBLOCKS.has(o.type)
    ? mergeInline(o.content ?? [], a.content ?? [], b.content ?? [])
    : mergeSeq(o.content ?? [], a.content ?? [], b.content ?? [], canonical, (x, y, z) => mergeNode(x, y, z, deep));
  if (!content) return null;
  if (content.length) n.content = content;
  return n;
}

/** Each attribute on its own: the side that changed it wins, and mine when both did (a heading's level, a checkbox). */
function mergeAttrs(o: DocNode["attrs"], a: DocNode["attrs"], b: DocNode["attrs"]): DocNode["attrs"] {
  if (!o && !a && !b) return undefined;
  const out: NonNullable<DocNode["attrs"]> = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const v = a?.[k] === o?.[k] ? b?.[k] : a?.[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ── Inline content ──────────────────────────────────────────────────────────────────────────────────────────────

/** A character with its marks, or an inline node (a mention, a line break): the unit an inline merge compares. */
interface Unit {
  key: string;
  ch?: string;
  marks?: DocMark[];
  node?: DocNode;
}

function units(content: readonly DocNode[]): Unit[] {
  const out: Unit[] = [];
  for (const n of content) {
    if (n.type !== "text") {
      out.push({ key: canonical(n), node: n });
      continue;
    }
    const marks = n.marks ?? [];
    const prefix = `${canonical(marks)}\u0000`;
    // By code point: a surrogate pair stays whole.
    for (const ch of n.text ?? "") out.push({ key: prefix + ch, ch, marks });
  }
  return out;
}

/** Null when both sides changed the same characters: the block then stays twice, which reads better than mixed words. */
function mergeInline(o: readonly DocNode[], a: readonly DocNode[], b: readonly DocNode[]): DocNode[] | null {
  const merged = mergeSeq(units(o), units(a), units(b), (u) => u.key, null);
  if (!merged) return null;
  const out: DocNode[] = [];
  for (const u of merged) {
    if (u.node) out.push(u.node);
    else pushText(out, u.ch!, u.marks!);
  }
  return out;
}

// ── Sequences ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What one side did to an item of the base. */
const KEPT = 0;
const DELETED = 1;
const REPLACED = 2;

interface Edits<T> {
  /** Per base item: KEPT, DELETED or REPLACED. */
  did: Uint8Array;
  /** Per base item, what replaced it. */
  by: (T | undefined)[];
  /** Per gap (before base item i; the last after them all), what was put there. */
  put: (T[] | undefined)[];
  /** Keys of `put`, for comparing two sides' insertions. */
  putKeys: (string[] | undefined)[];
}

/**
 * One side's edits of the base, from a common subsequence: between two kept items, the base's items left over are paired
 * in order with the side's as replacements; what is left of the side's is put after them, what is left of the base's
 * was deleted. So a paragraph edited and one added after it read as an edit and an insertion.
 */
function editsOf<T>(o: readonly T[], at: Int32Array, x: readonly T[], kx: readonly string[]): Edits<T> {
  const e: Edits<T> = { did: new Uint8Array(o.length), by: new Array<T | undefined>(o.length), put: new Array<T[] | undefined>(o.length + 1), putKeys: new Array<string[] | undefined>(o.length + 1) };
  let i = 0;
  let j = 0;
  while (i <= o.length) {
    let n = i;
    while (n < o.length && at[n]! < 0) n++;
    const end = n < o.length ? at[n]! : x.length;
    const paired = Math.min(n - i, end - j);
    for (let t = 0; t < n - i; t++) {
      if (t < paired) {
        e.did[i + t] = REPLACED;
        e.by[i + t] = x[j + t];
      } else e.did[i + t] = DELETED;
    }
    if (end - j > paired) {
      e.put[n] = x.slice(j + paired, end);
      e.putKeys[n] = kx.slice(j + paired, end);
    }
    i = n + 1;
    j = end + 1;
  }
  return e;
}

/**
 * diff3 over a sequence, item by item of the base: what only one side changed is taken from it; an item both replaced goes
 * to `item` (null there, or with no `item`, is a conflict); an edit beats a deletion. Insertions at one place on both sides
 * keep both, theirs first, what they share at the ends once. With no `item` a conflict makes the whole merge null.
 */
function mergeSeq<T>(o: readonly T[], a: readonly T[], b: readonly T[], key: (t: T) => string, item: ((o: T, a: T, b: T) => T | null) | null): T[] | null {
  const ko = o.map(key);
  const ka = a.map(key);
  const kb = b.map(key);
  const ea = editsOf(o, matchesOf(ko, ka), a, ka);
  const eb = editsOf(o, matchesOf(ko, kb), b, kb);
  const out: T[] = [];
  const push = (xs: readonly T[]) => {
    for (const x of xs) out.push(x);
  };
  for (let i = 0; i <= o.length; i++) {
    const pa = ea.put[i];
    const pb = eb.put[i];
    if (pa && pb) {
      const both = union(pa, ea.putKeys[i]!, pb, eb.putKeys[i]!, item !== null);
      if (!both) return null;
      push(both);
    } else push(pa ?? pb ?? []);
    if (i === o.length) break;
    const da = ea.did[i]!;
    const db = eb.did[i]!;
    if (da === KEPT && db === KEPT) out.push(o[i]!);
    else if (da === REPLACED && db === REPLACED) {
      const x = ea.by[i]!;
      const y = eb.by[i]!;
      const merged = key(x) === key(y) ? x : item?.(o[i]!, x, y);
      if (merged) out.push(merged);
      else if (item) out.push(y, x);
      else return null;
    } else if (da === REPLACED) out.push(ea.by[i]!);
    else if (db === REPLACED) out.push(eb.by[i]!);
    // Deleted on one side and kept or deleted on the other: gone.
  }
  return out;
}

/**
 * Two sides' insertions at one place: what both start or end with once, and between, theirs then mine. When one side's is
 * inside the other's (the same words, one with more typed around them) that is no conflict; otherwise null if not allowed.
 */
function union<T>(a: T[], ka: string[], b: T[], kb: string[], allowed: boolean): T[] | null {
  let p = 0;
  while (p < ka.length && p < kb.length && ka[p] === kb[p]) p++;
  let s = 0;
  while (s < ka.length - p && s < kb.length - p && ka[ka.length - 1 - s] === kb[kb.length - 1 - s]) s++;
  if (!allowed && p + s < ka.length && p + s < kb.length) return null;
  return [...a.slice(0, p), ...b.slice(p, b.length - s), ...a.slice(p, a.length - s), ...a.slice(a.length - s)];
}

/** For each item of `o`, the index of its match in `b` in a longest common subsequence, or -1. */
function matchesOf(o: readonly string[], b: readonly string[]): Int32Array {
  const at = new Int32Array(o.length).fill(-1);
  let start = 0;
  while (start < o.length && start < b.length && o[start] === b[start]) at[start] = start++;
  let endO = o.length;
  let endB = b.length;
  while (endO > start && endB > start && o[endO - 1] === b[endB - 1]) at[--endO] = --endB;
  for (const [x, y] of myers(o, start, endO, b, start, endB)) at[x] = y;
  return at;
}

/** Most edits a comparison looks for, and most work (edits × length): past them the middle counts as all changed. */
const EDITS_MAX = 400;
const WORK_MAX = 2_000_000;

/** Myers' O((N+M)·D) diff of a[a0..a1) and b[b0..b1): the matched index pairs, none when the distance is over the cap. */
function myers(a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number): Array<[number, number]> {
  const n = a1 - a0;
  const m = b1 - b0;
  if (!n || !m) return [];
  const max = Math.min(n + m, EDITS_MAX, Math.floor(WORK_MAX / (n + m)));
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, off, n, m, a0, b0);
    }
  }
  return [];
}

function backtrack(trace: Int32Array[], off: number, n: number, m: number, a0: number, b0: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([a0 + x, b0 + y]);
    }
    x = prevX;
    y = prevY;
  }
  return pairs;
}
