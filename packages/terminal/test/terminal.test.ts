import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as schema from "@rsva/schema/models";
import { ApiError, failure, NetworkError, UsageError } from "../src/client.ts";
import { cacheRoot, credentialFolder } from "../src/copies.ts";
import { byState, isClosedGroup, STATE_GROUPS, type IssueRow } from "../src/issues.ts";
import { editorArgv, pagerOf } from "../src/programs.ts";
import { blocks, spans } from "../src/markdown.ts";
import { clean, escaped, plain } from "../src/text.ts";
import { graphemes, graphemeWidth, NARROW, widthOf } from "../src/width.ts";

test("the copy of the state groups is the schema's", () => {
  assert.deepEqual(STATE_GROUPS, schema.STATE_GROUPS);
  for (const g of [...schema.STATE_GROUPS, "", null, undefined]) assert.equal(isClosedGroup(g), schema.isClosedGroup(g), String(g));
});

test("plain: controls and the marks that reorder text go; tab, newline and the rest of the text stay", () => {
  assert.equal(plain("a\tb\nc"), "a\tb\nc");
  assert.equal(plain("\u001b[2Jx\u0007\u009b31my\r"), "[2Jx31my");
  assert.equal(plain("evil‮txt.exe⁦⁩‎؜ "), "eviltxt.exe");
  assert.equal(plain("Привет, 世界 👍"), "Привет, 世界 👍");
});

test("escaped: the same characters in JSON as \\u escapes, so the JSON still parses to the text", () => {
  const text = "a\u001b[31m‮b";
  const json = escaped(JSON.stringify({ text }));
  assert.ok(!/[\u001b‮]/.test(json));
  assert.deepEqual(JSON.parse(json), { text });
});

test("clean: every string of an answer, deep; other values as they are", () => {
  assert.deepEqual(clean({ a: "x\u001b", b: ["‮y", 1, null], c: { d: true, e: "z\u0085" } }), { a: "x", b: ["y", 1, null], c: { d: true, e: "z" } });
});

test("byState: states by group in the app's order, each state's issues as they came", () => {
  const row = (key: string, state: string | null, stateGroup: string | null): IssueRow =>
    ({ key, title: key, state, stateGroup, priority: "none", labels: [], assignees: [], delegate: null, parent: null, cycle: null, startDate: null, dueDate: null });
  const rows = [row("A-1", "Done", "completed"), row("A-2", "Todo", "unstarted"), row("A-3", null, null), row("A-4", "Todo", "unstarted"), row("A-5", "Backlog", "backlog")];
  assert.deepEqual(byState(rows).map((g) => g.map((r) => r.key)), [["A-5"], ["A-2", "A-4"], ["A-1"], ["A-3"]]);
});

test("pagerOf: RSVA_PAGER before PAGER, else less with LESS=FRX; cat or empty is none (the CLI and the TUI choose by it)", () => {
  assert.equal(pagerOf({ RSVA_PAGER: "most -s", PAGER: "more" })?.command, "most -s");
  assert.equal(pagerOf({ PAGER: " more " })?.command, "more");
  assert.deepEqual(pagerOf({ HOME: "/h" }), { command: "less", env: { HOME: "/h", LESS: "FRX" } });
  assert.equal(pagerOf({ LESS: "R" })?.env.LESS, "R", "the person's LESS stays");
  assert.equal(pagerOf({ RSVA_PAGER: "cat", PAGER: "less" }), null);
  assert.equal(pagerOf({ RSVA_PAGER: "", PAGER: "less" }), null, "an empty RSVA_PAGER is none, not PAGER");
});

test("editorArgv: VISUAL, then EDITOR, else vi, through sh with the file as $1", () => {
  assert.deepEqual(editorArgv({ VISUAL: "code --wait", EDITOR: "nano" }, "/c/a b.md"), ["sh", ["-c", 'code --wait "$1"', "code --wait", "/c/a b.md"]]);
  assert.deepEqual(editorArgv({}, "/c/x.md"), ["sh", ["-c", 'vi "$1"', "vi", "/c/x.md"]]);
});

test("failure: the server's message and suggestions through plain, exit 1; a mistake 2; a bug is not one", () => {
  const e = new ApiError("no issue \u001b]0;pwned\u0007CORE-9\u202e", 404, ["CORE-1\u001b[2J", "CORE-2"]);
  assert.deepEqual(failure(e), { code: 1, text: "no issue ]0;pwnedCORE-9\ntry: CORE-1[2J, CORE-2" });
  assert.deepEqual(failure(new UsageError("which project?")), { code: 2, text: "which project?" });
  assert.deepEqual(failure(new NetworkError("fetch failed: ECONNREFUSED")), { code: 1, text: "fetch failed: ECONNREFUSED" });
  assert.equal(failure(new TypeError("x is undefined")), null);
});

