import assert from "node:assert/strict";
import { test } from "node:test";
import { branchName } from "@rsva/schema/models";
import { branchKeys, commitKeys, commitsKeys, pullKeys, textKeys } from "./refs.ts";

const pr = (over: Partial<Parameters<typeof pullKeys>[0]>) => Object.fromEntries(pullKeys({ head: "topic", title: "", body: "", commits: {}, ...over }));

test("a key touches no other letter or digit", () => {
  assert.deepEqual([...textKeys("LAS-1 (OPTO-22), xLAS-3 LAS-4a LAS-0 sha-256").keys()], ["LAS-1", "OPTO-22"]);
});

test("branches match in any case, text only in upper case", () => {
  assert.deepEqual(branchKeys("robin/las-123-fix-opto-7"), ["LAS-123", "OPTO-7"]);
  assert.equal(textKeys("see utf-8 and las-1").size, 0);
});

test("closing words take a list, linking words win", () => {
  assert.deepEqual(Object.fromEntries(textKeys("Fixes A-1, A-2 and B-3. **Closes**: C-4. Part of D-5. E-6")), {
    "A-1": "closing",
    "A-2": "closing",
    "B-3": "closing",
    "C-4": "closing",
    "D-5": "linking",
    "E-6": "bare",
  });
  assert.equal(textKeys("Fixes A-1\nRefs A-1").get("A-1"), "linking");
  assert.equal(textKeys("REFS: A-1").get("A-1"), "linking");
});

test("a commit closes only with a closing word", () => {
  assert.deepEqual(Object.fromEntries(commitKeys("Resolve A-1, mention B-2\n\nRefs C-3")), { "A-1": true, "B-2": false, "C-3": false });
  assert.deepEqual(commitsKeys(["A-1 start", "Fixes A-1", "Refs B-2"]), { "A-1": true, "B-2": false });
});

test("a pull request: the rules in order", () => {
  assert.deepEqual(pr({ head: "a-1-x" }), { "A-1": true });
  assert.deepEqual(pr({ title: "A-1 Rotate keys" }), { "A-1": true });
  assert.deepEqual(pr({ body: "Fixes A-1" }), { "A-1": true });
  assert.deepEqual(pr({ commits: { "A-1": true } }), { "A-1": true });
  assert.deepEqual(pr({ body: "about A-1" }), { "A-1": false });
  assert.deepEqual(pr({ commits: { "A-1": false } }), { "A-1": false });
  // "Refs" outweighs the branch: the author said this one does not close it.
  assert.deepEqual(pr({ head: "a-1-x", body: "Refs A-1" }), { "A-1": false });
  assert.deepEqual(pr({ title: "Refs A-1", body: "Fixes A-1" }), { "A-1": false });
});

test("a pasted list stops at fifty references", () => {
  const body = Array.from({ length: 80 }, (_, i) => `A-${i + 1}`).join(" ");
  assert.equal(pullKeys({ head: "x", title: "", body, commits: {} }).size, 50);
});

test("a revert links and closes nothing", () => {
  assert.deepEqual(pr({ head: "revert-44-a-1-x", title: 'Revert "A-1 x"' }), { "A-1": false });
  assert.deepEqual(pr({ title: 'Revert "Fixes A-1"', body: "Fixes A-1" }), { "A-1": false });
  assert.deepEqual(Object.fromEntries(commitKeys('Revert "Fixes A-1"\n\nThis reverts commit abc.')), { "A-1": false });
});

test("a branch name: the key, then the title; Cyrillic reads, length is bounded", () => {
  assert.equal(branchName("INFRA-246", "Rotate restic repository keys"), "infra-246-rotate-restic-repository-keys");
  assert.equal(branchName("LAS-1", "Краткое название: ёж и щука"), "las-1-kratkoe-nazvanie-yozh-i-shchuka");
  assert.equal(branchName("A-1", "!!!"), "a-1");
  const long = branchName("PLNR-96", "GitHub App in the planner: replace the integration in a Plane server");
  assert.ok(long.length <= 60 && !long.endsWith("-"));
  assert.equal(branchName("A-1", "x".repeat(100)).length, 60);
});

test("a branch name carries no other issue's key: it would close that issue on merge", () => {
  const name = branchName("LAS-50", "Follow-up to OPTO-12 for A-3");
  assert.equal(name, "las-50-follow-up-to-for");
  assert.deepEqual(branchKeys(name), ["LAS-50"]);
});
