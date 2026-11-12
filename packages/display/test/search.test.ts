import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex, byKey, search } from "../src/search.ts";

const issues = [
  { key: "INFRA-12", title: "Rotate the backup key" },
  { key: "INFRA-1", title: "Caddy: rate-limit the login route" },
  { key: "LAS-3", title: "Backup of uploads" },
  { key: "LAS-4", title: "Review caddy logs for INFRA-1 probes" },
];
const docs = buildIndex(issues, (i) => i.key, (i) => i.title);
const keys = (q: string) => search(docs, q).map((i) => i.key);

test("exact key first, then key prefix, then title matches", () => {
  assert.deepEqual(keys("infra-1"), ["INFRA-1", "INFRA-12", "LAS-4"]);
});

test("title start beats a word start beats anywhere", () => {
  assert.deepEqual(keys("backup"), ["LAS-3", "INFRA-12"]);
  assert.deepEqual(keys("cad"), ["INFRA-1", "LAS-4"]);
});

test("every word must match; empty query finds nothing", () => {
  assert.deepEqual(keys("caddy logs"), ["LAS-4"]);
  assert.deepEqual(keys("  "), []);
  assert.deepEqual(keys("nothing like this"), []);
});

test("a word starts after any character that is not a letter or a digit, not only a space (RSVA-430)", () => {
  const q = buildIndex([{ key: "Q-1", title: "Dispatch queue: project:PLNR order:due" }, { key: "Q-2", title: "Reorder projects" }], (i) => i.key, (i) => i.title);
  assert.deepEqual(search(q, "plnr").map((i) => i.key), ["Q-1"]);
  assert.deepEqual(search(q, "order").map((i) => i.key), ["Q-1", "Q-2"]);
});

test("limit", () => {
  assert.equal(search(docs, "a", 2).length, 2);
});

test("byKey: the exact key, then keys starting with the query when asked; never a title", () => {
  const projects = buildIndex(
    [
      { key: "PLANE", name: "Plane fork" },
      { key: "PLNR", name: "recursiva" },
      { key: "INFRA", name: "Plnr infrastructure" },
    ],
    (p) => p.key,
    (p) => p.name,
  );
  const at = (q: string, prefix: boolean) => byKey(projects, q, prefix).map((p) => p.key);
  assert.deepEqual(at("plnr", false), ["PLNR"]);
  assert.deepEqual(at(" PLNR ", true), ["PLNR"]);
  assert.deepEqual(at("pl", true), ["PLANE", "PLNR"]);
  assert.deepEqual(at("pl", false), []);
  assert.deepEqual(at("pl nr", true), []);
  assert.deepEqual(byKey(docs, "infra-1", false).map((i) => i.key), ["INFRA-1"]);
});
