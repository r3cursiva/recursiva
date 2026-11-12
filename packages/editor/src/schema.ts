// Our ProseMirror schema: exactly the owner's feature set (ADR 0006), nothing else. No raw HTML node, no attributes beyond
// the few below: whatever is pasted or imported is fitted to this. Images are files of the workspace only (PLNR-50).
//
// parseDOM rules serve the browser (paste, and the view reading DOM changes); the server never parses HTML through
// them (html.ts is DOM-free). toDOM is the editor's rendering; render.ts draws the same tags without ProseMirror.
import { DOMParser, Fragment, Schema, type DOMOutputSpec, type MarkSpec, type Node, type NodeSpec, type TagParseRule } from "prosemirror-model";
import { readFilePath } from "@rsva/schema/models";
import { CELL_ALIGNS, imageAltOf, MENTION_ID, mentionLabelOf, safeHref } from "./doc.ts";

/** The DOM element parse rules see, typed without the DOM library: the server type-checks this file too. */
interface El {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): (El & { className: string }) | null;
  textContent: string | null;
  style: { fontWeight: string; textAlign: string };
}

const block = (tag: string): DOMOutputSpec => [tag, 0];

/** Attribute validators throw (ProseMirror calls them on fromJSON and check()). */
const must = (ok: (v: unknown) => boolean, what: string) => (v: unknown) => {
  if (!ok(v)) throw new RangeError(`invalid ${what}: ${JSON.stringify(v)?.slice(0, 80)}`);
};

/** Pasted bold that is not bold: Google Docs wraps everything in <b style="font-weight:normal">. */
const notNormal = (el: El) => el.style.fontWeight !== "normal" && el.style.fontWeight !== "400" && null;

/** A pasted cell's alignment: ours (`data-align`), a style, or the old attribute; anything else is none. */
function alignOf(el: El): string {
  const a = (el.getAttribute("data-align") || el.style.textAlign || el.getAttribute("align") || "").toLowerCase();
  return (CELL_ALIGNS as readonly string[]).includes(a) ? a : "";
}
/**
 * A pasted cell's content on one line: whatever blocks it holds (Google Docs and Plane put paragraphs there, Plane lists
 * too) are parsed as a document and their text and mentions kept, a space between blocks and for a break, as Markdown's
 * cell would have it. Parsed apart because the parser would close the cell at its second block.
 */
