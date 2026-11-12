import assert from "node:assert/strict";
import { test } from "node:test";
import { copyKeys } from "./copy-keys.ts";

const press = (over: Partial<Parameters<typeof copyKeys>[0]>) => copyKeys({ metaKey: false, ctrlKey: false, shiftKey: false, key: "", code: "", ...over });

test("⌘. copies the key, ⌘⇧. the branch, on Ctrl too", () => {
  assert.equal(press({ metaKey: true, key: ".", code: "Period" }), "key");
  assert.equal(press({ ctrlKey: true, key: ".", code: "Period" }), "key");
  assert.equal(press({ metaKey: true, shiftKey: true, key: ">", code: "Period" }), "branch");
  assert.equal(press({ ctrlKey: true, shiftKey: true, key: ".", code: "Period" }), "branch");
});

test("the physical key counts on another layout", () => {
  assert.equal(press({ metaKey: true, shiftKey: true, key: "Ю", code: "Period" }), "branch");
});

test("no modifier or another key copies nothing", () => {
  assert.equal(press({ key: ".", code: "Period" }), null);
  assert.equal(press({ shiftKey: true, key: ">", code: "Period" }), null);
  assert.equal(press({ metaKey: true, key: "k", code: "KeyK" }), null);
});
