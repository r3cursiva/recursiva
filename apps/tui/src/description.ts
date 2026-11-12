// An issue's description laid out for a column of cells: Markdown as the artboards draw it, in the card's look (the
// home card, the queue) or reading's (the issue screen). Moved out of home.ts (RSVA-458): the issue screen and the queue
// lay it out too.
import { TABLE_CELLS_MAX, TABLE_COLUMNS_MAX } from "@rsva/editor/doc";
import { issueKeys } from "@rsva/editor/issue-ref";
import { isDelimiterRow, tableCells } from "@rsva/editor/markdown";
import { ISSUE_KEY } from "@rsva/schema/models";
import { blocks, spans } from "@rsva/terminal/markdown";
import { widthOf } from "@rsva/terminal/width";
import type { Pen } from "./grid.ts";
import type { Token } from "./theme.ts";
import { cutSegs, wrap, type Seg } from "./widgets.ts";

/** The text column's most cells, as the web keeps text to a measure: a wider window leaves the rest empty. */
export const MEASURE = 100;

export interface DescLine {
  segs: Seg[];
  /** A code or diff line's ground: it runs to the column's end. */
  ground?: Token;
  /** An image of the workspace, on a line of its own; `segs` are its caption, for where it is not drawn (images.ts). */
  image?: { src: string };
}

/** What stands for an image where it is not drawn: its alt text, after a frame. */
const caption = (alt: string): Seg => [`▣ ${alt.trim() || "image"}`, { fg: "ink-3" }];

/**
 * How text is drawn, as the artboards have it: the text in ink-2, links underlined in ink, issue keys in ink-3, headings
 * bold after their faint marks. The card's (TuiHome, the queue) keeps to that. Reading's, the issue screen (the "TUI ·
 * issue" artboards), also draws bold, italic and struck text, mentions in bold ink, code on its ground, quotes with a
 * bar, rules, addresses as links, done items quieter, code blocks with their line numbers and diffs on their grounds.
 */
export interface Look {
  text: Pen;
  link: Pen;
  key: Pen;
  mention: Pen;
  code: Pen;
  rich: boolean;
}

const CARD_LOOK: Look = { text: { fg: "ink-2" }, link: { fg: "ink", at: "U" }, key: { fg: "ink-3" }, mention: { fg: "ink", at: "U" }, code: { fg: "ink" }, rich: false };
export const READING_LOOK: Look = { ...CARD_LOOK, mention: { fg: "ink", at: "B" }, code: { fg: "ink", bg: "code" }, rich: true };

/** An issue's address, here or in the Plane it came from (…/browse/MEX-9/): its key is all a reader needs of it. */
const BROWSE = new RegExp(String.raw`/browse/(${ISSUE_KEY})/?(?:[?#][^\s]*)?$`);

/** An address as a reader sees it: an issue's as its key, any other as a link; a click opens either (RSVA-479). */
const address = (url: string, look: Look): Seg => {
  const key = look.rich ? BROWSE.exec(url)?.[1] : undefined;
  return key ? [key, { ...look.key, click: `issue:${key}` }] : [url, { ...look.link, click: `open:${url}` }];
};

/** Emphasis as the grid's attributes. */
const EMPHASIS = { bold: "B", strike: "S", italic: "I" } as const;

/** Inline Markdown in a look: the spans of @rsva/terminal/markdown, issue keys in running text. */
function inline(text: string, look: Look = CARD_LOOK): Seg[] {
  const out: Seg[] = [];
  const words = (t: string, pen: Pen = look.text) => {
    let at = 0;
    for (const k of issueKeys(t)) {
      if (k.from > at) out.push([t.slice(at, k.from), pen]);
      out.push([k.key, { ...look.key, click: `issue:${k.key}` }]);
      at = k.to;
    }
    if (at < t.length) out.push([t.slice(at), pen]);
  };
  const styled = (t: string, at: string) => words(t, { ...look.text, at: `${look.text.at ?? ""}${at}` });
  for (const s of spans(text, look.rich)) {
    if (s.kind === "text") words(s.text);
    // An image in running text reads as its caption, not as "!" and a link.
    else if (s.kind === "image") out.push(caption(s.alt));
    else if (s.kind === "mention") out.push([s.text || "@?", look.mention]);
    else if (s.kind === "link") out.push(s.text && s.text !== s.href ? [s.text, { ...look.link, click: `open:${s.href}` }] : address(s.href, look));
    else if (s.kind === "code") out.push([s.text, look.code]);
    else if (s.kind === "url") out.push(address(s.href, look));
    else styled(s.text, EMPHASIS[s.style]);
  }
  return out.filter(([t]) => t);
}