test("cacheRoot: XDG_CACHE_HOME when set, else the platform's caches; the copies live under it", () => {
  assert.equal(cacheRoot({ XDG_CACHE_HOME: "/x/cache" }), "/x/cache/rsva");
  assert.equal(cacheRoot({}), join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache", "rsva"));
  assert.match(credentialFolder("Bearer rsva_x", { XDG_CACHE_HOME: "/x/cache" }), /^\/x\/cache\/rsva\/[0-9a-f]{16}$/);
});

test("markdown blocks: each line as what it is, a fence to the next fence, the editor's images only", () => {
  const md = [
    "## Why",
    "text  ",
    "  - [x] done",
    "* [ ] open",
    "1. one",
    "+ plus",
    "> said",
    "* * *",
    "",
    "| a | b |",
    "![shot](/files/acme/ab)",
    "![far](https://e.com/x.png)",
    "~~~ts",
    "# not a heading",
    "~~~",
    "   ",
  ].join("\r\n");
  const got = blocks(md).map(({ line: _, indent: __, ...b }) => b);
  assert.deepEqual(got, [
    { kind: "heading", level: 2, text: "Why" },
    { kind: "text", text: "text" },
    { kind: "task", done: true, text: "done" },
    { kind: "task", done: false, text: "open" },
    { kind: "item", mark: "1.", text: "one" },
    { kind: "item", mark: "+", text: "plus" },
    { kind: "quote", text: "said" },
    { kind: "rule" },
    { kind: "blank" },
    { kind: "row" },
    { kind: "image", alt: "shot", src: "/files/acme/ab" },
    { kind: "text", text: "![far](https://e.com/x.png)" },
    { kind: "fence", open: true, lang: "ts" },
    { kind: "code", lang: "ts" },
    { kind: "fence", open: false, lang: "" },
    { kind: "blank" },
  ]);
  assert.deepEqual(blocks("  - [x] done")[0], { line: "  - [x] done", indent: "  ", kind: "task", done: true, text: "done" });
  assert.deepEqual(blocks("```\nnever closed").map((b) => b.kind), ["fence", "code"]);
});

test("markdown spans: links, mentions, images, code and escapes always; addresses and emphasis when rich", () => {
  const md = "Ask [@Ann](mention:u1) about [the spec](https://x.dev) ![a](/files/x) `[not](a link)` \\*x\\* **a\\*b** _it_ ~~gone~~ <https://e.com/a> https://e.com/b.";
  assert.deepEqual(spans(md), [
    { kind: "text", text: "Ask " },
    { kind: "mention", text: "@Ann", target: "u1" },
    { kind: "text", text: " about " },
    { kind: "link", text: "the spec", href: "https://x.dev" },
    { kind: "text", text: " " },
    { kind: "image", alt: "a", src: "/files/x" },
    { kind: "text", text: " " },
    { kind: "code", text: "[not](a link)" },
    { kind: "text", text: " " },
    { kind: "text", text: "*" },
    { kind: "text", text: "x" },
    { kind: "text", text: "*" },
    { kind: "text", text: " " },
    { kind: "emphasis", style: "bold", text: "a*b" },
    { kind: "text", text: " " },
    { kind: "emphasis", style: "italic", text: "it" },
    { kind: "text", text: " " },
    { kind: "emphasis", style: "strike", text: "gone" },
    { kind: "text", text: " " },
    { kind: "url", href: "https://e.com/a" },
    { kind: "text", text: " " },
    { kind: "url", href: "https://e.com/b" },
    { kind: "text", text: "." },
  ]);
  const plainSpans = spans("**b** _i_ https://e.com", false);
  assert.deepEqual(plainSpans, [{ kind: "text", text: "**b** _i_ https://e.com" }]);
  assert.deepEqual(spans("snake_case_name and 2*3*4"), [{ kind: "text", text: "snake_case_name and 2*3*4" }], "no emphasis inside words");
});

test("widthOf: wide letters take two cells, joining marks none, a letter one", () => {
  assert.deepEqual([widthOf("abc"), widthOf("一二"), widthOf(`e${String.fromCharCode(0x301)}`), widthOf("Привет — мир"), widthOf("한국어"), widthOf("")], [3, 4, 1, 12, 6, 0]);
  assert.deepEqual(graphemes("ab👍🏽c"), ["a", "b", "👍🏽", "c"]);
  assert.deepEqual(graphemes("Jé").map(graphemeWidth), [1, 1]);
});

test("widthOf: emoji as pictures by default take two cells, text-style pictographs one, as Rex draws them", () => {
  // Where the CLI's \p{Extended_Pictographic} and the TUI's \p{Emoji_Presentation} disagreed (RSVA-461): one cell each
  // in Rex, measured with the cursor's position (docs/research/terminal-width-2026-11-07.md).
  for (const one of ["©", "▪", "❤", "❤\ufe0f", "⚠\ufe0f", "™", "↔", "✔"]) assert.equal(widthOf(one), 1, one);
  for (const two of ["🔥", "👍", "👍🏽", "👨‍👩‍👧", "🇷🇺"]) assert.equal(widthOf(two), 2, two);
  for (const glyph of ["●", "◐", "✓", "✕"]) assert.equal(widthOf(glyph), 1, glyph);
});

test("NARROW: every character it lets through is a grapheme of its own and one cell", () => {
  const segmenter = new Intl.Segmenter();
  let n = 0;
  for (let c = 0x20; c < 0x10000; c++) {
    const ch = String.fromCharCode(c);
    if (!NARROW.test(ch)) continue;
    n++;
    assert.equal([...segmenter.segment(`a${ch}a${ch}`)].length, 4, `U+${c.toString(16)}`);
    assert.equal(graphemeWidth(ch), 1, `U+${c.toString(16)}`);
  }
  assert.ok(n > 1000);
});
