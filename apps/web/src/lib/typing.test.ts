import assert from "node:assert/strict";
import { test } from "node:test";
import { typedInto, typing } from "./typing.ts";

// Node has no DOM: an event target with a tag, attributes and a parent, matching the simple selectors typing.ts uses (a tag,
// [name], [name=value], [name='value'] and :not([name])).
class El extends EventTarget {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly parent: El | null;
  constructor(tag: string, attrs: Record<string, string> = {}, parent: El | null = null) {
    super();
    this.tag = tag;
    this.attrs = attrs;
    this.parent = parent;
  }
  matches(list: string): boolean {
    return list.split(",").some((s) => matchOne(this, s.trim()));
  }
  closest(list: string): El | null {
    for (let n: El | null = this; n; n = n.parent) if (n.matches(list)) return n;
    return null;
  }
}
function matchOne(el: El, selector: string): boolean {
  const m = /^([a-z]*)((?:\[[^\]]+\])*)(?::not\(\[([\w-]+)\]\))?$/.exec(selector);
  assert.ok(m, `unsupported selector ${selector}`);
  if (m[1] && m[1] !== el.tag) return false;
  for (const [, name, value] of m[2]!.matchAll(/\[([\w-]+)(?:=([^\]]*))?\]/g)) {
    const has = el.attrs[name!];
    if (has === undefined || (value !== undefined && has !== value.replace(/^'(.*)'$/, "$1"))) return false;
  }
  return !(m[3] && m[3] in el.attrs);
}
(globalThis as { Element?: unknown }).Element = El;

const page = new El("main");
const div = (attrs: Record<string, string> = {}, parent = page) => new El("div", attrs, parent);
const key = (k: string, target: unknown) => ({ key: k, target }) as unknown as KeyboardEvent;

test("fields count as typing, other elements do not", () => {
  for (const el of [new El("input", {}, page), new El("textarea", {}, page), new El("select", {}, page), div({ contenteditable: "" }), div({ contenteditable: "true" })]) {
    assert.equal(typing(el), true, el.tag);
  }
  assert.equal(typing(new El("span", {}, div({ contenteditable: "true" }))), true, "inside an editor");
  for (const el of [page, div(), new El("button", {}, page), new El("a", {}, page), div({ contenteditable: "false" })]) assert.equal(typing(el), false, el.tag);
  assert.equal(typing(null), false);
  assert.equal(typing(new EventTarget()), false, "not an element");
});

test("popups count as typing; a screen's own list only when asked", () => {
  for (const role of ["dialog", "menu", "listbox"]) assert.equal(typing(new El("button", {}, div({ role }))), true, role);
  const pageList = div({ role: "listbox", "data-page-list": "" });
  assert.equal(typing(pageList), false);
  assert.equal(typing(pageList, true), true);
});

test("a radio or a checkbox keeps only its arrows and Space", () => {
  const radio = new El("input", { type: "radio" }, page);
  const box = new El("input", { type: "checkbox" }, page);
  assert.equal(typedInto(key("j", radio)), false);
  assert.equal(typedInto(key("ArrowLeft", radio)), true);
  assert.equal(typedInto(key(" ", box)), true);
  assert.equal(typedInto(key("x", box)), false);
  assert.equal(typedInto(key("x", new El("input", { type: "checkbox" }, div({ role: "dialog" })))), true, "in a dialog the dialog keeps every key");
});

test("typedInto counts fields, popups and the screen's own list", () => {
  assert.equal(typedInto(key("j", new El("input", {}, page))), true);
  assert.equal(typedInto(key("j", div({ role: "listbox", "data-page-list": "" }))), true);
  assert.equal(typedInto(key("j", new El("button", {}, div({ role: "menu" })))), true);
  assert.equal(typedInto(key("j", new El("a", {}, page))), false);
  assert.equal(typedInto(key("j", null)), false);
});
