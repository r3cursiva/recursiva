// The document as plain JSON: exactly ProseMirror's Node.toJSON() for our schema (schema.ts), so the server stores it,
// y-prosemirror can load it later, and the Markdown, HTML and DOM converters below work without ProseMirror or a DOM.
//
// Node and mark names follow Linear's (snake_case: task_list, code_block). Attributes are always present on
// the types that have them, as toJSON writes them, so two equal documents are equal as JSON.
import { readFilePath, UUID_PATTERN } from "@rsva/schema/models";

type BlockName =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "code_block"
  | "horizontal_rule"
  | "bullet_list"
  | "ordered_list"
  | "task_list"
  | "image"
  | "table";
export type NodeName = "doc" | BlockName | "list_item" | "task_item" | "table_row" | "table_cell" | "text" | "hard_break" | "mention";
/** In schema order: the order of marks on a text node. Code is innermost. */
const MARKS = ["link", "bold", "italic", "strike", "underline", "code"] as const;
type MarkName = (typeof MARKS)[number];

export interface DocMark {
  type: MarkName;
  attrs?: { href: string };
}

export interface DocNode {
  type: NodeName;
  attrs?: Record<string, string | number | boolean>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}

/**
 * A mention (PLNR-27) is an inline atom `{ type: "mention", attrs: { id, label } }`: the person's user id and the name
 * shown when it was written. Markdown writes it as a link with the `mention:` scheme, `[@Name](mention:<user id>)`:
 * plain Markdown that reads as "@Name" anywhere else, and an agent can write it by hand.
 */
export const MENTION_SCHEME = "mention:";
/** A user id (UUID, any version) as Postgres writes it: lower case, so ids compare as strings everywhere. */
export const MENTION_ID = new RegExp(`^${UUID_PATTERN}$`);
/** Longest stored label: a name (NAME_MAX in packages/schema). */
const MENTION_LABEL_MAX = 80;

/** A label as stored: one line, single spaces, no space at either end, at most MENTION_LABEL_MAX. Markdown keeps it exactly. */
export const mentionLabelOf = (raw: string): string => raw.replace(/\s+/g, " ").trim().slice(0, MENTION_LABEL_MAX).trimEnd();

/** Every mention's person in reading order, repeats kept. */
export function mentionsInOrder(doc: DocNode): string[] {
  const out: string[] = [];
  const walk = (n: DocNode, depth: number) => {
    if (n.type === "mention" && typeof n.attrs?.id === "string") out.push(n.attrs.id);
    if (depth < MAX_NODE_DEPTH) for (const c of n.content ?? []) walk(c, depth + 1);
  };
  walk(doc, 0);
  return out;
}

/** The people a document mentions, each once, in reading order. */
export const mentionIds = (doc: DocNode): string[] => [...new Set(mentionsInOrder(doc))];

/**
 * An image (PLNR-50) is a block atom `{ type: "image", attrs: { src, alt } }`. `src` is only ever a file of the workspace,
 * `/files/<ws>/<sha256>` (readFilePath in packages/schema): no outside address, so a document cannot make a reader's
 * browser fetch anything from elsewhere. Markdown writes it on a line of its own, `![alt](/files/…)`.
 */
const IMAGE_ALT_MAX = 200;

/** Alt text as stored: one line, no brackets or backslashes (so Markdown keeps it exactly), at most IMAGE_ALT_MAX. */
export const imageAltOf = (raw: string): string => raw.replace(/[[\]\\]/g, "").replace(/\s+/g, " ").trim().slice(0, IMAGE_ALT_MAX).trimEnd();

/**
 * A table (PLNR-367) is GitHub's: rows of cells, the first row the header, each cell one line of inline content (text,
 * marks, mentions; no breaks, no blocks), and an alignment per column. No merged cells, colours or widths: Markdown
 * keeps none of them. The alignment is on every cell of a column (`align`), as the editor copies it into new cells.
 */
export const CELL_ALIGNS = ["", "left", "center", "right"] as const;
export type CellAlign = (typeof CELL_ALIGNS)[number];
/** Most columns a table may have; a wider header row in Markdown is not a table. */
export const TABLE_COLUMNS_MAX = 64;
/** Most cells a table may have (a stored document holds fewer anyway, DOC_JSON_MAX); Markdown rows past it end the table. */
export const TABLE_CELLS_MAX = 10_000;

