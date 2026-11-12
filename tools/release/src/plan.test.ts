import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { journalEntry, type ReleaseRecord } from "./journal.ts";
import { compareCounts, contextOf, formatPlan, lineDiff, parseCounts, parseStatus, planOf, protocolOf, riskyLines, type Counts, type Facts, type PerfState } from "./plan.ts";

const counts: Counts = { issues: 553, projects: 10, comments: 617, lastAction: 782, migrations: 18 };
const facts: Facts = {
  live: { tag: "aaaaaaaaa", previous: "bbbbbbbbb", healthy: true },
  sha: "cccccccccdddddd",
  change: { commits: ["One"], files: ["apps/web/src/a.ts"], migrations: [], schema: 18, protocol: null },
  forward: true,
  drift: [],
  perf: "ok",
};
const strict = { skipChecks: false, allowDiverged: false, allowDestructive: false };

test("parseStatus reads the tags and the health", () => {
  assert.deepEqual(parseStatus('tag 4257a1a61, previous 4ca3a7591\n{"ok":true}\n'), { tag: "4257a1a61", previous: "4ca3a7591", healthy: true });
  assert.deepEqual(parseStatus("tag 4257a1a61, previous none\n"), { tag: "4257a1a61", previous: null, healthy: false });
  assert.throws(() => parseStatus("Connection refused"), /unexpected/);
});

test("riskyLines finds what an older image cannot run against, and leaves additions alone", () => {
  const sql = `CREATE TABLE "a" (id int);\nALTER TABLE "b" ADD COLUMN "c" int;\nCREATE INDEX "i" ON "b" ("c");\nALTER TABLE "b" DROP COLUMN "d";\nALTER TABLE "b" RENAME COLUMN "e" TO "f";\nALTER TABLE "b" ALTER COLUMN "g" SET DATA TYPE text;\nDELETE FROM "h";`;
  assert.equal(riskyLines(sql).length, 4);
  assert.deepEqual(riskyLines(`ALTER TABLE "b" ADD COLUMN "dropped_at" int;`), []);
});

test("contextOf follows the Dockerfile's COPY lines", () => {
  assert.deepEqual(contextOf("FROM node\nCOPY a/b.js a/c.js a/\nCOPY d d/\nCMD x"), ["deploy/stand/Dockerfile", "a/b.js", "a/c.js", "d"]);
});

// `docker buildx build -f deploy/stand/Dockerfile .` sends only what .dockerignore lets through (PLNR-287).
test(".dockerignore lets through exactly what the Dockerfile copies", () => {
  const root = new URL("../../../", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8");
  const allowed = read(".dockerignore").split("\n").filter((l) => l.startsWith("!")).map((l) => l.slice(1));
  assert.deepEqual(allowed, contextOf(read("deploy/stand/Dockerfile")).slice(1));
});

test("protocolOf reads the version", () => {
  assert.equal(protocolOf("export const PROTOCOL_VERSION = 12;"), 12);
  assert.equal(protocolOf("nothing"), null);
});

test("lineDiff shows both sides", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nc"), ["- b", "+ c"]);
});

test("a plain release has no blockers", () => {
  assert.deepEqual(planOf(facts, strict).blockers, []);
});

test("the checks run unless skipped, and the plan's first line says which", () => {
  const first = (o = strict) => formatPlan(planOf(facts, o)).split("\n")[0];
  assert.equal(planOf(facts, strict).checks, true);
  assert.equal(first(), "Live aaaaaaaaa -> ccccccccc (checks: pnpm check and sync:browser before the build)");
  assert.equal(planOf(facts, { ...strict, skipChecks: true }).checks, false);
  assert.equal(first({ ...strict, skipChecks: true }), "Live aaaaaaaaa -> ccccccccc (checks: none, --skip-checks)");
});

test("Perf is one line of the plan and never blocks", () => {
  const line = (perf: PerfState) => formatPlan(planOf({ ...facts, perf }, strict)).split("\n")[1];
  assert.equal(line("ok"), "Perf: ok");
  assert.equal(line("running"), "Perf: still running, not blocking");
  assert.equal(line("none"), "Perf: no run for this commit");
  assert.equal(line({ failed: "https://run" }), "Perf: failed, not blocking: https://run");
  assert.deepEqual(planOf({ ...facts, perf: { failed: "https://run" } }, strict).blockers, []);
});

