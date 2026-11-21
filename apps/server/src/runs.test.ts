import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptsOf, fingerprint, leaseSeconds, LEASE_MAX, stopComment, stopReason, type RunFacts } from "./runs.ts";

const failed = (errorFingerprint: string | null = null): RunFacts => ({ outcome: "failed", errorFingerprint });
const expired: RunFacts = { outcome: "expired", errorFingerprint: null };
const done: RunFacts = { outcome: "done", errorFingerprint: null };

test("attempts count from the last done or stopped run", () => {
  assert.equal(attemptsOf([failed(), failed()]).length, 2);
  assert.deepEqual(attemptsOf([failed(), failed(), done]), []);
  assert.equal(attemptsOf([failed(), done, failed()]).length, 1);
  assert.equal(attemptsOf([failed(), { outcome: "stopped", errorFingerprint: null }, expired]).length, 1);
});

test("three failed or expired attempts stop the loop", () => {
  assert.equal(stopReason([failed("a"), failed("b")]), null);
  assert.equal(stopReason([failed("a"), failed("b"), failed("c")]), "3 failed attempts");
  assert.equal(stopReason([failed("a"), expired, failed("b")]), "3 failed attempts", "an expired lease is a failed attempt");
  assert.equal(stopReason(attemptsOf([failed("a"), failed("b"), done, failed("c")])), null, "done starts the count again");
});

test("the same error twice in a row stops; different errors, or an expiry between, do not", () => {
  assert.equal(stopReason([failed("a"), failed("a")]), "the same error twice in a row");
  assert.equal(stopReason([failed("a"), failed("b")]), null);
  assert.equal(stopReason([failed("a"), expired]), null);
  assert.equal(stopReason([expired, expired]), null, "an expiry has no error to repeat");
});

test("a fingerprint ignores digits, paths, ids, whitespace and case", () => {
  const a = fingerprint("TypeError at /Users/x/app/src/a.ts:12:5\n  cannot read id 3f2a9b1c of run 0192a1b2-0000-7000-8000-000000000001 after 30s");
  const b = fingerprint("typeerror at /home/ci/work/src/b.ts:40:1   cannot read id 99aa77bb of run 0192a1b2-0000-7000-8000-00000000abcd after 2s");
  assert.equal(a, b);
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
  ], true);
  assert.match(text, /^Stopped the work loop: 3 failed attempts\./);
  assert.match(text, /1\. failed — tried \\\*bold\\\* — error: boom \\\[x\\\]\\\(mention\\:me\\\)\n2\. expired\n/);
  assert.match(text, /until a person moves the issue out of review/);
});
