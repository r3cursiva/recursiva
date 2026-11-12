// Similar issues on our data (PLNR-295): which thresholds and which text the score should use, and what it costs. Read-only.
//
//   node tools/perf/src/similar.ts fetch dump.json   the workspace's issues through `rsva api` (GET only, 3 at a time)
//   node tools/perf/src/similar.ts dump.json         the measurement: pairs found by hand, false positives, time
//
// The dump holds the live issues (`GET /issues` leaves out the archived and the deleted) with their description,
// relations and, for cancelled ones, comments. Result: docs/research/similar-issues-2026-11-06.md.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { jaccard, OTHER_PROJECT, similarIssues, trigrams } from "../../../packages/protocol/src/similar.ts";
import { ISSUE_KEY } from "@rsva/schema/models";
import { seeded } from "@rsva/schema/util";
import { quantile } from "@rsva/test-kit";
import { printTable } from "./report.ts";

const fmt = (v: number, digits: number) => v.toFixed(digits);

interface Row {
  key: string;
  title: string;
  state: string;
  stateGroup: string;
  createdAt: string;
  completedAt: string | null;
  relations: { duplicateOf: string | null; duplicates: string[] };
  description: string;
  /** Comments of a cancelled issue (bodies only). */
  comments?: string[];
}

/** The project keys to fetch: RSVA_SIMILAR_PROJECTS, comma-separated. */
const PROJECTS = (process.env.RSVA_SIMILAR_PROJECTS ?? "").split(",").filter(Boolean);
const rsva = (path: string, ...query: string[]) =>
  new Promise<any>((resolve, reject) =>
    execFile("rsva", ["api", "GET", path, ...query], { maxBuffer: 1 << 27 }, (e, out, err) => (e ? reject(new Error(`${path}: ${err}`)) : resolve(JSON.parse(out)))),
  );

async function fetchDump(file: string): Promise<void> {
  const keys: string[] = [];
  // A project at a time: the list stops at 500, and the largest project has 380.
  for (const p of PROJECTS) keys.push(...(await rsva("/issues", `project=${p}`, "limit=500")).issues.map((i: Row) => i.key));
  const rows: Row[] = [];
  const queue = [...keys];
  // Three at a time and a pause after each: the token has 600 requests a minute (auth/tokens.ts).
  const worker = async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      const i = await rsva(`/issues/${key}`);
      const row: Row = { key, title: i.title, state: i.state, stateGroup: i.stateGroup, createdAt: i.createdAt, completedAt: i.completedAt, relations: i.relations, description: i.description };
      if (i.stateGroup === "cancelled") row.comments = (await rsva(`/issues/${key}/comments`)).comments.map((c: { body: string }) => c.body);
      rows.push(row);
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  writeFileSync(file, JSON.stringify(rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))));
  console.log(`${rows.length} issues → ${file}`);
}

// ── Scores ───────────────────────────────────────────────────────────────────────────────────────────────────────

const at = (r: Row) => Date.parse(r.createdAt.replace(" ", "T").replace(/\+00$/, "Z"));
const doneAt = (r: Row) => (r.completedAt ? Date.parse(r.completedAt.replace(" ", "T").replace(/\+00$/, "Z")) : Infinity);
/** Open when `r` was filed: made before, and not finished yet. */
const openAt = (rows: readonly Row[], r: Row) => rows.filter((c) => c !== r && at(c) < at(r) && doneAt(c) > at(r));

/** What the description adds to a probe in the variants that use it. */
const TEXT_CHARS = 300;
const text = (r: Row) => r.description.slice(0, TEXT_CHARS);
const project = (r: Row) => r.key.split("-")[0]!;
type Variant = { name: string; score(probe: Row, c: Row): number };
const VARIANTS: Variant[] = [
  { name: "title", score: (p, c) => jaccard(trigrams(p.title), trigrams(c.title)) * (project(p) === project(c) ? 1 : OTHER_PROJECT) },
  { name: "title, any project", score: (p, c) => jaccard(trigrams(p.title), trigrams(c.title)) },
  { name: "title+text vs title", score: (p, c) => jaccard(trigrams(`${p.title} ${text(p)}`), trigrams(c.title)) },
  { name: "title+text vs title+text", score: (p, c) => jaccard(trigrams(`${p.title} ${text(p)}`), trigrams(`${c.title} ${text(c)}`)) },
];

