// Guards against accidental quadratic work: typical views from 625 to 10,000 issues must grow about linearly, measured
// against themselves at the same moment so a busy CI runner cannot fail them (@rsva/test-kit, PLNR-190). The speed
// itself, 25 ms for 10,000 issues, fails only off CI: the runner's timings swing 5 to 50 times (ADR 0023, ADR 0030).
// Real numbers and the comparison of designs: test/bench.ts and docs/research/query-2026-10-27.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLinear } from "@rsva/test-kit";
import { DEFAULT_DISPLAY, parseQuery, runQuery, type DisplayOptions, type Filter } from "../src/index.ts";
import { bigProject, ctx, L, S } from "./fixture.ts";

const sorted = (n: number) => bigProject(n).sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0));
const issues = sorted(10_000);
const c = ctx();
const d = (over: Partial<DisplayOptions>): DisplayOptions => ({ ...DEFAULT_DISPLAY, showEmptyGroups: true, ...over });

function median(fn: () => unknown): number {
  for (let k = 0; k < 5; k++) fn();
  const xs: number[] = [];
  for (let k = 0; k < 21; k++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  return xs.sort((a, b) => a - b)[10]!;
}

const CASES: [string, Filter, DisplayOptions][] = [
  ["no filter, by state", {}, d({})],
  ["state + priority", { state: [S.todo.id, S.progress.id], priority: [1, 2] }, d({})],
  ["text", { text: "deploy caddy" }, d({ groupBy: "priority" })],
  ["labels, by labels, priority order", { label: [L.bug.id, L.security.id] }, d({ groupBy: "label", orderBy: "priority" })],
  ["me, by assignee, due order", { assignee: ["me"] }, d({ groupBy: "assignee", orderBy: "dueDate" })],
  ["created last 30 days, created order", { createdAt: { preset: "last-30-days" } }, d({ orderBy: "createdAt" })],
];

for (const [name, filter, display] of CASES) {
  test(`up to 10k issues: ${name} grows linearly; under 25 ms off CI`, (t) => {
    const g = assertLinear(name, sorted, (rows) => runQuery(rows, filter, display, c), issues.length);
    const ms = median(() => runQuery(issues, filter, display, c));
    t.diagnostic(`growth ${g.toFixed(1)}×, ${ms.toFixed(2)} ms for 10k`);
    if (!process.env.CI) assert.ok(ms < 25, `${ms.toFixed(2)} ms`);
  });
}

test("10k issues: groups hold every matching issue exactly once per group value", () => {
  const groups = runQuery(issues, {}, d({ groupBy: "state" }), c);
  assert.equal(groups.reduce((n, g) => n + g.issues.length, 0), issues.length);
});

test("parsing a long query is instant", () => {
  const q = 'state:Todo,"In Review",Done assignee:me,none priority:high,urgent label:bug,security due:next-2-weeks fix "dark mode"';
  assert.ok(median(() => parseQuery(q, c)) < 2);
});
