// Markdown as a terminal reads it, for the CLI and the TUI (RSVA-421): one reading, two pictures. `blocks` says what each
// line of a text is (a heading, an item, code, a quote…), `spans` what a line's text holds (links, mentions, code,
// emphasis). The CLI paints them in SGR line by line (apps/cli, format.ts); the TUI wraps them into cells (apps/tui,
// description.ts). Neither parses Markdown of its own any more: before, each had its own regexes for the same rules.
//
// It is the editor's Markdown (packages/editor, markdown.ts) as far as a terminal needs it, without a dependency: the
// CLI starts with nothing but this package. Tables are the one thing left to the reader: a `|` line is a `row`, and
// whether rows make a table is the TUI's to decide (it asks the editor, which knows delimiter rows).

/** What a line of the text is. `line` is the line as written, its end trimmed; `indent` the spaces it starts with. */
export type Block = { line: string; indent: string } & (
  | { kind: "blank" }
  /** A fence line, opening or closing; the opening one names its language. */
  | { kind: "fence"; open: boolean; lang: string }
  /** A line inside a fence, as written. */
  | { kind: "code"; lang: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "rule" }
  | { kind: "quote"; text: string }
  | { kind: "task"; done: boolean; text: string }
  /** A bulleted or numbered item: `mark` is "-", "*", "+" or "1." as written. */
  | { kind: "item"; mark: string; text: string }
  /** An image of the workspace alone on its line, as the editor writes it; any other `![…](…)` is text. */
  | { kind: "image"; alt: string; src: string }
  /** A line that starts with `|`: a table's row when a delimiter row is under the first one. */
  | { kind: "row" }
  | { kind: "text"; text: string }
);

const FENCE = /^ {0,3}(?:```|~~~)\s*([\w+-]*)/;
const IMAGE = /^ {0,3}!\[([^\]\n]*)\]\((\/files\/[^()\s]+)\)[ \t]*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** Every line of `md`, in order, as what it is. A fence runs to the next fence line, or to the end. */
export function blocks(md: string): Block[] {
  const out: Block[] = [];
  let fence: string | null = null;
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const indent = /^\s*/.exec(line)![0];
    const at = { line, indent };
    const open = FENCE.exec(line);
    if (open) {
      out.push({ ...at, kind: "fence", open: fence === null, lang: fence === null ? open[1]!.toLowerCase() : "" });
      fence = fence === null ? open[1]!.toLowerCase() : null;
      continue;
    }
    if (fence !== null) {
      out.push({ ...at, kind: "code", lang: fence });
      continue;
    }
    const img = IMAGE.exec(line);
    const q = QUOTE.exec(line);
    const h = HEADING.exec(line);
    const task = TASK.exec(line);
    const item = ITEM.exec(line);
    if (img) out.push({ ...at, kind: "image", alt: img[1]!, src: img[2]! });
    else if (RULE.test(line)) out.push({ ...at, kind: "rule" });
    else if (q) out.push({ ...at, kind: "quote", text: q[1]! });
    else if (!line) out.push({ ...at, kind: "blank" });
    else if (h) out.push({ ...at, kind: "heading", level: h[1]!.length, text: h[2]! });
    else if (task) out.push({ ...at, kind: "task", done: task[1] !== " ", text: task[2]! });
    else if (item) out.push({ ...at, kind: "item", mark: item[1]!, text: item[2]! });
    else if (line.trimStart().startsWith("|")) out.push({ ...at, kind: "row" });
    else out.push({ ...at, kind: "text", text: line.slice(indent.length) });
  }
  return out;
}

/** What a line's text holds. Emphasis and code carry their text without the marks, escapes undone. */
export type Span =
  | { kind: "text"; text: string }
  /** `[words](href)`; `text` may be empty. */
  | { kind: "link"; text: string; href: string }
  /** `![alt](src)` in running text: a reader shows its caption, never "!" and a link. */
  | { kind: "image"; alt: string; src: string }
  /** `[@Name](mention:<id>)`: `text` is the name it carries. */
  | { kind: "mention"; text: string; target: string }
  | { kind: "code"; text: string }
  /** `<https://…>` or a bare address. */
  | { kind: "url"; href: string }
  | { kind: "emphasis"; style: "bold" | "strike" | "italic"; text: string };

/** What Markdown escapes; an escape is only ever one of these printable characters. */
const ESCAPABLE = String.raw`[\\` + "`" + String.raw`*_{}[\]()#+\-.!~<>|]`;
// A link's text and an autolink hold no opener of their own: a failed match is not retried from every `[` or `<` inside
// it, which was quadratic (64 KB of `[` took 1.9 s, RSVA-621). `[a [b](u)` is "[a " and a link "b", as the editor reads it.
const LINK_CODE_ESCAPE = String.raw`(!?)\[([^[\]\n]*)\]\(([^()\s]+)\)|` + "`([^`\\n]+)`" + String.raw`|\\(${ESCAPABLE})`;
/** Emphasis may hold escapes: `**a\*b**` is bold "a*b". */
const held = (mark: string) => String.raw`((?:[^${mark}\n\\]|\\${ESCAPABLE})+)`;
const UNESCAPE = new RegExp(String.raw`\\(${ESCAPABLE})`, "g");
const unescape = (s: string) => s.replace(UNESCAPE, "$1");
/** Links, images, mentions, code spans and escapes: what any reader takes, whichever comes first in the line. */
const PLAIN_INLINE = new RegExp(LINK_CODE_ESCAPE, "g");
/** Also autolinks, bare addresses, bold, struck and italic text. */
const RICH_INLINE = new RegExp(
  `${LINK_CODE_ESCAPE}|${String.raw`<(https?://[^<>\s]+)>|(https?://[^\s<>()]*[^\s<>().,;:!?'"])|\*\*${held("*")}\*\*|~~${held("~")}~~|(?<![\w*])\*${held("*")}\*(?![\w*])|(?<![\w_])_${held("_")}_(?![\w_])`}`,
  "g",
);

/**
 * The spans of a line's text, in order; text between them as `text` spans, none of them empty. `rich` also reads
 * addresses and emphasis: the TUI's card keeps to links and code, as its artboards draw it.
 */
export function spans(text: string, rich = true): Span[] {
  const out: Span[] = [];
  const words = (t: string) => t && out.push({ kind: "text", text: t });
  let at = 0;
  for (const m of text.matchAll(rich ? RICH_INLINE : PLAIN_INLINE)) {
    words(text.slice(at, m.index));
    const [, image, label, href, code, escaped, auto, bare, bold, struck, star, under] = m;
    if (image) out.push({ kind: "image", alt: label!, src: href! });
    else if (href?.startsWith("mention:")) out.push({ kind: "mention", text: label!, target: href.slice("mention:".length) });
    else if (href) out.push({ kind: "link", text: label!, href });
    else if (code) out.push({ kind: "code", text: code });
    else if (escaped) words(escaped);
    else if (auto || bare) out.push({ kind: "url", href: (auto ?? bare)! });
    else out.push({ kind: "emphasis", style: bold ? "bold" : struck ? "strike" : "italic", text: unescape((bold ?? struck ?? star ?? under)!) });
    at = m.index + m[0].length;
  }
  words(text.slice(at));
  return out;
}
