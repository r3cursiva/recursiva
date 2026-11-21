import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptsOf, fingerprint, leaseSeconds, LEASE_MAX, stopComment, stopReason, type RunFacts } from "./runs.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const at = (hoursAgo = 1) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const failed = (errorFingerprint: string | null = null, createdAt = at()): RunFacts => ({ outcome: "failed", errorFingerprint, createdAt });
const expired: RunFacts = { outcome: "expired", errorFingerprint: null, createdAt: at() };
const done: RunFacts = { outcome: "done", errorFingerprint: null, createdAt: at() };

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
  assert.match(text, /1\. failed — tried \\\*bold\\\* — error: boom \\\[x\\\]\\\(mention\\:me\\\)\n2\. expired\n/);
  assert.match(text, /until a person moves the issue out of review/);
});

test("a fingerprint takes linear time on a hostile line, and reads 500 characters of it at most", () => {
  const hostile = `${"a/".repeat(1000)}${"0".repeat(1000)}g`;
  const t0 = performance.now();
  fingerprint(hostile);
  fingerprint(`${"-".repeat(2000)}${"a".repeat(2000)}`);
  assert.ok(performance.now() - t0 < 50, `took ${performance.now() - t0} ms`);
  assert.equal(fingerprint(`${"x".repeat(500)}tail one`), fingerprint(`${"x".repeat(500)}tail two`));
});

test("a refused move to review is said in the stop comment, with the refusal as plain text", () => {
  const text = stopComment("work", "3 failed attempts", [], { moved: false, refused: "only people move issues to *Review*" });
  assert.match(text, /The move to review was refused \(only people move issues to \\\*Review\\\*\), so the issue stays where it is; agents cannot claim the work stage again until a person changes its state\./);
  assert.match(stopComment("work", "x", [], { moved: false }), /The project has no review state/);
});
