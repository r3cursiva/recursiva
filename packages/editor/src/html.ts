// HTML → document without a DOM, for machine-written HTML: Plane's descriptions and comments (Tiptap output), legacy
// description rows. Runs on the server and in connectors. Pasted HTML in the browser goes through ProseMirror's own
// parser and the schema's parseDOM rules instead (it is messier, and the browser has a DOM).
//
// A small tokenizer is enough for well-formed HTML. Tags we know map to the schema; unknown tags keep their text;
// script, style and similar go with their content. Plane's quirks: the rule is <div data-type="horizontalRule">, task
// items are <li data-type="taskItem" data-checked> with the checkbox in a <label>, mentions are <mention-component>: one
// with a `user` the caller's resolver knows becomes a mention node, any other the text "@label" (connectors/plane).
// An image of the workspace becomes an image block; any other image a link to it (the schema shows only the workspace's
// files, doc.ts). A table becomes a table (doc.ts): its rows in order, the first one the header; a cell keeps its text
// and marks on one line (paragraphs joined by a space, lists and breaks too), a merged cell spreads into empty ones.
import { readFilePath } from "@rsva/schema/models";
import { decodeEntity, fitItem, imageAltOf, MARK_TAGS, MAX_DEPTH, mentionLabelOf, mentionNode, node, orEmpty, pushText, safeHref, sectionBlocks, TABLE_CELLS_MAX, TABLE_COLUMNS_MAX, type DocMark, type DocNode } from "./doc.ts";
import type { MentionResolver } from "./markdown.ts";

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: (El | string)[];
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "col", "source", "wbr", "area", "base", "embed", "param", "track"]);
const DROP = new Set(["script", "style", "template", "iframe", "object", "embed", "svg", "math", "noscript", "textarea", "select", "button", "head", "title", "label"]);
const decodeEntities = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => decodeEntity(e) ?? m);

const SPACE = /[\t\n\f\r ]/;
const LETTER = /[a-zA-Z]/;

/**
 * A tag from `<` at `at`: its name, attributes and where it ends, or null when the input ends inside it.
 *
 * A hand-written scanner, not a regular expression: every character is looked at once, so any input parses in linear
 * time. The regular expression it replaced backtracked exponentially on an unclosed tag with many quoted attributes
 * (PLNR-32), and even with disjoint alternatives it stayed quadratic on many unclosed tags or comments, because each
 * failed match was retried from the next `<`. The rules follow the HTML tokenizer: a name runs to a space, `/` or `>`;
 * a value is double-quoted, single-quoted or runs to a space or `>`; a tag the input ends inside is dropped with the rest.
 */
function scanTag(html: string, at: number): { close: boolean; tag: string; attrs: Record<string, string>; selfClose: boolean; end: number } | null {
  const close = html[at + 1] === "/";
  let i = at + (close ? 2 : 1);
  const nameStart = i;
  while (i < html.length && !SPACE.test(html[i]!) && html[i] !== "/" && html[i] !== ">") i++;
  const tag = html.slice(nameStart, i).toLowerCase();
  const attrs: Record<string, string> = {};
  for (;;) {
    while (i < html.length && (SPACE.test(html[i]!) || (html[i] === "/" && html[i + 1] !== ">"))) i++;
    if (i >= html.length) return null;
    if (html[i] === ">") return { close, tag, attrs, selfClose: false, end: i + 1 };
    if (html[i] === "/") return { close, tag, attrs, selfClose: true, end: i + 2 };
    const start = i++; // the first character may be "=", as in the HTML tokenizer
    while (i < html.length && !SPACE.test(html[i]!) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    const name = html.slice(start, i).toLowerCase();
    let j = i;
    while (j < html.length && SPACE.test(html[j]!)) j++;
    let value = "";
    if (html[j] === "=") {
      i = j + 1;
      while (i < html.length && SPACE.test(html[i]!)) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const endQuote = html.indexOf(q, i + 1);
        if (endQuote < 0) return null;
        value = html.slice(i + 1, endQuote);
        i = endQuote + 1;
      } else {
        const vs = i;
        while (i < html.length && !SPACE.test(html[i]!) && html[i] !== ">") i++;
        value = html.slice(vs, i);
      }
    }
    attrs[name] = decodeEntities(value);
  }
}

