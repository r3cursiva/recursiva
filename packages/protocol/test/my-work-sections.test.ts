import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FOLDED, myWorkFolds, sectionTitle } from "../src/my-work.ts";

test("nothing stored is Later and Done this week folded", () => {
  assert.deepEqual(myWorkFolds(null), ["later", "done"]);
  assert.deepEqual(myWorkFolds("nonsense"), ["later", "done"]);
  assert.deepEqual(DEFAULT_FOLDED, ["later", "done"]);
});

test("read back: group ids in their order, each once, junk dropped; an empty list is nothing folded", () => {
  assert.deepEqual(myWorkFolds(["done", "wait", "wait", "brief", 7, null]), ["wait", "done"]);
  assert.deepEqual(myWorkFolds([]), []);
});

test("a list from before the sections went is read for the groups it folded", () => {
  const old = [
    { id: "wait", kind: "wait", title: "", query: "", rows: 0, folded: false, hidden: false, hideEmpty: false },
    { id: "next", kind: "next", title: "", query: "", rows: 5, folded: true, hidden: true, hideEmpty: false },
    { id: "q1", kind: "query", title: "Mine", query: "assignee:me", rows: 10, folded: true, hidden: false, hideEmpty: false },
    { id: "later", kind: "later", folded: true },
  ];
  assert.deepEqual(myWorkFolds(old), ["next", "later"]);
});

test("a section's name: its title, else a group's name", () => {
  assert.equal(sectionTitle({ kind: "doing", title: "" }), "You’re doing");
  assert.equal(sectionTitle({ kind: "lane", title: "Urgent" }), "Urgent");
  assert.equal(sectionTitle({ kind: "lane", title: "" }), "");
});
