import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocNode } from "@rsva/editor/doc";
import { fromMarkdown } from "@rsva/editor/markdown";
import { attemptsOf, doneComment, doneCommentMax, fingerprint, leaseSeconds, LEASE_MAX, stopComment, stopReason, type RunFacts } from "./runs.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const at = (hoursAgo = 1) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const failed = (errorFingerprint: string | null = null, createdAt = at()): RunFacts => ({ outcome: "failed", errorFingerprint, createdAt });
const expired: RunFacts = { outcome: "expired", errorFingerprint: null, createdAt: at() };
const done: RunFacts = { outcome: "done", errorFingerprint: null, createdAt: at() };
const blocked = (errorFingerprint: string | null = "env"): RunFacts => ({ outcome: "blocked", errorFingerprint, createdAt: at() });

test("attempts count from the last stopped run, over the last day; a done run does not end the count", () => {
  assert.equal(attemptsOf([failed(), failed()], NOW).length, 2);
  assert.equal(attemptsOf([failed(), failed(), done], NOW).length, 3, "the agent saying done does not reset the cap");
  assert.equal(stopReason(attemptsOf([failed("a"), failed("b"), done, failed("c")], NOW)), "3 failed attempts", "fail, fail, done, fail stops");
  assert.equal(attemptsOf([failed(), { outcome: "stopped", errorFingerprint: null, createdAt: at() }, expired], NOW).length, 1);
  assert.equal(attemptsOf([failed("a", at(30)), failed("b", at(25)), failed("c")], NOW).length, 1, "older than a day: not counted");
});

test("three failed or expired attempts stop the loop", () => {
  assert.equal(stopReason([failed("a"), failed("b")]), null);
  assert.equal(stopReason([failed("a"), failed("b"), failed("c")]), "3 failed attempts");
  assert.equal(stopReason([failed("a"), expired, failed("b")]), "3 failed attempts", "an expired lease is a failed attempt");
});

test("a run that asked a person is no attempt: any number of them stop nothing (RSVA-644)", () => {
  const asked: RunFacts = { outcome: "asked", errorFingerprint: null, createdAt: at() };
  assert.equal(stopReason([asked, asked, asked, asked, asked]), null);
  assert.equal(stopReason([failed("a"), asked, failed("b")]), null, "two failures and a question are two failures");
});

test("the same error twice in a row stops; different errors, or an expiry between, do not", () => {
  assert.equal(stopReason([failed("a"), failed("a")]), "the same error twice in a row");
  assert.equal(stopReason([failed("a"), failed("b")]), null);
  assert.equal(stopReason([failed("a"), expired]), null);
  assert.equal(stopReason([expired, expired]), null, "an expiry has no error to repeat");
  assert.equal(stopReason([failed("a"), done, failed("a")]), "the same error twice in a row", "a done between them does not clear it");
  assert.equal(stopReason([failed("a"), expired, failed("a")]), "3 failed attempts", "an expiry between them is a failure of its own");
  assert.equal(stopReason([failed("a"), expired, done, failed("a")].slice(1)), null);
});

