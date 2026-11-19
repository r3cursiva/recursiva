// Three-way merge of descriptions (merge.ts): two edits of one text both stay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLinear } from "@rsva/test-kit";
import { fromMarkdown, toMarkdown } from "../src/markdown.ts";
import { mergeDocs } from "../src/merge.ts";

/** The merge of three Markdown texts, as Markdown. */
function merge(base: string, mine: string, theirs: string): string | null {
  const doc = mergeDocs(fromMarkdown(base), fromMarkdown(mine), fromMarkdown(theirs));
  return doc && toMarkdown(doc).trimEnd();
}

test("edits of different paragraphs both stay", () => {
  assert.equal(merge("One\n\nTwo\n\nThree", "One!\n\nTwo\n\nThree", "One\n\nTwo\n\nThree?"), "One!\n\nTwo\n\nThree?");
});

test("edits of neighbouring paragraphs both stay", () => {
  assert.equal(merge("One\n\nTwo", "One mine\n\nTwo", "One\n\nTwo theirs"), "One mine\n\nTwo theirs");
});

test("edits of different words of one paragraph both stay", () => {
  assert.equal(merge("The quick brown fox", "The slow brown fox", "The quick brown cat"), "The slow brown cat");
});

test("one side's edit is taken whole when the other changed nothing", () => {
  assert.equal(merge("Text", "Text", "Other text"), "Other text");
  assert.equal(merge("Text", "Mine", "Text"), "Mine");
});

test("the same edit on both sides appears once", () => {
  assert.equal(merge("A\n\nB", "A\n\nB\n\nC", "A\n\nB\n\nC"), "A\n\nB\n\nC");
});

test("what both wrote at the same place keeps both, theirs first", () => {
  assert.equal(merge("A", "A\n\nmine", "A\n\ntheirs"), "A\n\ntheirs\n\nmine");
  assert.equal(merge("The cat", "The dog", "The cow"), "The cow\n\nThe dog");
});

test("text one side took from a third and typed next to merges with the third's", () => {
  // Mine took "X" from someone else's save and typed after it; theirs is that save. Both "inserted" X: once.
  assert.equal(merge("a b", "a X more b", "a X b"), "a X more b");
});

test("an edit wins over a deletion of the same paragraph", () => {
  assert.equal(merge("Keep\n\nGone\n\nEnd", "Keep\n\nEnd", "Keep\n\nGone, edited\n\nEnd"), "Keep\n\nGone, edited\n\nEnd");
});

test("a deletion and an edit elsewhere both happen", () => {
  assert.equal(merge("Keep\n\nGone\n\nEnd", "Keep\n\nEnd", "Keep\n\nGone\n\nEnd!"), "Keep\n\nEnd!");
});

test("marks merge as text: a bold word and an edited word", () => {
  assert.equal(merge("one two three", "one **two** three", "one two four"), "one **two** four");
});

test("list items added on both sides both stay", () => {
  assert.equal(merge("- a\n- b", "- a\n- b\n- mine", "- a\n- theirs\n- b"), "- a\n- theirs\n- b\n- mine");
});

test("a checkbox ticked on one side and its text edited on the other", () => {
  assert.equal(merge("- [ ] task", "- [x] task", "- [ ] task, edited"), "- [x] task, edited");
});

test("table cells edited on both sides", () => {
  const base = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  assert.equal(merge(base, base.replace("1", "one"), base.replace("2", "two")), "| A | B |\n| --- | --- |\n| one | two |");
});

test("a column added on one side and a cell edited on the other gives a valid table", () => {
  const base = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const mine = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |";
  const merged = merge(base, mine, base.replace("1", "one"));
  assert.ok(merged?.includes("one") && merged.includes("3"), merged ?? "null");
});

test("a heading's level and its text change apart", () => {
  assert.equal(merge("# Title", "## Title", "# New title"), "## New title");
});

test("mentions and line breaks are units of their own", () => {
  const who = "[@Ann](mention:018f4c1e-0000-7000-8000-000000000001)";
  assert.equal(merge(`hi ${who} there`, `hi ${who} there!`, `oh hi ${who} there`), `oh hi ${who} there!`);
});

test("an emoji is not split", () => {
  assert.equal(merge("a 😀 b", "a 😀 b c", "z a 😀 b"), "z a 😀 b c");
});

test("from an empty description both texts stay", () => {
  assert.equal(merge("", "mine", "theirs"), "theirs\n\nmine");
});

test("a merge that would be too long is no merge", () => {
  const para = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] });
  const big = "x".repeat(250_000);
  assert.ok(mergeDocs(fromMarkdown(""), para(`${big}a`), para(`${big}b`)) === null);
});

test("merging stays linear on long and on wholly rewritten paragraphs", () => {
  const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i % 10}`).join(" ");
  const edited = (n: number) => [fromMarkdown(words(n, "w")), fromMarkdown(`${words(n, "w")} mine`), fromMarkdown(`theirs ${words(n, "w")}`)] as const;
  const rewritten = (n: number) => [fromMarkdown(words(n, "a")), fromMarkdown(words(n, "b")), fromMarkdown(words(n, "c"))] as const;
  const blocks = (n: number) => {
    const md = Array.from({ length: n }, (_, i) => `p${i}`).join("\n\n");
    return [fromMarkdown(md), fromMarkdown(md.replace("p1\n", "p1 mine\n")), fromMarkdown(md.replace(`p${n - 2}\n`, `p${n - 2} theirs\n`))] as const;
  };
  for (const [name, shape, n] of [["edited", edited, 4000], ["rewritten", rewritten, 4000], ["blocks", blocks, 4000]] as const) {
    assertLinear(name, shape, ([o, a, b]) => assert.ok(mergeDocs(o, a, b)), n);
  }
});
