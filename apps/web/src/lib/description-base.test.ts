import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocNode } from "@rsva/editor/doc";
import { takeText } from "./description-base.ts";

const doc = (...paragraphs: string[]): DocNode => ({ type: "doc", content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });
const texts = (d: DocNode | null) => d?.content?.map((p) => p.content?.[0]?.text ?? "") ?? null;

test("our own save coming back changes nothing", () => {
  const t = takeText(doc("a"), doc("a", "more typing"), doc("a"), true);
  assert.equal(t?.show, null);
});

test("someone else's text is shown when nothing is unsaved here", () => {
  const t = takeText(doc("a"), doc("a"), doc("a", "theirs"), false);
  assert.deepEqual(texts(t!.show), ["a", "theirs"]);
  assert.deepEqual(texts(t!.known), ["a", "theirs"]);
});

test("someone else's text merges with the typing here, which stays unsaved on top of it", () => {
  const t = takeText(doc("one", "two"), doc("one, mine", "two"), doc("one", "two, theirs"), true);
  assert.deepEqual(texts(t!.show), ["one, mine", "two, theirs"]);
  assert.deepEqual(texts(t!.known), ["one", "two, theirs"], "the next save is made from their text");
});

test("a text that cannot merge leaves the editor and its base as they are", () => {
  const huge = "x".repeat(250_000);
  assert.equal(takeText(doc(""), doc(`${huge}a`), doc(`${huge}b`), true), null);
});