/**
 * A line of a code block on the issue screen: its number, faint, then the code; in a diff, an added or removed line on
 * its own ground with its mark, a hunk's head quieter.
 */
function codeLine(line: string, fence: { lang: string; n: number }): DescLine {
  if (fence.lang === "diff" || fence.lang === "patch") {
    const add = /^\+(?!\+\+)/.test(line);
    const del = /^-(?!--)/.test(line);
    if (add || del) {
      const ground: Token = add ? "add-bg" : "del-bg";
      return { segs: [[add ? " + " : " − ", { fg: add ? "success" : "error", bg: ground, at: "B" }], [line.slice(1), { fg: "ink", bg: ground }]], ground };
    }
    return { segs: [[`   ${line}`, { fg: line.startsWith("@@") ? "ink-3" : "ink-2", bg: "code" }]], ground: "code" };
  }
  return { segs: [[String(fence.n++).padStart(3), { fg: "faint", bg: "code" }], [`  ${line}`, { fg: "ink-2", bg: "code" }]], ground: "code" };
}

/** Segments cut to `room` cells, as cutSegs, and padded to `room` when `pad`. */
function fitSegs(list: Seg[], room: number, pad: boolean): Seg[] {
  const out = cutSegs(list, room);
  const used = out.reduce((n, [t]) => n + widthOf(t), 0);
  if (pad && used < room) out.push([" ".repeat(room - used), { fg: "ink" }]);
  return out;
}

/**
 * A Markdown table (the editor's, GitHub's) as columns: one line a row, the header bold over a rule, each column as wide
 * as its widest cell, the widest ones narrowed until the table fits the room; a cell too long ends in "…".
 */
function tableLines(rows: string[], room: number, look: Look): DescLine[] {
  // The editor's caps (doc.ts): a description is drawn on every repaint, whatever it holds.
  const cells = rows
    .slice(0, TABLE_CELLS_MAX)
    .map((r) => tableCells(r).slice(0, TABLE_COLUMNS_MAX))
    .filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
  const cols = cells.reduce((n, r) => Math.max(n, r.length), 1);
  const segsOf = cells.map((r, i) => Array.from({ length: cols }, (_, k): Seg[] => inline(r[k] ?? "", i ? look : { ...look, text: { ...look.text, at: "B" } })));
  const widths = Array.from({ length: cols }, (_, k) => Math.max(1, ...segsOf.map((r) => r[k]!.reduce((n, [t]) => n + widthOf(t), 0))));
  const gap = 3;
  // The widest columns are cut down to one width, the largest that fits (at least 3): short columns keep their text whole.
  const fits = (cap: number) => widths.reduce((n, w) => n + Math.min(w, cap), 0) + gap * (cols - 1) <= room;
  let lo = 3;
  let hi = Math.max(...widths);
  if (!fits(hi)) {
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    widths.forEach((w, k) => (widths[k] = Math.min(w, lo)));
  }
  const rule: Seg = [widths.map((w) => "─".repeat(w)).join("─┼─"), { fg: "rule-strong" }];
  const out: DescLine[] = [];
  segsOf.forEach((r, i) => {
    const line: Seg[] = [];
    r.forEach((c, k) => {
      if (k) line.push([" │ ", { fg: "rule-strong" }]);
      line.push(...fitSegs(c, widths[k]!, k < cols - 1));
    });
    out.push({ segs: line });
    if (!i && segsOf.length > 1) out.push({ segs: [rule] });
  });
  return out;
}

