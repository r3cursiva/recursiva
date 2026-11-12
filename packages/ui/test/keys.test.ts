import assert from "node:assert/strict"
import { test } from "node:test"
import { keyCaps } from "../src/lib/keys.ts"

test("a press is written with ⌘ ⇧ ⌥ on a Mac and with names elsewhere", () => {
  assert.deepEqual(keyCaps(true, ["mod", "shift", "."]), ["⌘", "⇧", "."])
  assert.deepEqual(keyCaps(false, ["mod", "shift", "."]), ["Ctrl", "Shift", "."])
  assert.deepEqual(keyCaps(true, ["mod", "alt", "0"]), ["⌘", "⌥", "0"])
  assert.deepEqual(keyCaps(false, ["mod", "alt", "0"]), ["Ctrl", "Alt", "0"])
})

test("a part that is not a modifier is shown as it is", () => {
  assert.deepEqual(keyCaps(false, ["mod", "⌫"]), ["Ctrl", "⌫"])
  assert.deepEqual(keyCaps(true, ["Tab"]), ["Tab"])
})