const rank = (rows: readonly Row[], probe: Row, original: Row, v: Variant): { rank: number; score: number } | null => {
  const pool = openAt(rows, probe);
  if (!pool.includes(original)) return null;
  const scored = pool.map((c) => ({ c, s: v.score(probe, c) })).sort((a, b) => b.s - a.s);
  const i = scored.findIndex((x) => x.c === original);
  return { rank: i + 1, score: scored[i]!.s };
};

const short = (s: string, n = 58) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── Pairs found by hand ──────────────────────────────────────────────────────────────────────────────────────────

const SAYS = new RegExp(`(?:duplicate[sd]?(?: of| by)?|same as|dup of)\\s*:?\\s*\`?(${ISSUE_KEY})`, "gi");

function handPairs(rows: readonly Row[]): { dup: Row; original: Row; how: string }[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = new Map<string, { dup: Row; original: Row; how: string }>();
  const add = (dup: Row | undefined, original: Row | undefined, how: string) => {
    if (!dup || !original || dup === original) return;
    // The later issue is the duplicate, whichever way the relation was written.
    const [d, o] = at(dup) >= at(original) ? [dup, original] : [original, dup];
    out.set(`${d.key}>${o.key}`, { dup: d, original: o, how });
  };
  for (const r of rows) {
    if (r.relations.duplicateOf) add(r, byKey.get(r.relations.duplicateOf), "relation");
    for (const k of r.relations.duplicates) add(byKey.get(k), r, "relation");
    if (r.stateGroup === "cancelled") for (const t of [r.description, ...(r.comments ?? [])]) for (const m of t.matchAll(SAYS)) add(r, byKey.get(m[1]!.toUpperCase()), "text");
  }
  return [...out.values()];
}

// ── False positives ──────────────────────────────────────────────────────────────────────────────────────────────

// ── Time ─────────────────────────────────────────────────────────────────────────────────────────────────────────