test("a stale live tag, drift and a destructive migration each block", () => {
  const blockers = (f: Partial<Facts>, o = strict) => planOf({ ...facts, ...f }, o).blockers;
  assert.match(blockers({ forward: false })[0] as string, /--allow-diverged/);
  assert.deepEqual(blockers({ forward: false }, { ...strict, allowDiverged: true }), []);
  assert.match(blockers({ change: null })[0] as string, /not a commit known/);
  assert.match(blockers({ drift: [{ path: "deploy/stand/compose.yaml", lines: ["+ x"], put: false }] })[0] as string, /compose\.yaml[\s\S]*by hand[\s\S]*\+ x/);
  const risky = { ...facts.change!, migrations: [{ file: "0018_x.sql", risky: ["DROP TABLE a"] }] };
  assert.match(blockers({ change: risky })[0] as string, /0018_x\.sql: DROP TABLE a/);
  assert.deepEqual(blockers({ change: risky }, { ...strict, allowDestructive: true }), []);
});

test("a host file still at the live commit's version is put by the release: a note with the diff, not a blocker", () => {
  const plan = planOf({ ...facts, drift: [{ path: "deploy/stand/compose.yaml", lines: ["+ x"], put: true }] }, strict);
  assert.deepEqual(plan.blockers, []);
  assert.match(formatPlan(plan), /Note: deploy\/stand\/compose\.yaml changed since the live tag: the release puts it[\s\S]*\+ x/);
});

test("the plan says when nothing reaches the server, and names the protocol change", () => {
  const docs = { ...facts.change!, files: ["docs/a.md", "tools/release/src/cli.ts"], protocol: { from: 12, to: 13 } };
  const text = formatPlan(planOf({ ...facts, change: docs }, strict));
  assert.match(text, /only restart/);
  assert.match(text, /Protocol 12 -> 13/);
  assert.doesNotMatch(formatPlan(planOf(facts, strict)), /only restart/);
});

test("parseCounts rejects what is not a row of five numbers", () => {
  assert.deepEqual(parseCounts("553|10|617|782|18\n"), counts);
  assert.throws(() => parseCounts("553|10"), /unexpected/);
  assert.throws(() => parseCounts("ERROR: nope"), /unexpected/);
});

test("compareCounts tells lost data from a row deleted meanwhile", () => {
  assert.deepEqual(compareCounts(counts, { ...counts, issues: 560 }, 18), { failures: [], warnings: [] });
  assert.deepEqual(compareCounts(counts, { ...counts, comments: 616 }, 18), { failures: [], warnings: ["comments: 617 -> 616"] });
  assert.equal(compareCounts(counts, { ...counts, issues: 100 }, 18).failures.length, 1);
  assert.equal(compareCounts(counts, { ...counts, lastAction: 700 }, 18).failures.length, 1);
  assert.deepEqual(compareCounts(counts, counts, 19).failures, ["migrations: 19 expected, 18 applied"]);
  assert.deepEqual(compareCounts(counts, { ...counts, migrations: 19 }, 19).failures, []);
  assert.deepEqual(compareCounts({ ...counts, migrations: 19 }, { ...counts, migrations: 19 }, 19).failures, [], "the repeat of a release that rolled back");
});

const record: ReleaseRecord = { outcome: "shipped", from: "aaaaaaaaa", to: "bbbbbbbbb", commits: ["One"], migrations: [], dump: null, files: [], counts, failures: [], warnings: [] };
const at = new Date("2026-11-01T03:25:00Z");

test("journalEntry dates the line in Moscow time and names the way back", () => {
  const line = journalEntry(record, at);
  assert.ok(line.startsWith("- 2026-11-01 06:25 MSK — **планировщик обновлён `aaaaaaaaa` → `bbbbbbbbb`**"), line);
  assert.match(line, /Миграций нет/);
  assert.match(line, /образ `rsva:aaaaaaaaa` на месте/);
});

test("journalEntry names each host file the release replaced, and its copy", () => {
  const line = journalEntry({ ...record, files: [{ path: "/opt/rsva/compose.yaml", backup: "/opt/rsva/compose.yaml.bak-20261103-bbbbbbbbb" }] }, at);
  assert.match(line, /`\/opt\/rsva\/compose\.yaml` заменён на версию из репозитория, копия `\/opt\/rsva\/compose\.yaml\.bak-20261103-bbbbbbbbb`\./);
});

test("journalEntry keeps what went wrong and where the dump is", () => {
  const line = journalEntry({ ...record, outcome: "left-failing", migrations: [{ file: "0018_x.sql", risky: [] }], dump: "/d.dump", failures: ["x"] }, at);
  assert.match(line, /откат не запускался/);
  assert.match(line, /`0018_x\.sql`, перед выкладкой дамп `\/d\.dump`/);
  assert.match(line, /Проверка: x\./);
  assert.doesNotMatch(line, /Откат:/);
});
