// runQuery on 10,000 issues: the chosen design against two alternatives, on plain rows and on MobX rows as the
// browser has them (shallow observables read inside a computed, so every field read is also tracked).
//   node packages/query/test/bench.ts
// Results and the comparison: docs/research/query-2026-10-27.md.
import type { Issue } from "@rsva/schema/models";
import { autorun, computed, configure, observable } from "mobx";
import { DEFAULT_DISPLAY, runQuery, type DisplayOptions, type Filter, type IssueGroup, type QueryContext } from "../src/index.ts";
import { bigProject, ctx as makeCtx, L, S, U } from "./fixture.ts";

configure({ enforceActions: "never" });
const N = Number(process.argv[2] ?? 10_000);
const ctx = makeCtx();
const plain = bigProject(N).sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0));
const mobx = plain.map((i) => observable.object({ ...i }, undefined, { deep: false }) as Issue);

const d = (over: Partial<DisplayOptions>): DisplayOptions => ({ ...DEFAULT_DISPLAY, showEmptyGroups: true, ...over });
const CASES: [string, Filter, DisplayOptions][] = [
  ["no filter, by state", {}, d({})],
  ["state+priority, by state", { state: [S.todo.id, S.progress.id], priority: [1, 2] }, d({})],
  ["text 'dep', by state", { text: "dep" }, d({})],
  ["text 'deploy caddy', by priority", { text: "deploy caddy" }, d({ groupBy: "priority" })],
  ["label any-of, by labels", { label: [L.bug.id, L.security.id] }, d({ groupBy: "label" })],
  ["assignee me, by assignee, due date order", { assignee: ["me"] }, d({ groupBy: "assignee", orderBy: "dueDate" })],
  ["no filter, by labels, priority order", {}, d({ groupBy: "label", orderBy: "priority" })],
  ["due last-30-days, created order", { dueDate: { preset: "last-30-days" } }, d({ orderBy: "createdAt" })],
];

// ── Alternative A: the usual way. Array.filter with a closure per key, then a comparator that reads fields. ───────
function naive(issues: readonly Issue[], f: Filter, disp: DisplayOptions, c: QueryContext): IssueGroup[] {
  let rows = issues.filter((i) => disp.showSubIssues || !i.parentId);
  if (f.state?.length) rows = rows.filter((i) => f.state!.includes(i.stateId));
  if (f.priority?.length) rows = rows.filter((i) => f.priority!.includes(i.priority));
  if (f.label?.length) rows = rows.filter((i) => i.labelIds.some((l) => f.label!.includes(l)) || (f.label!.includes("none") && !i.labelIds.length));
  if (f.assignee?.length) rows = rows.filter((i) => i.assigneeIds.some((a) => f.assignee!.includes(a === c.me ? "me" : a)));
  if (f.text) {
    const words = f.text.toLowerCase().split(/\s+/);
    rows = rows.filter((i) => words.every((w) => i.title.toLowerCase().includes(w)));
  }
  const key = (i: Issue): string | number =>
    disp.orderBy === "priority" ? (i.priority || 5) : disp.orderBy === "dueDate" ? (i.dueDate ?? "9999") : disp.orderBy === "createdAt" ? i.createdAt : i.sortOrder;
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const groups = new Map<string, Issue[]>();
  for (const i of rows) {
    const ks = disp.groupBy === "label" ? (i.labelIds.length ? i.labelIds : ["none"]) : disp.groupBy === "priority" ? [String(i.priority)] : [i.stateId];
    for (const k of ks) {
      const g = groups.get(k);
      if (g) g.push(i);
      else groups.set(k, [i]);
    }
  }
  return [...groups].map(([k, issues]) => ({ key: k, groupBy: disp.groupBy, name: k, ref: null, issues }));
}

// ── Alternative C: inverted indexes as bitsets, built once per data change; filters become word-wise AND/OR. ──────
function buildIndex(issues: readonly Issue[]) {
  const words = (issues.length + 31) >>> 5;
  const sets = new Map<string, Uint32Array>();
  const bit = (k: string, n: number) => {
    let b = sets.get(k);
    if (!b) sets.set(k, (b = new Uint32Array(words)));
    b[n >>> 5]! |= 1 << (n & 31);
  };
  issues.forEach((i, n) => {
    bit(`s:${i.stateId}`, n);
    bit(`p:${i.priority}`, n);
    for (const l of i.labelIds) bit(`l:${l}`, n);
    if (!i.labelIds.length) bit("l:none", n);
    for (const a of i.assigneeIds) bit(`a:${a}`, n);
  });
  return { words, sets };
}
function bitsetQuery(issues: readonly Issue[], idx: ReturnType<typeof buildIndex>, f: Filter): Issue[] {
  const acc = new Uint32Array(idx.words).fill(0xffffffff);
  const any = (keys: string[]) => {
    const or = new Uint32Array(idx.words);
    for (const k of keys) {
      const b = idx.sets.get(k);
      if (b) for (let w = 0; w < or.length; w++) or[w]! |= b[w]!;
    }
    for (let w = 0; w < acc.length; w++) acc[w]! &= or[w]!;
  };
  if (f.state?.length) any(f.state.map((s) => `s:${s}`));
  if (f.priority?.length) any(f.priority.map((p) => `p:${p}`));
  if (f.label?.length) any(f.label.map((l) => `l:${l}`));
  const out: Issue[] = [];
  for (let n = 0; n < issues.length; n++) if (acc[n >>> 5]! & (1 << (n & 31))) out.push(issues[n]!);
  return out;
}

