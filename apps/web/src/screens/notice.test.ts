import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyName, notice } from "./notice.ts";

const stubClipboard = (writeText: (text: string) => Promise<void>) =>
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

afterEach(() => notice.clear());

test("a copied name shows in the toast", async () => {
  const written: string[] = [];
  stubClipboard(async (text) => void written.push(text));
  await copyName("infra-246-rotate", "Branch name", "unused");
  assert.deepEqual(written, ["infra-246-rotate"]);
  assert.equal(notice.text, "Branch name copied");
  assert.equal(notice.code, "infra-246-rotate");
  assert.equal(notice.failed, null);
});

test("a refused copy names what failed and hands over the name", async () => {
  stubClipboard(() => Promise.reject(new Error("blocked")));
  await copyName("infra-246-rotate", "Branch name", "Press and hold the name to copy it.");
  assert.equal(notice.text, "Couldn’t copy the branch name");
  assert.deepEqual(notice.failed, { detail: "Press and hold the name to copy it.", label: "Branch name", value: "infra-246-rotate" });
  assert.equal(notice.code, null);
});

test("a browser without a clipboard fails the same way", async () => {
  stubClipboard(() => {
    throw new TypeError("no clipboard");
  });
  await copyName("x", "Branch name", "d");
  assert.equal(notice.failed?.value, "x");
});

test("the next toast leaves nothing of the last one", () => {
  notice.showFailed("Failed", { detail: "d", label: "l", value: "v" });
  const n = notice.n;
  notice.show("Link copied");
  assert.equal(notice.failed, null);
  assert.equal(notice.n, n + 1);
  notice.showCode("Copied", "name");
  notice.show("Done", () => {});
  assert.equal(notice.code, null);
  assert.ok(notice.undo);
});
