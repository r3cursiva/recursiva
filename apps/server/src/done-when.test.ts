import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMarkdown, toMarkdown } from "@rsva/editor/markdown";
import { doneWhen, proofOf } from "./done-when.ts";

test("a Done when heading: its first list, checkboxes off, nested items ignored, text before the list allowed", () => {
  const md = [
    "Intro.",
    "",
    "## Done when",
    "",
    "Everything below, checked by hand.",
    "",
    "- [ ] `pnpm check` passes",
    "- [x] a test fails without the change",
    "  - details of the second",
    "    1. deeper still",
    "- the third, wrapped",
    "  onto a second line",
    "",
    "## Notes",
    "",
    "- not a criterion",
  ].join("\n");
  assert.deepEqual(doneWhen(md), ["`pnpm check` passes", "a test fails without the change", "the third, wrapped onto a second line"]);
});

test("a Done when: paragraph followed by a list, bold or not, any case; ordered items too", () => {
  assert.deepEqual(doneWhen("Text.\n\nDone when:\n\n1. first\n2. second\n\nAfter."), ["first", "second"]);
  assert.deepEqual(doneWhen("**DONE WHEN:**\n* alpha\n* beta"), ["alpha", "beta"]);
  assert.deepEqual(doneWhen("### done when\n- one"), ["one"]);
  assert.deepEqual(doneWhen("Done when:\n\nnot a list\n\n- later list"), [], "after a paragraph the list comes next");
});

test("no section, a section without a list, or one only in a code block: no criteria", () => {
  assert.deepEqual(doneWhen(""), []);
  assert.deepEqual(doneWhen("- a list\n- but no heading"), []);
  assert.deepEqual(doneWhen("## Done when\n\nWhen it feels right.\n\n## Next\n\n- x"), []);
  assert.deepEqual(doneWhen("Done when: the build is green"), [], "a sentence is not the section");
  assert.deepEqual(doneWhen("```md\n## Done when\n- example\n```\n\n- outside"), []);
  assert.deepEqual(doneWhen("````\n```\n## Done when\n````\n## Done when\n- real"), ["real"], "a fence closes on its own length");
});

test("the description as the server holds it: a mixed list the editor splits in two reads as one", () => {
  const md = toMarkdown(fromMarkdown("## Done when\n\n- [ ] checked one\n- plain one\n  - nested\n\nAfter."));
  assert.deepEqual(doneWhen(md), ["checked one", "plain one"]);
});

test("evidence: one non-blank text per criterion, in order; the first missing one named by number and text", () => {
  const criteria = ["tests pass", "docs updated"];
  assert.deepEqual(proofOf(criteria, [" CI run 12 ", "docs/x.md"]), { proof: [{ criterion: "tests pass", evidence: "CI run 12" }, { criterion: "docs updated", evidence: "docs/x.md" }] });
  assert.deepEqual(proofOf(criteria, ["CI"]), { refused: "no evidence for criterion 2 of 2: docs updated" });
  assert.deepEqual(proofOf(criteria, ["", "x"]), { refused: "no evidence for criterion 1 of 2: tests pass" });
  assert.deepEqual(proofOf(criteria, undefined), { refused: "no evidence for criterion 1 of 2: tests pass" });
  assert.match((proofOf(criteria, ["a", "b", "c"]) as { refused: string }).refused, /3 given for 2 criteria/);
  assert.match((proofOf(criteria, "a") as { refused: string }).refused, /a list of text/);
  assert.deepEqual(proofOf([], undefined), { proof: [] }, "no criteria, nothing to prove");
});