/** Deepest block nesting a document may have (lists in quotes in sections…). Deeper input is flattened to text. */
export const MAX_DEPTH = 24;
/** The same cap counted in nodes (a list level is three: list, item, paragraph), for documents as JSON. */
export const MAX_NODE_DEPTH = MAX_DEPTH * 3 + 4;
/** Largest stored description, characters of JSON (≈ 100 KB of text). */
export const DOC_JSON_MAX = 400_000;
/** Largest description an agent may send, characters of Markdown. */
export const DOC_MARKDOWN_MAX = 200_000;

export const emptyDoc = (): DocNode => ({ type: "doc", content: [{ type: "paragraph" }] });

/**
 * A file of the workspace as a link: its path, its name for the download, and its size for the card a comment draws
 * (render.ts). In Markdown a plain link, so an agent reads it and an older client keeps the text.
 */
const FILE_LINK = /^(\/files\/[a-z0-9-]{3,32}\/[0-9a-f]{64})\?name=([^&#\s()]{1,2048})&size=(\d{1,15})$/;

export function fileLink(path: string, name: string, size: number): string {
  const safe = encodeURIComponent(name).replace(/[()'!*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${path}?name=${safe}&size=${size}`;
}

/** A link's file, when it is one of fileLink's. */
export function readFileLink(href: string): { name: string; size: number } | null {
  const m = FILE_LINK.exec(href);
  if (!m || !readFilePath(m[1]!)) return null;
  try {
    return { name: decodeURIComponent(m[2]!), size: Number(m[3]) };
  } catch {
    return null;
  }
}

/** http(s) and mailto URLs and a file of the workspace; anything else (javascript:, data:, relative paths) is null. DOM-free. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const s = href.trim();
  if (s.startsWith("/files/")) return readFileLink(s) ? s : null;
  if (!/^(https?:\/\/|mailto:)/i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

export { docText } from "./text.ts";

/** No text and no structure worth keeping: a lone empty paragraph (or nothing). */
export function isEmptyDoc(doc: DocNode | null | undefined): boolean {
  if (!doc?.content?.length) return true;
  return doc.content.length === 1 && doc.content[0]!.type === "paragraph" && !doc.content[0]!.content?.length;
}

/** Equal as stored: key order does not matter, attribute values do. */
export function sameDoc(a: DocNode | null | undefined, b: DocNode | null | undefined): boolean {
  return canonical(a ?? emptyDoc()) === canonical(b ?? emptyDoc());
}

function canonical(n: unknown): string {
  if (Array.isArray(n)) return `[${n.map(canonical).join(",")}]`;
  if (n && typeof n === "object") {
    return `{${Object.keys(n)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((n as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(n);
}

// ── Builders shared by the converters ───────────────────────────────────────────────────────────────────────────

const ATTR_DEFAULTS: Partial<Record<NodeName, Record<string, string | number | boolean>>> = {
  heading: { level: 1 },
  code_block: { language: "" },
  ordered_list: { order: 1 },
  task_item: { checked: false },
  image: { src: "", alt: "" },
  table_cell: { align: "" },
};

/** A node in toJSON's shape: attributes complete, empty content left out. */
export function node(type: NodeName, attrs?: Record<string, string | number | boolean> | null, content?: DocNode[]): DocNode {
  const n: DocNode = { type };
  const def = ATTR_DEFAULTS[type];
  if (def) n.attrs = { ...def, ...attrs };
  if (content?.length) n.content = content;
  return n;
}

const RANK = new Map<string, number>(MARKS.map((m, i) => [m, i]));

/** Marks in schema order, copied: the order toJSON writes them in. */
function sortMarks(marks: readonly DocMark[]): DocMark[] {
  return [...marks].sort((a, b) => RANK.get(a.type)! - RANK.get(b.type)!).map((m) => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type }));
}

/** Marks a mention keeps: emphasis. A link or code over it (a selection formatted whole) does not apply to a person. */
export const mentionMarks = (marks: readonly DocMark[]): DocMark[] => marks.filter((m) => m.type !== "link" && m.type !== "code");

/** A mention node as toJSON writes it. */
export function mentionNode(id: string, label: string, marks: readonly DocMark[] = []): DocNode {
  const n: DocNode = { type: "mention", attrs: { id, label: mentionLabelOf(label) } };
  const kept = mentionMarks(marks);
  if (kept.length) n.marks = sortMarks(kept);
  return n;
}

/** Text nodes with marks in schema order; adjacent runs with equal marks merge, empty runs go (as Fragment.fromArray). */
export function pushText(out: DocNode[], text: string, marks: readonly DocMark[]): void {
  if (!text) return;
  const sorted = sortMarks(marks);
  const last = out.at(-1);
  if (last?.type === "text" && sameMarks(last.marks ?? [], sorted)) {
    last.text += text;
    return;
  }
  const t: DocNode = { type: "text", text };
  if (sorted.length) t.marks = sorted;
  out.push(t);
}

/** The same mark: its type and, for a link, its target. */
export const sameMark = (a: DocMark, b: DocMark): boolean => a.type === b.type && a.attrs?.href === b.attrs?.href;

const sameMarks = (a: readonly DocMark[], b: readonly DocMark[]): boolean => a.length === b.length && a.every((m, i) => sameMark(m, b[i]!));

/**
 * The marks of HTML's inline tags, for the HTML parser (html.ts) and the tags Markdown allows inline (markdown.ts; not
 * <code>, which has backticks). A Map, not an object: a tag named like a property of Object.prototype is no mark.
 */
export const MARK_TAGS = new Map<string, MarkName>([
  ["strong", "bold"],
  ["b", "bold"],
  ["em", "italic"],
  ["i", "italic"],
  ["s", "strike"],
  ["del", "strike"],
  ["strike", "strike"],
  ["u", "underline"],
  ["code", "code"],
]);

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
]);

/**
 * An entity's character from what is between `&` and `;` (`amp`, `#39`, `#x27`), or null for one we do not know or a
 * number that is no character. For the HTML parser and Markdown's mention labels; the names are the few that
 * machine-written HTML and Markdown use.
 */
export function decodeEntity(e: string): string | null {
  if (e[0] === "#") {
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : null;
  }
  return NAMED_ENTITIES.get(e.toLowerCase()) ?? null;
}

/**
 * Blocks fitted to the schema's content rules: a list item and a task item start with a paragraph, containers are
 * never empty: anything else in an item's first place gets an empty paragraph before it (as the editor makes it).
 */
export function fitItem(blocks: DocNode[]): DocNode[] {
  return blocks[0]?.type === "paragraph" ? blocks : [{ type: "paragraph" }, ...blocks];
}

/**
 * A collapsible section, as old documents, Markdown `<details>` and Plane's HTML have one (the editor had it until
 * PLNR-378): its title as a bold paragraph, then its content. Nothing is lost, and nothing folds any more.
 */
export function sectionBlocks(title: DocNode[], body: DocNode[]): DocNode[] {
  const bold = title.map((n): DocNode => {
    if ((n.type !== "text" && n.type !== "mention") || n.marks?.some((m) => m.type === "code" || m.type === "bold")) return n;
    return { ...n, marks: sortMarks([...(n.marks ?? []), { type: "bold" }]) };
  });
  return [node("paragraph", null, bold), ...body];
}

/** A stored document with its collapsible sections opened out (sectionBlocks); the same object when it has none. */
export function withoutSections(doc: DocNode): DocNode {
  const walk = (n: DocNode, depth: number): DocNode => {
    if (!n.content || depth > MAX_NODE_DEPTH) return n;
    let changed = false;
    const content: DocNode[] = [];
    for (const c of n.content) {
      if ((c.type as string) === "details") {
        const [title, ...body] = c.content ?? [];
        content.push(...sectionBlocks(title?.content ?? [], body.map((b) => walk(b, depth + 2))));
        changed = true;
      } else {
        const w = walk(c, depth + 1);
        changed ||= w !== c;
        content.push(w);
      }
    }
    return changed ? { ...n, content } : n;
  };
  return walk(doc, 0);
}

export const orEmpty = (blocks: DocNode[]): DocNode[] => (blocks.length ? blocks : [{ type: "paragraph" }]);
