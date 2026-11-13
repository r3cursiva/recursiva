// Markdown ⇄ document, without ProseMirror and without a DOM: the server (agent API, import), the comment renderer and
// the editor all use this one dialect.
//
// The dialect is CommonMark for what our schema has, plus GitHub's task items, strikethrough and bare URLs and `<u>` for
// underline. `<details>`/`<summary>` (as GitHub writes a collapsible section) is read as its title in bold and its
// content (doc.ts, sectionBlocks): the editor has no collapsible section since PLNR-378. Differences from CommonMark,
// all on purpose: no indented code blocks, no setext headings, no link reference definitions, and no raw HTML: tags
// other than those above stay text, nothing here ever produces markup from the source. Headings deeper than ### become
// ###.
//
// Tables are GitHub's (doc.ts): a header row, a delimiter row (`| --- | :---: |`) with as many cells, and rows up to a
// blank line or another block; a table may interrupt a paragraph. Short rows get empty cells, long ones lose the rest.
// `\|` is a pipe in a cell, in code too, as on GitHub. One difference: `\\|` is a backslash and an escaped pipe here,
// not a backslash and the end of the cell; a cell we write never ends in a backslash, so nothing we write depends on it.
//
// The source is untrusted: nesting deeper than MAX_DEPTH becomes text, every scan is linear (backtick runs and
// brackets are matched up front, emphasis looks back a bounded number of delimiters), and every link goes through
// safeHref.
//
// Serializing writes readable Markdown (`**bold**`, `*italic*`). Emphasis cannot express every overlap of marks (bold
// ending inside a word that stays italic), so every textblock is parsed back, and if it would come back different, its
// marks are written as inline tags (`<strong>`, `<em>`, `<s>`), which the parser reads exactly: doc → Markdown → doc
// keeps every mark.
//
// An image is a line of its own, `![alt](/files/<ws>/<sha256>)`, and only with a file of the workspace as its source
// (doc.ts). Anywhere else `![…](…)` stays what it was before images: the label as text.
//
// A mention is a link with the `mention:` scheme, `[@Name](mention:<user id>)` (doc.ts). Reading, its target goes
// through a resolver: by default only a user id is a mention; the agent API passes one that also takes an email or `me`.
// A target the resolver refuses leaves the label as text, like any other link that is not safe.
import { readFilePath } from "@rsva/schema/models";
import {
  decodeEntity,
  fitItem,
  imageAltOf,
  MARK_TAGS,
  MAX_DEPTH,
  MENTION_ID,
  MENTION_SCHEME,
  mentionLabelOf,
  mentionMarks,
  mentionNode,
  node,
  orEmpty,
  pushText,
  safeHref,
  sameDoc,
  sameMark,
  sectionBlocks,
  TABLE_CELLS_MAX,
  TABLE_COLUMNS_MAX,
  type CellAlign,
  type DocMark,
  type DocNode,
  withoutSections,
} from "./doc.ts";

/** A mention's target (after `mention:`) → the person it names, or null to leave the label as text. `label` fills an empty one. */
export type MentionResolver = (target: string) => { id: string; label?: string } | null;

const userIdOnly: MentionResolver = (t) => (MENTION_ID.test(t.toLowerCase()) ? { id: t.toLowerCase() } : null);
/** The resolver of the fromMarkdown call in progress (parsing is synchronous). */
let resolveMention: MentionResolver = userIdOnly;
/**
 * Table cells the fromMarkdown call in progress may still make, across all its tables: short rows are filled with empty
 * cells, so without one budget for the document a few hundred small tables of bare `|` rows would make millions.
 */
let cellBudget = TABLE_CELLS_MAX;

// ── Parse: blocks ───────────────────────────────────────────────────────────────────────────────────────────────

// The line patterns are linear in the line (RSVA-621): no run of spaces or marks may be matched in two ways, or a
// failed match tries every split of it. `(?=(x))\1` takes a run whole, as an atomic group would. A fence of tildes
// before a backtick was cubic (2 KB took 2 s); spaces in a fence line, a heading or a delimiter row were quadratic.
const FENCE = /^ {0,3}(?=(`{3,}|~{3,}))\1(?=[^`]*$)[ \t]*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(?![ \t])(.*?[^ \t]))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const DETAILS_OPEN = /^ {0,3}<details(\s+open(?:=(?:""|"open"|''|'open'|open))?)?\s*>(.*)$/i;
const DETAILS_CLOSE = /^ {0,3}<\/details>\s*$/i;
const SUMMARY = /^\s*<summary>(.*?)<\/summary>\s*$/i;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const IMAGE = /^ {0,3}!\[([^\]\n]*)\]\(([^()\s]+)\)[ \t]*$/;

/** An image line's node, or null for a line that is not one (another source than a workspace file is not an image). */
function imageLine(l: string): DocNode | null {
  const m = IMAGE.exec(l);
  return m && readFilePath(m[2]!) ? node("image", { src: m[2]!, alt: imageAltOf(m[1]!) }) : null;
}

/**
 * A delimiter row: cells of dashes with optional colons. One pipe at least, so `---` alone stays a rule. Spaces end a
 * cell or the row, never both (see FENCE).
 */
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*(?:\|[ \t]*)?$/;

/** A table's delimiter row (`| --- | :-: |`): what makes the line above it a header (the TUI asks too). */
export const isDelimiterRow = (line: string): boolean => line.includes("|") && DELIMITER_ROW.test(line);

