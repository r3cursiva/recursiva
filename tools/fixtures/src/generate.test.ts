import assert from "node:assert/strict";
import { test } from "node:test";
import type { BundleIssue } from "@rsva/schema/bundle";
import { toNdjson } from "@rsva/schema/bundle";
import { generate } from "./generate.ts";

const issuesOf = (lines: ReturnType<typeof generate>) => lines.filter((l): l is BundleIssue => l.m === "Issue");
const count = <T>(xs: T[]) => {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

test("same seed gives the same bundle, another seed a different one", () => {
  assert.equal(toNdjson(generate("sample", { seed: 7 })), toNdjson(generate("sample", { seed: 7 })));
  assert.notEqual(toNdjson(generate("sample", { seed: 7 })), toNdjson(generate("sample", { seed: 8 })));
});

test("sample has the shape of our workspace", () => {
  const lines = generate("sample");
  const issues = issuesOf(lines);
  assert.equal(issues.length, 427);
  assert.equal(lines.filter((l) => l.m === "Project").length, 10);
  assert.equal(lines.filter((l) => l.m === "State").length, 70);
  assert.equal(lines.filter((l) => l.m === "Label").length, 40);
  const users = lines.filter((l) => l.m === "User");
  assert.deepEqual(users.map((u) => u.kind), ["human", "agent"]);

  // Label counts 0:46/1:198/2:164/3:7 per 415, scaled to 427.
  const labels = count(issues.map((i) => i.labels?.length ?? 0));
  assert.deepEqual([0, 1, 2, 3].map((n) => labels.get(n)), [47, 204, 169, 7]);
  // Priorities high 134 / none 133 / low 89 / medium 53 / urgent 6 per 415.
  const prio = count<number>(issues.map((i) => i.priority));
  assert.deepEqual([2, 0, 4, 3, 1].map((n) => prio.get(n)), [138, 137, 92, 54, 6]);

  const lengths = issues.map((i) => i.descriptionHtml!.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)]!;
  assert.ok(median > 200 && median < 300, `median description ${median}`);
  assert.ok(lengths.at(-1)! <= 3700, `max description ${lengths.at(-1)}`);
});

test("references point at objects in the bundle and numbers are unique per project", () => {
  const lines = generate("10k", { seed: 3 });
  const issues = issuesOf(lines);
  assert.equal(issues.length, 10_000);
  const exts = new Set(lines.map((l) => ("ext" in l ? l.ext : "")));
  const keys = new Set<string>();
  for (const i of issues) {
    for (const r of [i.project, i.state, ...(i.labels ?? []), ...(i.assignees ?? []), ...(i.parent ? [i.parent] : [])]) assert.ok(exts.has(r.ext), r.ext);
    assert.ok(i.state.ext.startsWith(i.project.ext + "-") && (i.labels ?? []).every((l) => l.ext.startsWith(i.project.ext + "-")));
    const k = `${i.project.ext}#${i.number}`;
    assert.ok(!keys.has(k), k);
    keys.add(k);
  }
});
