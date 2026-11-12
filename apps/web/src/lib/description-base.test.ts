import assert from "node:assert/strict";
import { test } from "node:test";
import { followsServer } from "./description-base.ts";

test("the base stays while a save is on its way, whatever the row says", () => {
  assert.equal(followsServer(true, false, true), false);
  assert.equal(followsServer(true, true, false), false);
});

test("typing keeps the older base against someone else's text, and moves on with its own", () => {
  assert.equal(followsServer(false, true, false), false);
  assert.equal(followsServer(false, true, true), true);
});

test("with nothing unsaved the base follows the text", () => {
  assert.equal(followsServer(false, false, false), true);
});