/**
 * A table row's cells, still in Markdown: split at every pipe without a backslash before it, the outer pipes optional,
 * each cell trimmed, `\|` unescaped. One pass over the line.
 */
export function tableCells(line: string): string[] {
  const cells: string[] = [];
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "|" || s[i - 1] === "\\") continue;
    cells.push(s.slice(from, i));
    from = i + 1;
  }
  cells.push(s.slice(from));
  return cells.map((c) => c.trim().replaceAll("\\|", "|"));
}

/** A cell's Markdown with every pipe escaped: tableCells reads it back exactly (one backslash comes off each `\|`). */
const escapePipes = (md: string) => md.replaceAll("|", "\\|");

/** The header cells and alignments of a table starting at `i`, or null when the lines there are not one. */
function tableStart(lines: string[], i: number): { header: string[]; aligns: CellAlign[] } | null {
  const delim = lines[i + 1];
  if (delim === undefined || !isDelimiterRow(delim) || !lines[i]!.includes("|")) return null;
  const header = tableCells(lines[i]!);
  const marks = tableCells(delim);
  if (header.length !== marks.length || header.length > TABLE_COLUMNS_MAX || header.length * 2 > cellBudget) return null;
  const aligns = marks.map((m): CellAlign => (m.startsWith(":") ? (m.endsWith(":") ? "center" : "left") : m.endsWith(":") ? "right" : ""));
  return { header, aligns };
}

/** The table at `i` (tableStart said there is one); returns the line after it. */
function table(lines: string[], i: number, start: { header: string[]; aligns: CellAlign[] }, out: DocNode[], depth: number): number {
  const width = start.header.length;
  const row = (cells: string[]) =>
    node(
      "table_row",
      null,
      Array.from({ length: width }, (_, k) => node("table_cell", { align: start.aligns[k]! }, inline(cells[k] ?? "", depth + 1))),
    );
  cellBudget -= width;
  const rows = [row(start.header)];
  for (i += 2; i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!) && cellBudget >= width; i++, cellBudget -= width) rows.push(row(tableCells(lines[i]!)));
  out.push(node("table", null, rows));
  return i;
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const startsBlock = (l: string) =>
  FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l) || DETAILS_OPEN.test(l) || DETAILS_CLOSE.test(l) || imageLine(l) !== null;

export function fromMarkdown(md: string, opts: { mention?: MentionResolver } = {}): DocNode {
  const lines = md.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/\u0000/g, "�").split("\n");
  const outer = resolveMention;
  const outerBudget = cellBudget;
  resolveMention = opts.mention ?? userIdOnly;
  cellBudget = TABLE_CELLS_MAX;
  try {
    return node("doc", null, orEmpty(blocks(lines, 0)));
  } finally {
    resolveMention = outer;
    cellBudget = outerBudget;
  }
}

function blocks(lines: string[], depth: number): DocNode[] {
  if (depth >= MAX_DEPTH) {
    const text = lines.join(" ").replace(/\s+/g, " ").trim();
    return text ? [node("paragraph", null, [{ type: "text", text }])] : [];
  }
  const out: DocNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    let img: DocNode | null;
    let t: ReturnType<typeof tableStart>;
    if ((m = FENCE.exec(line))) {
      const fence = m[1]!;
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
      const strip = new RegExp(`^ {0,${indentOf(line)}}`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!.replace(strip, ""));
      i++;
      const text = body.join("\n");
      out.push(node("code_block", { language: (m[2] ?? "").slice(0, 32) }, text ? [{ type: "text", text }] : []));
    } else if ((m = HEADING.exec(line))) {
      out.push(node("heading", { level: Math.min(m[1]!.length, 3) }, inline(m[2] ?? "", depth)));
      i++;
    } else if (RULE.test(line)) {
      out.push({ type: "horizontal_rule" });
      i++;
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) inner.push(lines[i]!.replace(QUOTE, ""));
      out.push(node("blockquote", null, orEmpty(blocks(inner, depth + 1))));
    } else if (ITEM.test(line)) {
      i = list(lines, i, out, depth);
    } else if ((m = DETAILS_OPEN.exec(line))) {
      i = details(lines, i, m, out, depth);
    } else if ((img = imageLine(line))) {
      out.push(img);
      i++;
    } else if ((t = tableStart(lines, i))) {
      i = table(lines, i, t, out, depth);
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && !(para.length && (startsBlock(lines[i]!) || tableStart(lines, i))); i++) para.push(lines[i]!);
      const content = inline(para.join("\n"), depth);
      if (content.length) out.push(node("paragraph", null, content));
    }
  }
  return out;
}

/** `<details>` up to its matching `</details>`; the summary is on the same line or the next one. */
function details(lines: string[], start: number, m: RegExpExecArray, out: DocNode[], depth: number): number {
  let rest = m[2]!.trim();
  let i = start + 1;
  let summary = "";
  const s = SUMMARY.exec(rest);
  if (s) {
    summary = s[1]!;
    rest = "";
  } else if (!rest) {
    let j = i;
    while (j < lines.length && !lines[j]!.trim()) j++;
    const s2 = j < lines.length ? SUMMARY.exec(lines[j]!) : null;
    if (s2) {
      summary = s2[1]!;
      i = j + 1;
    }
  }
  const body: string[] = rest ? [rest] : [];
  let level = 1;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (DETAILS_OPEN.test(l)) level++;
    else if (DETAILS_CLOSE.test(l) && --level === 0) break;
    body.push(l);
  }
  out.push(...sectionBlocks(inline(summary, depth), blocks(body, depth + 1)));
  return i + 1;
}

