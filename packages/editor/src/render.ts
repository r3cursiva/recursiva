// Document → DOM nodes for reading: comments, and a description until the editor has loaded. No ProseMirror, no HTML
// parsing: elements are created one by one and text goes in as text nodes, so there is nothing to sanitize. The tags
// match the editor's (schema.ts toDOM and node views), so swapping the editor in does not move the text.
import { readFilePath } from "@rsva/schema/models";
import { CELL_ALIGNS, MAX_NODE_DEPTH, readFileLink, safeHref, withoutSections, type CellAlign, type DocNode } from "./doc.ts";
import { issueRefs, type IssueHref } from "./issue-ref.ts";
import { plural } from "@rsva/schema/util";

const TAG: Partial<Record<DocNode["type"], string>> = {
  paragraph: "p",
  blockquote: "blockquote",
  bullet_list: "ul",
  ordered_list: "ol",
  list_item: "li",
  task_list: "ul",
  task_item: "li",
  horizontal_rule: "hr",
  hard_break: "br",
  table_row: "tr",
};
const MARK_TAG = { bold: "strong", italic: "em", strike: "s", underline: "u", code: "code" } as const;

export interface RenderOptions {
  /** A mentioned person's current name; the stored label shows when there is none (not a member any more). */
  mentionName?: (id: string) => string | undefined;
  /** Issue keys in text become links to the issues the workspace has (issue-ref.ts); not in code or inside a link. */
  issueHref?: IssueHref;
  /** A code block longer than CODE_LINES shows that many and a button for the rest (a comment's logs). */
  foldCode?: boolean;
  /** A paragraph that is one link to a file of the workspace is drawn as a card, with its size written by this. */
  fileSize?: (bytes: number) => string;
}

/** Lines of a folded code block; `max-height` in content.css says the same. */
const CODE_LINES = 7;

/** A paragraph of one bold run, the first of a longer quote: who is quoted. */
const isQuoteAuthor = (n: DocNode | undefined): boolean => n?.type === "paragraph" && n.content?.length === 1 && !!n.content[0]!.marks?.some((m) => m.type === "bold");

/** The file a paragraph is, when it holds nothing but a link to one. */
function fileOf(n: DocNode): { href: string; name: string; size: number } | null {
  const only = n.content?.length === 1 ? n.content[0] : undefined;
  const link = only?.type === "text" ? only.marks?.find((m) => m.type === "link") : undefined;
  const href = link ? String(link.attrs?.href ?? "") : "";
  const file = readFileLink(href);
  return file && { href, ...file };
}

function fileCard(file: { href: string; name: string; size: number }, written: string, d: Document): HTMLElement {
  const a = d.createElement("a");
  a.className = "file-card";
  a.href = file.href;
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  a.append(d.createElement("span"), d.createElement("span"));
  a.firstElementChild!.textContent = file.name;
  a.lastElementChild!.textContent = written;
  return a;
}

/** The block cut to its first lines, and the button that shows the rest. No framework here: one listener per long block. */
function foldedCode(pre: HTMLElement, lines: number, d: Document): HTMLElement {
  const box = d.createElement("div");
  box.className = "code-fold";
  box.dataset.cut = "";
  const more = d.createElement("button");
  const rest = lines - CODE_LINES;
  const label = `Show ${plural(rest, "more line")}`;
  more.type = "button";
  more.textContent = label;
  more.addEventListener("click", () => {
    const cut = box.toggleAttribute("data-cut");
    more.textContent = cut ? label : "Show less";
  });
  box.append(pre, more);
  return box;
}

export function renderDoc(doc: DocNode, opts: RenderOptions = {}, document: Document = globalThis.document): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const c of withoutSections(doc).content ?? []) renderNode(c, frag, document, 0, opts);
  return frag;
}

