import assert from "node:assert/strict";
import { test } from "node:test";
import { failures, type Comparison } from "../src/verdict.ts";

const clean: Comparison = { rows: [{ model: "issuesLive", ok: "" }, { model: "members", ok: "" }], fieldDiffs: { title: 0 }, commentsMissing: 0, imagesWithoutFile: 0, planeLinks: 0, formatDiffs: [0, 0] };

test("a clean comparison passes, and members alone do not stop it", () => {
  assert.deepEqual(failures(clean), []);
  assert.deepEqual(failures({ ...clean, rows: [{ model: "members", ok: "≠" }] }), []);
});

test("every kind of difference fails", () => {
  assert.deepEqual(failures({ ...clean, rows: [{ model: "issuesLive", ok: "≠" }] }), ["issuesLive differ"]);
  assert.deepEqual(failures({ ...clean, fieldDiffs: { title: 2 } }), ["2 issues differ in title"]);
  assert.deepEqual(failures({ ...clean, commentsMissing: 1 }), ["1 comments missing"]);
  assert.deepEqual(failures({ ...clean, imagesWithoutFile: 3 }), ["3 images without an image file"]);
  assert.deepEqual(failures({ ...clean, planeLinks: 1 }), ["1 texts still link to Plane's assets"]);
  assert.deepEqual(failures({ ...clean, formatDiffs: [0, 2, 1] }), ["formatting differs in 3 places"]);
});