function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  let text = "";
  const flush = () => {
    if (text) stack.at(-1)!.children.push(decodeEntities(text));
    text = "";
  };
  for (let i = 0; i < html.length; ) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    const next = html[lt + 1] ?? "";
    // Comments, doctypes and processing instructions carry no content; one the input ends inside takes the rest.
    if (next === "!" || next === "?") {
      const comment = html.startsWith("<!--", lt);
      const end = comment ? html.indexOf("-->", lt + 4) : html.indexOf(">", lt + 2);
      if (end < 0) break;
      i = end + (comment ? 3 : 1);
      continue;
    }
    // A "<" that starts no tag is text.
    if (!LETTER.test(next) && !(next === "/" && LETTER.test(html[lt + 2] ?? ""))) {
      text += "<";
      i = lt + 1;
      continue;
    }
    const t = scanTag(html, lt);
    if (!t) break;
    i = t.end;
    flush();
    if (t.close) {
      const at = stack.findLastIndex((n) => n.tag === t.tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el: El = { tag: t.tag, attrs: t.attrs, children: [] };
    stack.at(-1)!.children.push(el);
    // Unclosed elements nest at most MAX_DEPTH × 4 deep: deeper ones flatten into their parent.
    if (!VOID.has(t.tag) && !t.selfClose && stack.length < MAX_DEPTH * 4) stack.push(el);
  }
  flush();
  return root;
}

const BLOCK_TAGS = new Set([
  "p", "div", "ul", "ol", "li", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr",
  "section", "article", "header", "footer", "details", "summary", "figure",
]);

const textOf = (n: El | string): string => (typeof n === "string" ? n : n.tag === "br" ? "\n" : n.children.map(textOf).join(""));
const isBlock = (n: El | string) => typeof n !== "string" && (BLOCK_TAGS.has(n.tag) || n.children.some(isBlock));

/** Table cells the fromHtml call in progress may still make, across all its tables (as in markdown.ts). */
let cellBudget = TABLE_CELLS_MAX;

/** The resolver of the fromHtml call in progress (parsing is synchronous); null leaves every mention as text. */
let resolveMention: MentionResolver | null = null;

/** `mention` turns a `<mention-component user=…>` into a mention node; without it, or when it refuses, the label is text. */
export function fromHtml(html: string, opts: { mention?: MentionResolver } = {}): DocNode {
  cellBudget = TABLE_CELLS_MAX;
  const outer = resolveMention;
  resolveMention = opts.mention ?? null;
  try {
    return node("doc", null, orEmpty(blocks(parse(html).children, 0)));
  } finally {
    resolveMention = outer;
  }
}

/** An `<img>` showing a file of the workspace as the image block it is, else null. */
function fileImage(n: El | string): DocNode | null {
  if (typeof n === "string" || n.tag !== "img" || !readFilePath(n.attrs.src ?? "")) return null;
  return node("image", { src: n.attrs.src!, alt: imageAltOf(n.attrs.alt ?? "") });
}

/** Children in a block context: runs of inline content become paragraphs. */
function blocks(children: (El | string)[], depth: number): DocNode[] {
  const out: DocNode[] = [];
  let run: (El | string)[] = [];
  const flush = () => {
    const content = inlines(run);
    if (content.length) out.push(node("paragraph", null, content));
    run = [];
  };
  for (const c of children) {
    if (typeof c !== "string" && DROP.has(c.tag)) continue;
    const image = fileImage(c);
    if (!image && !isBlock(c)) {
      run.push(c);
      continue;
    }
    flush();
    out.push(...(image ? [image] : block(c as El, depth)));
  }
  flush();
  return out;
}

