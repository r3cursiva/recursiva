import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE_DRAG, droppableFiles } from "@rsva/editor/drag";
import { strayFiles, takesDrop } from "./file-drop.ts";

test("a file drag no drop target took is cancelled", () => {
  assert.equal(strayFiles(["Files"], false), true);
  assert.equal(strayFiles(["text/uri-list", "Files"], false), true);
});

test("a drop target's drag and drags without files are left alone", () => {
  assert.equal(strayFiles(["Files"], true), false);
  assert.equal(strayFiles(["text/plain"], false), false);
  assert.equal(strayFiles(["text/uri-list", "text/html"], false), false);
  assert.equal(strayFiles([], false), false);
});

test("a drop target takes files from outside the page, not an image dragged from the page (PLNR-352)", () => {
  assert.equal(droppableFiles(["Files"]), true);
  assert.equal(droppableFiles(["text/uri-list", "text/html", "Files"]), true);
  assert.equal(droppableFiles(["text/plain", "text/html", PAGE_DRAG, "Files"]), false);
  assert.equal(droppableFiles(["text/plain"]), false);
  // The guard still cancels the page's own image when nothing took it: the browser would open it.
  assert.equal(strayFiles(["text/html", PAGE_DRAG, "Files"], false), true);
});

test("a drop target leaves a drop to the editor inside it that took it", () => {
  assert.equal(takesDrop(["Files"], false), true);
  // The composer around its editor: the editor uploaded the files, a second take would upload them again.
  assert.equal(takesDrop(["Files"], true), false);
  assert.equal(takesDrop(["text/html", PAGE_DRAG, "Files"], false), false);
});
