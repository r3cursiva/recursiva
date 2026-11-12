import assert from "node:assert/strict";
import { test } from "node:test";
import { keepUsed, withoutFontFaces } from "./startup-css.ts";

const used = (names: string[]) => (c: string) => names.includes(c);

test("a utility no startup module mentions goes, in an at-rule too, and the at-rule left empty with it", () => {
  const css = ".p-2{padding:.5rem}.px-3{padding-inline:.75rem}@media (width>=48rem){.md\\:flex{display:flex}}";
  assert.equal(keepUsed(css, used(["px-3"])), ".px-3{padding-inline:.75rem}");
});

test("rules without a class stay, and kept rules keep their order", () => {
  const css = ":root{--a:1}.b{color:red}[data-theme=mocha]{--a:2}.a{color:#00f}*{margin:0}";
  assert.equal(keepUsed(css, used(["a", "b"])), css);
  assert.equal(keepUsed(css, used([])), ":root{--a:1}[data-theme=mocha]{--a:2}*{margin:0}");
});

test("the rule's own class decides, not a variant's group or a :where() inside", () => {
  const css = ".group-hover\\:x:is(:where(.group):hover *){color:red}:where(.space-y-2>:not(:last-child)){margin:0}";
  assert.equal(keepUsed(css, used(["group"])), "");
  assert.equal(keepUsed(css, used(["group-hover:x", "space-y-2"])), css);
});

test("a selector list stays when any of its selectors is used", () => {
  assert.equal(keepUsed(".a,.b{color:red}", used(["b"])), ".a,.b{color:red}");
});

test("the whole sheet loses its font faces and nothing else", () => {
  const css = "@font-face{font-family:Onest;src:url(/a.woff2)}.a{font-family:Onest}";
  assert.equal(withoutFontFaces(css), ".a{font-family:Onest}");
});
