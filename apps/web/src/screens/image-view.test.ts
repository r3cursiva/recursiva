import assert from "node:assert/strict";
import { test } from "node:test";
import { gallery, opensImage } from "./image-view.ts";

test("a click opens a picture in text being read; in an editor only a double click does", () => {
  assert.equal(opensImage(false, 1), true);
  assert.equal(opensImage(true, 1), false);
  assert.equal(opensImage(true, 2), true);
  // The third click of a triple one selects the block: it does not open the picture again.
  assert.equal(opensImage(true, 3), false);
});

test("the viewer steps through the page's pictures once each, from the clicked one", () => {
  const a = { src: "/files/w/a", alt: "a" };
  const b = { src: "/files/w/b", alt: "b" };
  assert.deepEqual(gallery([a, b, { ...a, alt: "quoted" }], b.src), { images: [a, b], index: 1 });
  assert.deepEqual(gallery([a], a.src), { images: [a], index: 0 });
});