function time(fn: () => unknown, runs = 60): { med: number; p95: number } {
  for (let k = 0; k < 10; k++) fn();
  const xs: number[] = [];
  for (let k = 0; k < runs; k++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return { med: xs[Math.floor(runs / 2)]!, p95: xs[Math.floor(runs * 0.95)]! };
}

/**
 * Inside a live computed, as the screens run it: the filter is an observable, a keystroke replaces it and the
 * computed re-runs, re-tracking every field it reads. Alternates two equal filters so each run is a real re-run.
 */
function inComputed(run: typeof runQuery, issues: Issue[], f: Filter, disp: DisplayOptions): { med: number; p95: number } {
  const box = observable.box(f, { deep: false });
  const c = computed(() => run(issues, box.get(), disp, ctx));
  const dispose = autorun(() => c.get());
  const t = time(() => box.set({ ...box.get() }));
  dispose();
  return t;
}

/**
 * Alternative D: two levels of computeds. Each issue gets a computed plain copy of the fields the query reads
 * (re-run only when that issue changes); the query runs over the copies, untracked by field, and maps back to the
 * live rows. A keystroke re-runs only the plain query; an edit re-runs one copy plus the query.
 */
const copies = new WeakMap<Issue, { get(): Issue }>();
function snapshotOf(i: Issue): Issue {
  let c = copies.get(i);
  if (!c) {
    const live = i;
    const box = computed(() => ({ ...live, live }) as Issue);
    copies.set(i, (c = box));
  }
  return c.get();
}
function twoLevel(issues: readonly Issue[], f: Filter, disp: DisplayOptions, cx: QueryContext): IssueGroup[] {
  const snaps = issues.map(snapshotOf);
  return runQuery(snaps, f, disp, cx).map((g) => ({ ...g, issues: g.issues.map((s) => (s as Issue & { live: Issue }).live) }));
}

const fmt = (t: { med: number; p95: number }) => `${t.med.toFixed(2)} / ${t.p95.toFixed(2)}`;
console.log(`${N} issues; median / p95 ms\n`);
console.log("| case | runQuery plain | runQuery MobX computed | usual way (A) plain | (A) MobX computed | two-level (D) MobX |");
console.log("|---|---|---|---|---|---|");
for (const [name, f, disp] of CASES) {
  const a = time(() => runQuery(plain, f, disp, ctx));
  const b = inComputed(runQuery, mobx, f, disp);
  const c = time(() => naive(plain, f, disp, ctx));
  const e = inComputed(naive, mobx, f, disp);
  const g = inComputed(twoLevel, mobx, f, disp);
  console.log(`| ${name} | ${fmt(a)} | ${fmt(b)} | ${fmt(c)} | ${fmt(e)} | ${fmt(g)} |`);
}

// An edit to one issue while a query is live: what the list pays per change.
for (const [label, run] of [["single computed", runQuery], ["two-level (D)", twoLevel]] as const) {
  const box = observable.box<Filter>({ text: "dep" }, { deep: false });
  const c = computed(() => run(mobx, box.get(), d({}), ctx));
  const dispose = autorun(() => c.get());
  let k = 0;
  const t = time(() => {
    const i = mobx[k++ % mobx.length]!;
    // A title edit: the query reads titles for the text filter.
    (i as { title: string }).title = `${i.title} x`;
  });
  dispose();
  console.log(`edit one title, ${label}: ${fmt(t)}`);
}

const idxBuild = time(() => buildIndex(plain), 20);
const idx = buildIndex(plain);
const f = { state: [S.todo.id, S.progress.id], priority: [1, 2] };
console.log(`\nBitset indexes (C): build ${fmt(idxBuild)} plain, ${fmt(time(() => buildIndex(mobx), 20))} MobX;`);
console.log(`  state+priority filter only: bitset ${fmt(time(() => bitsetQuery(plain, idx, f)))}, compiled scan ${fmt(time(() => runQuery(plain, f, d({ groupBy: "none" }), ctx)))}`);

// Cold first run (a project opened for the first time) and the memory the per-issue copies of D hold.
// Run with --expose-gc for the heap numbers.
{
  const gc = (globalThis as { gc?: () => void }).gc;
  const fresh = plain.map((i) => observable.object({ ...i }, undefined, { deep: false }) as Issue);
  gc?.();
  const before = process.memoryUsage().heapUsed;
  const t1 = performance.now();
  const c1 = computed(() => runQuery(fresh, { assignee: [U.alex.id] }, d({}), ctx));
  const d1 = autorun(() => c1.get());
  const single = performance.now() - t1;
  gc?.();
  const mid = process.memoryUsage().heapUsed;
  const t2 = performance.now();
  const c2 = computed(() => twoLevel(fresh, { assignee: [U.alex.id] }, d({}), ctx));
  const d2 = autorun(() => c2.get());
  const two = performance.now() - t2;
  gc?.();
  const after = process.memoryUsage().heapUsed;
  console.log(`\ncold first run: single computed ${single.toFixed(1)} ms, two-level ${two.toFixed(1)} ms`);
  if (gc) console.log(`heap held: single computed ${((mid - before) / 1e6).toFixed(1)} MB, two-level ${((after - mid) / 1e6).toFixed(1)} MB more`);
  d1();
  d2();
}
