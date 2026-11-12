import assert from "node:assert/strict";
import { test } from "node:test";
import { drafts } from "./drafts.ts";

test("a draft handed over a reload reopens its composer once", () => {
  const d = drafts([
    ["reply:c1", "half a reply"],
    ["edit:c2", "a better wording"],
  ]);
  assert.equal(d.texts.get("reply:c1"), "half a reply");
  assert.ok(d.reopens("reply:c1"));
  assert.ok(d.reopens("edit:c2"));
  assert.ok(!d.reopens("reply:c3"), "nothing was handed over for it");

  d.opened("reply:c1");
  assert.ok(!d.reopens("reply:c1"), "open once: cancelled after that, it stays closed");
  assert.equal(d.texts.get("reply:c1"), "half a reply", "the draft itself stays");

  d.texts.delete("edit:c2");
  assert.ok(!d.reopens("edit:c2"), "sent before its composer opened again");
});

test("a draft typed on this page reopens nothing", () => {
  const d = drafts(null);
  d.texts.set("reply:c1", "typed, then cancelled");
  assert.ok(!d.reopens("reply:c1"));
});

test("junk in session storage gives no drafts", () => {
  for (const junk of [null, "x", { a: 1 }, [["reply:c1"]], [[1, "x"]], [["reply:c1", 2]]]) assert.equal(drafts(junk).texts.size, 0);
});