function renderNode(n: DocNode, parent: Node, d: Document, depth: number, opts: RenderOptions): void {
  if (n.type === "mention") {
    const id = String(n.attrs?.id ?? "");
    let target: Node = parent;
    for (const m of n.marks ?? []) if (m.type in MARK_TAG) target = target.appendChild(d.createElement(MARK_TAG[m.type as keyof typeof MARK_TAG]));
    const el = d.createElement("span");
    el.className = "mention";
    el.dataset.mention = id;
    el.textContent = `@${opts.mentionName?.(id) ?? String(n.attrs?.label ?? "")}`;
    target.appendChild(el);
    return;
  }
  if (n.type === "text") {
    let target: Node = parent;
    const text = n.text ?? "";
    const plain = !n.marks?.some((m) => m.type === "link" || m.type === "code");
    for (const m of n.marks ?? []) {
      if (m.type === "link") {
        const href = safeHref(m.attrs?.href);
        if (!href) continue;
        const a = d.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        target = target.appendChild(a);
      } else if (m.type in MARK_TAG) target = target.appendChild(d.createElement(MARK_TAG[m.type]));
    }
    if (plain && opts.issueHref) appendWithRefs(target, text, opts.issueHref, d);
    else target.appendChild(d.createTextNode(text));
    return;
  }
  if (depth >= MAX_NODE_DEPTH) {
    parent.appendChild(d.createTextNode(textOf(n)));
    return;
  }
  const file = n.type === "paragraph" && opts.fileSize ? fileOf(n) : null;
  if (file) {
    parent.appendChild(fileCard(file, opts.fileSize!(file.size), d));
    return;
  }
  let el: HTMLElement;
  let inner: HTMLElement;
  switch (n.type) {
    case "heading":
      el = inner = d.createElement(`h${Math.min(3, Math.max(1, Number(n.attrs?.level) || 1))}`);
      break;
    case "code_block": {
      el = d.createElement("pre");
      inner = el.appendChild(d.createElement("code"));
      const lang = String(n.attrs?.language ?? "");
      if (/^[\w+#.-]{1,32}$/.test(lang)) inner.className = `language-${lang}`;
      break;
    }
    case "ordered_list":
      el = inner = d.createElement("ol");
      if (n.attrs?.order !== 1) el.setAttribute("start", String(Number(n.attrs?.order) || 0));
      break;
    case "task_list":
      el = inner = d.createElement("ul");
      el.dataset.type = "taskList";
      break;
    case "task_item": {
      el = d.createElement("li");
      el.dataset.checked = String(!!n.attrs?.checked);
      const box = el.appendChild(d.createElement("input"));
      box.type = "checkbox";
      box.checked = !!n.attrs?.checked;
      box.disabled = true;
      inner = el.appendChild(d.createElement("div"));
      break;
    }
    case "image": {
      // Only a file of the workspace (schema.ts); anything else draws nothing.
      const src = String(n.attrs?.src ?? "");
      if (!readFilePath(src)) return;
      const img = d.createElement("img");
      img.src = src;
      img.alt = String(n.attrs?.alt ?? "");
      img.loading = "lazy";
      img.decoding = "async";
      parent.appendChild(img);
      return;
    }
    case "table":
      // As the editor draws it (schema.ts): the wrapper scrolls a wide table.
      el = d.createElement("div");
      el.className = "table-wrap";
      inner = el.appendChild(d.createElement("table")).appendChild(d.createElement("tbody"));
      break;
    case "table_cell": {
      el = inner = d.createElement("td");
      const align = String(n.attrs?.align ?? "");
      if (CELL_ALIGNS.includes(align as CellAlign) && align) el.dataset.align = align;
      break;
    }
    default: {
      const tag = TAG[n.type];
      if (!tag) return;
      el = inner = d.createElement(tag);
    }
  }
  // A code block holds only text, and its keys stay text.
  for (const c of n.content ?? []) renderNode(c, inner, d, depth + 1, n.type === "code_block" ? {} : opts);
  if (n.type === "blockquote" && (n.content?.length ?? 0) > 1 && isQuoteAuthor(n.content![0])) inner.firstElementChild?.classList.add("quote-author");
  const lines = n.type === "code_block" && opts.foldCode ? textOf(n).split("\n").length : 0;
  parent.appendChild(lines > CODE_LINES ? foldedCode(el, lines, d) : el);
}

function appendWithRefs(parent: Node, text: string, href: IssueHref, d: Document): void {
  let at = 0;
  for (const r of issueRefs(text, href)) {
    if (r.from > at) parent.appendChild(d.createTextNode(text.slice(at, r.from)));
    const a = d.createElement("a");
    a.href = r.href;
    a.className = "issue-ref";
    a.dataset.issue = r.key;
    a.textContent = r.key;
    parent.appendChild(a);
    at = r.to;
  }
  if (at < text.length || !at) parent.appendChild(d.createTextNode(text.slice(at)));
}

function textOf(n: DocNode): string {
  return n.text ?? (n.content ?? []).map(textOf).join(" ");
}