test("a fingerprint ignores digits, paths, ids, whitespace and case", () => {
  const a = fingerprint("\n  TypeError at /Users/x/app/src/a.ts:12:5 cannot read id 3f2a9b1c of run 0192a1b2-0000-7000-8000-000000000001 after 30s\nstack one");
  const b = fingerprint("typeerror at /home/ci/work/src/b.ts:40:1   cannot read id 99aa77bb of run 0192a1b2-0000-7000-8000-00000000abcd after 2s\nother stack");
  assert.equal(a, b, "the first non-blank line only");
  assert.notEqual(fingerprint("tests failed"), fingerprint("lint failed"));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("a lease: an hour by default, held to its bounds, refused when not whole seconds", () => {
  assert.equal(leaseSeconds(undefined), 3600);
  assert.equal(leaseSeconds(5), 60);
  assert.equal(leaseSeconds(10 ** 6), LEASE_MAX);
  for (const bad of [0, -1, 1.5, "1h", null]) assert.equal(leaseSeconds(bad), null, String(bad));
});

test("the stop comment lists each attempt and keeps Markdown out of what agents wrote", () => {
  const text = stopComment("work", "3 failed attempts", [
    { outcome: "failed", note: "tried *bold*", error: "\n  boom [x](mention:me)\nstack" },
    { outcome: "expired", note: null, error: null },
  ], { moved: true });
  assert.match(text, /^Stopped the work loop: 3 failed attempts\./);
  assert.match(text, /1\. failed — tried \\\*bold\\\* — error: boom \\\[x\\\]\(mention:me\)\n2\. expired\n/);
  assert.match(text, /until a person moves the issue out of review/);
});

test("a fingerprint takes linear time on hostile lines, and reads 500 characters of one at most", () => {
  // Each of these 4000-character lines took the old patterns about 10 ms (quadratic backtracking); ten of them, 100 ms.
  const hostile = ["a", "~", "0", "-"].flatMap((c) => [c.repeat(4000), `${c.repeat(3999)} `]).concat(["a/".repeat(2000), `${"-".repeat(2000)}${"a".repeat(2000)}`]);
  const t0 = performance.now();
  for (const line of hostile) fingerprint(line);
  assert.ok(performance.now() - t0 < 20, `took ${performance.now() - t0} ms`);
  assert.equal(fingerprint(`${"x".repeat(500)}tail one`), fingerprint(`${"x".repeat(500)}tail two`));
});

test("a refused move to review is said in the stop comment, with the refusal as plain text", () => {
  const text = stopComment("work", "3 failed attempts", [], { moved: false, refused: "only people move issues to *Review*" });
  assert.match(text, /The move to review was refused \(only people move issues to \\\*Review\\\*\), so the issue stays where it is; agents cannot claim the work stage again until a person changes its state\./);
  assert.match(stopComment("work", "x", [], { moved: false }), /The project has no review state/);
});

/** The inline nodes of a block, flattened: what a comment shows of it. */
const inlineOf = (n: DocNode): DocNode[] => (n.type === "text" || n.type === "mention" ? [n] : (n.content ?? []).flatMap(inlineOf));

test("evidence keeps inline code and bare URLs; agent text cannot change the comment's structure", () => {
  const hostile = ["# heading", "- item", "> quote", "```js", "1. two", "line\nbreak", "[@Ann](mention:0192a1b2-0000-7000-8000-000000000001)", "<img src=x onerror=y>", "| a | b |", "---", "@ann", "*bold*"];
  const md = doneComment(
    "work",
    [{ criterion: "`pnpm check` passes", evidence: "green in apps/server/src/runs.test.ts, ``a`b`` c" }, ...hostile.map((h) => ({ criterion: h, evidence: h }))],
    "PR https://github.com/r3cursiva/recursiva/pull/21.",
  )!;
  const doc = fromMarkdown(md);
  assert.deepEqual(doc.content!.map((b) => b.type), ["paragraph", "ordered_list", "paragraph"], md);
  const items = doc.content![1]!.content!;
  assert.equal(items.length, hostile.length + 1);
  for (const item of items) assert.deepEqual(item.content!.map((b) => b.type), ["paragraph"], "each item one paragraph: no heading, list, quote or fence inside");
  const all = inlineOf(doc);
  assert.ok(!all.some((n) => n.type === "mention"), "no mention");
  assert.deepEqual(all.filter((n) => n.marks?.some((m) => m.type === "code")).map((n) => n.text), ["pnpm check", "a`b"], "code spans stay code");
  assert.deepEqual(all.flatMap((n) => n.marks?.filter((m) => m.type === "link").map((m) => m.attrs!.href) ?? []), ["https://github.com/r3cursiva/recursiva/pull/21"], "the URL links, nothing else does");
  assert.ok(!all.some((n) => n.marks?.some((m) => m.type === "bold" || m.type === "italic")), "no emphasis");
  for (const h of hostile) assert.ok(all.map((n) => n.text).join("").includes(h.replace("\n", " ")), `${h} reads as it was written`);
  assert.match(md, /^1\.\s+`pnpm check` passes — green in apps\/server\/src\/runs\.test\.ts, ``a`b`` c$/m, "harmless punctuation is not escaped");
});

test("the environment's failures do not count as the agent's, and stop the loop at a cap of their own", () => {
  assert.equal(stopReason([failed("a"), blocked(), failed("b"), blocked()]), null, "two failures of the agent, two of the environment");
  assert.equal(stopReason([blocked("x"), blocked("x")]), null, "the same error twice: the environment's is not the agent's repeat");
  assert.equal(stopReason([failed("a"), blocked("a"), failed("b")]), null, "a blocked run between does not make a repeat either");
  assert.equal(stopReason([failed("a"), blocked("a"), failed("a")]), "the same error twice in a row", "nor clear one");
  assert.match(stopReason([blocked(), failed("a"), blocked(), blocked()])!, /^3 failures of the environment, not of the agent/);
  // An agent that calls every failure the environment's is still stopped: at most 3 + 3 failures in a window.
  assert.equal(stopReason([failed("a"), failed("b"), blocked(), blocked()]), null);
  assert.ok(stopReason([failed("a"), failed("b"), blocked(), blocked(), blocked()]));
  assert.ok(stopReason([blocked(), blocked(), failed("a"), failed("b"), failed("c")]));
});

test("code spans in agent text pair as the Markdown parser pairs them, an escaped backtick included", () => {
  const codes = (n: DocNode) => inlineOf(n).filter((x) => x.marks?.some((m) => m.type === "code")).map((x) => x.text);
  for (const s of ["say \\`a` and `b`", "``a`b`` c", "`a`` b` `c`", "\\``x``"]) {
    const md = doneComment("work", [{ criterion: "c", evidence: s }], null)!;
    assert.deepEqual(codes(fromMarkdown(md)), codes(fromMarkdown(s)), s);
  }
});

test("a done comment's longest form bounds every refusal it can quote", () => {
  const proof = [{ criterion: "c", evidence: "e" }];
  for (const unit of ["*", "\\", "<a", "&a;", "https://x ", "_ ", "`", "[x](mention:me)", "a"]) {
    const refused = unit.repeat(Math.ceil(1000 / unit.length));
    assert.ok(doneComment("work", proof, "n", { moved: false, refused })!.length <= doneCommentMax("work", proof, "n"), unit);
  }
});