function list(lines: string[], start: number, out: DocNode[], depth: number): number {
  const first = ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const marker = first[2]!.at(-1)!;
  const items: { task: boolean | null; blocks: DocNode[] }[] = [];
  /** The first line with text after the current run of blank lines: found once per run, not once per blank line. */
  let text = -1;
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    // Another bullet character or delimiter starts a new list, as in CommonMark.
    if (!m || m[1]!.length !== indent || m[2]!.at(-1) !== marker) break;
    const col = m[0].length === m[1]!.length + m[2]!.length ? m[0].length + 1 : m[0].length;
    const item = [lines[i]!.slice(m[0].length)];
    for (i++; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.trim()) {
        // A blank line continues the item only if indented content follows.
        if (text <= i) for (text = i + 1; text < lines.length && !lines[text]!.trim(); ) text++;
        if (text === lines.length || indentOf(lines[text]!) < col) break;
        item.push("");
      } else if (indentOf(l) >= col) item.push(l.slice(col));
      else if (indentOf(l) > indent && ITEM.test(l)) item.push(l.trimStart()); // a nested list indented less than the text
      else if (!startsBlock(l) && item.at(-1)?.trim()) item.push(l.trimStart()); // lazy continuation of the paragraph
      else break;
    }
    // Blank lines between items keep the list going.
    let j = i;
    while (j < lines.length && !lines[j]!.trim()) j++;
    const sibling = j < lines.length ? ITEM.exec(lines[j]!) : null;
    if (j > i && sibling && sibling[1]!.length === indent && sibling[2]!.at(-1) === marker) i = j;

    const task = !ordered ? TASK.exec(item[0]!) : null;
    if (task) item[0] = item[0]!.slice(task[0].length);
    items.push({ task: task ? task[1] !== " " : null, blocks: fitItem(blocks(item, depth + 1)) });
  }
  // Runs of task items and plain items become separate lists: the schema keeps them apart.
  const order = ordered ? parseInt(first[2]!, 10) : 1;
  for (let k = 0; k < items.length; ) {
    const isTask = items[k]!.task !== null;
    const run: DocNode[] = [];
    for (; k < items.length && (items[k]!.task !== null) === isTask; k++) {
      const it = items[k]!;
      run.push(isTask ? node("task_item", { checked: it.task! }, it.blocks) : node("list_item", null, it.blocks));
    }
    out.push(isTask ? node("task_list", null, run) : ordered ? node("ordered_list", { order }, run) : node("bullet_list", null, run));
  }
  return i;
}

// ── Parse: inline ───────────────────────────────────────────────────────────────────────────────────────────────

type Tag = "bold" | "italic" | "strike" | "underline";
type Tok =
  | { k: "text"; s: string }
  | { k: "code"; s: string }
  | { k: "br" }
  | { k: "mention"; id: string; label: string }
  | { k: "open"; m: Tag | "link"; href?: string }
  | { k: "close"; m: Tag | "link" }
  | Delim;

/** A run of `*`, `_` or `~~`, or an inline tag; resolved into open and close tokens by matching. */
interface Delim {
  k: "delim";
  ch: string;
  len: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
  /** An explicit tag (`<strong>`, `</strong>`): matched only to the same tag; `src` is its text if unmatched. */
  tag?: Tag;
  src?: string;
  opens: Tag[];
  closes: Tag[];
}

const PUNCT = /[\p{P}\p{S}]/u;
const WS = /\s/u;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
/** How far back a closer looks for its opener: keeps hostile input (thousands of `*`) linear. */
const LOOKBACK = 64;

function inline(src: string, depth: number): DocNode[] {
  const out: DocNode[] = [];
  const s = src.trim();
  emit(tokens(s, scan(s), 0, s.length, depth, false), out);
  return out;
}

/** Applies resolved tokens: a mark stack (a mark may nest in itself), text with the marks open at that point. */
function emit(toks: Tok[], out: DocNode[]): void {
  const open: DocMark[] = [];
  const current = (): DocMark[] => {
    const seen = new Map<string, DocMark>();
    for (const m of open) seen.set(m.type, m);
    return [...seen.values()];
  };
  for (const t of toks) {
    if (t.k === "text") pushText(out, t.s, current());
    else if (t.k === "code") pushText(out, t.s, [...current().filter((m) => m.type === "link"), { type: "code" }]);
    else if (t.k === "br") out.push({ type: "hard_break" });
    else if (t.k === "mention") out.push(mentionNode(t.id, t.label, current()));
    else if (t.k === "open") open.push(t.m === "link" ? { type: "link", attrs: { href: t.href! } } : { type: t.m });
    else if (t.k === "close") {
      const at = open.findLastIndex((x) => x.type === t.m);
      if (at >= 0) open.splice(at, 1);
    }
  }
}

/** Positions matched once per textblock, so the inline scan never searches ahead: code span ends and link brackets. */
interface Scan {
  /** Backtick run start → the start of its closing run of the same length, or -1. */
  codeEnd: Map<number, number>;
  /** `[` → its matching `]`. */
  bracket: Map<number, number>;
}