/**
 * The description laid out whole: headings, paragraphs and task, numbered and bulleted items wrapped (an item under its
 * text), code (its own background), blank lines between blocks. The painter shows as many lines as it has rows; the home
 * card counts the rest in its border (PLNR-397: it kept two lines a paragraph and one an item, cut, however tall it was).
 * Reading (the issue screen) also draws quotes with a bar, rules, numbered code and diffs.
 */
export function layoutDescription(md: string, room: number, look: Look = CARD_LOOK): DescLine[] {
  const out: DescLine[] = [];
  const lines = blocks(md);
  let para: string[] = [];
  let table: string[] = [];
  const flush = () => {
    if (para.length) for (const l of wrap(inline(para.join(" "), look), room)) out.push({ segs: l });
    if (table.length) out.push(...tableLines(table, room, look));
    para = [];
    table = [];
  };
  // An item: wrapped under its text.
  const item = (mark: Seg[], text: string) => {
    const indent = widthOf(mark.map(([t]) => t).join(""));
    wrap(inline(text, look), Math.max(1, room - indent)).forEach((l, i) => out.push({ segs: [...(i ? [[" ".repeat(indent), { fg: "ink" }] as Seg] : mark), ...l] }));
  };
  // The open fence's language and its next line's number.
  const fence = { lang: "", n: 1 };
  for (const [at, b] of lines.entries()) {
    if (b.kind === "fence") {
      flush();
      Object.assign(fence, { lang: b.lang, n: 1 });
    } else if (b.kind === "code") {
      out.push(look.rich ? codeLine(b.line, fence) : { segs: [[` ${b.line}`, { fg: "ink-2", bg: "code" }]], ground: "code" });
    } else if (b.kind === "image") {
      flush();
      out.push({ segs: [caption(b.alt)], image: { src: b.src } });
    } else if (b.kind === "rule" && look.rich) {
      flush();
      out.push({ segs: [["─".repeat(room), { fg: "rule-strong" }]] });
    } else if (b.kind === "quote" && look.rich) {
      flush();
      // A quote's lines each under the bar, in the quieter ink, as the web's blockquote.
      wrap(inline(b.text, { ...look, text: { fg: "ink-3" } }), Math.max(1, room - 2)).forEach((l) => out.push({ segs: [["│ ", { fg: "rule-strong" }], ...l] }));
    } else if (b.kind === "blank") {
      flush();
      if (out.length && out.at(-1)!.segs.length) out.push({ segs: [] });
    } else if (b.kind === "heading") {
      flush();
      out.push({ segs: [[`${"#".repeat(b.level)} `, { fg: "faint" }], [b.text, { fg: "ink", at: "B" }]] });
    } else if (b.kind === "task") {
      flush();
      const box: Seg[] = b.done ? [["[", { fg: "faint" }], ["✓", { fg: "success" }], ["] ", { fg: "faint" }]] : [["[ ] ", { fg: "faint" }]];
      // Done items read quieter on the issue screen, as the artboard has them.
      if (b.done && look.rich) {
        const quiet = { ...look, text: { fg: "ink-3" } as const };
        wrap(inline(b.text, quiet), Math.max(1, room - 4)).forEach((l, i) => out.push({ segs: [...(i ? [["    ", { fg: "ink" }] as Seg] : box), ...l] }));
      } else item(box, b.text);
    } else if (b.kind === "item") {
      flush();
      item([[/\d/.test(b.mark) ? `${b.mark} ` : "• ", { fg: "ink-3" }]], b.text);
    } else if (b.kind === "row" && (table.length || isDelimiterRow(lines[at + 1]?.line ?? ""))) {
      // A table starts at a `|` line with a delimiter row under it, as in markdown.ts; any other `|` line is text.
      if (para.length) flush();
      table.push(b.line);
    } else {
      // Text, and on the card, which draws neither, a quote and a rule as written.
      if (table.length) flush();
      para.push(b.line.trim());
    }
  }
  flush();
  while (out.length && !out.at(-1)!.segs.length) out.pop();
  return out;
}