function cellContent(dom: unknown, s: Schema): Fragment {
  const out: Node[] = [];
  DOMParser.fromSchema(s)
    .parse(dom as Parameters<DOMParser["parse"]>[0])
    .descendants((n) => {
      if (!n.isTextblock) return true;
      if (out.length && n.content.size) out.push(s.text(" "));
      n.forEach((c) => {
        if (c.isText || c.type.name === "mention") out.push(c);
        else if (c.type.name === "hard_break") out.push(s.text(" "));
      });
      return false;
    });
  return Fragment.fromArray(out);
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: { content: "inline*", group: "block", parseDOM: [{ tag: "p" }], toDOM: () => block("p") },
  heading: {
    attrs: { level: { default: 1, validate: must((v) => v === 1 || v === 2 || v === 3, "heading level") } },
    content: "inline*",
    group: "block",
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((l) => ({ tag: `h${l}`, attrs: { level: Math.min(l, 3) } })),
    toDOM: (n) => [`h${n.attrs.level}`, 0],
  },
  blockquote: { content: "block+", group: "block", defining: true, parseDOM: [{ tag: "blockquote" }], toDOM: () => block("blockquote") },
  code_block: {
    attrs: { language: { default: "", validate: must((v) => typeof v === "string" && /^[\w+#.-]{0,32}$/.test(v), "code language") } },
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (d) => ({ language: /language-([\w+#.-]{1,32})/.exec((d as unknown as El).querySelector("code")?.className ?? "")?.[1] ?? "" }),
      },
    ],
    toDOM: (n) => ["pre", ["code", n.attrs.language ? { class: `language-${n.attrs.language}` } : {}, 0]],
  },
  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }, { tag: 'div[data-type="horizontalRule"]' }],
    toDOM: () => ["hr"],
  },
  bullet_list: { content: "list_item+", group: "block", parseDOM: [{ tag: "ul" }], toDOM: () => block("ul") },
  ordered_list: {
    attrs: { order: { default: 1, validate: must((v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e9, "list start") } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ol", getAttrs: (d) => ({ order: Math.max(0, Math.min(1e9 - 1, parseInt((d as unknown as El).getAttribute("start") ?? "1", 10) || 1)) }) }],
    toDOM: (n) => ["ol", n.attrs.order === 1 ? {} : { start: n.attrs.order }, 0],
  },
  list_item: { content: "paragraph block*", defining: true, parseDOM: [{ tag: "li" }], toDOM: () => block("li") },
  task_list: {
    content: "task_item+",
    group: "block",
    parseDOM: [{ tag: 'ul[data-type="taskList"]', priority: 60 }],
    toDOM: () => ["ul", { "data-type": "taskList" }, 0],
  },
  task_item: {
    attrs: { checked: { default: false, validate: "boolean" } },
    content: "paragraph block*",
    defining: true,
    parseDOM: [
      {
        tag: "li[data-checked]",
        priority: 60,
        // Plane and our own view put the text in a <div> after the checkbox.
        contentElement: ((d: El) => d.querySelector(":scope > div") ?? d) as unknown as NonNullable<TagParseRule["contentElement"]>,
        getAttrs: (d) => ({ checked: (d as unknown as El).getAttribute("data-checked") === "true" }),
      },
    ],
    toDOM: (n) => ["li", { "data-checked": String(n.attrs.checked) }, 0],
  },
  image: {
    attrs: {
      src: { validate: must((v) => typeof v === "string" && readFilePath(v) !== null, "image source") },
      alt: { default: "", validate: must((v) => typeof v === "string" && imageAltOf(v) === v, "image alt") },
    },
    group: "block",
    atom: true,
    draggable: true,
    // Our own images only (copied within the app): the attribute is the path as written. Anything else is dropped.
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (d) => {
          const el = d as unknown as El;
          const src = el.getAttribute("src") ?? "";
          return readFilePath(src) ? { src, alt: imageAltOf(el.getAttribute("alt") ?? "") } : false;
        },
      },
    ],
    toDOM: (n) => ["img", { src: n.attrs.src, alt: n.attrs.alt, loading: "lazy", decoding: "async" }],
  },
  // A table (doc.ts): the first row is the header by its place, so every table has one, as Markdown's do. Cells are
  // textblocks of text and mentions only; a block pasted into a cell keeps its text (cellContent). The wrapper scrolls a
  // wide table inside the text, not the page.
  table: {
    content: "table_row+",
    group: "block",
    isolating: true,
    tableRole: "table",
    parseDOM: [{ tag: "table" }],
    toDOM: () => ["div", { class: "table-wrap" }, ["table", ["tbody", 0]]],
  },
  table_row: { content: "table_cell+", tableRole: "row", parseDOM: [{ tag: "tr" }], toDOM: () => block("tr") },
  table_cell: {
    attrs: { align: { default: "", validate: must((v) => (CELL_ALIGNS as readonly unknown[]).includes(v), "cell alignment") } },
    content: "(text | mention)*",
    isolating: true,
    tableRole: "cell",
    parseDOM: ["td", "th"].map((tag) => ({ tag, getAttrs: (d: unknown) => ({ align: alignOf(d as El) }), getContent: cellContent })),
    toDOM: (n) => ["td", n.attrs.align ? { "data-align": n.attrs.align } : {}, 0],
  },
  text: { group: "inline" },
  hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
  // A person, by user id; the label is the name when it was written (render.ts shows the current one where it can).
  mention: {
    attrs: {
      id: { validate: must((v) => typeof v === "string" && MENTION_ID.test(v), "mention") },
      label: { validate: must((v) => typeof v === "string" && mentionLabelOf(v) === v, "mention label") },
    },
    inline: true,
    group: "inline",
    atom: true,
    leafText: (n) => `@${n.attrs.label}`,
    parseDOM: [
      {
        tag: "span[data-mention]",
        getAttrs: (d) => {
          const el = d as unknown as El;
          const id = (el.getAttribute("data-mention") ?? "").toLowerCase();
          return MENTION_ID.test(id) ? { id, label: mentionLabelOf((el.textContent ?? "").replace(/^@/, "")) } : false;
        },
      },
    ],
    toDOM: (n) => ["span", { class: "mention", "data-mention": n.attrs.id }, `@${n.attrs.label}`],
  },
};

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: { validate: must((v) => typeof v === "string" && v.length <= 4096 && safeHref(v) === v, "link") } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        // An unsafe or relative link keeps its text and loses the link; so does a copied issue key (issue-ref.ts), which
        // is a link again wherever it is shown.
        getAttrs: (d) => {
          if (/(?:^|\s)issue-ref(?:\s|$)/.test((d as unknown as El).getAttribute("class") ?? "")) return false;
          const href = safeHref((d as unknown as El).getAttribute("href"));
          return href ? { href } : false;
        },
      },
    ],
    toDOM: (m) => ["a", { href: m.attrs.href, target: "_blank", rel: "noopener noreferrer nofollow" }, 0],
  },
  bold: {
    parseDOM: [
      { tag: "strong" },
      { tag: "b", getAttrs: (d) => notNormal(d as unknown as El) } as TagParseRule,
      { style: "font-weight=400", clearMark: (m) => m.type.name === "bold" },
      { style: "font-weight", getAttrs: (v) => /^(bold(er)?|[6-9]\d\d)$/.test(v as string) && null },
    ],
    toDOM: () => ["strong", 0],
  },
  italic: { parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }], toDOM: () => ["em", 0] },
  strike: {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration", getAttrs: (v) => (v as string).includes("line-through") && null }],
    toDOM: () => ["s", 0],
  },
  // Only <u>: pasted links carry text-decoration:underline as styling, which is not an underline mark.
  underline: { parseDOM: [{ tag: "u" }], toDOM: () => ["u", 0] },
  // Inline code takes no other formatting (a link around it is fine), as in Linear.
  code: { excludes: "bold italic strike underline code", parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
};

export const schema = new Schema({ nodes, marks });