function scan(src: string): Scan {
  // Maximal backtick runs by length: a code span closes on the next run of exactly its opener's length.
  const runs = new Map<number, number[]>();
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "`") continue;
    let j = i;
    while (src[j] === "`") j++;
    let list = runs.get(j - i);
    if (!list) runs.set(j - i, (list = []));
    list.push(i);
    i = j - 1;
  }
  const cursor = new Map<number, number>();
  const nextRun = (len: number, after: number) => {
    const list = runs.get(len) ?? [];
    let k = cursor.get(len) ?? 0;
    while (k < list.length && list[k]! < after) k++;
    cursor.set(len, k);
    return k < list.length ? list[k]! : -1;
  };
  // One pass in reading order: escapes apply outside code spans only (a backslash inside one is text), and brackets
  // inside code spans do not count.
  const codeEnd = new Map<number, number>();
  const bracket = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "`") {
      let j = i;
      while (src[j] === "`") j++;
      const end = nextRun(j - i, j);
      codeEnd.set(i, end);
      i = (end >= 0 ? end + (j - i) : j) - 1;
    } else if (c === "[") stack.push(i);
    else if (c === "]" && stack.length) bracket.set(stack.pop()!, i);
  }
  return { codeEnd, bracket };
}

/** src[from, to) → tokens with emphasis resolved. A link's label is tokenized on its own: emphasis never crosses it. */
function tokens(src: string, sc: Scan, from: number, to: number, depth: number, inLink: boolean): Tok[] {
  if (depth >= MAX_DEPTH) return [{ k: "text", s: src.slice(from, to) }];
  const toks: Tok[] = [];
  // Text since the last token: finished lines in `done`, the current one in `line`, and how many spaces it all ends
  // with. One string for the whole paragraph was re-read (flattened by V8) at every line end, which made long
  // paragraphs quadratic (66k lines took 17 s); a line end now reads only the line before it.
  let done: string[] = [];
  let line = "";
  let trail = 0;
  const add = (t: string) => {
    line += t;
    let k = t.length;
    while (k > 0 && t.charCodeAt(k - 1) === 32) k--;
    trail = k ? t.length - k : trail + t.length;
  };
  /** Drops the trailing spaces; returns how many there were. */
  const trimEnd = () => {
    const n = trail;
    for (let left = n; left > 0 && (line || done.length); line = done.pop() ?? "") {
      if (line.length >= left) {
        line = line.slice(0, line.length - left);
        break;
      }
      left -= line.length;
    }
    trail = 0;
    return n;
  };
  /** The current line is finished: later trims rarely reach back into it. */
  const endLine = () => {
    done.push(line);
    line = "";
  };
  const flush = () => {
    const text = done.length ? done.join("") + line : line;
    if (text) toks.push({ k: "text", s: text });
    done = [];
    line = "";
    trail = 0;
  };
  const at = (i: number) => (i < from || i >= to ? " " : src[i]!);
  for (let i = from; i < to; ) {
    const c = src[i]!;
    if (c === "\\" && src[i + 1] === "\n" && i + 1 < to) {
      trimEnd();
      flush();
      toks.push({ k: "br" });
      i += 2;
      while (src[i] === " " && i < to) i++;
    } else if (c === "\\" && i + 1 < to && ESCAPABLE.test(src[i + 1]!)) {
      add(src[i + 1]!);
      i += 2;
    } else if (c === "\n") {
      // Two trailing spaces make a hard break; a plain newline is a soft break (a space).
      const hard = trimEnd() >= 2;
      if (hard) {
        flush();
        toks.push({ k: "br" });
      } else {
        add(" ");
        endLine();
      }
      i++;
      while (src[i] === " " && i < to) i++;
    } else if (c === "`") {
      let j = i;
      while (src[j] === "`" && j < to) j++;
      const end = sc.codeEnd.get(i) ?? -1;
      if (end < 0 || end >= to) {
        add(src.slice(i, j));
        i = j;
        continue;
      }
      flush();
      let code = src.slice(j, end).replace(/\n/g, " ");
      if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
      toks.push({ k: "code", s: code });
      i = end + (j - i);
    } else if (c === "&") {
      const m = /^&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/i.exec(src.slice(i, Math.min(to, i + 10)));
      const ch = m && decodeEntity(m[1]!);
      if (ch) {
        add(ch);
        i += m[0].length;
      } else {
        add(c);
        i++;
      }
    } else if (c === "<") {
      const rest = src.slice(i, Math.min(to, i + 2048));
      const auto = !inLink ? /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest) : null;
      const tag = /^<(\/?)(strong|b|em|i|s|del|strike|u)>/i.exec(rest);
      const href = auto && safeHref(auto[1]!);
      if (auto && href) {
        flush();
        toks.push({ k: "open", m: "link", href }, { k: "text", s: auto[1]! }, { k: "close", m: "link" });
        i += auto[0].length;
      } else if (tag) {
        flush();
        toks.push({ k: "delim", ch: "<", len: 1, orig: 1, canOpen: !tag[1], canClose: !!tag[1], tag: MARK_TAGS.get(tag[2]!.toLowerCase()) as Tag, src: tag[0], opens: [], closes: [] });
        i += tag[0].length;
      } else {
        add(c);
        i++;
      }
    } else if ((c === "[" || (c === "!" && src[i + 1] === "[")) && !inLink) {
      const img = c === "!";
      const open = img ? i + 1 : i;
      const close = sc.bracket.get(open);
      const dest = close !== undefined && close < to && src[close + 1] === "(" ? destination(src, close + 1, to) : null;
      if (!dest) {
        add(c);
        i++;
        continue;
      }
      flush();
      const mention = !img && dest.url.startsWith(MENTION_SCHEME) ? resolveMention(dest.url.slice(MENTION_SCHEME.length)) : null;
      if (mention) {
        toks.push({ k: "mention", id: mention.id, label: mentionLabel(src.slice(open + 1, close!)) || (mention.label ?? "") });
        i = dest.end;
        continue;
      }
      const href = safeHref(dest.url);
      const label = tokens(src, sc, open + 1, close!, depth + 1, true);
      if (href) toks.push({ k: "open", m: "link", href }, ...(label.length ? label : [{ k: "text" as const, s: href }]), { k: "close", m: "link" });
      else toks.push(...label); // an unsafe link keeps its text
      i = dest.end;
    } else if ((c === "h" || c === "H") && !inLink && /[\s*_~(]/.test(at(i - 1))) {
      const url = bareUrl(src.slice(i, Math.min(to, i + 4096)));
      const href = url && safeHref(url);
      if (url && href) {
        flush();
        toks.push({ k: "open", m: "link", href }, { k: "text", s: url }, { k: "close", m: "link" });
        i += url.length;
      } else {
        add(c);
        i++;
      }
    } else if (c === "*" || c === "_" || c === "~") {
      let j = i;
      while (src[j] === c && j < to) j++;
      const len = j - i;
      if (c === "~" && len !== 2) {
        add(src.slice(i, j));
        i = j;
        continue;
      }
      flush();
      const before = at(i - 1);
      const after = at(j);
      const left = !WS.test(after) && (!PUNCT.test(after) || WS.test(before) || PUNCT.test(before));
      const right = !WS.test(before) && (!PUNCT.test(before) || WS.test(after) || PUNCT.test(after));
      const canOpen = c === "_" ? left && (!right || PUNCT.test(before)) : left;
      const canClose = c === "_" ? right && (!left || PUNCT.test(after)) : right;
      toks.push({ k: "delim", ch: c, len, orig: len, canOpen, canClose, opens: [], closes: [] });
      i = j;
    } else {
      // add(c) inlined: most characters come this way.
      line += c;
      trail = c === " " ? trail + 1 : 0;
      i++;
    }
  }
  flush();
  resolve(toks);
  // Delimiter runs become their unmatched characters plus the marks they open or close.
  const out: Tok[] = [];
  for (const t of toks) {
    if (t.k !== "delim") {
      out.push(t);
      continue;
    }
    for (const m of t.closes) out.push({ k: "close", m });
    if (t.len) out.push({ k: "text", s: t.src ?? t.ch.repeat(t.len) });
    for (const m of t.opens) out.push({ k: "open", m });
  }
  return out;
}