function block(el: El, depth: number): DocNode[] {
  if (depth >= MAX_DEPTH) {
    const text = textOf(el).replace(/\s+/g, " ").trim();
    return text ? [node("paragraph", null, [{ type: "text", text }])] : [];
  }
  const d = depth + 1;
  switch (el.tag) {
    case "p":
      return blocks(el.children, depth);
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return [node("heading", { level: Math.min(Number(el.tag[1]), 3) }, inlines(el.children))];
    case "hr":
      return [{ type: "horizontal_rule" }];
    case "pre": {
      const code = el.children.find((c): c is El => typeof c !== "string" && c.tag === "code");
      const language = /language-([\w+#.-]{1,32})/.exec(code?.attrs.class ?? "")?.[1] ?? "";
      const text = textOf(el).replace(/\n$/, "");
      return [node("code_block", { language }, text ? [{ type: "text", text }] : [])];
    }
    case "blockquote":
      return [node("blockquote", null, orEmpty(blocks(el.children, d)))];
    case "ul":
    case "ol":
      return list(el, d);
    case "details": {
      const summary = el.children.find((c): c is El => typeof c !== "string" && c.tag === "summary");
      const body = el.children.filter((c) => c !== summary);
      return sectionBlocks(summary ? inlines(summary.children) : [], blocks(body, d));
    }
    case "table":
      return table(el, d);
    case "thead":
    case "tbody":
    case "tr":
      return blocks(el.children, depth);
    case "div":
      if (el.attrs["data-type"] === "horizontalRule") return [{ type: "horizontal_rule" }];
      return blocks(el.children, depth);
    default:
      return blocks(el.children, depth);
  }
}

function list(el: El, depth: number): DocNode[] {
  const ordered = el.tag === "ol";
  const items = el.children.filter((c): c is El => typeof c !== "string" && c.tag === "li");
  const out: DocNode[] = [];
  // Task items and plain items in one list become separate lists: the schema keeps them apart.
  for (let k = 0; k < items.length; ) {
    const isTask = isTaskItem(items[k]!);
    const run: DocNode[] = [];
    for (; k < items.length && isTaskItem(items[k]!) === isTask; k++) {
      const li = items[k]!;
      const content = fitItem(blocks(li.children, depth));
      run.push(isTask ? node("task_item", { checked: li.attrs["data-checked"] === "true" }, content) : node("list_item", null, content));
    }
    if (isTask) out.push(node("task_list", null, run));
    else if (ordered) out.push(node("ordered_list", { order: Math.max(0, Math.min(1e9 - 1, parseInt(el.attrs.start ?? "1", 10) || 1)) }, run));
    else out.push(node("bullet_list", null, run));
  }
  return out;
}

/** A table's rows (in thead, tbody or straight in it) as a table node; a table with no cells is nothing. */
function table(el: El, depth: number): DocNode[] {
  const rows: El[] = [];
  const collect = (c: El | string) => {
    if (typeof c === "string") return;
    if (c.tag === "tr") rows.push(c);
    else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") c.children.forEach(collect);
  };
  el.children.forEach(collect);
  // A row stops at TABLE_COLUMNS_MAX cells, a merged cell's span counted as it spreads; rows stop where the document's
  // cell budget would not hold them at the widest row's width (Markdown fills short rows).
  const grid: DocNode[][] = [];
  let width = 0;
  for (const r of rows) {
    const out: DocNode[] = [];
    for (const c of r.children) {
      if (typeof c === "string" || (c.tag !== "td" && c.tag !== "th") || out.length >= TABLE_COLUMNS_MAX) continue;
      const span = Math.min(TABLE_COLUMNS_MAX - out.length, Math.max(1, parseInt(c.attrs.colspan ?? "1", 10) || 1));
      out.push(cell(c, depth));
      for (let k = 1; k < span; k++) out.push(node("table_cell", { align: "" }));
    }
    if (!out.length) continue;
    const wider = Math.max(width, out.length);
    if (wider * (grid.length + 1) > cellBudget) break;
    width = wider;
    grid.push(out);
  }
  if (!grid.length) return [];
  cellBudget -= width * grid.length;
  return [node("table", null, grid.map((r) => node("table_row", null, [...r, ...Array.from({ length: width - r.length }, () => node("table_cell", { align: "" }))])))];
}

/** A cell's content on one line: its blocks' inline content, a space between them; breaks and images become spaces. */
function cell(c: El, depth: number): DocNode {
  const out: DocNode[] = [];
  const add = (n: DocNode) => {
    if (n.type === "text") pushText(out, n.text ?? "", n.marks ?? []);
    else if (n.type === "mention") out.push(n);
    else if (n.type === "hard_break") pushText(out, " ", []);
    else if (n.content) {
      if (out.length && !n.type.endsWith("_list") && n.type !== "list_item" && n.type !== "task_item") pushText(out, " ", []);
      n.content.forEach(add);
    }
  };
  blocks(c.children, depth).forEach(add);
  const align = (c.attrs["data-align"] ?? /text-align:\s*(left|center|right)/i.exec(c.attrs.style ?? "")?.[1] ?? c.attrs.align ?? "").toLowerCase();
  return node("table_cell", { align: ["left", "center", "right"].includes(align) ? align : "" }, trimRuns(out));
}

/** Spaces at the ends of a cell and doubled between runs go, as Markdown would drop them. */
function trimRuns(runs: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const n of runs) {
    if (n.type !== "text") {
      out.push(n);
      continue;
    }
    const prev = out.at(-1);
    const text = (!prev || (prev.type === "text" && /\s$/.test(prev.text!)) ? n.text!.trimStart() : n.text!).replace(/\s+/g, " ");
    if (text) pushText(out, text, n.marks ?? []);
  }
  const last = out.at(-1);
  if (last?.type === "text") {
    last.text = last.text!.trimEnd();
    if (!last.text) out.pop();
  }
  return out;
}

const isTaskItem = (li: El) => li.attrs["data-type"] === "taskItem" || "data-checked" in li.attrs;

/** Inline content: whitespace collapses as HTML renders it; marks nest as the tags do. */
function inlines(children: (El | string)[]): DocNode[] {
  const out: DocNode[] = [];
  walk(children, [], out);
  // Collapse whitespace across runs and trim the block's edges.
  let prevSpace = true;
  for (const n of out) {
    if (n.type !== "text") {
      prevSpace = n.type !== "mention";
      continue;
    }
    let t = n.text!.replace(/[ \t\n\r\f]+/g, " ");
    if (prevSpace) t = t.replace(/^ /, "");
    prevSpace = t.endsWith(" ") || (prevSpace && !t);
    n.text = t;
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const n = out[i]!;
    if (n.type !== "text") break;
    n.text = n.text!.replace(/ $/, "");
    if (n.text) break;
  }
  const merged: DocNode[] = [];
  for (const n of out) {
    if (n.type === "text") pushText(merged, n.text!, n.marks ?? []);
    else merged.push(n);
  }
  return merged;
}

function walk(children: (El | string)[], marks: DocMark[], out: DocNode[]): void {
  for (const c of children) {
    if (typeof c === "string") {
      if (c) out.push(marks.length ? { type: "text", text: c, marks } : { type: "text", text: c });
      continue;
    }
    if (DROP.has(c.tag)) continue;
    const mark = MARK_TAGS.get(c.tag);
    if (c.tag === "br") out.push({ type: "hard_break" });
    else if (c.tag === "code") {
      const text = textOf(c);
      if (text) out.push({ type: "text", text, marks: [...marks.filter((m) => m.type === "link"), { type: "code" }] });
    } else if (mark) walk(c.children, marks.some((m) => m.type === mark) ? marks : [...marks, { type: mark }], out);
    else if (c.tag === "a") {
      const href = safeHref(c.attrs.href);
      walk(c.children, href ? [...marks.filter((m) => m.type !== "link"), { type: "link", attrs: { href } }] : marks, out);
    } else if (c.tag === "img") {
      const href = safeHref(c.attrs.src);
      const alt = c.attrs.alt?.trim() || "image";
      if (href) out.push({ type: "text", text: alt, marks: [...marks.filter((m) => m.type !== "link"), { type: "link", attrs: { href } }] });
    } else if (c.tag === "mention-component") {
      // A mention carries the person (`user`, resolved by the caller) and a label: what a reader saw.
      const label = mentionLabelOf(c.attrs.label || textOf(c).replace(/^@/, "")) || "user";
      const person = c.attrs.user && resolveMention ? resolveMention(c.attrs.user) : null;
      if (person) out.push(mentionNode(person.id, label, marks));
      else out.push({ type: "text", text: "@" + label, ...(marks.length ? { marks } : {}) });
    } else if (c.tag === "input") continue;
    else walk(c.children, marks, out);
  }
}