function timing(rows: readonly Row[]): void {
  const fake = (r: Row, n: number) => ({ id: `${n}:${r.key}`, title: r.title, projectId: r.key.split("-")[0]!, stateId: "s", archivedAt: null, deletedAt: null });
  const pool = rows.map((r, n) => fake(r, n));
  const group = () => "backlog";
  const probe = rows.find((r) => r.key === "PLNR-139")?.title ?? rows[0]!.title;

  // Server: one title against the whole workspace; cold = every candidate's trigrams built (a fresh process), warm = cached.
  const cold: number[] = [];
  for (let i = 0; i < 30; i++) {
    const titles = pool.map((p) => ({ ...p, title: `${p.title} ${i} ${Math.random()}` }));
    const t0 = performance.now();
    similarIssues(probe, titles, group);
    cold.push(performance.now() - t0);
  }
  const warm: number[] = [];
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now();
    similarIssues(probe, pool, group);
    warm.push(performance.now() - t0);
  }
  // The web: every prefix of a typed title against the cached pool.
  const keystroke: number[] = [];
  for (let rep = 0; rep < 30; rep++)
    for (let n = 3; n <= probe.length; n++) {
      const t0 = performance.now();
      similarIssues(probe.slice(0, n), pool, group);
      keystroke.push(performance.now() - t0);
    }
  const bigger = Array.from({ length: 5 }, (_, k) => pool.map((p) => ({ ...p, id: `${k}${p.id}`, title: `${p.title} ${k}` }))).flat();
  similarIssues(probe, bigger, group);
  const big: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    similarIssues(probe, bigger, group);
    big.push(performance.now() - t0);
  }
  printTable(
    ["case", "candidates", "median ms", "p95 ms", "max ms"],
    [
      ["server, cold cache", String(pool.length), fmt(quantile(cold, 0.5), 2), fmt(quantile(cold, 0.95), 2), fmt(Math.max(...cold), 2)],
      ["server, warm cache", String(pool.length), fmt(quantile(warm, 0.5), 3), fmt(quantile(warm, 0.95), 3), fmt(Math.max(...warm), 3)],
      ["web, one keystroke", String(pool.length), fmt(quantile(keystroke, 0.5), 3), fmt(quantile(keystroke, 0.95), 3), fmt(Math.max(...keystroke), 3)],
      ["warm cache, ×5 pool", String(bigger.length), fmt(quantile(big, 0.5), 3), fmt(quantile(big, 0.95), 3), fmt(Math.max(...big), 3)],
    ],
  );
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const [, , first, second] = process.argv;
if (first === "fetch") await fetchDump(second ?? "similar-dump.json");
else if (first) {
  const rows = (JSON.parse(readFileSync(first, "utf8")) as Row[]).sort((a, b) => at(a) - at(b));
  console.log(`${rows.length} issues\n`);

  const pairs = handPairs(rows);
  console.log(`## Pairs found by hand: ${pairs.length}\n`);
  printTable(
    ["duplicate", "original", "how", ...VARIANTS.flatMap((v) => [`${v.name}: rank`, "score"])],
    pairs.map((p) => [
      p.dup.key,
      p.original.key,
      p.how,
      ...VARIANTS.flatMap((v) => {
        const r = rank(rows, p.dup, p.original, v);
        return r ? [String(r.rank), fmt(r.score, 2)] : ["n/a", "n/a"];
      }),
    ]),
  );
  for (const p of pairs) console.log(`${p.dup.key} "${short(p.dup.title, 80)}"  ←  ${p.original.key} "${short(p.original.title, 80)}"`);

  console.log("\n## The best match of every issue among the issues open when it was filed (title only, 0.3 and up; * a pair found by hand)\n");
  const hand = new Set(pairs.flatMap((p) => [`${p.dup.key}>${p.original.key}`]));
  const best: { a: Row; b: Row; s: number }[] = [];
  for (const r of rows) {
    const top = openAt(rows, r).map((c) => ({ c, s: VARIANTS[0]!.score(r, c) })).sort((x, y) => y.s - x.s)[0];
    if (top && top.s >= 0.3) best.push({ a: r, b: top.c, s: top.s });
  }
  for (const x of best.sort((p, q) => q.s - p.s)) console.log(`${fmt(x.s, 2)}${hand.has(`${x.a.key}>${x.b.key}`) ? "*" : " "} ${x.a.key} "${short(x.a.title, 70)}"  ~  ${x.b.key} "${short(x.b.title, 70)}"`);
  console.log(`${best.length} of ${rows.length} issues have a match at 0.3 or more; ${[0.35, 0.4, 0.5, 0.6, 0.7, 0.8].map((t) => `${t}: ${best.filter((x) => x.s >= t).length}`).join(", ")}`);

  console.log("\n## Sample of 100 issues against the issues open when each was filed\n");
  const rand = seeded(295);
  const sample = [...rows].sort(() => rand() - 0.5).slice(0, 100);
  for (const v of VARIANTS) {
    const tops = sample.map((r) => {
      const top = openAt(rows, r).map((c) => ({ c, s: v.score(r, c) })).sort((x, y) => y.s - x.s)[0];
      return { r, c: top?.c, s: top?.s ?? 0 };
    });
    console.log(`${v.name}: ${[0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => `≥${t}: ${tops.filter((x) => x.s >= t).length}`).join("  ")}`);
    if (v === VARIANTS[0]) for (const x of tops.filter((y) => y.s >= 0.4).sort((p, q) => q.s - p.s)) console.log(`  ${fmt(x.s, 2)}  ${x.r.key} "${short(x.r.title, 70)}"  ~  ${x.c!.key} "${short(x.c!.title, 70)}"`);
  }

  console.log("\n## Time\n");
  timing(rows);
} else console.log("usage: similar.ts fetch <dump.json> | similar.ts <dump.json>");