/** CommonMark's emphasis matching ("process emphasis"); explicit tags match only each other and nest strictly. */
function resolve(toks: Tok[]): void {
  const stack: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const c = toks[i]!;
    if (c.k !== "delim") continue;
    while (c.canClose && c.len > 0) {
      let found = -1;
      for (let s = stack.length - 1, seen = 0; s >= 0 && seen < LOOKBACK; s--, seen++) {
        const o = toks[stack[s]!] as Delim;
        if (o.len === 0) continue;
        if (c.tag || o.tag) {
          if (c.tag && c.tag === o.tag) found = s;
          // Emphasis does not match across an open tag.
          if (found >= 0 || (o.tag && !c.tag)) break;
          continue;
        }
        if (o.ch !== c.ch) continue;
        if (c.ch !== "~" && (o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
        found = s;
        break;
      }
      if (found < 0) break;
      const o = toks[stack[found]!] as Delim;
      const n = c.tag ? 1 : c.ch === "~" ? 2 : o.len >= 2 && c.len >= 2 ? 2 : 1;
      const m: Tag = c.tag ?? (c.ch === "~" ? "strike" : n === 2 ? "bold" : "italic");
      o.len -= n;
      c.len -= n;
      o.opens.unshift(m);
      c.closes.push(m);
      // Openers between the pair are done: they can no longer close anything inside it.
      stack.length = found + (o.len > 0 ? 1 : 0);
    }
    if (c.canOpen && c.len > 0) stack.push(i);
  }
}

/** A mention's label as written: escapes and entities decoded, without the leading `@`, on one line, at most a name long. */
function mentionLabel(raw: string): string {
  // Escapes and entities in one pass, as tokens() reads them: `\&amp;` is the text "&amp;".
  const text = raw.replace(/\\([!-/:-@[-`{-~])|&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (e, esc: string | undefined, ent: string | undefined) =>
    esc ?? decodeEntity(ent!) ?? e,
  );
  return mentionLabelOf(text.replace(/^\s*@/, ""));
}

/**
 * `(dest "title")` at `i`; returns the URL and where the link ends. The leading spaces are taken whole (see FENCE): with no
 * destination they could also be the title's or the closing ones, which made `(` and 2 KB of spaces cost 5 ms (RSVA-621).
 */
function destination(src: string, i: number, to: number): { url: string; end: number } | null {
  const m = /^\((?=(\s*))\1(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/.exec(
    src.slice(i, Math.min(to, i + 2048)),
  );
  if (!m) return null;
  return { url: (m[2] ?? m[3] ?? "").replace(/\\([!-/:-@[-`{-~])/g, "$1"), end: i + m[0].length };
}

const TRAILING = "?!.,:*_~;'\"";

/** GitHub's autolink literal: trailing punctuation and an unbalanced `)` stay outside the link. */
function bareUrl(s: string): string | null {
  // Only the host can make a URL fail to parse. It ends at the first `/`, `?`, `#` or `\`; a prefix that takes it whole
  // and ends on a character the trimming below never removes (not TRAILING, not `)`) parses exactly when the link would.
  // Testing that first keeps a run of failing candidates (`(http://[` repeated) from scanning and parsing the window from
  // each of them (RSVA-623).
  const host = /^https?:\/\/[/\\]*(?![/\\])[^\s<>/?#\\]*(?:[/#\\]|\?[?!.,:*_~;'")]*[^\s<>?!.,:*_~;'")])/i.exec(s);
  if (host && !parses(host[0])) return null;
  const m = /^https?:\/\/[^\s<>]+/i.exec(s);
  if (!m) return null;
  // One pass from the end, with the parentheses counted once: re-counting them per `)` was quadratic.
  const whole = m[0];
  let open = 0;
  let close = 0;
  for (const ch of whole) {
    if (ch === "(") open++;
    else if (ch === ")") close++;
  }
  let end = whole.length;
  for (;;) {
    while (end > 0 && TRAILING.includes(whole[end - 1]!)) end--;
    if (whole[end - 1] !== ")" || close <= open) break;
    end--;
    close--;
  }
  const url = whole.slice(0, end);
  return parses(url) ? url : null;
}

/**
 * The bare URLs in plain text, by the rule a comment's Markdown links them (bareUrl): at the start, after a space or `(`.
 * Pasted text links them as Markdown would: plain text is stored escaped (`https\://`) and is never linked later (RSVA-627).
 */
export function urlSpans(text: string): { from: number; to: number; href: string }[] {
  const out: { from: number; to: number; href: string }[] = [];
  for (const m of text.matchAll(/(?<![^\s(])https?:\/\//gi)) {
    if (m.index < (out.at(-1)?.to ?? 0)) continue;
    const url = bareUrl(text.slice(m.index, m.index + 4096));
    const href = url && safeHref(url);
    if (url && href) out.push({ from: m.index, to: m.index + url.length, href });
  }
  return out;
}

/** A host after the scheme, and a URL that parses: checked with canParse, which throws no exception per candidate. */
const parses = (url: string) => /^https?:\/\/[^/?#\s]/i.test(url) && URL.canParse(url);

// ── Serialize ───────────────────────────────────────────────────────────────────────────────────────────────────

export function toMarkdown(doc: DocNode): string {
  const md = joinBlocks(withoutSections(doc).content ?? []);
  return md ? md + "\n" : "";
}

const LISTS = new Set(["bullet_list", "ordered_list", "task_list"]);

/**
 * Blocks separated by blank lines; in a list item, a nested list follows the text directly (a tight list). Adjacent
 * lists of one kind would merge when read back, so every other one uses the other bullet or delimiter.
 */
function joinBlocks(nodes: DocNode[], inItem = false): string {
  let out = "";
  let prevMarker = "";
  let prev: DocNode | null = null;
  for (const n of nodes) {
    const sameKind = prev && LISTS.has(n.type) && (n.type === "ordered_list") === (prev.type === "ordered_list") && LISTS.has(prev.type);
    const marker = !LISTS.has(n.type) ? "" : n.type === "ordered_list" ? (sameKind && prevMarker === "." ? ")" : ".") : sameKind && prevMarker === "-" ? "*" : "-";
    const s = block(n, marker);
    // A block with no Markdown (an empty or blank paragraph) does not separate two lists: the next one still alternates.
    if (!s) continue;
    prev = n;
    prevMarker = marker;
    const tight = inItem && LISTS.has(n.type) && !(n.type === "ordered_list" && n.attrs?.order !== 1);
    out += out ? (tight ? "\n" : "\n\n") + s : s;
  }
  return out;
}

const indent = (s: string, first: string, rest: string) =>
  s
    .split("\n")
    .map((l, i) => (i === 0 ? first + l : l ? rest + l : l))
    .join("\n");

function block(n: DocNode, marker: string): string | null {
  const kids = n.content ?? [];
  switch (n.type) {
    case "paragraph":
      return kids.length ? inlineMd(kids, "block") : null;
    case "heading": {
      const text = inlineMd(kids, "line").replace(/(\s)(#+)$/, "$1\\$2");
      return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${text}`.trimEnd();
    }
    case "blockquote":
      return joinBlocks(kids)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "code_block": {
      const text = kids.map((k) => k.text ?? "").join("");
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map((x) => x[0].length + 1)));
      return `${fence}${n.attrs?.language ?? ""}\n${text}${text ? "\n" : ""}${fence}`;
    }
    case "horizontal_rule":
      return "---";
    case "image":
      return `![${imageAltOf(String(n.attrs?.alt ?? ""))}](${n.attrs?.src ?? ""})`;
    case "bullet_list":
    case "task_list":
      return kids
        .map((li) => {
          const box = n.type === "task_list" ? (li.attrs?.checked ? "[x] " : "[ ] ") : "";
          return indent(joinBlocks(li.content ?? [], true), `${marker} ${box}`, "  ").trimEnd();
        })
        .join("\n");
    case "ordered_list": {
      const start = Number(n.attrs?.order ?? 1);
      const width = String(start + kids.length - 1).length + 2;
      return kids.map((li, i) => indent(joinBlocks(li.content ?? [], true), `${start + i}${marker} `.padEnd(width), " ".repeat(width)).trimEnd()).join("\n");
    }
    case "table": {
      const rows = normalTable(n).content!;
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
      const cellsOf = (r: DocNode) => r.content!.map((c) => escapePipes(inlineMd(c.content ?? [], "line")));
      const delim = rows[0]!.content!.map((c) => ({ "": "---", left: ":---", center: ":---:", right: "---:" })[String(c.attrs?.align ?? "") as CellAlign] ?? "---");
      return [line(cellsOf(rows[0]!)), line(delim), ...rows.slice(1).map((r) => line(cellsOf(r)))].join("\n");
    }
    default:
      return null;
  }
}

// ── Serialize: inline ───────────────────────────────────────────────────────────────────────────────────────────

type Style = Record<Tag, readonly [string, string]>;
const MARKDOWN: Style = { bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"], underline: ["<u>", "</u>"] };
const TAGGED: Style = { bold: ["<strong>", "</strong>"], italic: ["<em>", "</em>"], strike: ["<s>", "</s>"], underline: ["<u>", "</u>"] };

/**
 * Inline content of a textblock. `block`: a paragraph, whose lines may start with block syntax that needs escaping;
 * `line`: a heading or a table cell, which stays on one line (a hard break becomes a space).
 */
function inlineMd(nodes: DocNode[], where: "block" | "line"): string {
  const want = normalizeInline(nodes, where);
  const md = writeInline(want, where, MARKDOWN);
  // Read it back: marks that emphasis cannot express this way are written as tags instead.
  return sameDoc({ type: "doc", content: inline(md, 0) }, { type: "doc", content: want }) ? md : writeInline(want, where, TAGGED);
}

/**
 * What a textblock's content reads back as: edges and line starts trimmed, newlines (and breaks in one-line blocks) as
 * spaces, and emphasis that starts or ends on a space moved off it (`** a**` is not bold in Markdown).
 */
function normalizeInline(nodes: DocNode[], where: "block" | "line"): DocNode[] {
  const runs: DocNode[] = [];
  let lineStart = true;
  for (const n of nodes) {
    if (n.type === "hard_break") {
      if (where === "line") {
        if (!lineStart) pushText(runs, " ", []);
      } else {
        trimTail(runs);
        runs.push({ type: "hard_break" });
        lineStart = true;
      }
      continue;
    }
    if (n.type === "mention") {
      runs.push(mentionNode(String(n.attrs?.id), String(n.attrs?.label ?? ""), n.marks ?? []));
      lineStart = false;
      continue;
    }
    let text = (n.text ?? "").replace(/\n/g, " ");
    if (lineStart && !isCode(n)) text = text.trimStart();
    if (!text) continue;
    lineStart = false;
    pushText(runs, text, n.marks ?? []);
  }
  while (runs[0]?.type === "hard_break") runs.shift();
  for (;;) {
    trimTail(runs);
    if (runs.at(-1)?.type === "hard_break") runs.pop();
    else break;
  }
  const out: DocNode[] = [];
  runs.forEach((n, i) => {
    if (n.type !== "text" || !n.text) {
      if (n.type !== "text") out.push(n);
      return;
    }
    const marks = n.marks ?? [];
    if (marks.some((m) => m.type === "code")) return pushText(out, n.text, marks);
    const near = (k: DocNode | undefined) => (k?.type === "text" ? (k.marks ?? []) : []);
    const prev = near(runs[i - 1]);
    const next = near(runs[i + 1]);
    const keepIf = (other: DocMark[]) => marks.filter((m) => !EMPHASIS.has(m.type) || other.some((o) => sameMark(o, m)));
    if (!n.text.trim()) return pushText(out, n.text, keepIf(prev).filter((m) => keepIf(next).includes(m)));
    const lead = /^\s*/.exec(n.text)![0];
    const trail = /\s*$/.exec(n.text)![0];
    pushText(out, lead, keepIf(prev));
    pushText(out, n.text.slice(lead.length, n.text.length - trail.length), marks);
    pushText(out, trail, keepIf(next));
  });
  return out;
}

const EMPHASIS = new Set(["bold", "italic", "strike"]);
const isCode = (n: DocNode) => !!n.marks?.some((m) => m.type === "code");

/** Spaces before a line end are not kept (code keeps its own). */
function trimTail(runs: DocNode[]): void {
  for (let last = runs.at(-1); last?.type === "text" && !isCode(last); last = runs.at(-1)) {
    last.text = last.text!.trimEnd();
    if (last.text) return;
    runs.pop();
  }
}

/**
 * The document as its Markdown reads back, apart from empty paragraphs (which Markdown has no form for): textblocks
 * normalized as above. fromMarkdown(toMarkdown(doc)) equals this; the tests check it.
 */
export function markdownNormal(n: DocNode): DocNode {
  if (n.type === "table") {
    const t = normalTable(n);
    return { ...t, content: t.content!.map((r) => ({ ...r, content: r.content!.map(markdownNormal) })) };
  }
  if (n.type === "paragraph" || n.type === "heading" || n.type === "table_cell") {
    const content = normalizeInline(n.content ?? [], n.type === "paragraph" ? "block" : "line");
    const { content: _, ...rest } = n;
    return content.length ? { ...rest, content } : rest;
  }
  return n.content && n.type !== "code_block" ? { ...n, content: n.content.map(markdownNormal) } : n;
}

/**
 * A table as Markdown has it: every row as wide as the widest (empty cells added), each column aligned as its header
 * cell is.
 */
function normalTable(n: DocNode): DocNode {
  const rows = n.content ?? [];
  const width = rows.reduce((w, r) => Math.max(w, r.content?.length ?? 0), 1);
  const header = rows[0]?.content ?? [];
  const aligns = Array.from({ length: width }, (_, k) => String(header[k]?.attrs?.align ?? ""));
  return {
    ...n,
    content: rows.map((r) => ({
      ...r,
      content: Array.from({ length: width }, (_, k) => {
        const c = r.content?.[k];
        return { ...(c ?? { type: "table_cell" as const }), attrs: { align: aligns[k]! } };
      }),
    })),
  };
}

const has = (n: DocNode | undefined, m: DocMark) => !!n && (n.type === "text" || n.type === "mention") && (n.marks ?? []).some((x) => sameMark(x, m));

function writeInline(items: DocNode[], where: "block" | "line", style: Style): string {
  let out = "";
  const open: DocMark[] = []; // outermost first; code is never here
  let lineStart = true;
  const close = (keep: number) => {
    while (open.length > keep) {
      const m = open.pop()!;
      out += m.type === "link" ? `](${linkDest(m.attrs!.href)})` : style[m.type as Tag][1];
    }
  };
  /** How many of the open marks, outermost first, the run also has. */
  const kept = (n: DocNode | undefined) => {
    let k = 0;
    while (k < open.length && has(n, open[k]!)) k++;
    return k;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.type === "hard_break") {
      close(0);
      out += "\\\n";
      lineStart = true;
      continue;
    }
    const marks = it.marks ?? [];
    if (it.type === "mention") {
      // A mention takes emphasis only (mentionMarks): a link open around it closes first, as links do not nest.
      const own = { ...it, marks: mentionMarks(marks) };
      close(kept(own));
      const missing = own.marks.filter((m) => !open.some((o) => sameMark(o, m)));
      for (const m of missing.sort((a, b) => reach(items, i, b) - reach(items, i, a))) {
        out += style[m.type as Tag][0];
        open.push(m);
      }
      out = bangSafe(out) + `[@${escapeText(String(it.attrs?.label ?? ""), false)}](${MENTION_SCHEME}${String(it.attrs?.id)})`;
      lineStart = false;
      continue;
    }
    const code = marks.some((m) => m.type === "code");
    const next = items[i + 1];
    const text = it.text!;
    // A link whose text is its address reads back from `<address>`.
    const link = marks.find((m) => m.type === "link");
    if (link && marks.length === 1 && text === link.attrs!.href && !has(items[i - 1], link) && !has(next, link)) {
      close(0);
      out += `<${text}>`;
      lineStart = false;
      continue;
    }
    close(kept(it));
    const missing = marks.filter((m) => m.type !== "code" && !open.some((o) => sameMark(o, m)));
    // Those that last longer open first (outermost), so fewer close and reopen later.
    missing.sort((a, b) => reach(items, i, b) - reach(items, i, a));
    for (const m of missing) {
      out = m.type === "link" ? bangSafe(out) + "[" : out + style[m.type as Tag][0];
      open.push(m);
    }
    out += code ? codeSpan(text) : escapeText(text, lineStart && where === "block");
    lineStart = false;
  }
  close(0);
  return out;
}

/** Before a `[`: a text ending in `!` would make it an image (`wow![x](…)`), so that `!` is escaped. */
const bangSafe = (out: string): string => (/(?<!\\)!$/.test(out) ? out.slice(0, -1) + "\\!" : out);

/** How many runs from `i` on carry the mark. */
function reach(items: DocNode[], i: number, m: DocMark): number {
  let n = 0;
  while (has(items[i + n], m)) n++;
  return n;
}

function linkDest(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>\n]/g, encodeURIComponent)}>` : href;
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((x) => x[0].length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || (/^ .* $/.test(text) && text.trim()) ? " " : "";
  return ticks + pad + text + pad + ticks;
}

/** Markdown syntax in text stays literal; `_` inside a word and a lone `~` need no escape. */
function escapeText(s: string, lineStart: boolean): string {
  let t = s
    .replace(/[\\`*[\]]/g, "\\$&")
    .replace(/~(?=~)|(?<=~)~/g, "\\~")
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_")
    .replace(/<(?=[a-zA-Z/!?])/g, "\\<")
    .replace(/&(?=#?[a-zA-Z0-9]+;)/g, "\\&")
    .replace(/\b(https?):\/\//gi, "$1\\://")
    .replace(/ /g, "&nbsp;");
  if (lineStart) t = t.replace(/^([#>+-]|\d+(?=[.)]))/, (mk: string) => (/\d/.test(mk) ? mk + "\\" : "\\" + mk));
  return t;
}
