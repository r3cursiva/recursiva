// Shared by the perf checks: budgets, baseline and history.
//
// A budget (perf/budgets.json) is a hard ceiling from the plan. The baseline (perf/baseline.json) is the last accepted
// value: a metric may not grow beyond the tolerance without an explicit `--update`, which rewrites the baseline and
// appends a line to perf/history.ndjson. That way growth shows up in the commit diff and gets reviewed.
//
// PERF_TIMINGS=warn (CI, ADR 0021) reports a timing over its budget without failing: a shared runner's timings swing past
// a budget with no change in the code.
//
// perf:net's byte baseline comes from CI alone (ADR 0023): the same commit measured 62.1 KB there and 69.8 KB on the Mac,
// across a 2 % tolerance. Off CI its growth is a note, and `--update` takes CI's values instead of this machine's.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = new URL("../../../", import.meta.url).pathname;
const PERF = join(ROOT, "perf");

export interface Metric {
  /** Key in the budget and baseline, e.g. `bundle.initial.br`. */
  key: string;
  label: string;
  value: number;
  unit: "B" | "ms" | "n" | "MB";
  /** Compare against the baseline. Timings are noisy, so they only check the budget. */
  ratchet: boolean;
}

interface Budgets {
  ratchetPct: number;
  limits: Record<string, number>;
}

type Baseline = Record<string, number>;

/** NONE: the value is not a finite number, e.g. the median of no runs. */
type Verdict = "ok" | "SLOW" | "BUDGET" | "GREW" | "BIGGER" | "NONE";

interface Rules {
  ratchetPct: number;
  /** `--update`: the run is accepting new values, so growth is not a failure. */
  update: boolean;
  warnTimings: boolean;
  /** The baseline was measured elsewhere, so growth past it is a note. */
  noteGrowth: boolean;
}

export function judge(m: Metric, limit: number | undefined, base: number | undefined, rules: Rules): Verdict {
  // Every comparison with NaN or undefined is false, so without this a metric that measured nothing would pass.
  if (!Number.isFinite(m.value)) return "NONE";
  if (limit !== undefined && m.value > limit) return rules.warnTimings && m.unit === "ms" ? "SLOW" : "BUDGET";
  if (!rules.update && m.ratchet && base !== undefined && m.value > base * (1 + rules.ratchetPct / 100)) return rules.noteGrowth ? "BIGGER" : "GREW";
  return "ok";
}

export function check(section: string, metrics: Metric[], extra: unknown): void {
  const update = process.argv.includes("--update");
  const budgets = readJson<Budgets>("budgets.json");
  const baseline = readJson<Baseline>("baseline.json");
  const failures: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const missing: string[] = [];
  const rules = { ratchetPct: budgets.ratchetPct, update, warnTimings: process.env.PERF_TIMINGS === "warn", noteGrowth: section === "net" && !process.env.CI };

  const rows = metrics.map((m) => {
    const limit = budgets.limits[m.key];
    const base = baseline[m.key];
    const delta = base === undefined || base === 0 || !Number.isFinite(m.value) ? "" : pct((m.value - base) / base);
    const status = judge(m, limit, base, rules);
    const over = `${m.label}: ${fmt(m.value, m.unit)} > budget ${fmt(limit ?? 0, m.unit)}`;
    const growth = `${m.label}: ${fmt(base ?? 0, m.unit)} → ${fmt(m.value, m.unit)} (${delta})`;
    if (status === "SLOW") warnings.push(over);
    if (status === "BUDGET") failures.push(over);
    if (status === "GREW") failures.push(growth);
    if (status === "BIGGER") notes.push(growth);
    if (status === "NONE") missing.push(`${m.label}: ${String(m.value)}`);
    return [m.label, fmt(m.value, m.unit), base === undefined ? "—" : fmt(base, m.unit), delta, limit === undefined ? "—" : fmt(limit, m.unit), status];
  });
  printTable(["metric", "now", "base", "Δ", "budget", ""], rows);
  // A workflow command: GitHub lists it on the run's page, where a line in the log of a green step would go unseen.
  for (const w of warnings) console.log(`::warning title=Timing over budget::${w}`);
  if (notes.length) console.log(`\nOver a baseline measured in CI, so only a note here; the Perf run on main decides:\n  ${notes.join("\n  ")}`);

  mkdirSync(join(PERF, "out"), { recursive: true });
  writeFileSync(join(PERF, "out", `${section}.json`), JSON.stringify({ metrics, extra }, null, 2) + "\n");

  if (missing.length) {
    // Before --update too: accepting it would write null into the baseline.
    console.error("\nNo value measured:\n  " + missing.join("\n  "));
    process.exitCode = 1;
    return;
  }
  if (update) return accept(section, metrics, gitSha());
  if (failures.length) {
    console.error("\nFailed:\n  " + failures.join("\n  "));
    console.error(`\nIf the growth is justified: pnpm perf:${section} --update and explain it in the commit.`);
    process.exitCode = 1;
  }
}

/** A run count from the environment: a whole number not below `min`, else the run would measure nothing. */
export function runCount(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name}=${raw} is not a whole number of runs, ${min} or more`);
  return n;
}

function accept(section: string, metrics: Metric[], commit: string | null): void {
  const baseline = readJson<Baseline>("baseline.json");
  for (const m of metrics) baseline[m.key] = Math.round(m.value);
  writeFileSync(join(PERF, "baseline.json"), JSON.stringify(sortKeys(baseline), null, 2) + "\n");
  const entry = { date: new Date().toISOString(), commit, section, ...Object.fromEntries(metrics.map((m) => [m.key, Math.round(m.value)])) };
  appendFileSync(join(PERF, "history.ndjson"), JSON.stringify(entry) + "\n");
  console.log(`\nBaseline updated (${section}). Explain the growth in the commit message.`);
}

/** Moves `section`'s ratcheted metrics to the values of the last Perf run on main, finished red or green. */
export function acceptFromCi(section: string): void {
  const gh = (...args: string[]) => execFileSync("gh", args, { cwd: ROOT, encoding: "utf8" });
  const runs = JSON.parse(gh("run", "list", "--workflow", "Perf", "--branch", "main", "--limit", "10", "--json", "databaseId,headSha,conclusion")) as { databaseId: number; headSha: string; conclusion: string }[];
  const run = runs.find((r) => r.conclusion === "success" || r.conclusion === "failure");
  if (!run) throw new Error("no finished Perf run on main");
  const dir = mkdtempSync(join(tmpdir(), "perf-ci-"));
  gh("run", "download", String(run.databaseId), "--name", "perf", "--dir", dir);
  const { metrics } = JSON.parse(readFileSync(join(dir, `${section}.json`), "utf8")) as { metrics: Metric[] };
  accept(section, metrics.filter((m) => m.ratchet), run.headSha.slice(0, 7));
}

export function fmt(v: number, unit: Metric["unit"]): string {
  if (unit === "B") return v >= 10_240 ? `${(v / 1024).toFixed(1)} KB` : `${Math.round(v)} B`;
  if (unit === "ms") return `${Math.round(v)} ms`;
  if (unit === "MB") return `${Math.round(v)} MB`;
  return String(Math.round(v));
}

export function printTable(head: string[], rows: string[][]): void {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ");
  console.log(line(head));
  for (const r of rows) console.log(line(r));
}

function pct(x: number): string {
  return (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
}

function readJson<T>(name: string): T {
  try {
    return JSON.parse(readFileSync(join(PERF, name), "utf8")) as T;
  } catch {
    return {} as T;
  }
}

function sortKeys(o: Baseline): Baseline {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}
